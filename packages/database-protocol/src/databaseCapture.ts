import {
    DATABASE_CAPTURE_RESOURCE_REF_V1,
    DatabaseFindingObservationV1ProtocolSchema,
    readProductionCaptureFindingGroupKeyV1,
    type DatabaseCaptureFindingDetailV1,
} from '@happier-dev/plugin-sdk/database';
import { AutomationDatabaseFindingSubjectV1ProtocolSchema } from '@happier-dev/plugin-sdk/events';
import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';

export {
    DATABASE_CAPTURE_RESOURCE_ID_V1,
    DATABASE_CAPTURE_RESOURCE_REF_V1,
    readProductionCaptureFindingGroupKeyV1,
} from '@happier-dev/plugin-sdk/database';

export const PRODUCTION_CAPTURE_FINDING_EVENT_REF_V1 = {
    pluginId: DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId, localId: 'production-finding-observed',
} as const;

/** Process-local handoff to the installed Workbench Event publisher. */
export const CAPTURED_DATABASE_FINDING_EVENT_REF_V1 = {
    pluginId: DATABASE_CAPTURE_RESOURCE_REF_V1.pluginId, localId: 'database-finding-captured',
} as const;
export const CapturedDatabaseFindingV1Schema = defineProtocolObject({
    observation: DatabaseFindingObservationV1ProtocolSchema,
    subject: AutomationDatabaseFindingSubjectV1ProtocolSchema,
    observationReceivedAt: defineProtocolNumber({ integer: true, minimum: 0 }),
    observedDelta: defineProtocolLiteral(1),
}, { policy: 'closed' });
export type CapturedDatabaseFindingV1 = ReturnType<typeof CapturedDatabaseFindingV1Schema.parse>;

export function buildProductionCaptureFindingWorkflowSeedV1(finding: DatabaseCaptureFindingDetailV1) {
    const groupKey = readProductionCaptureFindingGroupKeyV1(finding);
    const subject = finding.verification.readBefore.input.source;
    if (!groupKey || subject.kind !== 'environment') return undefined;
    return {
        eventRef: PRODUCTION_CAPTURE_FINDING_EVENT_REF_V1,
        monitoringMachineId: finding.sourceScope.machineId,
        setupInput: { v: 1 as const, source: subject },
        initialFilter: { v: 1 as const, all: [{ op: 'eq' as const, field: '/groupKey', value: groupKey }] },
    };
}

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

export {
    DatabaseCaptureCursorV1Schema,
    DatabaseCapturePageV1Schema,
    DatabaseCaptureSummaryV1Schema,
    DatabaseCaptureRepeatedQueryV1Schema,
    DatabaseCaptureEndpointCursorV1Schema,
    DatabaseCaptureEndpointV1Schema,
    DatabaseCaptureLogCorrelationV1Schema,
    DatabaseCaptureStatusInputV1Schema,
    DatabaseCaptureStatusResultV1Schema,
    DatabaseCaptureQueriesListInputV1Schema,
    DatabaseCaptureQueriesListResultV1Schema,
    DatabaseCaptureQueryGetInputV1Schema,
    DatabaseCaptureQueryGetResultV1Schema,
    DatabaseCaptureTracesListInputV1Schema,
    DatabaseCaptureTracesListResultV1Schema,
    DatabaseCaptureTraceGetInputV1Schema,
    DatabaseCaptureTraceGetResultV1Schema,
    DatabaseCaptureLogsListInputV1Schema,
    DatabaseCaptureLogsListResultV1Schema,
    DatabaseCaptureEndpointsListInputV1Schema,
    DatabaseCaptureEndpointsListResultV1Schema,
    DatabaseCaptureClearInputV1Schema,
    DatabaseCaptureClearResultV1Schema,
    DatabaseCaptureConfigureInputV1Schema,
    DatabaseCaptureConfigureResultV1Schema,
    DatabaseCaptureResourceInputV1Schema,
    DatabaseCaptureResourceSnapshotV1Schema,
    DatabaseCaptureCursorV1Schema as DatabaseCaptureCursorV1ProtocolSchema,
    DatabaseCapturePageV1Schema as DatabaseCapturePageV1ProtocolSchema,
    DatabaseCaptureSummaryV1Schema as DatabaseCaptureSummaryV1ProtocolSchema,
    DatabaseCaptureRepeatedQueryV1Schema as DatabaseCaptureRepeatedQueryV1ProtocolSchema,
    DatabaseCaptureEndpointCursorV1Schema as DatabaseCaptureEndpointCursorV1ProtocolSchema,
    DatabaseCaptureEndpointV1Schema as DatabaseCaptureEndpointV1ProtocolSchema,
    DatabaseCaptureLogCorrelationV1Schema as DatabaseCaptureLogCorrelationV1ProtocolSchema,
    DatabaseCaptureStatusInputV1Schema as DatabaseCaptureStatusInputV1ProtocolSchema,
    DatabaseCaptureStatusResultV1Schema as DatabaseCaptureStatusResultV1ProtocolSchema,
    DatabaseCaptureQueriesListInputV1Schema as DatabaseCaptureQueriesListInputV1ProtocolSchema,
    DatabaseCaptureQueriesListResultV1Schema as DatabaseCaptureQueriesListResultV1ProtocolSchema,
    DatabaseCaptureQueryGetInputV1Schema as DatabaseCaptureQueryGetInputV1ProtocolSchema,
    DatabaseCaptureQueryGetResultV1Schema as DatabaseCaptureQueryGetResultV1ProtocolSchema,
    DatabaseCaptureTracesListInputV1Schema as DatabaseCaptureTracesListInputV1ProtocolSchema,
    DatabaseCaptureTracesListResultV1Schema as DatabaseCaptureTracesListResultV1ProtocolSchema,
    DatabaseCaptureTraceGetInputV1Schema as DatabaseCaptureTraceGetInputV1ProtocolSchema,
    DatabaseCaptureTraceGetResultV1Schema as DatabaseCaptureTraceGetResultV1ProtocolSchema,
    DatabaseCaptureLogsListInputV1Schema as DatabaseCaptureLogsListInputV1ProtocolSchema,
    DatabaseCaptureLogsListResultV1Schema as DatabaseCaptureLogsListResultV1ProtocolSchema,
    DatabaseCaptureEndpointsListInputV1Schema as DatabaseCaptureEndpointsListInputV1ProtocolSchema,
    DatabaseCaptureEndpointsListResultV1Schema as DatabaseCaptureEndpointsListResultV1ProtocolSchema,
    DatabaseCaptureClearInputV1Schema as DatabaseCaptureClearInputV1ProtocolSchema,
    DatabaseCaptureClearResultV1Schema as DatabaseCaptureClearResultV1ProtocolSchema,
    DatabaseCaptureConfigureInputV1Schema as DatabaseCaptureConfigureInputV1ProtocolSchema,
    DatabaseCaptureConfigureResultV1Schema as DatabaseCaptureConfigureResultV1ProtocolSchema,
    DatabaseCaptureResourceInputV1Schema as DatabaseCaptureResourceInputV1ProtocolSchema,
    DatabaseCaptureResourceSnapshotV1Schema as DatabaseCaptureResourceSnapshotV1ProtocolSchema,
} from '@happier-dev/plugin-sdk/database';
export type {
    DatabaseCaptureResourceInputV1,
    DatabaseCaptureProjectV1,
    DatabaseCaptureSourceV1,
    DatabaseCaptureCursorV1,
    DatabaseCapturePageV1,
    DatabaseCaptureCoverageV1,
    DatabaseCaptureSummaryV1,
    DatabaseCaptureRepeatedQueryV1,
    DatabaseCaptureEndpointCursorV1,
    DatabaseCaptureEndpointV1,
    DatabaseCaptureLogCorrelationV1,
    DatabaseCaptureResourceSnapshotV1,
    DatabaseCaptureStatusInputV1,
    DatabaseCaptureStatusResultV1,
    DatabaseCaptureQueriesListInputV1,
    DatabaseCaptureQueriesListResultV1,
    DatabaseCaptureQueryGetInputV1,
    DatabaseCaptureQueryGetResultV1,
    DatabaseCaptureTracesListInputV1,
    DatabaseCaptureTracesListResultV1,
    DatabaseCaptureTraceGetInputV1,
    DatabaseCaptureTraceGetResultV1,
    DatabaseCaptureLogsListInputV1,
    DatabaseCaptureLogsListResultV1,
    DatabaseCaptureEndpointsListInputV1,
    DatabaseCaptureEndpointsListResultV1,
    DatabaseCaptureClearInputV1,
    DatabaseCaptureClearResultV1,
    DatabaseCaptureConfigureInputV1,
    DatabaseCaptureConfigureResultV1,
} from '@happier-dev/plugin-sdk/database';
export { DatabaseCaptureProjectV1Schema, DatabaseCaptureSourceV1Schema, DatabaseCaptureCoverageV1Schema } from './databaseCaptureSource.js';
export { DatabaseCaptureProjectV1Schema as DatabaseCaptureProjectV1ProtocolSchema, DatabaseCaptureSourceV1Schema as DatabaseCaptureSourceV1ProtocolSchema, DatabaseCaptureCoverageV1Schema as DatabaseCaptureCoverageV1ProtocolSchema } from './databaseCaptureSource.js';
