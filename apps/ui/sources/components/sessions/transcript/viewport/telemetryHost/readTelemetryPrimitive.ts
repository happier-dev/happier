export function readFiniteTelemetryNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readTelemetryBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}
