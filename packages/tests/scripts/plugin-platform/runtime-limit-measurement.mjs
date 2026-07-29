import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const RA21_MEASUREMENT_ARTIFACT_NAME = 'ra21-runtime-limit-measurement.v1.json';

const DEFAULT_MAX_FAMILIES = 128;
const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const SECRET_LIKE_PATTERN = /(?:^|[-_.:])(?:sk[-_.:](?:live|proj|test)|ghp|github[-_.:]pat|bearer)(?:$|[-_.:])/iu;

function fail(message) {
  throw new Error(`RA21 measurement: ${message}`);
}

function boundedIdentifier(value, field) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!IDENTIFIER_PATTERN.test(normalized) || SECRET_LIKE_PATTERN.test(normalized)) {
    fail(`${field} must be a bounded identifier and must not contain secret-like material`);
  }
  return normalized;
}

function finiteNonNegative(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    fail(`${field} must be a finite non-negative number`);
  }
  return number;
}

function safeNonNegativeInteger(value, field) {
  const number = finiteNonNegative(value, field);
  if (!Number.isSafeInteger(number)) fail(`${field} must be a safe integer`);
  return number;
}

function safeMetricNumber(value, field) {
  const number = finiteNonNegative(value, field);
  if (number > Number.MAX_SAFE_INTEGER) {
    fail(`${field} exceeded the safe numeric range`);
  }
  return number;
}

function safeIntegerAdd(current, increment, field) {
  const next = safeNonNegativeInteger(current, `${field} current`)
    + safeNonNegativeInteger(increment, `${field} increment`);
  if (!Number.isSafeInteger(next)) fail(`${field} exceeded the safe integer range`);
  return next;
}

function round(value, field = 'metric') {
  const number = safeMetricNumber(value, field);
  const rounded = Math.round(number * 1_000_000) / 1_000_000;
  if (!Number.isFinite(rounded) || rounded > Number.MAX_SAFE_INTEGER) {
    fail(`${field} overflowed during rounding`);
  }
  return rounded;
}

function safeMetricAdd(current, increment, field) {
  const next = safeMetricNumber(current, `${field} current`)
    + safeMetricNumber(increment, `${field} increment`);
  if (!Number.isFinite(next) || next > Number.MAX_SAFE_INTEGER) {
    fail(`${field} exceeded the safe numeric range`);
  }
  return round(next, field);
}

function utf8Bytes(value, valueField, bytesField) {
  if (value !== undefined && valueField !== undefined) {
    fail(`provide ${valueField} or ${bytesField}, not both`);
  }
  if (valueField !== undefined) return safeNonNegativeInteger(valueField, bytesField);
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  fail(`${valueField} or ${bytesField} is required`);
}

function decodedJsonBytes(value, explicitBytes) {
  if (value !== undefined && explicitBytes !== undefined) {
    fail('provide decodedValue or decodedBytes, not both');
  }
  if (explicitBytes !== undefined) return safeNonNegativeInteger(explicitBytes, 'decodedBytes');
  if (value === undefined) fail('decodedValue or decodedBytes is required');
  const json = JSON.stringify(value);
  if (json === undefined) fail('decodedValue must be JSON serializable');
  return Buffer.byteLength(json, 'utf8');
}

function createByteStats() {
  return { min: null, max: 0, total: 0 };
}

function addByteSample(stats, bytes, field) {
  return {
    min: stats.min === null ? bytes : Math.min(stats.min, bytes),
    max: Math.max(stats.max, bytes),
    total: safeIntegerAdd(stats.total, bytes, field),
  };
}

function readItemCountStats(params) {
  if (params.itemCount !== undefined && params.itemCountStats !== undefined) {
    fail('provide itemCount or itemCountStats, not both');
  }
  if (params.itemCount !== undefined) {
    const itemCount = safeNonNegativeInteger(params.itemCount, 'itemCount');
    return { samples: 1, min: itemCount, max: itemCount, total: itemCount };
  }
  if (params.itemCountStats === undefined) return null;
  const samples = safeNonNegativeInteger(params.itemCountStats.samples, 'itemCountStats.samples');
  const min = safeNonNegativeInteger(params.itemCountStats.min, 'itemCountStats.min');
  const max = safeNonNegativeInteger(params.itemCountStats.max, 'itemCountStats.max');
  const total = safeNonNegativeInteger(params.itemCountStats.total, 'itemCountStats.total');
  if (samples < 1) fail('itemCountStats.samples must be at least one');
  if (min > max) fail('itemCountStats.min must not exceed itemCountStats.max');
  const remainingSamples = BigInt(samples - 1);
  const minimumTotal = (BigInt(min) * remainingSamples) + BigInt(max);
  const maximumTotal = (BigInt(max) * remainingSamples) + BigInt(min);
  if (BigInt(total) < minimumTotal || BigInt(total) > maximumTotal) {
    fail('itemCountStats.total must be consistent with samples, min, and max');
  }
  return { samples, min, max, total };
}

function addItemCountStats(current, incoming) {
  if (!current) return incoming;
  return {
    samples: safeIntegerAdd(current.samples, incoming.samples, 'item-count sample count'),
    min: Math.min(current.min, incoming.min),
    max: Math.max(current.max, incoming.max),
    total: safeIntegerAdd(current.total, incoming.total, 'aggregated item count'),
  };
}

function familyId(map, family, maxFamilies) {
  const id = boundedIdentifier(family, 'family');
  if (!map[id] && Object.keys(map).length >= maxFamilies) {
    fail(`family limit of ${maxFamilies} exceeded`);
  }
  return id;
}

function createQueueEntry() {
  return {
    observations: 0,
    highWaterItems: 0,
    highWaterBytes: 0,
    backpressureCount: 0,
    sequence: {
      basis: null,
      expectedFirst: null,
      expectedLast: null,
      first: null,
      last: null,
      observed: 0,
      missing: 0,
      duplicates: 0,
      outOfOrder: 0,
    },
  };
}

function cloneQueueEntry(queue) {
  return { ...queue, sequence: { ...queue.sequence } };
}

function createPhaseEntry() {
  return {
    samples: 0,
    durationMs: { total: 0, max: 0 },
    memoryBytes: { max: 0 },
    stalls: { count: 0, totalMs: 0, maxMs: 0 },
  };
}

function snapshotQueue(queue) {
  const hasExpectedBounds = Number.isSafeInteger(queue.sequence.expectedFirst)
    && Number.isSafeInteger(queue.sequence.expectedLast);
  const observedOrderedNoLoss = hasExpectedBounds
    && queue.sequence.observed > 0
    && queue.sequence.first === queue.sequence.expectedFirst
    && queue.sequence.last === queue.sequence.expectedLast
    && queue.sequence.missing === 0
    && queue.sequence.duplicates === 0
    && queue.sequence.outOfOrder === 0;
  return {
    observations: queue.observations,
    highWaterItems: queue.highWaterItems,
    highWaterBytes: queue.highWaterBytes,
    backpressureCount: queue.backpressureCount,
    sequence: {
      ...queue.sequence,
      observedOrderedNoLoss,
      orderedNoLoss: queue.sequence.basis === 'source' && observedOrderedNoLoss,
    },
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createRuntimeLimitMeasurementCapture(options) {
  const provenanceInput = options?.provenance ?? {};
  const provenance = Object.freeze({
    runId: boundedIdentifier(provenanceInput.runId, 'provenance.runId'),
    runnerId: boundedIdentifier(provenanceInput.runnerId, 'provenance.runnerId'),
    providerId: boundedIdentifier(provenanceInput.providerId, 'provenance.providerId'),
    scenarioId: boundedIdentifier(provenanceInput.scenarioId, 'provenance.scenarioId'),
    buildId: boundedIdentifier(provenanceInput.buildId, 'provenance.buildId'),
    platformId: boundedIdentifier(provenanceInput.platformId, 'provenance.platformId'),
  });
  const maxFamilies = safeNonNegativeInteger(
    options?.maxFamilies ?? DEFAULT_MAX_FAMILIES,
    'maxFamilies',
  );
  if (maxFamilies < 1) fail('maxFamilies must be at least one');

  const envelopes = { send: Object.create(null), event: Object.create(null) };
  const queues = Object.create(null);
  const phases = { host: Object.create(null), ui: Object.create(null) };
  let finalized = false;

  const snapshot = () => {
    const queueSnapshot = Object.fromEntries(
      Object.entries(queues).map(([family, queue]) => [family, snapshotQueue(queue)]),
    );
    return clone({
      schemaVersion: 1,
      kind: 'ra21-runtime-limit-measurement',
      provenance,
      envelopes,
      queues: queueSnapshot,
      phases,
    });
  };

  return Object.freeze({
    recordEnvelope(params) {
      if (finalized) fail('capture is already finalized');
      const direction = params?.direction;
      if (direction !== 'send' && direction !== 'event') fail('direction must be send or event');
      const decodedBytes = decodedJsonBytes(params.decodedValue, params.decodedBytes);
      const encodedBytes = utf8Bytes(
        params.encodedValue,
        params.encodedBytes,
        'encodedBytes',
      );
      const itemCount = readItemCountStats(params);
      const id = familyId(envelopes[direction], params.family, maxFamilies);
      const current = envelopes[direction][id] ?? {
        samples: 0,
        decodedBytes: createByteStats(),
        encodedBytes: createByteStats(),
        amplification: { min: null, max: 0, total: 0 },
      };
      const amplification = decodedBytes === 0
        ? 0
        : round(encodedBytes / decodedBytes, 'amplification');
      const next = {
        samples: safeIntegerAdd(current.samples, 1, 'envelope sample count'),
        decodedBytes: addByteSample(
          current.decodedBytes,
          decodedBytes,
          'aggregated decoded byte count',
        ),
        encodedBytes: addByteSample(
          current.encodedBytes,
          encodedBytes,
          'aggregated encoded byte count',
        ),
        amplification: {
          min: current.amplification.min === null
            ? amplification
            : Math.min(current.amplification.min, amplification),
          max: Math.max(current.amplification.max, amplification),
          total: safeMetricAdd(
            current.amplification.total,
            amplification,
            'aggregated amplification',
          ),
        },
        ...(itemCount
          ? { itemCount: addItemCountStats(current.itemCount, itemCount) }
          : current.itemCount
            ? { itemCount: current.itemCount }
            : {}),
      };
      envelopes[direction][id] = next;
    },

    recordQueueSample(params) {
      if (finalized) fail('capture is already finalized');
      const id = familyId(queues, params?.family, maxFamilies);
      const queuedItems = safeNonNegativeInteger(params.queuedItems, 'queuedItems');
      const queuedBytes = safeNonNegativeInteger(params.queuedBytes, 'queuedBytes');
      const expectedFirst = params.expectedFirstSequence === undefined
        ? undefined
        : safeNonNegativeInteger(params.expectedFirstSequence, 'expectedFirstSequence');
      const sequence = params.sequence === undefined
        ? undefined
        : safeNonNegativeInteger(params.sequence, 'sequence');
      if (
        params.sequenceBasis !== undefined
        && params.sequenceBasis !== 'source'
        && params.sequenceBasis !== 'observer'
      ) fail('sequenceBasis must be source or observer');

      const queue = cloneQueueEntry(queues[id] ?? createQueueEntry());
      queue.observations = safeIntegerAdd(queue.observations, 1, 'queue observation count');
      queue.highWaterItems = Math.max(queue.highWaterItems, queuedItems);
      queue.highWaterBytes = Math.max(queue.highWaterBytes, queuedBytes);
      if (params.backpressured === true) {
        queue.backpressureCount = safeIntegerAdd(
          queue.backpressureCount,
          1,
          'queue backpressure count',
        );
      }

      if (expectedFirst !== undefined) {
        if (
          queue.sequence.expectedFirst !== null
          && queue.sequence.expectedFirst !== expectedFirst
        ) fail('expectedFirstSequence changed for queue family');
        queue.sequence.expectedFirst = expectedFirst;
      }
      if (params.sequenceBasis !== undefined) {
        if (queue.sequence.basis !== null && queue.sequence.basis !== params.sequenceBasis) {
          fail('sequenceBasis changed for queue family');
        }
        queue.sequence.basis = params.sequenceBasis;
      }
      if (sequence !== undefined) {
        const previous = queue.sequence.last;
        if (queue.sequence.first === null) {
          queue.sequence.first = sequence;
          if (
            Number.isSafeInteger(queue.sequence.expectedFirst)
            && sequence > queue.sequence.expectedFirst
          ) {
            queue.sequence.missing = safeIntegerAdd(
              queue.sequence.missing,
              sequence - queue.sequence.expectedFirst,
              'queue missing sequence count',
            );
          }
        } else if (sequence === previous) {
          queue.sequence.duplicates = safeIntegerAdd(
            queue.sequence.duplicates,
            1,
            'queue duplicate sequence count',
          );
        } else if (sequence < previous) {
          queue.sequence.outOfOrder = safeIntegerAdd(
            queue.sequence.outOfOrder,
            1,
            'queue out-of-order sequence count',
          );
        } else if (sequence - previous > 1) {
          queue.sequence.missing = safeIntegerAdd(
            queue.sequence.missing,
            sequence - previous - 1,
            'queue missing sequence count',
          );
        }
        queue.sequence.last = sequence;
        queue.sequence.observed = safeIntegerAdd(
          queue.sequence.observed,
          1,
          'queue observed sequence count',
        );
      }
      queues[id] = queue;
    },

    finishQueueFamily(params) {
      if (finalized) fail('capture is already finalized');
      const family = boundedIdentifier(params?.family, 'family');
      const current = queues[family];
      if (!current) fail(`queue family ${family} has no observations`);
      const queue = cloneQueueEntry(current);
      const expectedLast = safeNonNegativeInteger(
        params.expectedLastSequence,
        'expectedLastSequence',
      );
      if (
        queue.sequence.expectedLast !== null
        && queue.sequence.expectedLast !== expectedLast
      ) fail('expectedLastSequence changed for queue family');
      queue.sequence.expectedLast = expectedLast;
      if (Number.isSafeInteger(queue.sequence.last) && expectedLast > queue.sequence.last) {
        queue.sequence.missing = safeIntegerAdd(
          queue.sequence.missing,
          expectedLast - queue.sequence.last,
          'queue missing sequence count',
        );
      }
      queues[family] = queue;
    },

    recordPhaseSample(params) {
      if (finalized) fail('capture is already finalized');
      const surface = params?.surface;
      if (surface !== 'host' && surface !== 'ui') fail('surface must be host or ui');
      const phase = boundedIdentifier(params.phase, 'phase');
      const family = boundedIdentifier(params.family, 'family');
      const durationMs = safeMetricNumber(params.durationMs, 'durationMs');
      const memoryBytes = params.memoryBytes === undefined
        ? 0
        : safeNonNegativeInteger(params.memoryBytes, 'memoryBytes');
      const stallMs = params.stallMs === undefined
        ? 0
        : safeMetricNumber(params.stallMs, 'stallMs');
      const phaseEntries = phases[surface][phase];
      if (!phaseEntries && Object.keys(phases[surface]).length >= maxFamilies) {
        fail(`phase family limit of ${maxFamilies} exceeded`);
      }
      if (phaseEntries && !phaseEntries[family] && Object.keys(phaseEntries).length >= maxFamilies) {
        fail(`family limit of ${maxFamilies} exceeded`);
      }
      const current = phaseEntries?.[family] ?? createPhaseEntry();
      const entry = {
        samples: safeIntegerAdd(current.samples, 1, 'phase sample count'),
        durationMs: {
          total: safeMetricAdd(current.durationMs.total, durationMs, 'phase duration total'),
          max: Math.max(current.durationMs.max, durationMs),
        },
        memoryBytes: { max: Math.max(current.memoryBytes.max, memoryBytes) },
        stalls: { ...current.stalls },
      };
      if (stallMs > 0) {
        entry.stalls.count = safeIntegerAdd(entry.stalls.count, 1, 'phase stall count');
        entry.stalls.totalMs = safeMetricAdd(
          entry.stalls.totalMs,
          stallMs,
          'phase stall duration total',
        );
        entry.stalls.maxMs = Math.max(entry.stalls.maxMs, stallMs);
      }
      if (!phases[surface][phase]) phases[surface][phase] = Object.create(null);
      phases[surface][phase][family] = entry;
    },

    snapshot,

    async writeArtifact({ artifactDir }) {
      if (finalized) fail('capture is already finalized');
      const directory = resolve(String(artifactDir ?? ''));
      if (!String(artifactDir ?? '').trim()) fail('artifactDir is required');
      const artifactPath = join(directory, RA21_MEASUREMENT_ARTIFACT_NAME);
      const artifact = snapshot();
      finalized = true;
      await mkdir(directory, { recursive: true });
      await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o444,
      });
      await chmod(artifactPath, 0o444);
      return artifact;
    },
  });
}

export function createRuntimeLimitMeasurementCaptureFromEnv({ env, runnerId, scenarioId }) {
  const artifactDir = String(env?.HAPPIER_RA21_MEASUREMENT_DIR ?? '').trim();
  if (!artifactDir) return null;
  const required = (name) => {
    const value = String(env?.[name] ?? '').trim();
    if (!value) fail(`${name} is required when HAPPIER_RA21_MEASUREMENT_DIR is set`);
    return value;
  };
  return Object.freeze({
    artifactDir: resolve(artifactDir),
    capture: createRuntimeLimitMeasurementCapture({
      provenance: {
        runId: required('HAPPIER_RA21_RUN_ID'),
        runnerId,
        providerId: required('HAPPIER_RA21_PROVIDER_ID'),
        scenarioId,
        buildId: required('HAPPIER_RA21_BUILD_ID'),
        platformId: required('HAPPIER_RA21_PLATFORM_ID'),
      },
    }),
  });
}

function toolTraceEventFamily(event) {
  const payload = event?.payload;
  const payloadType = payload && typeof payload === 'object' && !Array.isArray(payload)
    && typeof payload.type === 'string'
    ? payload.type
    : 'other';
  return ['tool-call', 'tool-result', 'permission-request'].includes(payloadType)
    ? payloadType
    : 'other';
}

export function recordJsonlTraceMeasurements(capture, params) {
  if (!capture) return;
  const traceRaw = String(params?.traceRaw ?? '');
  const traceEvents = params?.traceEvents;
  if (!Array.isArray(traceEvents)) fail('traceEvents must be an array');
  capture.recordPhaseSample({
    surface: 'host',
    phase: 'decode',
    family: 'tooltrace-jsonl',
    durationMs: params.decodeDurationMs,
  });

  let queuedBytes = Buffer.byteLength(traceRaw, 'utf8');
  for (const [sequence, event] of traceEvents.entries()) {
    const json = JSON.stringify(event);
    if (json === undefined) fail('trace event must be JSON serializable');
    const decodedBytes = Buffer.byteLength(json, 'utf8');
    const encodedBytes = safeIntegerAdd(decodedBytes, 1, 'JSONL encoded byte count');
    capture.recordEnvelope({
      direction: 'event',
      family: toolTraceEventFamily(event),
      decodedBytes,
      encodedBytes,
    });
    capture.recordQueueSample({
      family: 'tooltrace-decoded',
      queuedItems: traceEvents.length - sequence,
      queuedBytes,
      backpressured: false,
      sequence,
      sequenceBasis: 'observer',
      ...(sequence === 0 ? { expectedFirstSequence: 0 } : {}),
    });
    queuedBytes = Math.max(0, queuedBytes - encodedBytes);
  }
  if (traceEvents.length > 0) {
    capture.finishQueueFamily({
      family: 'tooltrace-decoded',
      expectedLastSequence: traceEvents.length - 1,
    });
  }
}

export function recordHostRuntimeLimitMeasurement(capture, sample) {
  if ('decodedBytes' in sample || 'itemCount' in sample) {
    capture.recordEnvelope({
      direction: 'event',
      family: sample.family,
      decodedBytes: sample.decodedBytes,
      encodedBytes: sample.decodedBytes,
      itemCount: sample.itemCount,
    });
    return;
  }
  capture.recordQueueSample({
    family: sample.family,
    queuedItems: sample.queuedItems,
    queuedBytes: sample.queuedBytes,
    backpressured: sample.backpressured,
    ...(sample.family === 'plugin-event-broker' && sample.sequence !== undefined
      ? {
          sequence: sample.sequence,
          sequenceBasis: 'source',
          ...(sample.sequence === 1 ? { expectedFirstSequence: 1 } : {}),
        }
      : {}),
  });
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function uiPhaseForEventName(name) {
  const normalized = String(name ?? '').toLowerCase();
  if (normalized.includes('responsejson') || normalized.includes('decrypt')) return 'decode';
  if (normalized.includes('firstusable') || normalized.includes('fullyhydrated')) return 'stable-paint';
  if (normalized.includes('projection') || normalized.includes('apply')) return 'projection';
  if (normalized.includes('render')) return 'render';
  return null;
}

function recordUiSessionPayloadMeasurement(capture, event) {
  const family = event?.name === 'ui.session.payload.consume.presentation'
    ? 'presentation-ui-consumer'
    : event?.name === 'ui.session.payload.consume.work-state'
      ? 'work-state-ui-consumer'
      : null;
  if (!family) return;
  const payloadBytes = numericOrNull(event?.fieldStats?.payloadBytes?.max);
  if (payloadBytes === null || !Number.isSafeInteger(payloadBytes)) return;
  const itemCountFieldStats = event?.fieldStats?.itemCount;
  const itemCountStats = itemCountFieldStats && event?.count !== undefined
    ? {
        samples: event.count,
        min: itemCountFieldStats.min,
        max: itemCountFieldStats.max,
        total: itemCountFieldStats.sum,
      }
    : null;
  capture.recordEnvelope({
    direction: 'event',
    family,
    decodedBytes: payloadBytes,
    encodedBytes: payloadBytes,
    ...(itemCountStats ? { itemCountStats } : {}),
  });
}

export function recordAgentBrowserPerfMeasurements(capture, results) {
  for (const result of Array.isArray(results) ? results : []) {
    const family = boundedIdentifier(result?.scenario?.id, 'scenario.id');
    const durationMs = numericOrNull(result?.browserSummary?.durationMs);
    const memoryBytes = numericOrNull(result?.raw?.memory?.usedJSHeapSize);
    const stallMs = Math.max(
      numericOrNull(result?.browserSummary?.maxLongTaskMs) ?? 0,
      numericOrNull(result?.browserSummary?.maxFrameGapMs) ?? 0,
    );
    if (durationMs !== null) {
      capture.recordPhaseSample({
        surface: 'ui',
        phase: 'scenario',
        family,
        durationMs,
        ...(memoryBytes === null ? {} : { memoryBytes }),
        stallMs,
      });
    }
    for (const event of Array.isArray(result?.syncTopEvents) ? result.syncTopEvents : []) {
      recordUiSessionPayloadMeasurement(capture, event);
      const phase = uiPhaseForEventName(event?.name);
      const totalMs = numericOrNull(event?.totalMs);
      if (!phase || totalMs === null) continue;
      capture.recordPhaseSample({
        surface: 'ui',
        phase,
        family,
        durationMs: totalMs,
        ...(memoryBytes === null ? {} : { memoryBytes }),
        stallMs: numericOrNull(event?.maxMs) ?? 0,
      });
    }
  }
}

export function recordWebMemoryProfileMeasurements(capture, summary) {
  for (const sample of Array.isArray(summary?.samples) ? summary.samples : []) {
    const family = boundedIdentifier(sample?.label, 'memory sample label');
    const memoryBytes = numericOrNull(sample?.heapUsedSize)
      ?? numericOrNull(sample?.performanceUsedJSHeapSize);
    if (memoryBytes !== null) {
      capture.recordPhaseSample({
        surface: 'ui',
        phase: 'memory',
        family,
        durationMs: 0,
        memoryBytes,
      });
    }
    const renderTotalMs = numericOrNull(sample?.listRenderTotalMs);
    if ((numericOrNull(sample?.listRenderCount) ?? 0) > 0 && renderTotalMs !== null) {
      capture.recordPhaseSample({
        surface: 'ui',
        phase: 'render',
        family,
        durationMs: renderTotalMs,
        ...(memoryBytes === null ? {} : { memoryBytes }),
      });
    }
  }
}
