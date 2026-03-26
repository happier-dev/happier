import { serverFetch } from '@/sync/http/client';

function normalizeBaseUrl(raw: string): string {
    return String(raw ?? '').trim().replace(/\/+$/, '');
}

export async function requestMtlsWebToken(
    serverUrl: string,
    opts?: Readonly<{
        signal?: AbortSignal;
        timeoutMs?: number;
    }>,
): Promise<string> {
    const endpoint = normalizeBaseUrl(serverUrl);
    if (!endpoint) {
        throw new Error('Missing server URL');
    }

    const timeoutMs = opts?.timeoutMs ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, timeoutMs));

    const upstreamSignal = opts?.signal;
    let removeListener = () => {};
    if (upstreamSignal) {
        if (upstreamSignal.aborted) {
            controller.abort();
        } else {
            const onAbort = () => controller.abort();
            upstreamSignal.addEventListener('abort', onAbort, { once: true });
            removeListener = () => upstreamSignal.removeEventListener('abort', onAbort);
        }
    }

    try {
        const res = await serverFetch(
            `${endpoint}/v1/auth/mtls`,
            {
                method: 'POST',
                signal: controller.signal,
            },
            { includeAuth: false },
        );
        const json = await res.json().catch(() => null);
        if (!res.ok || !json || typeof (json as any).token !== 'string') {
            throw new Error(`MTLS login failed (${res.status})`);
        }
        return String((json as any).token);
    } finally {
        clearTimeout(timer);
        removeListener();
    }
}
