import { maskPostgresqlObservationError } from '@happier-dev/databases/postgresql';
import { randomUUID } from 'node:crypto';
import type { DaemonDatabase } from '@happier-dev/plugin-sdk/storage';
import { createCaptureStore, type CaptureEvent } from './store/capture.js';
import { createCaptureIngest } from './store/ingest.js';
import type { NormalizeDatabaseStatement, NormalizedTelemetryBatch, OtlpAdmission, OtlpSignal } from './otlp/types.js';
import type { IncomingMessage } from 'node:http';
import type { WireObservation } from './wire/tracker.js';

export type CapturePartition = Readonly<{ partition: string }>;

/** One runner-owned store/writer, shared by local capture and the production collector. */
export function createCaptureRuntime(input: {
 database: DaemonDatabase;
 normalizeStatement: NormalizeDatabaseStatement;
 publish: (partitions: readonly string[]) => void;
}) {
 const store = createCaptureStore(input.database, input.publish);
 const ingest = createCaptureIngest(store.write, (_coverage, partitions) => input.publish(partitions));
 const normalizeBatch = (batch: NormalizedTelemetryBatch, context: CapturePartition): CaptureEvent[] => [
  ...batch.spans.map(span => ({
   id: `span:${span.traceId}:${span.spanId}`, worktree: context.partition, kind: span.database ? 'query' as const : 'span' as const, source: 'otlp' as const,
   at: Number(BigInt(span.startTimeUnixNano) / 1_000_000n), traceId: span.traceId, spanId: span.spanId,
   shape: span.database?.shape, durationMs: span.durationMs, outcome: span.status,
   parentSpanId: span.parentSpanId, spanKind: span.kind, serviceName: span.serviceName,
   endpointMethod: span.endpoint?.method, endpointRoute: span.endpoint?.route, httpStatusCode: span.httpStatusCode,
   statementKind: span.database?.statementKind, parameterIdentity: span.database?.parameterIdentity,
   callsite: span.database?.callsite,
   detail: { span },
  })),
  ...batch.logs.map(log => ({ id: randomUUID(), worktree: context.partition, kind: 'log' as const, source: 'otlp' as const,
   at: Number(BigInt(log.timeUnixNano !== '0' ? log.timeUnixNano : log.observedTimeUnixNano) / 1_000_000n), traceId: log.traceId, spanId: log.spanId,
   serviceName: log.serviceName, severityNumber: log.severityNumber, detail: { log },
  })),
 ];
 return {
  store, ingest,
  recordCoverage(partition: string, reason: string) { ingest.recordLoss(partition, reason); },
  observeWire(observation: WireObservation, partition: string) {
   if (observation.kind === 'transaction') {
    ingest.offer([{ id: observation.id, worktree: partition, kind: 'transaction', source: 'wire', connectionId: observation.connectionId,
     at: observation.startedAt, durationMs: observation.durationMs, outcome: observation.outcome,
     detail: { executionIds: observation.executionIds } }]);
    return;
   }
   const parameters = Object.fromEntries(observation.parameters.map(value => [String(value.ordinal), { ...value }]));
   const normalized = observation.sqlUnavailable ? { shape: null, fingerprint: null, maskedSql: null, maskedParameters: null, statementKind: 'unknown' as const, parameterIdentity: undefined } : input.normalizeStatement(observation.rawSql, parameters);
   ingest.offer([{ id: observation.id, worktree: partition, kind: 'query', source: 'wire', at: observation.startedAt,
    shape: normalized.shape, durationMs: observation.durationMs, outcome: observation.outcome,
    statementKind: normalized.statementKind, parameterIdentity: normalized.parameterIdentity,
    executionIdentity: observation.id, transactionId: observation.transactionId, connectionId: observation.connectionId,
    detail: { sql: normalized.maskedSql, parameters: normalized.maskedParameters ?? null,
     transactionId: observation.transactionId, rowCount: observation.rowCount,
     error: observation.error ? maskPostgresqlObservationError(observation.error) : null },
   }]);
  },
  /** P6 uses the same receiver/parser and supplies its token-hash admission. */
  async acquireReceiver(options: { port: number; host?: '127.0.0.1' | '0.0.0.0'; context: CapturePartition;
   admit?: (request: IncomingMessage, signal: OtlpSignal) => OtlpAdmission<CapturePartition> | Promise<OtlpAdmission<CapturePartition>> }) {
   const { startOtlpReceiver } = await import('./otlp/receiver.js');
   const receiver = await startOtlpReceiver({ ...options, normalizeStatement: input.normalizeStatement,
    withWriter: options.admit ? operation => ingest.exclusive(operation) : undefined,
    async onBatch(batch, context) {
     if (batch.rejectedRecords) ingest.recordLoss(context.partition, 'invalid_telemetry', batch.rejectedRecords);
     const events = normalizeBatch(batch, context);
     if (options.admit) {
      const result = await ingest.write(events);
      if (result.accepted) return { accepted: true as const };
      const full = result.code === 'daemon_database_quota_exceeded';
      return { accepted: false as const, retryable: !full, ...(full ? { status: 507 as const } : {}),
       message: full ? 'collector storage full' : 'OTLP store write failed' };
     }
     const accepted = ingest.offer(events);
     return { accepted: true as const, rejectedRecords: accepted ? 0 : events.length,
      ...(accepted ? {} : { message: 'Capture coverage lost while storage was unavailable' }) };
    },
   });
   return { endpoint: receiver.url, release: receiver.close };
  },
  /** Clear shares the admitted writer lifetime; no ingestion or clearing wakes maintenance. */
  clear(partition: string) { return ingest.exclusive(async () => {
   const before = ingest.coverage(partition).lostObservations;
   await store.clear(partition);
   ingest.clearCoverage(partition, before);
   ingest.retry();
  }); },
 };
}
export type CaptureRuntime = ReturnType<typeof createCaptureRuntime>;
