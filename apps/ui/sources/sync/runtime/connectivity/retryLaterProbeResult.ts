import type { ReadinessProbeResult, ReadinessRetryLaterReason } from '@happier-dev/connection-supervisor';

const RETRY_REASON_HEADER = 'X-Happier-Retry-Reason';

export function parseRetryAfterMs(headers: Headers): number | undefined {
    const raw = headers.get('Retry-After') ?? headers.get('retry-after');
    if (!raw) return undefined;
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const seconds = Number.parseInt(trimmed, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000;
    }
    const timestamp = Date.parse(trimmed);
    if (Number.isFinite(timestamp)) {
        const deltaMs = timestamp - Date.now();
        if (deltaMs > 0) return deltaMs;
    }
    return undefined;
}

export function readRetryLaterReason(headers: Headers): ReadinessRetryLaterReason | undefined {
    const value = headers.get(RETRY_REASON_HEADER)?.trim();
    if (value === 'server_restarting') return 'server_restarting';
    if (value === 'probe_failed') return 'probe_failed';
    return undefined;
}

export function buildRetryLaterProbeResultFromResponse(
    response: Response,
    errorMessage: string,
): Extract<ReadinessProbeResult, { status: 'retry_later' }> {
    const retryAfterMs = parseRetryAfterMs(response.headers);
    const reason = readRetryLaterReason(response.headers);
    return {
        status: 'retry_later',
        ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
        ...(reason ? { reason } : {}),
        errorMessage,
    };
}
