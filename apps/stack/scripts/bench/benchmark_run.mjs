import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { spawnProc } from '../utils/proc/proc.mjs';
import { collectEnvironmentManifest } from './environment_manifest.mjs';
import { collectSystemMetrics } from './system_metrics.mjs';

function defaultBoundary() {
  return {
    nowNs: () => process.hrtime.bigint(),
    startCommand: ({ command, args, cwd, env, label, silent }) => {
      const child = spawnProc(`bench:${label}`, command, args, env, {
        cwd,
        persistOutput: false,
        silent,
      });
      return { pid: child.pid, completion: child.completion };
    },
    sample: ({ pid, cwd, env }) => collectSystemMetrics({ rootPid: pid, cwd, env }),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    collectManifest: ({ cwd, env }) => collectEnvironmentManifest({ cwd, env }),
  };
}

function finiteValues(samples, select) {
  return samples.map(select).filter((value) => Number.isFinite(value));
}

function maximum(values) {
  return values.length > 0 ? Math.max(...values) : null;
}

function average(values) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function latencyDistribution(samples, select) {
  const values = finiteValues(samples, select);
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: maximum(values),
  };
}

function summarize({ label, command, args, startedAtNs, endedAtNs, outcome, samples }) {
  const durationMs = Number(endedAtNs - startedAtNs) / 1_000_000;
  return {
    schemaVersion: 1,
    label,
    command: {
      executable: basename(command),
      argCount: args.length,
      commandFingerprint: createHash('sha256').update([command, ...args].join('\0')).digest('hex'),
    },
    durationMs,
    outcome: {
      exitCode: outcome.code ?? null,
      signal: outcome.signal ?? null,
      spawnErrorCode: outcome.error?.code ?? null,
    },
    metrics: {
      sampleCount: samples.length,
      peakRssBytes: maximum(finiteValues(samples, (sample) => sample.process?.rssBytes)),
      averageCpuPercent: average(finiteValues(samples, (sample) => sample.process?.cpuPercent)),
      maxProcessCount: maximum(finiteValues(samples, (sample) => sample.process?.processCount)),
      maxThreadCount: maximum(finiteValues(samples, (sample) => sample.process?.threadCount)),
      maxHostLoadAverage1m: maximum(finiteValues(samples, (sample) => sample.host?.loadAverage1m)),
      maxSwapUsedBytes: maximum(finiteValues(samples, (sample) => sample.host?.swapUsedBytes)),
      responsiveness: {
        shellSpawnLatencyMs: latencyDistribution(samples, (sample) => sample.host?.responsiveness?.shellSpawnLatencyMs),
        filesystemLatencyMs: latencyDistribution(samples, (sample) => sample.host?.responsiveness?.filesystemLatencyMs),
      },
    },
  };
}

function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function summaryCsv(summary) {
  const headers = [
    'label', 'duration_ms', 'exit_code', 'signal', 'peak_rss_bytes', 'average_cpu_percent',
    'max_process_count', 'max_thread_count', 'max_host_load_1m', 'max_swap_used_bytes',
  ];
  const values = [
    summary.label,
    summary.durationMs,
    summary.outcome.exitCode,
    summary.outcome.signal,
    summary.metrics.peakRssBytes,
    summary.metrics.averageCpuPercent,
    summary.metrics.maxProcessCount,
    summary.metrics.maxThreadCount,
    summary.metrics.maxHostLoadAverage1m,
    summary.metrics.maxSwapUsedBytes,
  ];
  return `${headers.join(',')}\n${values.map(csvCell).join(',')}\n`;
}

async function writeArtifacts({ outputDir, manifest, events, summary }) {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(outputDir, 'events.jsonl'), `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, { mode: 0o600 }),
    writeFile(join(outputDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(outputDir, 'summary.csv'), summaryCsv(summary), { mode: 0o600 }),
  ]);
}

export async function runBenchmarkCommand({
  command,
  args = [],
  cwd,
  env = process.env,
  label = 'benchmark',
  outputDir,
  sampleIntervalMs = 500,
  silent = false,
  manifest: providedManifest = null,
  boundary = defaultBoundary(),
} = {}) {
  if (!command) throw new Error('benchmark command is required');
  if (!outputDir) throw new Error('benchmark outputDir is required');
  if (!Number.isFinite(sampleIntervalMs) || sampleIntervalMs < 1) {
    throw new Error('benchmark sampleIntervalMs must be a positive number');
  }

  const manifest = providedManifest ?? await boundary.collectManifest({ cwd, env });
  const startedAtNs = boundary.nowNs();
  const child = boundary.startCommand({ command, args, cwd, env, label, silent });
  const events = [{
    schemaVersion: 1,
    type: 'command_start',
    elapsedMs: 0,
    label,
    executable: basename(command),
    argCount: args.length,
  }];
  const samples = [];
  let settled = false;
  let outcome = null;
  let completedAtNs = null;
  const completion = Promise.resolve(child.completion).then((result) => {
    completedAtNs = boundary.nowNs();
    outcome = result;
    settled = true;
    return result;
  });

  while (!settled) {
    try {
      const sample = await boundary.sample({ pid: child.pid, cwd, env });
      if (!settled) {
        samples.push(sample);
        events.push({
          schemaVersion: 1,
          type: 'sample',
          elapsedMs: Number(boundary.nowNs() - startedAtNs) / 1_000_000,
          ...sample,
        });
      }
    } catch (error) {
      events.push({
        schemaVersion: 1,
        type: 'sample_error',
        elapsedMs: Number(boundary.nowNs() - startedAtNs) / 1_000_000,
        code: error?.code ?? null,
      });
    }
    if (!settled) await Promise.race([completion, boundary.wait(sampleIntervalMs)]);
  }
  await completion;
  const endedAtNs = completedAtNs ?? boundary.nowNs();
  const summary = summarize({ label, command, args, startedAtNs, endedAtNs, outcome, samples });
  events.push({
    schemaVersion: 1,
    type: 'command_finish',
    elapsedMs: summary.durationMs,
    outcome: summary.outcome,
  });
  await writeArtifacts({ outputDir, manifest, events, summary });
  return { manifest, events, summary, outputDir };
}
