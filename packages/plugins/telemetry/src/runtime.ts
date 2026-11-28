import { maskPostgresqlObservationError } from '@happier-dev/databases/postgresql';
import type { DeploymentTelemetryAssignmentV1 } from '@happier-dev/plugin-sdk';
import { metricPointId } from './store/metrics.js';
import { createHash, randomUUID } from 'node:crypto';
import type { DaemonDatabase } from '@happier-dev/plugin-sdk/storage';
import { createCaptureStore, type CaptureEvent, type CaptureExceptionEvent } from './store/capture.js';
import { exceptionFingerprint, exceptionTopFrame } from './exceptions/grouping.js';
import { createCaptureIngest } from './store/ingest.js';
import type { NormalizeDatabaseStatement, NormalizedException, NormalizedResourceIdentity, NormalizedTelemetryBatch, OtlpAdmission, OtlpSignal } from './otlp/types.js';
import type { IncomingMessage } from 'node:http';
import type { WireObservation } from './wire/tracker.js';
import { DATABASE_EXECUTION_ID_ATTRIBUTE, readSqlCommenterExecutionIdentity, type SqlCommenterExecutionIdentity } from './analysis/executionIdentity.js';
import { databaseEndpointKey } from './telemetry/databaseEndpoint.js';

/** `capabilities` are the Environment's opt-ins, admitted once with the exporter token. */
export type CapturePartition = Readonly<{ partition: string; physicalRootIdentity?: string; capabilities?: DeploymentTelemetryAssignmentV1['capabilities'] }>;

function exceptionEvent(input: Readonly<{ id: string; context: CapturePartition; origin: 'span' | 'log';
 resource: NormalizedResourceIdentity; exception: NormalizedException; traceId?: string; spanId?: string }>): CaptureExceptionEvent {
 const { exception, resource } = input;
 const topFrame = exceptionTopFrame(exception.stacktrace);
 return { kind: 'exception', id: input.id, worktree: input.context.partition, origin: input.origin,
  at: Number(BigInt(exception.timeUnixNano) / 1_000_000n),
  ...(exception.applicationOrigin ? { applicationOrigin: exception.applicationOrigin } : {}),
  fingerprint: exceptionFingerprint({ partition: input.context.partition, serviceName: resource.serviceName, exception }),
  serviceName: resource.serviceName, serviceVersion: resource.serviceVersion, type: exception.type, message: exception.message,
  topFrame, traceId: input.traceId, spanId: input.spanId, ...(exception.escaped === undefined ? {} : { escaped: exception.escaped }),
  detail: { exception, ...(resource.serviceName === undefined ? {} : { serviceName: resource.serviceName }),
   ...(resource.serviceVersion === undefined ? {} : { serviceVersion: resource.serviceVersion }) } };
}

/** One runner-owned store/writer, shared by local capture and the production collector. */
export function createCaptureRuntime(input: {
 database: DaemonDatabase;
 normalizeStatement: NormalizeDatabaseStatement;
 publish: (partitions: readonly string[]) => void;
}) {
 const store = createCaptureStore(input.database, input.publish);
 const ingest = createCaptureIngest(store.write, (_coverage, partitions) => input.publish(partitions));
 const normalizeBatch = (batch: NormalizedTelemetryBatch, context: CapturePartition, deployed: boolean): CaptureEvent[] => [
  ...(batch.metrics ?? []).map(metric => ({ id: metricPointId(metric), worktree: context.partition,
   kind: 'metric' as const, source: 'otlp' as const, at: Number(BigInt(metric.timeUnixNano) / 1_000_000n), metric })),
  ...batch.spans.map(span => ({
   id: `span:${span.traceId}:${span.spanId}`, worktree: context.partition, kind: span.database ? 'query' as const : 'span' as const, source: 'otlp' as const,
   physicalRootIdentity: context.physicalRootIdentity,
   at: Number(BigInt(span.startTimeUnixNano) / 1_000_000n), traceId: span.traceId, spanId: span.spanId,
   shape: span.database?.shape, durationMs: span.durationMs, outcome: span.status,
   parentSpanId: span.parentSpanId, spanKind: span.kind, serviceName: span.serviceName, serviceVersion: span.serviceVersion,
   ...(context.capabilities?.appLlmCost === true && span.genAi ? { genAi: span.genAi } : {}),
   endpointMethod: span.endpoint?.method, endpointRoute: span.endpoint?.route, httpStatusCode: span.httpStatusCode,
   statementKind: span.database?.statementKind, parameterIdentity: span.database?.parameterIdentity,
   callsite: span.database?.callsite, executionIdentity: span.database?.executionIdentity,
   ...(deployed && span.database?.endpoint && { databaseMemberKey: databaseEndpointKey(span.database.endpoint) }),
   // Stacks are stored once, as exception occurrences, and only when selected.
   detail: { span: (({ exceptions: _exceptions, genAi: _genAi, database, ...rest }) => ({
    ...rest, ...(database && { database: (({ endpoint: _endpoint, ...query }) => query)(database) }),
   }))(span) },
  })),
  ...(context.capabilities?.exceptions === true ? batch.spans.flatMap(span => (span.exceptions ?? []).map(({ eventIndex, ...exception }) => exceptionEvent({
   id: `exception:${span.traceId}:${span.spanId}:${eventIndex}`, context, origin: 'span', resource: span, exception,
   traceId: span.traceId, spanId: span.spanId }))) : []),
  ...(context.capabilities?.exceptions === true ? batch.logs.flatMap(log => log.exception ? [exceptionEvent({
   id: `exception:log:${log.recordUid ?? randomUUID()}`, context, origin: 'log', resource: log, exception: log.exception,
   traceId: log.traceId, spanId: log.spanId })] : []) : []),
  ...batch.logs.map(log => ({
   id: log.recordUid ? `log:${createHash('sha256').update(log.recordUid).digest('hex')}` : randomUUID(),
   worktree: context.partition, kind: 'log' as const, source: 'otlp' as const,
   physicalRootIdentity: context.physicalRootIdentity,
   at: Number(BigInt(log.timeUnixNano !== '0' ? log.timeUnixNano : log.observedTimeUnixNano) / 1_000_000n), traceId: log.traceId, spanId: log.spanId,
   serviceName: log.serviceName, severityNumber: log.severityNumber,
   detail: { log: log.exception ? (({ exception: _exception, ...rest }) => rest)(log) : log },
  })),
 ];
 return {
  store, ingest,
  async removeWorktree(physicalRoot: string) {
   // Removal already settled; this identity must never be resolved against the filesystem again.
   await ingest.exclusive(async () => {
    const persistedPartitions = await store.worktreePartitions(physicalRoot);
    const partitions = new Set([...persistedPartitions, ...ingest.pendingWorktreePartitions(physicalRoot)]);
    for (const partition of partitions) {
     await store.clear(partition);
     ingest.clearCoverage(partition, ingest.coverage(partition).lostObservations);
     await store.forgetWorktree(partition);
    }
   });
  },
  recordCoverage(partition: string, reason: string, physicalRootIdentity?: string) {
   ingest.recordLoss(partition, reason, 1, physicalRootIdentity);
  },
  observeWire(observation: WireObservation, { partition, physicalRootIdentity }: CapturePartition, databaseMemberKey?: string) {
   if (observation.kind === 'transaction') {
    ingest.offer([{ id: observation.id, worktree: partition, kind: 'transaction', source: 'wire', connectionId: observation.connectionId,
     physicalRootIdentity,
     at: observation.startedAt, durationMs: observation.durationMs, outcome: observation.outcome,
     detail: { executionIds: observation.executionIds } }]);
    return;
   }
   const parameters = Object.fromEntries(observation.parameters.map(value => [String(value.ordinal), { ...value }]));
   const tagged: { identity?: SqlCommenterExecutionIdentity | null } | undefined =
    observation.rawSql.includes(DATABASE_EXECUTION_ID_ATTRIBUTE) ? {} : undefined;
   const normalized = observation.sqlUnavailable ? { shape: null, fingerprint: null, maskedSql: null, maskedParameters: null, statementKind: 'unknown' as const, parameterIdentity: undefined }
    : input.normalizeStatement(observation.rawSql, parameters, tagged && (comment => {
     const candidate = readSqlCommenterExecutionIdentity(comment);
     if (candidate) tagged.identity = tagged.identity === undefined ? candidate : null;
    }));
   ingest.offer([{ id: observation.id, worktree: partition, kind: 'query', source: 'wire', at: observation.startedAt,
    physicalRootIdentity,
    shape: normalized.shape, durationMs: observation.durationMs, outcome: observation.outcome,
    ...(databaseMemberKey !== undefined && normalized.shape ? { databaseMemberKey } : {}),
    statementKind: normalized.statementKind, parameterIdentity: normalized.parameterIdentity,
    ...(normalized.shape && tagged?.identity), transactionId: observation.transactionId, connectionId: observation.connectionId,
    detail: { sql: normalized.maskedSql, parameters: normalized.maskedParameters ?? null,
     transactionId: observation.transactionId, rowCount: observation.rowCount,
     error: observation.error ? maskPostgresqlObservationError(observation.error) : null },
   }]);
  },
  /** P6 uses the same receiver/parser and supplies its token-hash admission. */
  async acquireReceiver(options: { port: number; host?: '127.0.0.1' | '0.0.0.0'; context: CapturePartition;
   admit?: (request: IncomingMessage, signal: OtlpSignal) => OtlpAdmission<CapturePartition> | Promise<OtlpAdmission<CapturePartition>>;
   /** Affected exception groups after their occurrences committed; the issue writer runs after the response. */
   onExceptionsCommitted?: (context: CapturePartition, fingerprints: readonly string[]) => void;
   onTraceBatchCommitted?: (context: CapturePartition, traceIds: readonly string[]) => void }) {
   const { startOtlpReceiver } = await import('./otlp/receiver.js');
   const receiver = await startOtlpReceiver({ ...options, normalizeStatement: input.normalizeStatement,
    async admit(request, signal): Promise<OtlpAdmission<CapturePartition>> {
     const admission = options.admit ? await options.admit(request, signal) : { accepted: true as const, context: options.context };
     if (admission.accepted && signal === 'metrics' && admission.context.capabilities?.metrics !== true) {
      return { accepted: false, status: 403, message: 'Metric capture is disabled' };
     }
     return admission;
    },
    withWriter: ingest.exclusive,
    async onBatch(batch, context) {
     const events = normalizeBatch(batch, context, options.admit !== undefined);
     if (batch.rejectedRecords) ingest.recordLoss(context.partition, 'invalid_telemetry', batch.rejectedRecords, context.physicalRootIdentity);
     const result = await ingest.write(events);
     if (result.accepted) {
      if (options.admit) {
       const fingerprints = [...new Set(events.flatMap(event => event.kind === 'exception' ? [event.fingerprint] : []))];
       if (fingerprints.length) options.onExceptionsCommitted?.(context, fingerprints);
      }
      if (result.changedTraceIds.length) options.onTraceBatchCommitted?.(context, result.changedTraceIds);
      return { accepted: true as const };
     }
     if (options.admit) {
      const full = result.code === 'daemon_database_quota_exceeded';
      return { accepted: false as const, retryable: !full, ...(full ? { status: 507 as const } : {}),
       message: full ? 'collector storage full' : 'OTLP store write failed' };
     }
     return { accepted: true as const, rejectedRecords: events.length, message: 'Capture coverage lost while storage was unavailable' };
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
