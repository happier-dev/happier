const SERVER_FETCH_CONNECTIVITY_PROBE_PATHS = new Set([
    '/health',
    '/v1/auth/ping',
]);

export function isServerFetchConnectivityProbeRequest(input: unknown): boolean {
    try {
        return SERVER_FETCH_CONNECTIVITY_PROBE_PATHS.has(new URL(String(input)).pathname);
    } catch {
        return false;
    }
}
