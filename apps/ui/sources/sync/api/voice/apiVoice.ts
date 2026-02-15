import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { serverFetch } from '@/sync/http/client';

export type VoiceTokenResponse =
    | {
        allowed: true;
        token: string;
        leaseId: string;
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
        }, { includeAuth: false });
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

export async function completeHappierVoiceSession(
    credentials: AuthCredentials,
    params: { leaseId: string; providerConversationId: string },
    options?: { timeoutMs?: number },
): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 5000;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await serverFetch('/v1/voice/session/complete', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${credentials.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(params),
            signal: controller.signal,
        }, { includeAuth: false });

        if (!response.ok) {
            let bodyText: string | null = null;
            try {
                bodyText = await response.text();
            } catch {
                bodyText = null;
            }

            const suffix = bodyText ? `: ${bodyText.slice(0, 300)}` : '';
            throw new Error(`Voice session complete failed (${response.status})${suffix}`);
        }
    } finally {
        clearTimeout(timer);
    }
}
