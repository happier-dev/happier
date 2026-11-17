/** Owned binding names shared by setup, native launch and platform variable sync. */
export const TELEMETRY_EXPORT_ENVIRONMENT_KEYS_V1 = [
    'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_PROTOCOL', 'OTEL_EXPORTER_OTLP_HEADERS',
    'OTEL_SERVICE_NAME', 'OTEL_RESOURCE_ATTRIBUTES',
] as const;

/** Each SDK signal-specific endpoint overrides the generic exporter destination. */
export const TELEMETRY_COLLECTOR_ENDPOINT_ENVIRONMENT_KEYS_V1 = [
    TELEMETRY_EXPORT_ENVIRONMENT_KEYS_V1[0],
    'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT', 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
] as const;

export function usesOwnTelemetryCollectorV1(authoredEnvironmentKeys: ReadonlySet<string>): boolean {
    return TELEMETRY_COLLECTOR_ENDPOINT_ENVIRONMENT_KEYS_V1.some(key => authoredEnvironmentKeys.has(key));
}

/** OTLP uses URL-encoded header values; the Saved Secret itself remains raw. */
export function encodeTelemetryAuthorizationHeaderV1(token: string): string {
    return `Authorization=${encodeURIComponent(`Bearer ${token}`)}`;
}

/** An omitted choice preserves the application's SDK sampling default. */
export function buildTelemetrySamplingVariablesV1(ratio?: number): Readonly<{
    OTEL_TRACES_SAMPLER?: 'parentbased_traceidratio'; OTEL_TRACES_SAMPLER_ARG?: string;
}> {
    if (ratio === undefined) return {};
    if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) throw new RangeError('Sampling must be between zero and one');
    return { OTEL_TRACES_SAMPLER: 'parentbased_traceidratio', OTEL_TRACES_SAMPLER_ARG: String(ratio) };
}
