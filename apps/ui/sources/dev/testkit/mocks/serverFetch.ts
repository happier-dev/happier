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
