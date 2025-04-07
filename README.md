# bunmark ⚡

A blazing fast, minimalist API benchmarking tool powered by [Bun](https://bun.sh).

Designed for quick and easy performance testing of your HTTP endpoints directly from the terminal, with a clean, modern output.

## Features

- 🚀 **Fast:** Built on Bun for exceptional performance.
- ⏱️ **Flexible Benchmarking:** Run tests based on request count (`-n`) or duration (`-t`).
- 🔄 **Concurrency Control:** Easily set the number of concurrent requests (`-c`).
- 🛠️ **Full HTTP Support:** Specify methods (`-X`), headers (`-H`), query parameters (`-q`), and request bodies (`-d`, including reading from files with `@`).
- 🎨 **Modern Output:** Displays results in a visually appealing, colorized format in the terminal (uses `chalk` and `ora`).
- 🔁 **Interactive Progress:** Shows a spinner while the benchmark is running.
- 💾 **JSON Output:** Option to get results in JSON format (`--json`) for programmatic use.

## Requirements

- **Bun:** Version 1.0 or later recommended. [Installation Guide](https://bun.sh/docs/installation)

## Installation

### Globally (Recommended once published):

```bash
bun add -g bunmark
```

### From Source (for development):

```bash
git clone https://github.com/bernabedev/bunmark.git
cd bunmark
bun install
chmod +x index.ts   # Ensure the script is executable
bun link            # Make the 'bunmark' command available system-wide
```

## Usage

```bash
bunmark [options] <url>
```

### Arguments:

- `<url>`: (Required) The URL of the API endpoint to benchmark.

### Options:

| Option                | Alias | Description                                                      | Default   |
| --------------------- | ----- | ---------------------------------------------------------------- | --------- |
| `--method <method>`   | `-X`  | HTTP method                                                      | GET       |
| `--header <header>`   | `-H`  | Add request header (use multiple times) (e.g., "Auth: Bearer")   | []        |
| `--data <data>`       | `-d`  | HTTP request body (use @filename to read from file)              | undefined |
| `--query <query>`     | `-q`  | Add query parameter (use multiple times) (e.g., "key=value")     | []        |
| `--requests <num>`    | `-n`  | Total number of requests to run (conflicts with -t)              | 100       |
| `--duration <secs>`   | `-t`  | Duration of benchmark in seconds (e.g., 10s) (conflicts with -n) | 10        |
| `--concurrency <num>` | `-c`  | Number of concurrent requests                                    | 50        |
| `--json`              |       | Output results in JSON format                                    | false     |
| `--help`              | `-h`  | Display help information                                         |           |
| `--version`           | `-v`  | Display version number                                           |           |

## Examples

```bash
# Simple GET benchmark (100 requests, 50 concurrent)
bunmark https://httpbin.org/get

# Benchmark with 1000 requests and 100 concurrency
bunmark -n 1000 -c 100 https://api.example.com/users

# Benchmark POST with JSON body for 30 seconds
bunmark -X POST -H "Content-Type: application/json" -d '{"name":"test"}' -t 30s https://httpbin.org/post

# Read body from file and add query params
echo '{"id": 123, "value": "update"}' > payload.json
bunmark -X PUT -d @payload.json -q "user=admin" -H "X-API-Key: secret" https://api.example.com/items/123

# Get JSON output only
bunmark --json https://httpbin.org/get
```

## Example Output

```bash
Benckmarking GET https://httpbin.org/delay/1 with 50 concurrency... ✓ Benchmark finished in 3.15s

Benchmark Results:
--- Summary ---
  Total Requests:    100
  Successful:        100 (100.0%)
  Failed:            0 (0.0%)
  Reqs/sec:          31.75

--- Latency (Successful Requests) ---
  Average:           1565.81ms
  Min:               1042.12ms
  Max:               2105.55ms
  P50 (Median):      1550.30ms
  P90:               2051.80ms
  P99:               2100.15ms

--- Status Code Distribution ---
  [200]: 100 requests
```

## License

[MIT](LICENSE.md)
