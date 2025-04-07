#!/usr/bin/env bun
import chalk from "chalk";
import { Command } from "commander";
import { performance } from "perf_hooks"; // More precise timing

interface BenchmarkOptions {
  method: string;
  header: string[];
  data?: string;
  query: string[];
  requests?: string; // Parsed as number later
  duration?: string; // Parsed as number later
  concurrency: string; // Parsed as number later
  json: boolean;
}

interface RequestResult {
  status: number | null;
  latency: number; // in ms
  error?: Error | string;
  timestamp: number; // end timestamp
}

interface BenchmarkStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalTimeSeconds: number;
  rps: number; // Requests per second
  averageLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  p50LatencyMs: number;
  p90LatencyMs: number;
  p99LatencyMs: number;
  latencyMs: number[]; // Store all for calculation
  statusCodes: Record<string, number>;
  errors: Record<string, number>;
}

const program = new Command();

program
  .name("bunmark")
  .description("A minimalist API benchmarking tool using Bun.")
  .version("0.1.0")
  .argument("<url>", "URL to benchmark")
  .option("-X, --method <method>", "HTTP method", "GET")
  .option(
    "-H, --header <header...>",
    'Add request header (e.g., "Content-Type: application/json")',
    []
  )
  .option(
    "-d, --data <data>",
    "HTTP request body. Prefix with @ to read from file (e.g., @body.json)"
  )
  .option(
    "-q, --query <query...>",
    'Add query parameter (e.g., "key=value")',
    []
  )
  .option("-n, --requests <number>", "Number of requests to run")
  .option(
    "-t, --duration <seconds>",
    "Duration of the benchmark in seconds (e.g., 10 or 10s)"
  )
  .option("-c, --concurrency <number>", "Number of concurrent requests", "50")
  .option("--json", "Output results in JSON format", false)
  .action(runBenchmark);

async function runBenchmark(url: string, options: BenchmarkOptions) {
  const {
    json,
    method,
    header: headerStrings,
    data: dataOption,
    query: queryStrings,
  } = options;

  // --- Input Validation and Parsing ---
  let numRequests: number | undefined = undefined;
  let durationSeconds: number | undefined = undefined;
  const concurrency = parseInt(options.concurrency, 10);

  if (options.requests && options.duration) {
    console.error(
      chalk.red("Error: Cannot use both -n/--requests and -t/--duration.")
    );
    process.exit(1);
  }
  if (options.requests) {
    numRequests = parseInt(options.requests, 10);
    if (isNaN(numRequests) || numRequests <= 0) {
      console.error(
        chalk.red("Error: -n/--requests must be a positive number.")
      );
      process.exit(1);
    }
  } else if (options.duration) {
    const durationMatch = options.duration.match(/^(\d+)(s?)$/);
    if (
      !durationMatch ||
      isNaN(parseInt(durationMatch[1], 10)) ||
      parseInt(durationMatch[1], 10) <= 0
    ) {
      console.error(
        chalk.red(
          "Error: -t/--duration must be a positive number (e.g., 10 or 10s)."
        )
      );
      process.exit(1);
    }
    durationSeconds = parseInt(durationMatch[1], 10);
  } else {
    // Default benchmark type if none specified
    numRequests = 100;
    if (!json) {
      console.log(
        chalk.yellow(
          "Info: Neither -n nor -t specified, defaulting to -n 100 requests."
        )
      );
    }
  }

  if (isNaN(concurrency) || concurrency <= 0) {
    console.error(
      chalk.red("Error: -c/--concurrency must be a positive number.")
    );
    process.exit(1);
  }

  // --- Prepare Request Details ---
  const headers = new Headers();
  for (const h of headerStrings) {
    const parts = h.split(":");
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join(":").trim();
      headers.append(key, value);
    } else {
      console.warn(chalk.yellow(`Warning: Ignoring malformed header: "${h}"`));
    }
  }

  let body: BodyInit | undefined = undefined;
  if (dataOption) {
    if (dataOption.startsWith("@")) {
      const filePath = dataOption.substring(1);
      try {
        const file = Bun.file(filePath);
        if (!(await file.exists())) {
          console.error(chalk.red(`Error: Data file not found: ${filePath}`));
          process.exit(1);
        }
        body = await file.text();
        // Auto-detect Content-Type for JSON if not set by user
        if (!headers.has("Content-Type") && filePath.endsWith(".json")) {
          headers.set("Content-Type", "application/json");
        }
      } catch (err: any) {
        console.error(
          chalk.red(`Error reading data file "${filePath}": ${err.message}`)
        );
        process.exit(1);
      }
    } else {
      body = dataOption;
    }
  }

  const targetUrl = new URL(url);
  for (const q of queryStrings) {
    const parts = q.split("=");
    if (parts.length >= 2) {
      const key = parts[0].trim();
      const value = parts.slice(1).join("=").trim();
      targetUrl.searchParams.append(key, value);
    } else {
      console.warn(
        chalk.yellow(`Warning: Ignoring malformed query param: "${q}"`)
      );
    }
  }
  const finalUrl = targetUrl.toString();

  // --- Setup Benchmark ---
  const results: RequestResult[] = [];
  let requestsSent = 0;
  let activeRequests = 0;
  const controller = new AbortController(); // To stop benchmark on time limit
  const signal = controller.signal;

  if (!json) {
    console.log(chalk.cyan(`Starting benchmark for ${finalUrl}...`));
    console.log(chalk.cyan(`Method: ${method}, Concurrency: ${concurrency}`));
    if (numRequests) console.log(chalk.cyan(`Target requests: ${numRequests}`));
    if (durationSeconds)
      console.log(chalk.cyan(`Target duration: ${durationSeconds}s`));
  }

  const benchmarkStartTime = performance.now();
  let timeoutId: Timer | undefined = undefined;

  if (durationSeconds) {
    timeoutId = setTimeout(() => {
      controller.abort(); // Signal ongoing fetches to stop
      if (!json)
        console.log(
          chalk.yellow("\nDuration limit reached. Finishing active requests...")
        );
    }, durationSeconds * 1000);
  }

  // --- Run Benchmark ---
  const makeRequest = async (): Promise<void> => {
    const requestStartTime = performance.now();
    try {
      const response = await fetch(finalUrl, {
        method,
        headers,
        body,
        signal: signal, // Link fetch to the AbortController
      });
      await response.arrayBuffer(); // Consume body to free resources & measure full time
      const requestEndTime = performance.now();
      results.push({
        status: response.status,
        latency: requestEndTime - requestStartTime,
        timestamp: requestEndTime,
      });
    } catch (err: any) {
      const requestEndTime = performance.now();
      // Differentiate between abort error and other errors
      const error =
        signal.aborted && err.name === "AbortError"
          ? "Request aborted (duration limit)"
          : err;
      results.push({
        status: null,
        latency: requestEndTime - requestStartTime, // Still record latency until failure point
        error: error instanceof Error ? error.message : String(error),
        timestamp: requestEndTime,
      });
    } finally {
      activeRequests--;
    }
  };

  const runner = async () => {
    const promises: Promise<void>[] = [];
    while (true) {
      const elapsedSeconds = (performance.now() - benchmarkStartTime) / 1000;

      // Stop conditions
      if (signal.aborted) break; // Duration limit hit
      if (numRequests && requestsSent >= numRequests) break; // Request limit hit

      // Launch new requests if concurrency allows and not stopped
      while (
        activeRequests < concurrency &&
        (!numRequests || requestsSent < numRequests) &&
        !signal.aborted
      ) {
        activeRequests++;
        requestsSent++;
        promises.push(makeRequest());
        // Avoid overwhelming the event loop immediately, yields slightly
        await Bun.sleep(0);
      }

      // Optimization: Wait only if needed, prevents busy-waiting when max concurrency is hit
      if (
        activeRequests >= concurrency ||
        (numRequests && requestsSent >= numRequests)
      ) {
        // Wait for *any* active request to finish before attempting to launch more
        // This is tricky to manage efficiently without a library like p-limit
        // Simple approach: check again after a small delay
        await Bun.sleep(1); // Adjust sleep time as needed
      }

      // Clean up finished promises occasionally (less critical with modern JS engines)
      // Or better: use Promise.race to actively manage completions (more complex setup)
    }
    // Wait for all potentially still active requests to finish *after* the stop condition
    await Promise.allSettled(promises);
  };

  await runner(); // Execute the benchmark runner

  const benchmarkEndTime = performance.now();
  if (timeoutId) clearTimeout(timeoutId); // Clean up timer

  // --- Calculate Statistics ---
  const totalTimeSeconds = (benchmarkEndTime - benchmarkStartTime) / 1000;
  const successfulResults = results.filter(
    (r) => r.status !== null && r.status >= 200 && r.status < 400 && !r.error
  );
  const failedResults = results.filter(
    (r) => r.status === null || r.status >= 400 || r.error
  );

  const latencies = successfulResults
    .map((r) => r.latency)
    .sort((a, b) => a - b);
  const totalRequests = results.length;
  const successfulRequests = successfulResults.length;
  const failedRequests = failedResults.length;

  const stats: BenchmarkStats = {
    totalRequests: totalRequests,
    successfulRequests: successfulRequests,
    failedRequests: failedRequests,
    totalTimeSeconds: parseFloat(totalTimeSeconds.toFixed(2)),
    rps:
      totalRequests > 0 && totalTimeSeconds > 0
        ? parseFloat((totalRequests / totalTimeSeconds).toFixed(2))
        : 0,
    averageLatencyMs:
      latencies.length > 0
        ? parseFloat(
            (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)
          )
        : 0,
    minLatencyMs:
      latencies.length > 0 ? parseFloat(latencies[0].toFixed(2)) : 0,
    maxLatencyMs:
      latencies.length > 0
        ? parseFloat(latencies[latencies.length - 1].toFixed(2))
        : 0,
    p50LatencyMs:
      latencies.length > 0
        ? parseFloat(latencies[Math.floor(latencies.length * 0.5)].toFixed(2))
        : 0,
    p90LatencyMs:
      latencies.length > 0
        ? parseFloat(latencies[Math.floor(latencies.length * 0.9)].toFixed(2))
        : 0,
    p99LatencyMs:
      latencies.length > 0
        ? parseFloat(latencies[Math.floor(latencies.length * 0.99)].toFixed(2))
        : 0,
    latencyMs: latencies, // Keep raw sorted latencies if needed for JSON
    statusCodes: results.reduce((acc, r) => {
      const key = r.status ? String(r.status) : "Error";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
    errors: failedResults.reduce((acc, r) => {
      const key = r.error
        ? String(r.error).split("\n")[0]
        : r.status
        ? `Status ${r.status}`
        : "Unknown Error"; // Short error key
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };

  // --- Output Results ---
  if (json) {
    // Remove raw latencies from default JSON output for brevity
    const jsonOutput = { ...stats };
    delete jsonOutput.latencyMs;
    console.log(JSON.stringify(jsonOutput, null, 2));
  } else {
    console.log(chalk.bold("\nBenchmark Results:"));
    console.log(chalk.greenBright("--- Summary ---"));
    console.log(`  ${chalk.cyan("Total Requests:")}   ${stats.totalRequests}`);
    console.log(
      `  ${chalk.cyan("Successful:")}       ${stats.successfulRequests} (${(
        (stats.successfulRequests / stats.totalRequests) * 100 || 0
      ).toFixed(1)}%)`
    );
    console.log(
      `  ${chalk.cyan("Failed:")}           ${stats.failedRequests} (${(
        (stats.failedRequests / stats.totalRequests) * 100 || 0
      ).toFixed(1)}%)`
    );
    console.log(
      `  ${chalk.cyan("Time Taken:")}       ${stats.totalTimeSeconds}s`
    );
    console.log(
      `  ${chalk.cyan("Requests/sec:")}     ${chalk.bold(stats.rps)}`
    );

    console.log(chalk.greenBright("\n--- Latency (Successful Requests) ---"));
    if (latencies.length > 0) {
      console.log(
        `  ${chalk.cyan("Average:")}          ${stats.averageLatencyMs}ms`
      );
      console.log(
        `  ${chalk.cyan("Min:")}              ${stats.minLatencyMs}ms`
      );
      console.log(
        `  ${chalk.cyan("Max:")}              ${stats.maxLatencyMs}ms`
      );
      console.log(
        `  ${chalk.cyan("P50 (Median):")}     ${stats.p50LatencyMs}ms`
      );
      console.log(
        `  ${chalk.cyan("P90:")}              ${stats.p90LatencyMs}ms`
      );
      console.log(
        `  ${chalk.cyan("P99:")}              ${stats.p99LatencyMs}ms`
      );
    } else {
      console.log(
        chalk.yellow("  No successful requests to calculate latency.")
      );
    }

    console.log(chalk.greenBright("\n--- Status Code Distribution ---"));
    const sortedStatusCodes = Object.entries(stats.statusCodes).sort((a, b) =>
      a[0].localeCompare(b[0])
    );
    if (sortedStatusCodes.length > 0) {
      sortedStatusCodes.forEach(([code, count]) => {
        const color =
          code === "Error" || parseInt(code, 10) >= 400
            ? chalk.red
            : chalk.green;
        console.log(`  [${color(code)}]: ${count} requests`);
      });
    } else {
      console.log(chalk.yellow("  No requests completed."));
    }

    if (stats.failedRequests > 0) {
      console.log(chalk.redBright("\n--- Error Summary ---"));
      const sortedErrors = Object.entries(stats.errors).sort(
        (a, b) => b[1] - a[1]
      ); // Sort by count desc
      sortedErrors.forEach(([error, count]) => {
        console.log(`  ${chalk.red(error)}: ${count} occurrences`);
      });
    }
    console.log("\n"); // Add a final newline for cleaner terminal output
  }
}

// --- Entry Point ---
program.parse(process.argv);

// Handle cases where no arguments might be provided (commander shows help by default)
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
