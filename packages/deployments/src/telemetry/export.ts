export {
    TELEMETRY_EXPORT_ENVIRONMENT_KEYS_V1,
    TELEMETRY_COLLECTOR_ENDPOINT_ENVIRONMENT_KEYS_V1,
    usesOwnTelemetryCollectorV1,
    encodeTelemetryAuthorizationHeaderV1,
    buildTelemetrySamplingVariablesV1,
} from '@happier-dev/deployment-protocol/v1';
export { resolveTelemetryCollectorSelectionV1,
    type TelemetryCollectorSelectionInputV1, type TelemetryCollectorSelectionV1 } from './collectorSelection.js';
export { readTelemetryCollectorKeyPinsV1, type TelemetryCollectorKeyPinPortsV1 } from './collectorKeyPins.js';
