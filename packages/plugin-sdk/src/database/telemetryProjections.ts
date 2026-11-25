import * as databaseTelemetryMetricSeries from './databaseTelemetryMetricSeries.js';
import * as native from './telemetryMetrics.js';
import type { ProtocolComposableSchema, ProtocolJsonValue } from '../protocol/protocolFacade.js';
import type { SchemaInput, TelemetryEnvironmentMetricsReadInputV1, TelemetryEnvironmentMetricsReadResultV1, TelemetryKeyFlowConfigV1, TelemetryKeyFlowMeasureV1, TelemetryMetricsReadInputV1, TelemetryMetricsReadResultV1 } from './schemaTypes.js';

export const TelemetryKeyFlowMeasureV1ProtocolSchema: ProtocolComposableSchema<
    SchemaInput<'telemetryKeyFlowMeasureV1'>, TelemetryKeyFlowMeasureV1 & ProtocolJsonValue
> = native.TelemetryKeyFlowMeasureV1ProtocolSchema;
export const TelemetryKeyFlowConfigV1ProtocolSchema: ProtocolComposableSchema<
    SchemaInput<'telemetryKeyFlowConfigV1'>, TelemetryKeyFlowConfigV1 & ProtocolJsonValue
> = native.TelemetryKeyFlowConfigV1ProtocolSchema;
export const TelemetryMetricsReadInputV1ProtocolSchema: ProtocolComposableSchema<
    SchemaInput<'telemetryMetricsReadInputV1'>, TelemetryMetricsReadInputV1 & ProtocolJsonValue
> = native.TelemetryMetricsReadInputV1ProtocolSchema;
export const TelemetryMetricsReadResultV1ProtocolSchema: ProtocolComposableSchema<
    SchemaInput<'telemetryMetricsReadResultV1'>, TelemetryMetricsReadResultV1 & ProtocolJsonValue
> = native.TelemetryMetricsReadResultV1ProtocolSchema;
export const TelemetryEnvironmentMetricsReadInputV1ProtocolSchema: ProtocolComposableSchema<
    SchemaInput<'telemetryEnvironmentMetricsReadInputV1'>, TelemetryEnvironmentMetricsReadInputV1 & ProtocolJsonValue
> = native.TelemetryEnvironmentMetricsReadInputV1ProtocolSchema;
export const TelemetryEnvironmentMetricsReadResultV1ProtocolSchema: ProtocolComposableSchema<
    SchemaInput<'telemetryEnvironmentMetricsReadResultV1'>, TelemetryEnvironmentMetricsReadResultV1 & ProtocolJsonValue
> = native.TelemetryEnvironmentMetricsReadResultV1ProtocolSchema;
export const TelemetryMetricsActionReadInputV1ProtocolSchema: ProtocolComposableSchema<
    SchemaInput<'telemetryMetricsActionReadInputV1'>,
    (TelemetryMetricsReadInputV1 | TelemetryEnvironmentMetricsReadInputV1) & ProtocolJsonValue
> = native.TelemetryMetricsActionReadInputV1ProtocolSchema;
export const TelemetryMetricsActionReadResultV1ProtocolSchema: ProtocolComposableSchema<
    SchemaInput<'telemetryMetricsActionReadResultV1'>,
    (TelemetryMetricsReadResultV1 | TelemetryEnvironmentMetricsReadResultV1) & ProtocolJsonValue
> = native.TelemetryMetricsActionReadResultV1ProtocolSchema;
export const projectTelemetryMetricsActionReadResultV1: (input: SchemaInput<'telemetryMetricsActionReadResultV1'>) => ProtocolJsonValue = native.projectTelemetryMetricsActionReadResultV1;
export type {
    TelemetryEnvironmentMetricsReadInputV1,
    TelemetryEnvironmentMetricsReadResultV1,
    TelemetryMetricsReadResultV1,
    TelemetryMetricsReadInputV1,
    TelemetryKeyFlowConfigV1,
    TelemetryKeyFlowMeasureV1,
} from './schemaTypes.js';

export const DatabaseTelemetryMetricIntervalV1ProtocolSchema = databaseTelemetryMetricSeries.DatabaseTelemetryMetricIntervalV1ProtocolSchema;
export type {
    DatabaseTelemetryMetricIntervalV1,
} from './schemaTypes.js';
