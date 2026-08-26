import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { collectEnvironmentManifest } from './environment_manifest.mjs';
import { runBenchmarkCommand } from './benchmark_run.mjs';

function defaultBoundary() {
  return {
    collectManifest: ({ cwd, env }) => collectEnvironmentManifest({ cwd, env }),
    runCommand: runBenchmarkCommand,
  };
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function distribution(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (sorted.length === 0) return { min: null, p50: null, p95: null, p99: null, max: null, mean: null };
  return {
    min: sorted[0],
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1),
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

function aggregateCsv(aggregate) {
  const rows = Object.entries(aggregate)
    .filter(([, value]) => value && typeof value === 'object' && 'p50' in value)
    .map(([metric, value]) => [metric, value.min, value.p50, value.p95, value.p99, value.max, value.mean].join(','));
  return `metric,min,p50,p95,p99,max,mean\n${rows.join('\n')}\n`;
}

function numberedDirectory(prefix, index) {
  return `${prefix}-${String(index + 1).padStart(3, '0')}`;
}

function formatMetric(value, suffix = '') {
  return Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : 'unavailable';
}

function humanSummary({ aggregate, manifest, warmupCount }) {
  return [
    `# Benchmark: ${aggregate.label}`,
    '',
    `- Environment: ${manifest.platform?.os ?? 'unknown'} ${manifest.platform?.arch ?? ''}`.trimEnd(),
    `- Measured runs: ${aggregate.samples}`,
    `- Warmup runs: ${warmupCount}`,
    `- Identical command concurrency: ${aggregate.concurrency}`,
    `- Throughput: p50 ${formatMetric(aggregate.commandsPerMinute.p50, ' commands/min')}; p95 ${formatMetric(aggregate.commandsPerMinute.p95, ' commands/min')}`,
    `- Duration: p50 ${formatMetric(aggregate.durationMs.p50, ' ms')}; p95 ${formatMetric(aggregate.durationMs.p95, ' ms')}; p99 ${formatMetric(aggregate.durationMs.p99, ' ms')}`,
    `- Peak RSS: p50 ${formatMetric(aggregate.peakRssBytes.p50, ' bytes')}; max ${formatMetric(aggregate.peakRssBytes.max, ' bytes')}`,
    `- Average CPU: p50 ${formatMetric(aggregate.averageCpuPercent.p50, '%')}; max ${formatMetric(aggregate.averageCpuPercent.max, '%')}`,
    `- Host run queue: p50 ${formatMetric(aggregate.maxHostRunQueue.p50)}; p95 ${formatMetric(aggregate.maxHostRunQueue.p95)}`,
    `- Host memory PSI avg10: p50 ${formatMetric(aggregate.maxHostMemoryPsiAvg10.p50, '%')}; max ${formatMetric(aggregate.maxHostMemoryPsiAvg10.max, '%')}`,
    `- Host responsiveness: shell p95 ${formatMetric(aggregate.shellSpawnLatencyP95Ms.p95, ' ms')}; filesystem p95 ${formatMetric(aggregate.filesystemLatencyP95Ms.p95, ' ms')}`,
    '',
    'This file is generated from aggregate.json. Raw command arguments and environment values are intentionally omitted.',
    '',
  ].join('\n');
}

const aggregateMetricSelectors = {
  peakRssBytes: (summary) => summary.metrics?.peakRssBytes,
  averageCpuPercent: (summary) => summary.metrics?.averageCpuPercent,
  maxProcessCount: (summary) => summary.metrics?.maxProcessCount,
  maxThreadCount: (summary) => summary.metrics?.maxThreadCount,
  maxHostLoadAverage1m: (summary) => summary.metrics?.maxHostLoadAverage1m,
  maxHostRunQueue: (summary) => summary.metrics?.maxHostRunQueue,
  minHostAvailableMemoryBytes: (summary) => summary.metrics?.minHostAvailableMemoryBytes,
  maxHostCompressedMemoryBytes: (summary) => summary.metrics?.maxHostCompressedMemoryBytes,
  minHostMemoryFreePercent: (summary) => summary.metrics?.minHostMemoryFreePercent,
  maxSwapUsedBytes: (summary) => summary.metrics?.maxSwapUsedBytes,
  swapInPagesDelta: (summary) => summary.metrics?.swapInPagesDelta,
  swapOutPagesDelta: (summary) => summary.metrics?.swapOutPagesDelta,
  contextSwitchesDelta: (summary) => summary.metrics?.contextSwitchesDelta,
  maxHostCpuPsiAvg10: (summary) => summary.metrics?.maxHostCpuPsiAvg10,
  maxHostMemoryPsiAvg10: (summary) => summary.metrics?.maxHostMemoryPsiAvg10,
  maxHostIoPsiAvg10: (summary) => summary.metrics?.maxHostIoPsiAvg10,
  maxHostThermalPressure: (summary) => summary.metrics?.maxHostThermalPressure,
  shellSpawnLatencyP95Ms: (summary) => summary.metrics?.responsiveness?.shellSpawnLatencyMs?.p95,
  filesystemLatencyP95Ms: (summary) => summary.metrics?.responsiveness?.filesystemLatencyMs?.p95,
};

function aggregateMetrics(summaries) {
  return Object.fromEntries(Object.entries(aggregateMetricSelectors).map(([name, select]) => [
    name,
    distribution(summaries.map(select)),
  ]));
}

export async function runBenchmarkSeries({
  command,
  args = [],
  cwd,
  env = process.env,
  label = 'benchmark',
  outputDir,
  warmupCount = 0,
  repeatCount = 5,
  concurrency = 1,
  sampleIntervalMs = 500,
  silent = false,
  boundary = defaultBoundary(),
} = {}) {
  if (!Number.isInteger(warmupCount) || warmupCount < 0) throw new Error('benchmark warmupCount must be a non-negative integer');
  if (!Number.isInteger(repeatCount) || repeatCount < 1) throw new Error('benchmark repeatCount must be a positive integer');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new Error('benchmark concurrency must be an integer between 1 and 64');
  }
  if (!outputDir) throw new Error('benchmark series outputDir is required');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const manifest = await boundary.collectManifest({ cwd, env });
  await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

  const execute = async (kind, index) => {
    const runLabel = `${label}:${kind}:${index + 1}`;
    const measuredCommand = concurrency === 1 ? command : process.execPath;
    const measuredArgs = concurrency === 1
      ? args
      : [new URL('./concurrent_command.mjs', import.meta.url).pathname, `--count=${concurrency}`, '--', command, ...args];
    return await boundary.runCommand({
      command: measuredCommand,
      args: measuredArgs,
      cwd,
      env,
      label: runLabel,
      outputDir: join(outputDir, numberedDirectory(kind, index)),
      sampleIntervalMs,
      silent,
      manifest,
    });
  };

  for (let index = 0; index < warmupCount; index += 1) {
    const result = await execute('warmup', index);
    if (result.summary.outcome.exitCode !== 0) throw new Error(`benchmark warmup ${index + 1} failed`);
  }

  const summaries = [];
  for (let index = 0; index < repeatCount; index += 1) {
    const result = await execute('run', index);
    summaries.push(result.summary);
    if (result.summary.outcome.exitCode !== 0) throw new Error(`benchmark run ${index + 1} failed`);
  }

  const aggregate = {
    schemaVersion: 1,
    label,
    samples: summaries.length,
    concurrency,
    durationMs: distribution(summaries.map((summary) => summary.durationMs)),
    commandsPerMinute: distribution(summaries.map((summary) => concurrency * 60_000 / summary.durationMs)),
    ...aggregateMetrics(summaries),
  };
  await Promise.all([
    writeFile(join(outputDir, 'aggregate.json'), `${JSON.stringify(aggregate, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(outputDir, 'aggregate.csv'), aggregateCsv(aggregate), { mode: 0o600 }),
    writeFile(join(outputDir, 'summary.md'), humanSummary({ aggregate, manifest, warmupCount }), { mode: 0o600 }),
  ]);
  return { manifest, summaries, aggregate, outputDir };
}
