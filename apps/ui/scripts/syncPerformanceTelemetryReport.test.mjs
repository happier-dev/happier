import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(scriptsDir, 'syncPerformanceTelemetryReport.mjs');

async function loadReportModule() {
  try {
    return await import(`file://${scriptPath}`);
  } catch (error) {
    assert.fail(`sync performance telemetry report module should load: ${error?.message ?? error}`);
  }
}

function summary(events) {
  return JSON.stringify({ events });
}

test('parses sync performance summaries from direct and native log lines', async () => {
  const { parseSyncPerformanceLog, summarizeSyncPerformanceSummaries } = await loadReportModule();
  const raw = [
    `[sync-perf] ${summary([{
      name: 'sync.sessions.snapshot.decryptDataKeys',
      count: 2,
      totalMs: 80,
      minMs: 30,
      maxMs: 50,
      slowCount: 2,
      fields: { items: 4 },
      fieldStats: { items: { sum: 4, min: 2, max: 2, last: 2 } },
    }])}`,
    `05-03 12:00:00.000 111 222 I ReactNativeJS: [sync-perf] ${summary([{
      name: 'sync.sessions.snapshot.decryptDataKeys',
      count: 1,
      totalMs: 10,
      minMs: 10,
      maxMs: 10,
      slowCount: 0,
      fields: { items: 1 },
      fieldStats: { items: { sum: 1, min: 1, max: 1, last: 1 } },
    }])}`,
    '[sync-perf] not-json',
  ].join('\n');

  const parsed = parseSyncPerformanceLog(raw);
  assert.equal(parsed.summaries.length, 2);
  assert.equal(parsed.malformedLines, 1);

  const report = summarizeSyncPerformanceSummaries(parsed.summaries);
  assert.equal(report.summaryCount, 2);
  assert.equal(report.events.length, 1);
  assert.deepEqual(report.events[0], {
    name: 'sync.sessions.snapshot.decryptDataKeys',
    count: 3,
    totalMs: 90,
    avgMs: 30,
    minMs: 10,
    maxMs: 50,
    slowCount: 2,
    fields: { items: 5 },
    fieldStats: { items: { sum: 5, min: 1, max: 2, last: 1 } },
  });
});

test('computes before and after deltas by event name', async () => {
  const { summarizeSyncPerformanceSummaries, compareSyncPerformanceReports } = await loadReportModule();

  const baseline = summarizeSyncPerformanceSummaries([{
    events: [{
      name: 'sync.sessions.snapshot.decryptDataKeys',
      count: 2,
      totalMs: 200,
      minMs: 80,
      maxMs: 120,
      slowCount: 2,
      fields: {},
      fieldStats: {},
    }],
  }]);
  const candidate = summarizeSyncPerformanceSummaries([{
    events: [{
      name: 'sync.sessions.snapshot.decryptDataKeys',
      count: 2,
      totalMs: 70,
      minMs: 30,
      maxMs: 40,
      slowCount: 1,
      fields: {},
      fieldStats: {},
    }],
  }]);

  const comparison = compareSyncPerformanceReports({ baseline, candidate });

  assert.equal(comparison.events.length, 1);
  assert.deepEqual(comparison.events[0], {
    name: 'sync.sessions.snapshot.decryptDataKeys',
    baseline: { count: 2, totalMs: 200, avgMs: 100, maxMs: 120, slowCount: 2 },
    candidate: { count: 2, totalMs: 70, avgMs: 35, maxMs: 40, slowCount: 1 },
    delta: { count: 0, totalMs: -130, avgMs: -65, maxMs: -80, slowCount: -1 },
  });
});
