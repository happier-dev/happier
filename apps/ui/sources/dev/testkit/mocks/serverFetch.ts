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

/** Model the released server boundary before additive quota day summaries. */
export function withLegacyProviderAccountUsageRoutes<Args extends unknown[]>(request: (...args: Args) => Promise<Response>): (...args: Args) => Promise<Response> {
    return (...args) => {
        const path = new URL(String(args[0]), 'https://test.invalid').pathname;
        if (path === '/v4/connect/qualified/provider-account-usage/day-summaries') return Promise.resolve(new Response(null, { status: 404 }));
        return request(...args);
    };
}
