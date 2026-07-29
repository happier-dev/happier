# Terminal Bench

Local TERM fixture runner for byte/base64 terminal workloads. The scripts produce local artifacts only; do not commit generated reports.

Run every repo-owned terminal workload through bounded base64 frames:

```bash
node scripts/terminal-bench/run.mjs --out .project/logs/terminal-bench/local.json
```

Run a smaller workload subset:

```bash
node scripts/terminal-bench/run.mjs --workload ansi-burst --workload long-scrollback --repeat 3 --frame-bytes 8192 --out .project/logs/terminal-bench/subset.json
```

Print a concise summary for a generated report:

```bash
node scripts/terminal-bench/report.mjs .project/logs/terminal-bench/local.json
```

Compare a baseline and candidate report with regression gates:

```bash
node scripts/terminal-bench/report.mjs --compare .project/logs/terminal-bench/baseline.json .project/logs/terminal-bench/candidate.json --min-throughput-ratio 0.75 --max-additional-loss-events 0
```

Cleanup fences are available from `packages/tests/src/testkit/terminal/cleanupFence.ts`; they intentionally scope checks to terminal-owned paths instead of a repo-wide `data: string` search.

Windows/ConPTY byte-stream support is represented by structured diagnostics in `packages/tests/src/testkit/terminal/windows.ts`: Windows stays legacy-only unless a real raw-Buffer output and checksum match are proven.
