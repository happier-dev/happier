import { isAuthenticationError } from '@/api/client/httpStatusError';
import type { Credentials } from '@/persistence';
import { archiveSessionOnceInactive } from '@/session/services/archiveSessionOnceInactive';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import { StopSessionResultSchema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

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
    params: Readonly<{
        credentials: Credentials;
        fallbackStopSession: ForkStopSession;
        sessionId: string;
    }>,
): Promise<void> {
    const rawSession = await fetchSessionByIdCompat({
        token: params.credentials.token,
        sessionId: params.sessionId,
    }).catch(() => null);
    const machineId = typeof rawSession?.machineId === 'string'
        && rawSession.machineId.trim().length > 0
        && rawSession.machineId === rawSession.machineId.trim()
        ? rawSession.machineId
        : null;
    if (machineId) {
        try {
            const stopResult = StopSessionResultSchema.safeParse(
                await callMachineRpc({
                    credentials: params.credentials,
                    machineId,
                    method: RPC_METHODS.STOP_SESSION,
                    request: { sessionId: params.sessionId },
                    authorization: {
                        kind: 'session.write',
                        sessionId: params.sessionId,
                    },
                }),
            );
            if (stopResult.success && stopResult.data.status === 'stopped') {
                return;
            }
        } catch {
            // Fall back to the daemon-local stop below so a server outage cannot leave a runner alive.
        }
    }
    try {
        await params.fallbackStopSession(params.sessionId);
    } catch {
        // Best-effort only: the important part is surfacing the original fork failure.
    }
}

export async function archiveSessionBestEffort(token: string, sessionId: string): Promise<void> {
    await archiveSessionOnceInactive({ token, sessionId });
}
