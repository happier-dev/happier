export function ownServerTelemetryRelayKey(environmentInstanceId: string, materializationId: string): string {
    return JSON.stringify([environmentInstanceId, materializationId, 'telemetry']);
}

/** The receiver can change its ephemeral port while Compose keeps the alias. */
export function createOwnServerTelemetryRelayForward(readEndpoint: () => string | null | undefined) {
    const endpoint = () => new URL(readEndpoint() ?? 'http://127.0.0.1:0');
    return {
        get host() { return endpoint().hostname; },
        get port() { return Number(endpoint().port); },
    };
}
