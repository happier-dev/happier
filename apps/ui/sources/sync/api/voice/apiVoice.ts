import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';

export type VoiceTokenResponse =
    | {
        allowed: true;
        token: string;
        leaseId: string;
        bindingNonce: string;
        expiresAtMs: number;
    }
    | {
        allowed: false;
        reason: string;
    };

function isVoiceTokenResponse(value: unknown): value is VoiceTokenResponse {
    if (!value || typeof value !== 'object') return false;
    const allowed = (value as any).allowed;
    if (allowed === true) {
        return (
            typeof (value as any).token === 'string' &&
            typeof (value as any).leaseId === 'string' &&
            typeof (value as any).bindingNonce === 'string' &&
            typeof (value as any).expiresAtMs === 'number'
        );
    }
    if (allowed === false) {
        return typeof (value as any).reason === 'string';
    }
    return false;
}

export async function fetchHappierVoiceToken(
    credentials: AuthCredentials,
    opts?: { sessionId?: string | null; signal?: AbortSignal; timeoutMs?: number },
): Promise<VoiceTokenResponse> {
    const timeoutMs = opts?.timeoutMs ?? 10_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    const upstreamSignal = opts?.signal;
    const onAbort = () => controller.abort();
    if (upstreamSignal) {
        if (upstreamSignal.aborted) {
            controller.abort();
        } else {
            upstreamSignal.addEventListener('abort', onAbort, { once: true });
        }
    }

    let response: Response;
    try {
        const sessionId = typeof opts?.sessionId === 'string' ? opts.sessionId.trim() : '';
        const body = sessionId ? { sessionId } : {};

        response = await serverFetch('/v1/voice/token', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        }, { includeAuth: false, retry: 'none' });
    } finally {
        clearTimeout(timeout);
        if (upstreamSignal) {
            upstreamSignal.removeEventListener('abort', onAbort);
        }
    }

    if (response.ok) {
        const parsed = await response.json().catch(() => null);
        if (isVoiceTokenResponse(parsed)) return parsed;
        throw new Error('Voice token request returned an invalid response');
    }

    // Expected denial modes (fail closed).
    if (response.status === 403 || response.status === 429 || response.status === 503) {
        const parsed = await response.json().catch(() => null);
        if (isVoiceTokenResponse(parsed)) return parsed;
        return { allowed: false, reason: 'upstream_error' };
    }

    throw new Error(`Voice token request failed: ${response.status}`);
}

async function postHappierVoiceSessionLifecycle(
    credentials: AuthCredentials,
    path: '/v1/voice/session/complete',
    params: { leaseId: string; providerConversationId: string },
    errorPrefix: string,
    options?: { timeoutMs?: number },
): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 5000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await serverFetch(path, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(params),
            signal: controller.signal,
        }, { includeAuth: false, retry: 'none' });

        if (!response.ok) {
            // Avoid including raw response bodies in error messages: these errors are often shipped to
            // telemetry/log sinks, and response bodies can contain PII or internal details.
            throw new Error(`${errorPrefix} (${response.status})`);
        }
    } finally {
        clearTimeout(timer);
    }
}

export async function completeHappierVoiceSession(
    credentials: AuthCredentials,
    params: { leaseId: string; providerConversationId: string },
    options?: { timeoutMs?: number },
): Promise<void> {
    return postHappierVoiceSessionLifecycle(
        credentials,
        '/v1/voice/session/complete',
        params,
        'Voice session complete failed',
        options,
    );
}
