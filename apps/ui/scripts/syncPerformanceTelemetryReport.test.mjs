import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

test('discovers sync performance logs from a mobile Maestro run manifest', async () => {
  const { discoverSyncPerformanceLogFiles, readSyncPerformanceLogs } = await loadReportModule();
  assert.equal(typeof discoverSyncPerformanceLogFiles, 'function');
  assert.equal(typeof readSyncPerformanceLogs, 'function');

  const runDir = await mkdtemp(join(tmpdir(), 'happier-sync-perf-run-'));
  await writeFile(
    join(runDir, 'manifest.json'),
    JSON.stringify({
      tool: 'maestro',
      artifacts: {
        androidLogcat: 'android-logcat.log',
        syncPerformanceLogs: ['android-logcat.log'],
      },
    }),
    'utf8',
  );
  await writeFile(
    join(runDir, 'android-logcat.log'),
    `05-04 13:00:00.000 1 1 I ReactNativeJS: [sync-perf] ${summary([{
      name: 'sync.sessions.snapshot.decryptDataKeys',
      count: 1,
      totalMs: 5,
      minMs: 5,
      maxMs: 5,
      slowCount: 0,
    }])}\n`,
    'utf8',
  );

  assert.deepEqual(discoverSyncPerformanceLogFiles([runDir]), [join(runDir, 'android-logcat.log')]);

  const logs = await readSyncPerformanceLogs([runDir]);
  assert.equal(logs.summaries.length, 1);
  assert.equal(logs.matchedLines, 1);
  assert.equal(logs.malformedLines, 0);
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

test('aggregates duration buckets and reports approximate p99 timing', async () => {
  const { summarizeSyncPerformanceSummaries } = await loadReportModule();

  const report = summarizeSyncPerformanceSummaries([{
    events: [{
      name: 'sync.crypto.worker.probe',
      count: 4,
      totalMs: 89,
      minMs: 3,
      maxMs: 65,
      p99Ms: 256,
      slowCount: 1,
      durationBuckets: { 4: 1, 16: 2, 256: 1 },
      fields: { items: 8 },
      fieldStats: { payloadBytes: { sum: 4096, min: 1024, max: 1024, last: 1024 } },
    }],
  }, {
    events: [{
      name: 'sync.crypto.worker.probe',
      count: 1,
      totalMs: 1025,
      minMs: 1025,
      maxMs: 1025,
      p99Ms: 4096,
      slowCount: 1,
      durationBuckets: { 4096: 1 },
      fields: { items: 2 },
      fieldStats: { payloadBytes: { sum: 2048, min: 2048, max: 2048, last: 2048 } },
    }],
  }]);

  assert.deepEqual(report.events[0], {
    name: 'sync.crypto.worker.probe',
    count: 5,
    totalMs: 1114,
    avgMs: 222.8,
    minMs: 3,
    maxMs: 1025,
    p50Ms: 16,
    p90Ms: 4096,
    p99Ms: 4096,
    slowCount: 2,
    durationBuckets: { 4: 1, 16: 2, 256: 1, 4096: 1 },
    fields: { items: 10 },
    fieldStats: { payloadBytes: { sum: 6144, min: 1024, max: 2048, last: 2048 } },
  });
});

test('classifies session performance metric coverage from known telemetry families', async () => {
  const { summarizeSyncPerformanceSummaries } = await loadReportModule();

  const report = summarizeSyncPerformanceSummaries([{
    events: [
      {
        name: 'sync.sessions.snapshot.applyRenderables',
        count: 1,
        totalMs: 5,
        minMs: 5,
        maxMs: 5,
        slowCount: 0,
      },
      {
        name: 'sync.sessions.snapshot.backgroundHydration',
        count: 1,
        totalMs: 20,
        minMs: 20,
        maxMs: 20,
        slowCount: 1,
      },
      {
        name: 'sync.store.sessions.renderables.replace',
        count: 1,
        totalMs: 0,
        minMs: 0,
        maxMs: 0,
        slowCount: 0,
        fields: { staleMetadataPreserved: 2, stalePendingFlagsPreserved: 1 },
      },
      {
        name: 'sync.sessions.snapshot.decryptDataKeys',
        count: 1,
        totalMs: 40,
        minMs: 40,
        maxMs: 40,
        slowCount: 1,
      },
      {
        name: 'sync.crypto.worker.queueWaitMs',
        count: 3,
        totalMs: 9,
        minMs: 1,
        maxMs: 5,
        slowCount: 0,
      },
      {
        name: 'sync.runtime.jsThreadLag.summary',
        count: 1,
        totalMs: 0,
        minMs: 0,
        maxMs: 0,
        slowCount: 0,
        fields: { p99Ms: 55, maxMs: 80 },
      },
      {
        name: 'sync.store.sessions.apply',
        count: 2,
        totalMs: 18,
        minMs: 8,
        maxMs: 10,
        slowCount: 0,
      },
      {
        name: 'sync.store.sessions.apply.listRebuild',
        count: 1,
        totalMs: 7,
        minMs: 7,
        maxMs: 7,
        slowCount: 0,
      },
      {
        name: 'sync.sessions.list.visible.compute',
        count: 2,
        totalMs: 2,
        minMs: 1,
        maxMs: 1,
        slowCount: 0,
      },
      {
        name: 'sync.sessions.messages.request',
        count: 1,
        totalMs: 30,
        minMs: 30,
        maxMs: 30,
        slowCount: 1,
        fields: { initial: 1 },
      },
      {
        name: 'sync.sessions.socket.transcriptStreamSegment',
        count: 1,
        totalMs: 3,
        minMs: 3,
        maxMs: 3,
        slowCount: 0,
      },
    ],
  }]);

  assert.ok(Array.isArray(report.metricCoverage), 'report should include metric coverage entries');
  const coverageById = new Map(report.metricCoverage.map((item) => [item.id, item]));

  assert.equal(coverageById.get('dataKeyDecrypt')?.status, 'covered');
  assert.equal(coverageById.get('nativeWorkerQueueWait')?.status, 'covered');
  assert.equal(coverageById.get('storeApply')?.status, 'covered');
  assert.equal(coverageById.get('visibleListCompute')?.status, 'covered');
  assert.equal(coverageById.get('firstUsableList')?.status, 'partial');
  assert.equal(coverageById.get('fullyHydratedList')?.status, 'partial');
  assert.equal(coverageById.get('rowSkeletonStalePreservation')?.status, 'partial');
  assert.equal(coverageById.get('sessionOpen')?.status, 'partial');
  assert.equal(coverageById.get('streamingVisibleUpdate')?.status, 'partial');
  assert.deepEqual(
    coverageById.get('firstUsableList')?.events.map((event) => event.name),
    ['sync.sessions.snapshot.applyRenderables', 'sync.store.sessions.renderables.replace'],
  );
  assert.deepEqual(
    coverageById.get('rowSkeletonStalePreservation')?.missingEvents,
    ['sync.sessions.list.identitySkeleton'],
  );
});
