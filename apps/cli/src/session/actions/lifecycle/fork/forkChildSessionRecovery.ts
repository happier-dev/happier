import { isAuthenticationError } from '@/api/client/httpStatusError';
import { archiveSessionByIdBestEffort } from '@/session/services/setSessionArchivedState';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';

import type { ForkLifecycleRawSession, ForkStopSession } from './forkLifecycleTypes';

export async function fetchForkChildSessionOrThrow(params: Readonly<{
    token: string;
    sessionId: string;
    attempts?: number;
    delayMs?: number;
}>): Promise<ForkLifecycleRawSession> {
    const attempts = typeof params.attempts === 'number' && params.attempts >= 1 ? Math.floor(params.attempts) : 6;
    const delayMs = typeof params.delayMs === 'number' && params.delayMs >= 0 ? Math.floor(params.delayMs) : 250;
    let lastError: unknown = null;

    for (let index = 0; index < attempts; index += 1) {
        try {
            const raw = await fetchSessionByIdCompat({ token: params.token, sessionId: params.sessionId });
            if (raw) return raw;
            lastError = new Error('Session fetch returned empty response');
        } catch (error) {
            if (isAuthenticationError(error)) throw error;
            lastError = error;
        }
        if (index < attempts - 1 && delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    throw lastError instanceof Error ? lastError : new Error(`Failed to load forked child session ${params.sessionId}`);
}

export async function cleanupForkChildBestEffort(
    stopSession: ForkStopSession,
    sessionId: string,
): Promise<void> {
    try {
        await stopSession(sessionId);
    } catch {
        // Best-effort only: the important part is surfacing the original fork failure.
    }
}

export async function archiveSessionBestEffort(token: string, sessionId: string): Promise<void> {
    await archiveSessionByIdBestEffort({ token, sessionId });
}
