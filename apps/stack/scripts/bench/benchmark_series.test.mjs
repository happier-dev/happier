import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { runBenchmarkSeries } from './benchmark_series.mjs';

test('runBenchmarkSeries excludes warmups, reuses one manifest, and writes aggregate percentiles', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-bench-series-' });
  const durations = [999, 10, 20, 30, 40, 50];
  let manifestCount = 0;
  const calls = [];

  const result = await runBenchmarkSeries({
    command: 'fixture-command',
    args: ['secret-arg'],
    cwd: fixture.root,
    label: 'series-check',
    outputDir: fixture.path('results'),
    warmupCount: 1,
    repeatCount: 5,
    boundary: {
      collectManifest: async () => {
        manifestCount += 1;
        return { schemaVersion: 1, platform: { os: 'test' } };
      },
      runCommand: async (options) => {
        calls.push(options);
        const durationMs = durations[calls.length - 1];
        return {
          summary: {
            schemaVersion: 1,
            label: options.label,
            durationMs,
            outcome: { exitCode: 0, signal: null, spawnErrorCode: null },
            metrics: {
              peakRssBytes: durationMs * 100,
              averageCpuPercent: durationMs,
              maxHostRunQueue: durationMs / 10,
              minHostAvailableMemoryBytes: durationMs * 1_000,
              maxSwapUsedBytes: durationMs * 2_000,
              swapInPagesDelta: durationMs * 3,
              maxHostMemoryPsiAvg10: durationMs / 100,
              responsiveness: {
                shellSpawnLatencyMs: { p95: durationMs + 1 },
                filesystemLatencyMs: { p95: durationMs + 2 },
              },
            },
          },
        };
      },
    },
  });

  assert.equal(manifestCount, 1);
  assert.equal(calls.length, 6);
  assert.equal(result.aggregate.samples, 5);
  assert.equal(result.aggregate.durationMs.p50, 30);
  assert.equal(result.aggregate.durationMs.p95, 50);
  assert.equal(result.aggregate.durationMs.p99, 50);
  assert.equal(result.aggregate.peakRssBytes.max, 5000);
  assert.equal(result.aggregate.maxHostRunQueue.p95, 5);
  assert.equal(result.aggregate.minHostAvailableMemoryBytes.min, 10_000);
  assert.equal(result.aggregate.maxSwapUsedBytes.max, 100_000);
  assert.equal(result.aggregate.swapInPagesDelta.p50, 90);
  assert.equal(result.aggregate.maxHostMemoryPsiAvg10.p99, 0.5);
  assert.equal(result.aggregate.shellSpawnLatencyP95Ms.p95, 51);
  assert.equal(calls[0].manifest.platform.os, 'test');
  assert.match(await readFile(fixture.path('results', 'aggregate.csv'), 'utf8'), /^metric,min,p50,p95,p99,max,mean/m);
  assert.doesNotMatch(await readFile(fixture.path('results', 'aggregate.json'), 'utf8'), /secret-arg/);
  const humanSummary = await readFile(fixture.path('results', 'summary.md'), 'utf8');
  assert.match(humanSummary, /series-check/);
  assert.match(humanSummary, /Duration.*p50.*30\.0 ms/i);
  assert.doesNotMatch(humanSummary, /secret-arg/);
});

test('runBenchmarkSeries measures one parent process tree for identical concurrent commands', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-bench-concurrent-series-' });
  const calls = [];
  const result = await runBenchmarkSeries({
    command: 'fixture-command',
    args: ['work'],
    cwd: fixture.root,
    outputDir: fixture.path('results'),
    repeatCount: 2,
    concurrency: 2,
    boundary: {
      collectManifest: async () => ({ schemaVersion: 1, platform: { os: 'test' } }),
      runCommand: async (options) => {
        calls.push(options);
        return {
          summary: {
            durationMs: calls.length * 1_000,
            outcome: { exitCode: 0 },
            metrics: {},
          },
        };
      },
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, process.execPath);
  assert.match(calls[0].args[0], /concurrent_command\.mjs$/);
  assert.deepEqual(calls[0].args.slice(1), ['--count=2', '--', 'fixture-command', 'work']);
  assert.equal(result.aggregate.concurrency, 2);
  assert.equal(result.aggregate.commandsPerMinute.p50, 60);
  assert.equal(result.aggregate.commandsPerMinute.p95, 120);
  assert.equal(result.aggregate.commandsPerMinute.min, 60);
});
