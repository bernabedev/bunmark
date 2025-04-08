#!/usr/bin/env bun
import chalk from "chalk";
import { Command } from "commander";
import { existsSync } from "fs"; // Use fs.existsSync for sync check
import ora from "ora";
import { performance } from "perf_hooks";
import pkg from "../package.json";

// --- Interfaces ---

interface BenchmarkOptions {
  method: string;
  header: string[];
  data?: string;
  query: string[];
  requests?: string;
  duration?: string;
  concurrency: string;
  json: boolean;
}

interface RequestResult {
  status: number | null;
  latency: number; // in ms
  error?: string; // Store error message string
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
  latencyMs?: number[]; // Optional: Only included if needed later, maybe remove from default JSON
  statusCodes: Record<string, number>;
  errors: Record<string, number>;
}

// --- Commander Setup ---

const program = new Command();

program
  .name("bunmark")
  .description("A minimalist API benchmarking tool using Bun.")
  .version(pkg.version)
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
  .option(
    "-n, --requests <number>",
    "Number of requests to run (conflicts with -t)"
  )
  .option(
    "-t, --duration <seconds>",
    "Duration of the benchmark in seconds (e.g., 10 or 10s) (conflicts with -n)"
  )
  .option("-c, --concurrency <number>", "Number of concurrent requests", "50")
  .option("--json", "Output results in JSON format", false)
  .action(runBenchmark);

// --- Main Benchmark Logic ---

async function runBenchmark(url: string, options: BenchmarkOptions) {
  const {
    json,
    method,
    header: headerStrings,
    data: dataOption,
    query: queryStrings,
  } = options;
  const spinner = ora({
    text: "Preparing benchmark...",
    color: "yellow",
    discardStdin: false,
  });

  try {
    // --- Input Validation and Parsing ---
    let numRequests: number | undefined = undefined;
    let durationSeconds: number | undefined = undefined;
    const concurrency = parseInt(options.concurrency, 10);

    if (options.requests && options.duration) {
      throw new Error("Cannot use both -n/--requests and -t/--duration.");
    }
    if (options.requests) {
      numRequests = parseInt(options.requests, 10);
      if (isNaN(numRequests) || numRequests <= 0) {
        throw new Error("-n/--requests must be a positive number.");
      }
    } else if (options.duration) {
      const durationMatch = options.duration.match(/^(\d+)(s?)$/);
      if (
        !durationMatch ||
        isNaN(parseInt(durationMatch[1], 10)) ||
        parseInt(durationMatch[1], 10) <= 0
      ) {
        throw new Error(
          "-t/--duration must be a positive number (e.g., 10 or 10s)."
        );
      }
      durationSeconds = parseInt(durationMatch[1], 10);
    } else {
      // Default benchmark type if none specified
      numRequests = 100;
    }

    if (isNaN(concurrency) || concurrency <= 0) {
      throw new Error("-c/--concurrency must be a positive number.");
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
        // Warn non-interactively if not JSON mode
        if (!json)
          console.warn(
            chalk.yellow(`Warning: Ignoring malformed header: "${h}"`)
          );
      }
    }

    let body: BodyInit | undefined = undefined;
    if (dataOption) {
      if (dataOption.startsWith("@")) {
        const filePath = dataOption.substring(1);
        try {
          // Use sync exists check for simplicity before async read
          if (!existsSync(filePath)) {
            throw new Error(`Data file not found: ${filePath}`);
          }
          const file = Bun.file(filePath);
          body = await file.text();
          // Auto-detect Content-Type for JSON if not set by user
          if (!headers.has("Content-Type") && filePath.endsWith(".json")) {
            headers.set("Content-Type", "application/json");
          }
        } catch (err: any) {
          throw new Error(
            `Error reading data file "${filePath}": ${err.message}`
          );
        }
      } else {
        body = dataOption;
      }
      // Ensure Content-Type is set for POST/PUT if body exists and not already set
      if (
        (method === "POST" || method === "PUT") &&
        body &&
        !headers.has("Content-Type")
      ) {
        headers.set("Content-Type", "application/octet-stream"); // Default if not JSON/file
        if (!json)
          console.warn(
            chalk.yellow(
              `Warning: Auto-setting Content-Type to application/octet-stream for body data. Set explicitly with -H if needed.`
            )
          );
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
        if (!json)
          console.warn(
            chalk.yellow(`Warning: Ignoring malformed query param: "${q}"`)
          );
      }
    }
    const finalUrl = targetUrl.toString();

    // --- Setup Benchmark ---
    const results: RequestResult[] = [];
    let requestsSent = 0;
    let completedRequests = 0;
    let activeRequests = 0;
    const controller = new AbortController();
    const signal = controller.signal;

    if (!json) {
      let initialText = `Benchmarking ${chalk.cyan(method)} ${chalk.green(
        finalUrl
      )} with ${chalk.magenta(concurrency)} concurrency`;
      if (numRequests)
        initialText += ` (Target: ${chalk.blue(numRequests)} requests)`;
      if (durationSeconds)
        initialText += ` (Target: ${chalk.blue(durationSeconds)}s duration)`;
      spinner.text = initialText + "...";
      spinner.start();
    }

    const benchmarkStartTime = performance.now();
    let timeoutId: Timer | undefined = undefined;
    let spinnerUpdateInterval: Timer | undefined = undefined;

    if (durationSeconds) {
      timeoutId = setTimeout(() => {
        controller.abort("Duration limit reached"); // Provide reason for abort
      }, durationSeconds * 1000);
    }

    // Spinner Updater
    if (!json) {
      spinnerUpdateInterval = setInterval(() => {
        const elapsedSeconds = (
          (performance.now() - benchmarkStartTime) /
          1000
        ).toFixed(1);
        let progressText = "";
        if (numRequests) {
          progressText = ` | ${completedRequests}/${numRequests} requests`;
        } else if (durationSeconds) {
          progressText = ` | ${elapsedSeconds}s / ${durationSeconds}s`;
        } else {
          progressText = ` | ${completedRequests} requests completed`;
        }
        spinner.text = `Benchmarking ${chalk.cyan(method)} ${chalk.green(
          finalUrl
        )}...${progressText}`;
      }, 200);
    }

    // --- Run Benchmark ---
    const makeRequest = async (): Promise<void> => {
      const requestStartTime = performance.now();
      let status: number | null = null;
      let errorMsg: string | undefined = undefined;
      try {
        const response = await fetch(finalUrl, {
          method,
          headers,
          body,
          signal: signal, // Link fetch to the AbortController
        });
        status = response.status;
        await response.arrayBuffer(); // Consume body fully
        if (!response.ok) {
          // Capture non-2xx status as a logical error for reporting
          errorMsg = `Status ${status}`;
        }
      } catch (err: any) {
        status = null; // Indicate network or other fetch error
        if (err.name === "AbortError") {
          // Don't treat deliberate aborts as failures in stats, but record result
          errorMsg = "Request aborted";
        } else {
          errorMsg = err.message || String(err);
        }
      } finally {
        const requestEndTime = performance.now();
        results.push({
          status: status,
          latency: requestEndTime - requestStartTime,
          error: errorMsg,
          timestamp: requestEndTime,
        });
        activeRequests--;
        completedRequests++;
      }
    };

    const runner = async () => {
      const promises: Promise<void>[] = [];
      // Use a more robust loop that handles promises finishing
      let promiseQueue: Promise<void>[] = [];

      while (true) {
        // Stop conditions check first
        if (signal.aborted) break;
        if (numRequests && requestsSent >= numRequests) break;

        // Fill concurrency slots
        while (
          activeRequests < concurrency &&
          (!numRequests || requestsSent < numRequests) &&
          !signal.aborted
        ) {
          activeRequests++;
          requestsSent++;
          const requestPromise = makeRequest();
          promiseQueue.push(requestPromise);
          // Remove promise from queue once settled (regardless of outcome)
          requestPromise.finally(() => {
            promiseQueue = promiseQueue.filter((p) => p !== requestPromise);
          });
          // Small yield to prevent blocking, especially at high concurrency
          await Bun.sleep(0);
        }

        // If fully utilized or target met, wait for *any* promise to finish
        if (
          activeRequests >= concurrency ||
          (numRequests && requestsSent >= numRequests)
        ) {
          if (promiseQueue.length > 0) {
            await Promise.race(promiseQueue);
          } else {
            // Should not happen if activeRequests > 0, but safeguard
            await Bun.sleep(1);
          }
        } else if (
          !signal.aborted &&
          (!numRequests || requestsSent < numRequests)
        ) {
          // If not fully utilized but loop continues, brief pause
          await Bun.sleep(1);
        }
      }
      // Wait for all outstanding requests to finish after loop ends
      await Promise.allSettled(promises.concat(promiseQueue)); // Ensure all started promises are awaited
    };

    await runner(); // Execute the benchmark runner

    const benchmarkEndTime = performance.now();
    // Clean up timers and intervals
    if (timeoutId) clearTimeout(timeoutId);
    if (spinnerUpdateInterval) clearInterval(spinnerUpdateInterval);

    // --- Calculate Statistics ---
    const totalTimeSeconds = (benchmarkEndTime - benchmarkStartTime) / 1000;
    // Success = 2xx status code AND no fetch/abort error
    const successfulResults = results.filter(
      (r) =>
        r.status !== null &&
        r.status >= 200 &&
        r.status < 300 &&
        r.error !== "Request aborted"
    );
    // Failure = Fetch error OR non-2xx status code (excluding deliberate aborts)
    const failedResults = results.filter(
      (r) =>
        (r.status === null || r.status < 200 || r.status >= 300) &&
        r.error !== "Request aborted"
    );

    const latencies = successfulResults
      .map((r) => r.latency)
      .sort((a, b) => a - b);
    const totalRequestsCompleted = results.length; // All results collected
    const successfulRequests = successfulResults.length;
    const failedRequests = failedResults.length;

    const stats: BenchmarkStats = {
      totalRequests: totalRequestsCompleted,
      successfulRequests: successfulRequests,
      failedRequests: failedRequests,
      totalTimeSeconds: parseFloat(totalTimeSeconds.toFixed(2)),
      rps:
        totalRequestsCompleted > 0 && totalTimeSeconds > 0
          ? parseFloat((totalRequestsCompleted / totalTimeSeconds).toFixed(2))
          : 0,
      averageLatencyMs:
        latencies.length > 0
          ? parseFloat(
              (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(
                2
              )
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
          ? parseFloat(
              latencies[
                Math.max(0, Math.floor(latencies.length * 0.5) - 1)
              ].toFixed(2)
            )
          : 0, // Adjust index for 0-based
      p90LatencyMs:
        latencies.length > 0
          ? parseFloat(
              latencies[
                Math.max(0, Math.floor(latencies.length * 0.9) - 1)
              ].toFixed(2)
            )
          : 0,
      p99LatencyMs:
        latencies.length > 0
          ? parseFloat(
              latencies[
                Math.max(0, Math.floor(latencies.length * 0.99) - 1)
              ].toFixed(2)
            )
          : 0,
      // latencyMs: latencies, // Keep raw sorted latencies (optional)
      statusCodes: results.reduce((acc, r) => {
        // Group null status under 'Error' unless it was an abort
        const key = r.status
          ? String(r.status)
          : r.error === "Request aborted"
          ? "Aborted"
          : "Error";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
      errors: failedResults.reduce((acc, r) => {
        // Use the recorded error message, defaulting if somehow missing
        const key = r.error
          ? r.error.split("\n")[0]
          : r.status
          ? `Status ${r.status}`
          : "Unknown Error";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    };

    // --- Output Results ---
    if (json) {
      // Clean up stats for JSON output if desired (e.g., remove raw latencies)
      const jsonOutput = { ...stats };
      // delete jsonOutput.latencyMs;
      console.log(JSON.stringify(jsonOutput, null, 2));
    } else {
      if (spinner.isSpinning) {
        spinner.succeed(
          chalk.greenBright(`Benchmark finished in ${stats.totalTimeSeconds}s`)
        );
      } else {
        // If spinner wasn't started (e.g., immediate error), print basic finish message
        console.log(
          chalk.greenBright(`Benchmark finished in ${stats.totalTimeSeconds}s`)
        );
      }

      console.log(chalk.bold("\nBenchmark Results:"));
      console.log(chalk.greenBright("--- Summary ---"));
      const successRate =
        totalRequestsCompleted > 0
          ? (successfulRequests / totalRequestsCompleted) * 100
          : 0;
      const failureRate =
        totalRequestsCompleted > 0
          ? (failedRequests / totalRequestsCompleted) * 100
          : 0;

      console.log(
        `  ${chalk.cyan("Total Requests:")}   ${totalRequestsCompleted}`
      );
      console.log(
        `  ${chalk.cyan(
          "Successful:"
        )}       ${successfulRequests} (${successRate.toFixed(1)}%)`
      );
      console.log(
        `  ${chalk.cyan(
          "Failed:"
        )}           ${failedRequests} (${failureRate.toFixed(1)}%)`
      );
      console.log(
        `  ${chalk.cyan("Reqs/sec:")}         ${chalk.bold(stats.rps)}`
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
          chalk.yellow(
            "  No successful requests to calculate latency distribution."
          )
        );
      }

      console.log(chalk.greenBright("\n--- Status Code Distribution ---"));
      const sortedStatusCodes = Object.entries(stats.statusCodes).sort((a, b) =>
        a[0].localeCompare(b[0])
      );
      if (sortedStatusCodes.length > 0) {
        sortedStatusCodes.forEach(([code, count]) => {
          let color = chalk.gray; // Default for Aborted or unknown
          if (code === "Error") color = chalk.red;
          else if (code === "Aborted") color = chalk.yellow;
          else {
            const numericCode = parseInt(code, 10);
            if (!isNaN(numericCode)) {
              if (numericCode >= 200 && numericCode < 300) color = chalk.green;
              else if (numericCode >= 300 && numericCode < 400)
                color = chalk.blue;
              else if (numericCode >= 400 && numericCode < 500)
                color = chalk.yellow;
              else if (numericCode >= 500) color = chalk.red;
            }
          }
          console.log(`  [${color(code)}]: ${count} requests`);
        });
      } else {
        console.log(
          chalk.yellow(
            "  No requests completed or all were aborted before status could be read."
          )
        );
      }

      if (stats.failedRequests > 0) {
        console.log(
          chalk.redBright("\n--- Error Summary (Failed Requests) ---")
        );
        const sortedErrors = Object.entries(stats.errors).sort(
          (a, b) => b[1] - a[1]
        ); // Sort by count desc
        sortedErrors.forEach(([error, count]) => {
          console.log(`  ${chalk.red(error)}: ${count} occurrences`);
        });
      }
      console.log("\n"); // Final newline for clean prompt return
    }
  } catch (error: any) {
    if (!json) {
      // Ensure spinner stops on error, even during setup
      if (spinner.isSpinning) {
        spinner.fail(
          chalk.redBright("Benchmark failed during setup or execution.")
        );
      } else {
        // If spinner never started, just log the error
        console.error(chalk.redBright("\nBenchmark failed."));
      }
    }
    // Log the actual error message regardless of JSON mode
    console.error(chalk.red(`Error: ${error.message}`));
    // Optionally: console.error(error); // for stack trace during dev
    process.exit(1);
  } finally {
    // Final safety net to ensure spinner is stopped if something went wrong
    if (spinner.isSpinning) {
      spinner.stop();
    }
  }
}

// --- Entry Point ---
program.parse(process.argv);

// Show help if no arguments are provided (Commander default behavior might cover this, but explicit check is fine)
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
