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
            metrics: { peakRssBytes: durationMs * 100, averageCpuPercent: durationMs },
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
  assert.equal(calls[0].manifest.platform.os, 'test');
  assert.match(await readFile(fixture.path('results', 'aggregate.csv'), 'utf8'), /^metric,min,p50,p95,p99,max,mean/m);
  assert.doesNotMatch(await readFile(fixture.path('results', 'aggregate.json'), 'utf8'), /secret-arg/);
  const humanSummary = await readFile(fixture.path('results', 'summary.md'), 'utf8');
  assert.match(humanSummary, /series-check/);
  assert.match(humanSummary, /Duration.*p50.*30\.0 ms/i);
  assert.doesNotMatch(humanSummary, /secret-arg/);
});
