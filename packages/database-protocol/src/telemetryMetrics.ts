/** The saved Key flow health-check kind (D32): one named flow, its routes and threshold, checked on the collector. */
export const TELEMETRY_KEY_FLOW_HEALTH_KIND_V1 = { pluginId: 'happier.telemetry', localId: 'key-flow' } as const;
/** Services rows are Environments: one demand reads every emitted service for the mounted rows. */
export const TELEMETRY_REQUESTS_FIELD_ID_V1 = 'requests-24h' as const;
export const TELEMETRY_REQUESTS_LIST_EXTENSION_ID_V1 = 'service-requests' as const;
export const TELEMETRY_REQUESTS_WINDOW_MS_V1 = 24 * 60 * 60 * 1000;

export {
    TelemetryKeyFlowMeasureV1Schema,
    TelemetryKeyFlowConfigV1Schema,
    TelemetryMetricsReadInputV1Schema,
    TelemetryMetricsReadResultV1Schema,
    TelemetryEnvironmentMetricsReadInputV1Schema,
    TelemetryEnvironmentMetricsResourceInputV1Schema,
    TelemetryEnvironmentMetricsReadResultV1Schema,
    TelemetryMetricsActionReadInputV1ProtocolSchema,
    TelemetryMetricsActionReadResultV1ProtocolSchema,
    TelemetryKeyFlowMeasureV1Schema as TelemetryKeyFlowMeasureV1ProtocolSchema,
    TelemetryKeyFlowConfigV1Schema as TelemetryKeyFlowConfigV1ProtocolSchema,
    TelemetryMetricsReadInputV1Schema as TelemetryMetricsReadInputV1ProtocolSchema,
    TelemetryMetricsReadResultV1Schema as TelemetryMetricsReadResultV1ProtocolSchema,
} from '@happier-dev/plugin-sdk/database';
export type {
    TelemetryEnvironmentMetricsReadInputV1,
    TelemetryEnvironmentMetricsReadResultV1,
    TelemetryEnvironmentMetricsResourceInputV1,
    TelemetryMetricsReadResultV1,
    TelemetryMetricsReadInputV1,
    TelemetryKeyFlowConfigV1,
    TelemetryKeyFlowMeasureV1,
} from '@happier-dev/plugin-sdk/database';
