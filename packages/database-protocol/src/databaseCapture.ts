import { z } from 'zod/mini';
import type { ProtocolComposableSchema, ProtocolJsonValue } from '@happier-dev/protocol/plugins/actions/protocolComposableSchema';
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

/** Lists exclude demanded details; log prefixes are bounded, redacted display projections. */
export const DatabaseCaptureSummaryV1Schema = z.strictObject({
    id, worktree: id, kind: z.enum(['query', 'transaction', 'span', 'log', 'coverage']),
    source: z.enum(['wire', 'otlp', 'capture']), at: time,
    bodyPrefix: z.optional(z.string()), bodyPrefixTruncated: z.optional(z.boolean()),
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
export const DatabaseCaptureResourceInputV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureResourceInputV1Schema>, DatabaseCaptureResourceInputV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureResourceInputV1Schema);

export type DatabaseCaptureProjectV1 = z.infer<typeof DatabaseCaptureProjectV1Schema>;
export const DatabaseCaptureProjectV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureProjectV1Schema>, DatabaseCaptureProjectV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureProjectV1Schema);

export type DatabaseCaptureSourceV1 = z.infer<typeof DatabaseCaptureSourceV1Schema>;
export const DatabaseCaptureSourceV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureSourceV1Schema>, DatabaseCaptureSourceV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureSourceV1Schema);

export type DatabaseCaptureCursorV1 = z.infer<typeof DatabaseCaptureCursorV1Schema>;
export const DatabaseCaptureCursorV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureCursorV1Schema>, DatabaseCaptureCursorV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureCursorV1Schema);

export type DatabaseCapturePageV1 = z.infer<typeof DatabaseCapturePageV1Schema>;
export const DatabaseCapturePageV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCapturePageV1Schema>, DatabaseCapturePageV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCapturePageV1Schema);

export type DatabaseCaptureCoverageV1 = z.infer<typeof DatabaseCaptureCoverageV1Schema>;
export const DatabaseCaptureCoverageV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureCoverageV1Schema>, DatabaseCaptureCoverageV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureCoverageV1Schema);

export type DatabaseCaptureSummaryV1 = z.infer<typeof DatabaseCaptureSummaryV1Schema>;
export const DatabaseCaptureSummaryV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureSummaryV1Schema>, DatabaseCaptureSummaryV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureSummaryV1Schema);

export type DatabaseCaptureRepeatedQueryV1 = z.infer<typeof DatabaseCaptureRepeatedQueryV1Schema>;
export const DatabaseCaptureRepeatedQueryV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureRepeatedQueryV1Schema>, DatabaseCaptureRepeatedQueryV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureRepeatedQueryV1Schema);

export type DatabaseCaptureEndpointCursorV1 = z.infer<typeof DatabaseCaptureEndpointCursorV1Schema>;
export const DatabaseCaptureEndpointCursorV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureEndpointCursorV1Schema>, DatabaseCaptureEndpointCursorV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureEndpointCursorV1Schema);

export type DatabaseCaptureEndpointV1 = z.infer<typeof DatabaseCaptureEndpointV1Schema>;
export const DatabaseCaptureEndpointV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureEndpointV1Schema>, DatabaseCaptureEndpointV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureEndpointV1Schema);

export type DatabaseCaptureLogCorrelationV1 = z.infer<typeof DatabaseCaptureLogCorrelationV1Schema>;
export const DatabaseCaptureLogCorrelationV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureLogCorrelationV1Schema>, DatabaseCaptureLogCorrelationV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureLogCorrelationV1Schema);

export type DatabaseCaptureResourceSnapshotV1 = z.infer<typeof DatabaseCaptureResourceSnapshotV1Schema>;
export const DatabaseCaptureResourceSnapshotV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureResourceSnapshotV1Schema>, DatabaseCaptureResourceSnapshotV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureResourceSnapshotV1Schema);

export type DatabaseCaptureStatusInputV1 = z.infer<typeof DatabaseCaptureStatusInputV1Schema>;
export const DatabaseCaptureStatusInputV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureStatusInputV1Schema>, DatabaseCaptureStatusInputV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureStatusInputV1Schema);

export type DatabaseCaptureStatusResultV1 = z.infer<typeof DatabaseCaptureStatusResultV1Schema>;
export const DatabaseCaptureStatusResultV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureStatusResultV1Schema>, DatabaseCaptureStatusResultV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureStatusResultV1Schema);

export type DatabaseCaptureQueriesListInputV1 = z.infer<typeof DatabaseCaptureQueriesListInputV1Schema>;
export const DatabaseCaptureQueriesListInputV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureQueriesListInputV1Schema>, DatabaseCaptureQueriesListInputV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureQueriesListInputV1Schema);

export type DatabaseCaptureQueriesListResultV1 = z.infer<typeof DatabaseCaptureQueriesListResultV1Schema>;
export const DatabaseCaptureQueriesListResultV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureQueriesListResultV1Schema>, DatabaseCaptureQueriesListResultV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureQueriesListResultV1Schema);

export type DatabaseCaptureQueryGetInputV1 = z.infer<typeof DatabaseCaptureQueryGetInputV1Schema>;
export const DatabaseCaptureQueryGetInputV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureQueryGetInputV1Schema>, DatabaseCaptureQueryGetInputV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureQueryGetInputV1Schema);

export type DatabaseCaptureQueryGetResultV1 = z.infer<typeof DatabaseCaptureQueryGetResultV1Schema>;
export const DatabaseCaptureQueryGetResultV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureQueryGetResultV1Schema>, DatabaseCaptureQueryGetResultV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureQueryGetResultV1Schema);

export type DatabaseCaptureTracesListInputV1 = z.infer<typeof DatabaseCaptureTracesListInputV1Schema>;
export const DatabaseCaptureTracesListInputV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureTracesListInputV1Schema>, DatabaseCaptureTracesListInputV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureTracesListInputV1Schema);

export type DatabaseCaptureTracesListResultV1 = z.infer<typeof DatabaseCaptureTracesListResultV1Schema>;
export const DatabaseCaptureTracesListResultV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureTracesListResultV1Schema>, DatabaseCaptureTracesListResultV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureTracesListResultV1Schema);

export type DatabaseCaptureTraceGetInputV1 = z.infer<typeof DatabaseCaptureTraceGetInputV1Schema>;
export const DatabaseCaptureTraceGetInputV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureTraceGetInputV1Schema>, DatabaseCaptureTraceGetInputV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureTraceGetInputV1Schema);

export type DatabaseCaptureTraceGetResultV1 = z.infer<typeof DatabaseCaptureTraceGetResultV1Schema>;
export const DatabaseCaptureTraceGetResultV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureTraceGetResultV1Schema>, DatabaseCaptureTraceGetResultV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureTraceGetResultV1Schema);

export type DatabaseCaptureLogsListInputV1 = z.infer<typeof DatabaseCaptureLogsListInputV1Schema>;
export const DatabaseCaptureLogsListInputV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureLogsListInputV1Schema>, DatabaseCaptureLogsListInputV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureLogsListInputV1Schema);

export type DatabaseCaptureLogsListResultV1 = z.infer<typeof DatabaseCaptureLogsListResultV1Schema>;
export const DatabaseCaptureLogsListResultV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureLogsListResultV1Schema>, DatabaseCaptureLogsListResultV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureLogsListResultV1Schema);

export type DatabaseCaptureEndpointsListInputV1 = z.infer<typeof DatabaseCaptureEndpointsListInputV1Schema>;
export const DatabaseCaptureEndpointsListInputV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureEndpointsListInputV1Schema>, DatabaseCaptureEndpointsListInputV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureEndpointsListInputV1Schema);

export type DatabaseCaptureEndpointsListResultV1 = z.infer<typeof DatabaseCaptureEndpointsListResultV1Schema>;
export const DatabaseCaptureEndpointsListResultV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureEndpointsListResultV1Schema>, DatabaseCaptureEndpointsListResultV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureEndpointsListResultV1Schema);

export type DatabaseCaptureClearInputV1 = z.infer<typeof DatabaseCaptureClearInputV1Schema>;
export const DatabaseCaptureClearInputV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureClearInputV1Schema>, DatabaseCaptureClearInputV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureClearInputV1Schema);

export type DatabaseCaptureClearResultV1 = z.infer<typeof DatabaseCaptureClearResultV1Schema>;
export const DatabaseCaptureClearResultV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureClearResultV1Schema>, DatabaseCaptureClearResultV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureClearResultV1Schema);

export type DatabaseCaptureConfigureInputV1 = z.infer<typeof DatabaseCaptureConfigureInputV1Schema>;
export const DatabaseCaptureConfigureInputV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureConfigureInputV1Schema>, DatabaseCaptureConfigureInputV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureConfigureInputV1Schema);

export type DatabaseCaptureConfigureResultV1 = z.infer<typeof DatabaseCaptureConfigureResultV1Schema>;
export const DatabaseCaptureConfigureResultV1ProtocolSchema: ProtocolComposableSchema<z.input<typeof DatabaseCaptureConfigureResultV1Schema>, DatabaseCaptureConfigureResultV1 & ProtocolJsonValue> = projectZodProtocolSchema(DatabaseCaptureConfigureResultV1Schema);
