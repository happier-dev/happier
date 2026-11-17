import { z } from 'zod/mini';
import { projectZodProtocolSchema } from '@happier-dev/protocol/plugins/actions/internalProtocolZodAdapter';
import { DATABASE_CAPTURE_STATUS_ACTION_ID_V1 } from './actionIdsDatabaseV1.js';
import { DatabaseFailureV1Schema } from './databaseOperations.js';
import { DatabaseCaptureCostsReadInputV1Schema, DatabaseCaptureCostsReadResultV1Schema } from './databaseCaptureCosts.js';
import { DatabaseCaptureProjectV1Schema, DatabaseCaptureSourceV1Schema, DatabaseCaptureCoverageV1Schema } from './databaseCaptureSource.js';
export { DatabaseCaptureProjectV1Schema, DatabaseCaptureSourceV1Schema, DatabaseCaptureCoverageV1Schema } from './databaseCaptureSource.js';

/** The local capture launch producer and setup guidance share these names. */
export const LOCAL_CAPTURE_DATABASE_ENVIRONMENT_NAMES = ['DATABASE_URL'] as const;
export const LOCAL_CAPTURE_OTLP_PROTOCOL_ENVIRONMENT_NAMES = [
    'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_TRACES_PROTOCOL', 'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
] as const;
export const LOCAL_CAPTURE_ENVIRONMENT_NAMES = [...LOCAL_CAPTURE_DATABASE_ENVIRONMENT_NAMES,
    'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    ...LOCAL_CAPTURE_OTLP_PROTOCOL_ENVIRONMENT_NAMES,
    'OTEL_SERVICE_NAME', 'OTEL_RESOURCE_ATTRIBUTES',
] as const;

const id = z.string().check(z.minLength(1));
const count = z.number().check(z.int(), z.nonnegative());
const time = z.number().check(z.int(), z.nonnegative());
const optionalText = z.optional(z.nullable(z.string()));
const optionalNumber = z.optional(z.nullable(z.number()));

export const DatabaseCaptureCursorV1Schema = z.strictObject({ at: time, id });
export const DatabaseCapturePageV1Schema = z.strictObject({
    limit: z.number().check(z.int(), z.positive()),
    before: z.optional(DatabaseCaptureCursorV1Schema),
});

/** Lists cannot carry demanded SQL, parameter, error or log bodies. */
export const DatabaseCaptureSummaryV1Schema = z.strictObject({
    id, worktree: id, kind: z.enum(['query', 'transaction', 'span', 'log', 'coverage']),
    source: z.enum(['wire', 'otlp', 'capture']), at: time,
    shape: optionalText, traceId: optionalText, spanId: optionalText, durationMs: optionalNumber, outcome: optionalText,
    parentSpanId: optionalText, spanKind: optionalNumber, serviceName: optionalText, severityNumber: optionalNumber,
    endpointMethod: optionalText, endpointRoute: optionalText, httpStatusCode: optionalNumber,
    statementKind: z.optional(z.nullable(z.enum(['select', 'control', 'other', 'unknown']))),
    parameterIdentity: optionalText, executionIdentity: optionalText, callsite: optionalText,
    transactionId: optionalText, retryOf: optionalText, connectionId: optionalText,
});
export const DatabaseCaptureRepeatedQueryV1Schema = z.strictObject({
    traceId: id, requestSpanId: id, shape: z.string(),
    kind: z.enum(['suspected_n_plus_one', 'duplicate_work', 'repeated_query']),
    repetitionCount: count, totalDatabaseTimeMs: z.number(),
    observationIds: z.array(id), callsites: z.array(z.string()), explanation: z.string(),
});
export const DatabaseCaptureEndpointCursorV1Schema = z.strictObject({ serviceName: z.string(), method: id, route: id });
export const DatabaseCaptureEndpointV1Schema = z.extend(DatabaseCaptureEndpointCursorV1Schema, {
    requestCount: count, errorCount: count, errorRate: z.nullable(z.number()), totalDurationMs: z.number(), databaseTimeMs: z.number(),
});
export const DatabaseCaptureLogCorrelationV1Schema = z.strictObject({
    logId: id, traceId: id, spanId: z.nullable(id), spanObservationId: z.nullable(id),
});
const sourceInput = { source: DatabaseCaptureSourceV1Schema };
const selectedPage = {
    ...sourceInput, page: DatabaseCapturePageV1Schema, since: z.optional(time), until: z.optional(time),
};
const summaryPage = z.strictObject({
    ok: z.literal(true), source: DatabaseCaptureSourceV1Schema, items: z.array(DatabaseCaptureSummaryV1Schema), nextCursor: z.optional(DatabaseCaptureCursorV1Schema),
});
const status = z.strictObject({ ...sourceInput, coverage: DatabaseCaptureCoverageV1Schema });

export const DatabaseCaptureStatusInputV1Schema = z.strictObject(sourceInput);
export const DatabaseCaptureStatusResultV1Schema = z.union([DatabaseFailureV1Schema, z.extend(status, { ok: z.literal(true) })]);
export const DatabaseCaptureQueriesListInputV1Schema = z.strictObject({ ...selectedPage, traceId: z.optional(id) });
export const DatabaseCaptureQueriesListResultV1Schema = z.union([DatabaseFailureV1Schema, summaryPage]);
export const DatabaseCaptureQueryGetInputV1Schema = z.strictObject({ ...sourceInput, id });
export const DatabaseCaptureQueryGetResultV1Schema = z.union([DatabaseFailureV1Schema,
    z.strictObject({ ok: z.literal(true), source: DatabaseCaptureSourceV1Schema, detail: z.nullable(z.record(z.string(), z.json())) }),
]);
export const DatabaseCaptureTracesListInputV1Schema = z.strictObject(selectedPage);
export const DatabaseCaptureTracesListResultV1Schema = z.union([DatabaseFailureV1Schema, summaryPage]);
export const DatabaseCaptureTraceGetInputV1Schema = z.strictObject({ ...sourceInput, traceId: id, page: z.strictObject({ limit: DatabaseCapturePageV1Schema.shape.limit }) });
export const DatabaseCaptureTraceGetResultV1Schema = z.union([DatabaseFailureV1Schema, z.strictObject({
    ok: z.literal(true), ...sourceInput, traceId: id, summaries: z.array(DatabaseCaptureSummaryV1Schema),
    repeatedQueries: z.array(DatabaseCaptureRepeatedQueryV1Schema),
    slowChildSpans: z.array(DatabaseCaptureSummaryV1Schema),
    logCorrelations: z.array(DatabaseCaptureLogCorrelationV1Schema),
})]);
export const DatabaseCaptureLogsListInputV1Schema = z.strictObject({
    ...selectedPage, serviceName: z.optional(z.string()), severityNumber: z.optional(count),
});
export const DatabaseCaptureLogsListResultV1Schema = z.union([DatabaseFailureV1Schema, summaryPage]);
export const DatabaseCaptureEndpointsListInputV1Schema = z.strictObject({
    ...sourceInput, page: z.strictObject({ limit: DatabaseCapturePageV1Schema.shape.limit, before: z.optional(DatabaseCaptureEndpointCursorV1Schema) }),
    since: z.optional(time), until: z.optional(time),
});
export const DatabaseCaptureEndpointsListResultV1Schema = z.union([DatabaseFailureV1Schema, z.strictObject({
    ok: z.literal(true), source: DatabaseCaptureSourceV1Schema, items: z.array(DatabaseCaptureEndpointV1Schema), nextCursor: z.optional(DatabaseCaptureEndpointCursorV1Schema),
})]);
export const DatabaseCaptureClearInputV1Schema = z.strictObject(sourceInput);
export const DatabaseCaptureClearResultV1Schema = z.union([DatabaseFailureV1Schema, z.strictObject({ ok: z.literal(true) })]);
export const DatabaseCaptureConfigureInputV1Schema = z.strictObject({
    project: DatabaseCaptureProjectV1Schema, enabled: z.boolean(), retry: z.optional(z.literal(true)),
});
export const DatabaseCaptureConfigureResultV1Schema = z.union([DatabaseFailureV1Schema, z.strictObject({ ok: z.literal(true), enabled: z.boolean() })]);

export const DATABASE_CAPTURE_RESOURCE_ID_V1 = 'capture-view' as const;
/** Qualified identity derives from the one Action catalogue's capture owner. */
export const DATABASE_CAPTURE_RESOURCE_REF_V1 = {
    pluginId: DATABASE_CAPTURE_STATUS_ACTION_ID_V1.split('/actions/')[0]!,
    contributionId: DATABASE_CAPTURE_RESOURCE_ID_V1,
} as const;
export const DatabaseCaptureResourceInputV1Schema = z.discriminatedUnion('view', [
    z.strictObject({ view: z.literal('costs'), input: DatabaseCaptureCostsReadInputV1Schema }),
    z.strictObject({ view: z.literal('status'), input: DatabaseCaptureStatusInputV1Schema }),
    z.strictObject({ view: z.literal('queries'), input: DatabaseCaptureQueriesListInputV1Schema }),
    z.strictObject({ view: z.literal('query'), input: DatabaseCaptureQueryGetInputV1Schema }),
    z.strictObject({ view: z.literal('traces'), input: DatabaseCaptureTracesListInputV1Schema }),
    z.strictObject({ view: z.literal('trace'), input: DatabaseCaptureTraceGetInputV1Schema }),
    z.strictObject({ view: z.literal('logs'), input: DatabaseCaptureLogsListInputV1Schema }),
    z.strictObject({ view: z.literal('endpoints'), input: DatabaseCaptureEndpointsListInputV1Schema }),
]);
export const DatabaseCaptureResourceSnapshotV1Schema = z.discriminatedUnion('view', [
    z.strictObject({ view: z.literal('costs'), result: DatabaseCaptureCostsReadResultV1Schema }),
    z.strictObject({ view: z.literal('status'), result: DatabaseCaptureStatusResultV1Schema }),
    z.strictObject({ view: z.literal('queries'), result: DatabaseCaptureQueriesListResultV1Schema }),
    z.strictObject({ view: z.literal('query'), result: DatabaseCaptureQueryGetResultV1Schema }),
    z.strictObject({ view: z.literal('traces'), result: DatabaseCaptureTracesListResultV1Schema }),
    z.strictObject({ view: z.literal('trace'), result: DatabaseCaptureTraceGetResultV1Schema }),
    z.strictObject({ view: z.literal('logs'), result: DatabaseCaptureLogsListResultV1Schema }),
    z.strictObject({ view: z.literal('endpoints'), result: DatabaseCaptureEndpointsListResultV1Schema }),
]);
export type DatabaseCaptureResourceInputV1 = z.infer<typeof DatabaseCaptureResourceInputV1Schema>;
export const DatabaseCaptureResourceInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureResourceInputV1Schema);

export type DatabaseCaptureProjectV1 = z.infer<typeof DatabaseCaptureProjectV1Schema>;
export const DatabaseCaptureProjectV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureProjectV1Schema);

export type DatabaseCaptureSourceV1 = z.infer<typeof DatabaseCaptureSourceV1Schema>;
export const DatabaseCaptureSourceV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureSourceV1Schema);

export type DatabaseCaptureCursorV1 = z.infer<typeof DatabaseCaptureCursorV1Schema>;
export const DatabaseCaptureCursorV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureCursorV1Schema);

export type DatabaseCapturePageV1 = z.infer<typeof DatabaseCapturePageV1Schema>;
export const DatabaseCapturePageV1ProtocolSchema = projectZodProtocolSchema(DatabaseCapturePageV1Schema);

export type DatabaseCaptureCoverageV1 = z.infer<typeof DatabaseCaptureCoverageV1Schema>;
export const DatabaseCaptureCoverageV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureCoverageV1Schema);

export type DatabaseCaptureSummaryV1 = z.infer<typeof DatabaseCaptureSummaryV1Schema>;
export const DatabaseCaptureSummaryV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureSummaryV1Schema);

export type DatabaseCaptureRepeatedQueryV1 = z.infer<typeof DatabaseCaptureRepeatedQueryV1Schema>;
export const DatabaseCaptureRepeatedQueryV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureRepeatedQueryV1Schema);

export type DatabaseCaptureEndpointCursorV1 = z.infer<typeof DatabaseCaptureEndpointCursorV1Schema>;
export const DatabaseCaptureEndpointCursorV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureEndpointCursorV1Schema);

export type DatabaseCaptureEndpointV1 = z.infer<typeof DatabaseCaptureEndpointV1Schema>;
export const DatabaseCaptureEndpointV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureEndpointV1Schema);

export type DatabaseCaptureLogCorrelationV1 = z.infer<typeof DatabaseCaptureLogCorrelationV1Schema>;
export const DatabaseCaptureLogCorrelationV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureLogCorrelationV1Schema);

export type DatabaseCaptureResourceSnapshotV1 = z.infer<typeof DatabaseCaptureResourceSnapshotV1Schema>;
export const DatabaseCaptureResourceSnapshotV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureResourceSnapshotV1Schema);

export type DatabaseCaptureStatusInputV1 = z.infer<typeof DatabaseCaptureStatusInputV1Schema>;
export const DatabaseCaptureStatusInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureStatusInputV1Schema);

export type DatabaseCaptureStatusResultV1 = z.infer<typeof DatabaseCaptureStatusResultV1Schema>;
export const DatabaseCaptureStatusResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureStatusResultV1Schema);

export type DatabaseCaptureQueriesListInputV1 = z.infer<typeof DatabaseCaptureQueriesListInputV1Schema>;
export const DatabaseCaptureQueriesListInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureQueriesListInputV1Schema);

export type DatabaseCaptureQueriesListResultV1 = z.infer<typeof DatabaseCaptureQueriesListResultV1Schema>;
export const DatabaseCaptureQueriesListResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureQueriesListResultV1Schema);

export type DatabaseCaptureQueryGetInputV1 = z.infer<typeof DatabaseCaptureQueryGetInputV1Schema>;
export const DatabaseCaptureQueryGetInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureQueryGetInputV1Schema);

export type DatabaseCaptureQueryGetResultV1 = z.infer<typeof DatabaseCaptureQueryGetResultV1Schema>;
export const DatabaseCaptureQueryGetResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureQueryGetResultV1Schema);

export type DatabaseCaptureTracesListInputV1 = z.infer<typeof DatabaseCaptureTracesListInputV1Schema>;
export const DatabaseCaptureTracesListInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureTracesListInputV1Schema);

export type DatabaseCaptureTracesListResultV1 = z.infer<typeof DatabaseCaptureTracesListResultV1Schema>;
export const DatabaseCaptureTracesListResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureTracesListResultV1Schema);

export type DatabaseCaptureTraceGetInputV1 = z.infer<typeof DatabaseCaptureTraceGetInputV1Schema>;
export const DatabaseCaptureTraceGetInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureTraceGetInputV1Schema);

export type DatabaseCaptureTraceGetResultV1 = z.infer<typeof DatabaseCaptureTraceGetResultV1Schema>;
export const DatabaseCaptureTraceGetResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureTraceGetResultV1Schema);

export type DatabaseCaptureLogsListInputV1 = z.infer<typeof DatabaseCaptureLogsListInputV1Schema>;
export const DatabaseCaptureLogsListInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureLogsListInputV1Schema);

export type DatabaseCaptureLogsListResultV1 = z.infer<typeof DatabaseCaptureLogsListResultV1Schema>;
export const DatabaseCaptureLogsListResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureLogsListResultV1Schema);

export type DatabaseCaptureEndpointsListInputV1 = z.infer<typeof DatabaseCaptureEndpointsListInputV1Schema>;
export const DatabaseCaptureEndpointsListInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureEndpointsListInputV1Schema);

export type DatabaseCaptureEndpointsListResultV1 = z.infer<typeof DatabaseCaptureEndpointsListResultV1Schema>;
export const DatabaseCaptureEndpointsListResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureEndpointsListResultV1Schema);

export type DatabaseCaptureClearInputV1 = z.infer<typeof DatabaseCaptureClearInputV1Schema>;
export const DatabaseCaptureClearInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureClearInputV1Schema);

export type DatabaseCaptureClearResultV1 = z.infer<typeof DatabaseCaptureClearResultV1Schema>;
export const DatabaseCaptureClearResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureClearResultV1Schema);

export type DatabaseCaptureConfigureInputV1 = z.infer<typeof DatabaseCaptureConfigureInputV1Schema>;
export const DatabaseCaptureConfigureInputV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureConfigureInputV1Schema);

export type DatabaseCaptureConfigureResultV1 = z.infer<typeof DatabaseCaptureConfigureResultV1Schema>;
export const DatabaseCaptureConfigureResultV1ProtocolSchema = projectZodProtocolSchema(DatabaseCaptureConfigureResultV1Schema);
