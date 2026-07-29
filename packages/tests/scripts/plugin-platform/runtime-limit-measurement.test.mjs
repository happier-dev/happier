import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RA21_MEASUREMENT_ARTIFACT_NAME,
  createRuntimeLimitMeasurementCapture,
  createRuntimeLimitMeasurementCaptureFromEnv,
  recordAgentBrowserPerfMeasurements,
  recordHostRuntimeLimitMeasurement,
  recordJsonlTraceMeasurements,
  recordWebMemoryProfileMeasurements,
} from './runtime-limit-measurement.mjs';

const PROVENANCE = Object.freeze({
  runId: 'run-2026-07-22-a',
  runnerId: 'agent-runtime-conformance',
  providerId: 'fixture-acp',
  scenarioId: 'ordered-burst',
  buildId: '877ee97a',
  platformId: 'linux-x64-node22',
});

test('RA21 capture aggregates boundary bytes, amplification, queue ordering, and host/UI costs', async () => {
  const artifactDir = await mkdtemp(join(tmpdir(), 'happier-ra21-measurement-'));
  try {
    const capture = createRuntimeLimitMeasurementCapture({ provenance: PROVENANCE });
    capture.recordEnvelope({
      direction: 'send',
      family: 'turn-prompt',
      decodedValue: { text: 'hello' },
      encodedValue: '{"method":"send","params":{"text":"hello"}}',
    });
    capture.recordEnvelope({
      direction: 'event',
      family: 'message-delta',
      decodedValue: { kind: 'message-delta', text: 'world' },
      encodedValue: new TextEncoder().encode('{"kind":"message-delta","text":"world","sequence":1}'),
    });
    capture.recordQueueSample({
      family: 'runtime-events',
      queuedItems: 2,
      queuedBytes: 120,
      backpressured: false,
      sequence: 40,
      expectedFirstSequence: 40,
      sequenceBasis: 'source',
    });
    capture.recordQueueSample({
      family: 'runtime-events',
      queuedItems: 5,
      queuedBytes: 480,
      backpressured: true,
      sequence: 41,
    });
    capture.finishQueueFamily({ family: 'runtime-events', expectedLastSequence: 41 });
    capture.recordPhaseSample({
      surface: 'host',
      phase: 'decode',
      family: 'message-delta',
      durationMs: 1.25,
      memoryBytes: 4096,
    });
    capture.recordPhaseSample({
      surface: 'ui',
      phase: 'stable-paint',
      family: 'transcript',
      durationMs: 8.5,
      memoryBytes: 8192,
      stallMs: 2.5,
    });

    const artifact = await capture.writeArtifact({ artifactDir });
    const saved = JSON.parse(await readFile(join(artifactDir, RA21_MEASUREMENT_ARTIFACT_NAME), 'utf8'));

    assert.deepEqual(saved, artifact);
    assert.equal(saved.schemaVersion, 1);
    assert.deepEqual(saved.provenance, PROVENANCE);
    assert.equal(saved.envelopes.send['turn-prompt'].samples, 1);
    assert.equal(saved.envelopes.send['turn-prompt'].decodedBytes.total, 16);
    assert.equal(saved.envelopes.send['turn-prompt'].encodedBytes.total, 43);
    assert.equal(saved.envelopes.send['turn-prompt'].amplification.max, 2.6875);
    assert.equal(Object.hasOwn(saved.envelopes.send['turn-prompt'], 'itemCount'), false);
    assert.deepEqual(saved.queues['runtime-events'], {
      observations: 2,
      highWaterItems: 5,
      highWaterBytes: 480,
      backpressureCount: 1,
      sequence: {
        basis: 'source',
        expectedFirst: 40,
        expectedLast: 41,
        first: 40,
        last: 41,
        observed: 2,
        missing: 0,
        duplicates: 0,
        outOfOrder: 0,
        observedOrderedNoLoss: true,
        orderedNoLoss: true,
      },
    });
    assert.deepEqual(saved.phases.host.decode['message-delta'], {
      samples: 1,
      durationMs: { total: 1.25, max: 1.25 },
      memoryBytes: { max: 4096 },
      stalls: { count: 0, totalMs: 0, maxMs: 0 },
    });
    assert.equal(saved.phases.ui['stable-paint'].transcript.stalls.count, 1);
    assert.equal(saved.phases.ui['stable-paint'].transcript.stalls.totalMs, 2.5);
    assert.equal((await stat(join(artifactDir, RA21_MEASUREMENT_ARTIFACT_NAME))).mode & 0o222, 0);
    await assert.rejects(
      capture.writeArtifact({ artifactDir }),
      /already finalized|already exists/i,
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test('RA21 capture stores no payloads or secret provenance and marks sequence loss', async () => {
  const secret = 'sk-live-should-never-be-retained';
  const capture = createRuntimeLimitMeasurementCapture({ provenance: PROVENANCE });
  capture.recordEnvelope({
    direction: 'event',
    family: 'tool-result',
    decodedValue: { token: secret, nested: { output: secret } },
    encodedValue: JSON.stringify({ token: secret, output: secret }),
  });
  capture.recordQueueSample({
    family: 'runtime-events',
    queuedItems: 1,
    queuedBytes: 64,
    sequence: 10,
    expectedFirstSequence: 10,
    sequenceBasis: 'source',
  });
  capture.recordQueueSample({
    family: 'runtime-events',
    queuedItems: 1,
    queuedBytes: 64,
    sequence: 12,
  });
  capture.finishQueueFamily({ family: 'runtime-events', expectedLastSequence: 13 });

  const serialized = JSON.stringify(capture.snapshot());
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.equal(capture.snapshot().queues['runtime-events'].sequence.missing, 2);
  assert.equal(capture.snapshot().queues['runtime-events'].sequence.orderedNoLoss, false);
  assert.throws(
    () => createRuntimeLimitMeasurementCapture({
      provenance: { ...PROVENANCE, buildId: `build-${secret}` },
    }),
    /bounded identifier/i,
  );
});

test('RA21 capture is opt-in, requires complete provenance, and bounds families and numbers', () => {
  assert.equal(createRuntimeLimitMeasurementCaptureFromEnv({ env: {}, runnerId: 'provider-runner', scenarioId: 'smoke' }), null);
  assert.throws(
    () => createRuntimeLimitMeasurementCaptureFromEnv({
      env: { HAPPIER_RA21_MEASUREMENT_DIR: '/tmp/ra21' },
      runnerId: 'provider-runner',
      scenarioId: 'smoke',
    }),
    /HAPPIER_RA21_RUN_ID/,
  );

  const capture = createRuntimeLimitMeasurementCapture({ provenance: PROVENANCE, maxFamilies: 2 });
  capture.recordEnvelope({ direction: 'event', family: 'one', decodedValue: {}, encodedValue: '{}' });
  capture.recordEnvelope({ direction: 'event', family: 'two', decodedValue: {}, encodedValue: '{}' });
  assert.throws(
    () => capture.recordEnvelope({ direction: 'event', family: 'three', decodedValue: {}, encodedValue: '{}' }),
    /family limit/i,
  );
  assert.throws(
    () => capture.recordPhaseSample({ surface: 'ui', phase: 'render', family: 'row', durationMs: Number.POSITIVE_INFINITY }),
    /finite non-negative/i,
  );
});

test('RA21 capture rejects metric and integer aggregation overflow without mutating prior state', () => {
  const phaseCapture = createRuntimeLimitMeasurementCapture({ provenance: PROVENANCE });
  phaseCapture.recordPhaseSample({
    surface: 'ui',
    phase: 'render',
    family: 'row',
    durationMs: 1,
    stallMs: 1,
  });
  const phaseBefore = phaseCapture.snapshot();
  assert.throws(
    () => phaseCapture.recordPhaseSample({
      surface: 'ui',
      phase: 'render',
      family: 'row',
      durationMs: Number.MAX_VALUE,
      stallMs: Number.MAX_VALUE,
    }),
    /safe numeric range|overflow/i,
  );
  assert.deepEqual(phaseCapture.snapshot(), phaseBefore);

  const byteCapture = createRuntimeLimitMeasurementCapture({ provenance: PROVENANCE });
  byteCapture.recordEnvelope({
    direction: 'event',
    family: 'large-event',
    decodedBytes: Number.MAX_SAFE_INTEGER,
    encodedBytes: Number.MAX_SAFE_INTEGER,
  });
  const bytesBefore = byteCapture.snapshot();
  assert.throws(
    () => byteCapture.recordEnvelope({
      direction: 'event',
      family: 'large-event',
      decodedBytes: 1,
      encodedBytes: 1,
    }),
    /safe integer range|overflow/i,
  );
  assert.deepEqual(byteCapture.snapshot(), bytesBefore);

  const countCapture = createRuntimeLimitMeasurementCapture({ provenance: PROVENANCE });
  countCapture.recordEnvelope({
    direction: 'event',
    family: 'large-item-count',
    decodedBytes: 1,
    encodedBytes: 1,
    itemCount: Number.MAX_SAFE_INTEGER,
  });
  const countBefore = countCapture.snapshot();
  assert.throws(
    () => countCapture.recordEnvelope({
      direction: 'event',
      family: 'large-item-count',
      decodedBytes: 1,
      encodedBytes: 1,
      itemCount: 1,
    }),
    /safe integer range|overflow/i,
  );
  assert.deepEqual(countCapture.snapshot(), countBefore);
});

test('RA21 JSONL adapter skips disabled work and scans trace bytes once when enabled', () => {
  const disabledEvents = new Proxy([], {
    get() {
      throw new Error('disabled measurement touched trace events');
    },
  });
  assert.doesNotThrow(() => recordJsonlTraceMeasurements(null, {
    traceRaw: '{"payload":{"type":"tool-call"}}\n',
    traceEvents: disabledEvents,
    get decodeDurationMs() {
      throw new Error('disabled measurement read decode timing');
    },
  }));

  const capture = createRuntimeLimitMeasurementCapture({ provenance: PROVENANCE });
  const traceEvents = [
    { payload: { type: 'tool-call', text: '💡' } },
    { payload: { type: 'tool-result', text: 'done' } },
  ];
  const traceRaw = `${traceEvents.map((event) => JSON.stringify(event)).join('\n')}\n`;
  const originalByteLength = Buffer.byteLength;
  let fullTraceByteScans = 0;
  Buffer.byteLength = function byteLength(value, ...args) {
    if (value === traceRaw) fullTraceByteScans += 1;
    return originalByteLength(value, ...args);
  };
  try {
    recordJsonlTraceMeasurements(capture, {
      traceRaw,
      traceEvents,
      decodeDurationMs: 2,
    });
  } finally {
    Buffer.byteLength = originalByteLength;
  }

  const snapshot = capture.snapshot();
  assert.equal(fullTraceByteScans, 1);
  assert.equal(snapshot.envelopes.event['tool-call'].samples, 1);
  assert.equal(snapshot.envelopes.event['tool-result'].samples, 1);
  assert.equal(snapshot.queues['tooltrace-decoded'].observations, 2);
  assert.equal(snapshot.queues['tooltrace-decoded'].highWaterBytes, originalByteLength(traceRaw));
  assert.equal(snapshot.queues['tooltrace-decoded'].sequence.observedOrderedNoLoss, true);
});

test('RA21 UI adapters retain only numeric timing, memory, render, projection, and stall summaries', () => {
  const secretUrl = 'https://example.test/session/secret-session-id';
  const capture = createRuntimeLimitMeasurementCapture({ provenance: PROVENANCE });
  recordAgentBrowserPerfMeasurements(capture, [{
    scenario: { id: 'desktop.session-view.streaming' },
    browserSummary: { durationMs: 20, maxLongTaskMs: 55, maxFrameGapMs: 30 },
    raw: { memory: { usedJSHeapSize: 12_000 }, url: secretUrl },
    syncTopEvents: [
      { name: 'sync.sessions.snapshot.responseJson', count: 2, totalMs: 4, maxMs: 3 },
      { name: 'sync.sessions.snapshot.applyRenderables', count: 1, totalMs: 6, maxMs: 6 },
      { name: 'sync.sessions.snapshot.firstUsableList', count: 1, totalMs: 8, maxMs: 8 },
      { name: 'ui.react.render.sessions.list.virtualized', count: 3, totalMs: 9, maxMs: 4 },
    ],
  }]);
  recordWebMemoryProfileMeasurements(capture, {
    samples: [{
      label: 'baseline-after-forced-gc',
      heapUsedSize: 10_000,
      listRenderCount: 2,
      listRenderTotalMs: 5,
      href: secretUrl,
    }],
  });

  const snapshot = capture.snapshot();
  assert.equal(snapshot.phases.ui.decode['desktop.session-view.streaming'].durationMs.total, 4);
  assert.equal(snapshot.phases.ui.projection['desktop.session-view.streaming'].durationMs.total, 6);
  assert.equal(snapshot.phases.ui['stable-paint']['desktop.session-view.streaming'].durationMs.total, 8);
  assert.equal(snapshot.phases.ui.render['desktop.session-view.streaming'].durationMs.total, 9);
  assert.equal(snapshot.phases.ui.scenario['desktop.session-view.streaming'].stalls.maxMs, 55);
  assert.equal(snapshot.phases.ui.memory['baseline-after-forced-gc'].memoryBytes.max, 10_000);
  assert.doesNotMatch(JSON.stringify(snapshot), /secret-session-id/);
});

test('RA21 host adapter retains presentation and work-state source/aggregate byte and item-count samples', () => {
  const capture = createRuntimeLimitMeasurementCapture({ provenance: PROVENANCE });
  recordHostRuntimeLimitMeasurement(capture, {
    family: 'current-session-presentation',
    decodedBytes: 410,
    itemCount: 3,
  });
  recordHostRuntimeLimitMeasurement(capture, {
    family: 'current-session-presentation',
    decodedBytes: 460,
    itemCount: 5,
  });
  recordHostRuntimeLimitMeasurement(capture, {
    family: 'native-work-state-source',
    decodedBytes: 240,
    itemCount: 7,
  });
  recordHostRuntimeLimitMeasurement(capture, {
    family: 'native-work-state-aggregate',
    decodedBytes: 980,
    itemCount: 9,
  });
  capture.recordEnvelope({
    direction: 'event',
    family: 'optional-item-count',
    decodedBytes: 20,
    encodedBytes: 20,
    itemCount: 4,
  });
  capture.recordEnvelope({
    direction: 'event',
    family: 'optional-item-count',
    decodedBytes: 30,
    encodedBytes: 30,
  });

  const event = capture.snapshot().envelopes.event;
  assert.deepEqual(event['current-session-presentation'].decodedBytes, {
    min: 410,
    max: 460,
    total: 870,
  });
  assert.deepEqual(event['current-session-presentation'].itemCount, {
    samples: 2,
    min: 3,
    max: 5,
    total: 8,
  });
  assert.deepEqual(event['native-work-state-source'].itemCount, {
    samples: 1,
    min: 7,
    max: 7,
    total: 7,
  });
  assert.deepEqual(event['native-work-state-aggregate'].itemCount, {
    samples: 1,
    min: 9,
    max: 9,
    total: 9,
  });
  assert.equal(event['optional-item-count'].samples, 2);
  assert.deepEqual(event['optional-item-count'].itemCount, {
    samples: 1,
    min: 4,
    max: 4,
    total: 4,
  });
});

test('RA21 UI adapter records presentation and work-state aggregate bytes and observed item-count stats without payloads', () => {
  const capture = createRuntimeLimitMeasurementCapture({ provenance: PROVENANCE });
  recordAgentBrowserPerfMeasurements(capture, [{
    scenario: { id: 'desktop.session-view.presentation-work-state' },
    syncTopEvents: [
      {
        name: 'ui.session.payload.consume.presentation',
        count: 2,
        totalMs: 0,
        maxMs: 0,
        fieldStats: {
          payloadBytes: { sum: 850, min: 410, max: 440, last: 440 },
          itemCount: { sum: 8, min: 3, max: 5, last: 5 },
        },
      },
      {
        name: 'ui.session.payload.consume.work-state',
        count: 3,
        totalMs: 0,
        maxMs: 0,
        fieldStats: {
          payloadBytes: { sum: 2_940, min: 900, max: 1_040, last: 1_000 },
          itemCount: { sum: 18, min: 4, max: 8, last: 6 },
        },
      },
    ],
  }]);

  const snapshot = capture.snapshot();
  const serialized = JSON.stringify(snapshot);
  assert.equal(snapshot.envelopes.event['presentation-ui-consumer'].decodedBytes.max, 440);
  assert.deepEqual(snapshot.envelopes.event['presentation-ui-consumer'].itemCount, {
    samples: 2,
    min: 3,
    max: 5,
    total: 8,
  });
  assert.equal(snapshot.envelopes.event['work-state-ui-consumer'].decodedBytes.max, 1_040);
  assert.deepEqual(snapshot.envelopes.event['work-state-ui-consumer'].itemCount, {
    samples: 3,
    min: 4,
    max: 8,
    total: 18,
  });
  assert.doesNotMatch(serialized, /ready|secret|payload.*text/i);

  const missingCounts = createRuntimeLimitMeasurementCapture({ provenance: PROVENANCE });
  recordAgentBrowserPerfMeasurements(missingCounts, [{
    scenario: { id: 'desktop.session-view.presentation-without-counts' },
    syncTopEvents: [{
      name: 'ui.session.payload.consume.presentation',
      count: 1,
      totalMs: 0,
      maxMs: 0,
      fieldStats: {
        payloadBytes: { sum: 200, min: 200, max: 200, last: 200 },
      },
    }],
  }]);
  assert.equal(
    Object.hasOwn(
      missingCounts.snapshot().envelopes.event['presentation-ui-consumer'],
      'itemCount',
    ),
    false,
  );
});
