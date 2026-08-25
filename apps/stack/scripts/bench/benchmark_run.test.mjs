import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { runBenchmarkCommand } from './benchmark_run.mjs';

test('runBenchmarkCommand records sampled command metrics and machine-readable artifacts without raw arguments', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-bench-run-' });
  let completed = false;
  let finishCommand;
  const completion = new Promise((resolve) => {
    finishCommand = () => {
      completed = true;
      resolve({ code: 0, signal: null });
    };
  });
  const result = await runBenchmarkCommand({
    command: 'tool-with-secret',
    args: ['--token=do-not-persist', 'work'],
    cwd: fixture.root,
    label: 'sample-check',
    outputDir: fixture.path('results'),
    sampleIntervalMs: 10,
    boundary: {
      nowNs: (() => {
        let value = 1_000_000_000n;
        return () => {
          value += 100_000_000n;
          return value;
        };
      })(),
      startCommand: () => ({
        pid: 42,
        completion,
      }),
      sample: async () => ({
        process: { rssBytes: 1024, cpuPercent: 50, processCount: 2, threadCount: 4 },
        host: {
          loadAverage1m: 3,
          availableMemoryBytes: 4096,
          swapUsedBytes: 0,
          responsiveness: { shellSpawnLatencyMs: 4, filesystemLatencyMs: 2 },
        },
      }),
      wait: async () => {
        if (!completed) finishCommand();
      },
      collectManifest: async () => ({ schemaVersion: 1, platform: { os: 'test' } }),
    },
  });

  assert.equal(result.summary.label, 'sample-check');
  assert.equal(result.summary.outcome.exitCode, 0);
  assert.equal(result.summary.metrics.peakRssBytes, 1024);
  assert.equal(result.summary.metrics.maxProcessCount, 2);
  assert.equal(result.summary.metrics.maxThreadCount, 4);
  assert.equal(result.summary.metrics.responsiveness.shellSpawnLatencyMs.p95, 4);
  assert.equal(result.summary.metrics.responsiveness.filesystemLatencyMs.p95, 2);
  assert.ok(result.summary.durationMs > 0);

  const eventsText = await readFile(fixture.path('results', 'events.jsonl'), 'utf8');
  const summaryText = await readFile(fixture.path('results', 'summary.json'), 'utf8');
  const manifest = JSON.parse(await readFile(fixture.path('results', 'manifest.json'), 'utf8'));
  const csv = await readFile(fixture.path('results', 'summary.csv'), 'utf8');

  assert.match(eventsText, /"type":"sample"/);
  assert.match(summaryText, /"commandFingerprint"/);
  assert.doesNotMatch(`${eventsText}\n${summaryText}`, /do-not-persist/);
  assert.deepEqual(manifest, { schemaVersion: 1, platform: { os: 'test' } });
  assert.match(csv, /^label,duration_ms,exit_code,signal,peak_rss_bytes/m);
});
