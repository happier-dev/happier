import * as databaseCaptureSource from './databaseCaptureSource.js';
import * as native from './databaseCapture.js';
import type { ProtocolComposableSchema, ProtocolJsonValue } from '../protocol/protocolFacade.js';
import type { DatabaseCaptureClearInputV1, DatabaseCaptureClearResultV1, DatabaseCaptureConfigureInputV1, DatabaseCaptureConfigureResultV1, DatabaseCaptureCursorV1, DatabaseCaptureEndpointCursorV1, DatabaseCaptureEndpointV1, DatabaseCaptureEndpointsListInputV1, DatabaseCaptureEndpointsListResultV1, DatabaseCaptureFindingDetailV1, DatabaseCaptureLogCorrelationV1, DatabaseCaptureLogsListInputV1, DatabaseCaptureLogsListResultV1, DatabaseCapturePageV1, DatabaseCaptureQueriesListInputV1, DatabaseCaptureQueriesListResultV1, DatabaseCaptureQueryGetInputV1, DatabaseCaptureQueryGetResultV1, DatabaseCaptureRepeatedQueryV1, DatabaseCaptureResourceInputV1, DatabaseCaptureResourceSnapshotV1, DatabaseCaptureStatusInputV1, DatabaseCaptureStatusResultV1, DatabaseCaptureSummaryV1, DatabaseCaptureTraceGetInputV1, DatabaseCaptureTraceGetResultV1, DatabaseCaptureTracesListInputV1, DatabaseCaptureTracesListResultV1, SchemaInput } from './schemaTypes.js';

export const DatabaseCaptureCursorV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureCursorV1'>, DatabaseCaptureCursorV1 & ProtocolJsonValue> = native.DatabaseCaptureCursorV1ProtocolSchema;
export const DatabaseCapturePageV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCapturePageV1'>, DatabaseCapturePageV1 & ProtocolJsonValue> = native.DatabaseCapturePageV1ProtocolSchema;
export const DatabaseCaptureSummaryV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureSummaryV1'>, DatabaseCaptureSummaryV1 & ProtocolJsonValue> = native.DatabaseCaptureSummaryV1ProtocolSchema;
export const DatabaseCaptureRepeatedQueryV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureRepeatedQueryV1'>, DatabaseCaptureRepeatedQueryV1 & ProtocolJsonValue> = native.DatabaseCaptureRepeatedQueryV1ProtocolSchema;
export const DatabaseCaptureEndpointCursorV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureEndpointCursorV1'>, DatabaseCaptureEndpointCursorV1 & ProtocolJsonValue> = native.DatabaseCaptureEndpointCursorV1ProtocolSchema;
export const DatabaseCaptureEndpointV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureEndpointV1'>, DatabaseCaptureEndpointV1 & ProtocolJsonValue> = native.DatabaseCaptureEndpointV1ProtocolSchema;
export const DatabaseCaptureLogCorrelationV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureLogCorrelationV1'>, DatabaseCaptureLogCorrelationV1 & ProtocolJsonValue> = native.DatabaseCaptureLogCorrelationV1ProtocolSchema;
export const DatabaseCaptureStatusInputV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureStatusInputV1'>, DatabaseCaptureStatusInputV1 & ProtocolJsonValue> = native.DatabaseCaptureStatusInputV1ProtocolSchema;
export const DatabaseCaptureStatusResultV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureStatusResultV1'>, DatabaseCaptureStatusResultV1 & ProtocolJsonValue> = native.DatabaseCaptureStatusResultV1ProtocolSchema;
export const DatabaseCaptureQueriesListInputV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureQueriesListInputV1'>, DatabaseCaptureQueriesListInputV1 & ProtocolJsonValue> = native.DatabaseCaptureQueriesListInputV1ProtocolSchema;
export const DatabaseCaptureQueriesListResultV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureQueriesListResultV1'>, DatabaseCaptureQueriesListResultV1 & ProtocolJsonValue> = native.DatabaseCaptureQueriesListResultV1ProtocolSchema;
export const DatabaseCaptureQueryGetInputV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureQueryGetInputV1'>, DatabaseCaptureQueryGetInputV1 & ProtocolJsonValue> = native.DatabaseCaptureQueryGetInputV1ProtocolSchema;
export const DatabaseCaptureQueryGetResultV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureQueryGetResultV1'>, DatabaseCaptureQueryGetResultV1 & ProtocolJsonValue> = native.DatabaseCaptureQueryGetResultV1ProtocolSchema;
export const DatabaseCaptureTracesListInputV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureTracesListInputV1'>, DatabaseCaptureTracesListInputV1 & ProtocolJsonValue> = native.DatabaseCaptureTracesListInputV1ProtocolSchema;
export const DatabaseCaptureTracesListResultV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureTracesListResultV1'>, DatabaseCaptureTracesListResultV1 & ProtocolJsonValue> = native.DatabaseCaptureTracesListResultV1ProtocolSchema;
export const DatabaseCaptureTraceGetInputV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureTraceGetInputV1'>, DatabaseCaptureTraceGetInputV1 & ProtocolJsonValue> = native.DatabaseCaptureTraceGetInputV1ProtocolSchema;
export const DatabaseCaptureTraceGetResultV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureTraceGetResultV1'>, DatabaseCaptureTraceGetResultV1 & ProtocolJsonValue> = native.DatabaseCaptureTraceGetResultV1ProtocolSchema;
export const DatabaseCaptureLogsListInputV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureLogsListInputV1'>, DatabaseCaptureLogsListInputV1 & ProtocolJsonValue> = native.DatabaseCaptureLogsListInputV1ProtocolSchema;
export const DatabaseCaptureLogsListResultV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureLogsListResultV1'>, DatabaseCaptureLogsListResultV1 & ProtocolJsonValue> = native.DatabaseCaptureLogsListResultV1ProtocolSchema;
export const DatabaseCaptureEndpointsListInputV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureEndpointsListInputV1'>, DatabaseCaptureEndpointsListInputV1 & ProtocolJsonValue> = native.DatabaseCaptureEndpointsListInputV1ProtocolSchema;
export const DatabaseCaptureEndpointsListResultV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureEndpointsListResultV1'>, DatabaseCaptureEndpointsListResultV1 & ProtocolJsonValue> = native.DatabaseCaptureEndpointsListResultV1ProtocolSchema;
export const DatabaseCaptureClearInputV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureClearInputV1'>, DatabaseCaptureClearInputV1 & ProtocolJsonValue> = native.DatabaseCaptureClearInputV1ProtocolSchema;
export const DatabaseCaptureClearResultV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureClearResultV1'>, DatabaseCaptureClearResultV1 & ProtocolJsonValue> = native.DatabaseCaptureClearResultV1ProtocolSchema;
export const DatabaseCaptureConfigureInputV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureConfigureInputV1'>, DatabaseCaptureConfigureInputV1 & ProtocolJsonValue> = native.DatabaseCaptureConfigureInputV1ProtocolSchema;
export const DatabaseCaptureConfigureResultV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureConfigureResultV1'>, DatabaseCaptureConfigureResultV1 & ProtocolJsonValue> = native.DatabaseCaptureConfigureResultV1ProtocolSchema;
export const DatabaseCaptureResourceInputV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureResourceInputV1'>, DatabaseCaptureResourceInputV1 & ProtocolJsonValue> = native.DatabaseCaptureResourceInputV1ProtocolSchema;
export const DatabaseCaptureResourceSnapshotV1ProtocolSchema: ProtocolComposableSchema<SchemaInput<'databaseCaptureResourceSnapshotV1'>, DatabaseCaptureResourceSnapshotV1 & ProtocolJsonValue> = native.DatabaseCaptureResourceSnapshotV1ProtocolSchema;
/** The capture list and finding detail use the same request failure definition. */
export function captureSummaryFailed(
    summary: Readonly<{ httpStatusCode?: number | null; outcome?: string | null }>,
): boolean {
    return (summary.httpStatusCode ?? 0) >= 500 || summary.outcome === 'error';
}

export const readProductionCaptureFindingGroupKeyV1: (finding: DatabaseCaptureFindingDetailV1) => string | undefined = native.readProductionCaptureFindingGroupKeyV1;
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
} from './schemaTypes.js';

export const DatabaseCaptureProjectV1ProtocolSchema = databaseCaptureSource.DatabaseCaptureProjectV1ProtocolSchema;
export const DatabaseCaptureSourceV1ProtocolSchema = databaseCaptureSource.DatabaseCaptureSourceV1ProtocolSchema;
export const DatabaseCaptureCoverageV1ProtocolSchema = databaseCaptureSource.DatabaseCaptureCoverageV1ProtocolSchema;
