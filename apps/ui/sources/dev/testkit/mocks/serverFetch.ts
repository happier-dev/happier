export function getServerFetchUrl(input: unknown): URL {
    return new URL(input instanceof Request ? input.url : String(input));
}

/** Match the endpoint and any query facts the test owns, allowing transport metadata. */
export function matchServerFetchUrl(expectedUrl: string) {
    const expected = new URL(expectedUrl);
    return {
        asymmetricMatch(input: unknown): boolean {
            const actual = getServerFetchUrl(input);
            return actual.origin === expected.origin && actual.pathname === expected.pathname
                && [...expected.searchParams.keys()].every((key) => {
                    const values = expected.searchParams.getAll(key);
                    const actualValues = actual.searchParams.getAll(key);
                    return values.length === actualValues.length && values.every((value, index) => value === actualValues[index]);
                });
        },
    };
}

export function isServerReachabilityProbeRequest(input: RequestInfo | URL | unknown): boolean {
    const url = String(input);
    return url.endsWith('/health') || url.endsWith('/v1/auth/ping');
}

export function createSuccessfulServerReachabilityProbeResponse(): Response {
    return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

type ServerFetchTestHandler = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => unknown | Promise<unknown>;

export function createServerFetchWithReachabilityProbe(
    handler: ServerFetchTestHandler,
): ServerFetchTestHandler {
    return async (input, init) => {
        if (isServerReachabilityProbeRequest(input)) {
            return createSuccessfulServerReachabilityProbeResponse();
        }
        return await handler(input, init);
    };
}
