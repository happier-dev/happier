import './utils/env/env.mjs';

import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import { runBenchmarkSeries } from './bench/benchmark_series.mjs';
import { listBenchmarkWorkloads, resolveBenchmarkWorkloadInvocation } from './bench/workload_catalog.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getHappyStacksHomeDir } from './utils/paths/paths.mjs';

function flagValue(argv, name) {
  const prefix = `${name}=`;
  const inline = argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.indexOf(name);
  if (index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith('--')) return argv[index + 1];
  return '';
}

function positiveNumberFlag(argv, name, fallback) {
  const raw = flagValue(argv, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function integerFlag(argv, name, fallback, { minimum }) {
  const raw = flagValue(argv, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

function defaultOutputDir(env) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomUUID().slice(0, 8);
  return join(getHappyStacksHomeDir(env), 'benchmarks', 'linux-agent-execution-fabric', `${timestamp}-${suffix}`);
}

function usage(json) {
  printResult({
    json,
    data: {
      commands: ['catalog', 'run'],
      usage: 'hstack tools bench catalog | hstack tools bench run [--concurrency=1] [--workload=ID | -- COMMAND [ARG...]]',
    },
    text: [
      '[bench] usage:',
      '  hstack tools bench catalog [--json]',
      '  hstack tools bench run --workload=ID [--concurrency=1] [--output-dir=PATH] [--label=NAME] [--warmup=N] [--repeat=N] [--json]',
      '  hstack tools bench run [--output-dir=PATH] [--label=NAME] [--warmup=0] [--repeat=5] [--sample-interval-ms=500] [--json] -- COMMAND [ARG...]',
      '',
      'Artifacts: manifest.json, events.jsonl, summary.json, summary.csv',
      'Raw command arguments and environment values are not written to benchmark artifacts.',
    ].join('\n'),
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const json = wantsJson(argv);
  const commandName = argv.find((arg) => !arg.startsWith('-')) ?? '';
  if (wantsHelp(argv) || !commandName || commandName === 'help') {
    usage(json);
    return;
  }
  if (commandName === 'catalog') {
    const workloads = listBenchmarkWorkloads();
    printResult({
      json,
      data: { workloads },
      text: workloads.map((workload) => `${workload.id}\t${workload.sourceRequirement}\t${workload.description}`).join('\n'),
    });
    return;
  }
  if (commandName !== 'run') throw new Error(`[bench] unknown command: ${commandName}`);
  const separator = argv.indexOf('--');
  const workloadId = flagValue(argv, '--workload').trim();
  if (workloadId && separator >= 0) {
    throw new Error('[bench] run accepts either --workload=ID or -- COMMAND [ARG...], not both');
  }
  if (!workloadId && (separator < 0 || separator === argv.length - 1)) {
    throw new Error('[bench] run requires --workload=ID or -- COMMAND [ARG...]');
  }
  const workloadInvocation = workloadId
    ? resolveBenchmarkWorkloadInvocation(workloadId, { rootDir: process.cwd() })
    : null;
  const workload = workloadInvocation?.workload ?? null;
  const [command, ...args] = workloadInvocation
    ? [workloadInvocation.command, ...workloadInvocation.args]
    : argv.slice(separator + 1);
  const optionArgs = separator >= 0 ? argv.slice(0, separator) : argv;
  const outputRaw = flagValue(optionArgs, '--output-dir');
  const outputDir = resolve(outputRaw || defaultOutputDir(process.env));
  const label = flagValue(optionArgs, '--label').trim() || workload?.id || 'benchmark';
  const sampleIntervalMs = positiveNumberFlag(optionArgs, '--sample-interval-ms', 500);
  const warmupCount = integerFlag(optionArgs, '--warmup', workload?.warmupCount ?? 0, { minimum: 0 });
  const repeatCount = integerFlag(optionArgs, '--repeat', workload?.repeatCount ?? 5, { minimum: 1 });
  const concurrency = integerFlag(optionArgs, '--concurrency', 1, { minimum: 1 });
  if (concurrency > 64) throw new Error('--concurrency must be an integer <= 64');
  const result = await runBenchmarkSeries({
    command,
    args,
    cwd: workloadInvocation?.cwd ?? process.cwd(),
    env: process.env,
    label,
    outputDir,
    sampleIntervalMs,
    warmupCount,
    repeatCount,
    concurrency,
    silent: json,
  });
  printResult({
    json,
    data: { outputDir, aggregate: result.aggregate },
    text: [
      `[bench] ${result.aggregate.label}: ${result.aggregate.samples} measured run(s)`,
      `[bench] duration p50=${result.aggregate.durationMs.p50?.toFixed(1) ?? 'n/a'} ms p95=${result.aggregate.durationMs.p95?.toFixed(1) ?? 'n/a'} ms`,
      `[bench] artifacts: ${outputDir}`,
    ].join('\n'),
  });
}

main().catch((error) => {
  process.stderr.write(`[bench] failed: ${String(error?.message ?? error)}\n`);
  process.exitCode = 1;
});
