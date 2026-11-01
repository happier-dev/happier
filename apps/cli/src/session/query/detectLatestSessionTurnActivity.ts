import {
    detectSessionTurnActivity,
    detectSessionTurnActivityFromProjection,
    SessionTurnActivityUnavailableError,
    type SessionTurnActivity,
} from '@/session/query/detectSessionTurnInFlight';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { resolveTranscriptFetchTimeoutMs, withTranscriptReadDeadline } from '@/session/replay/fetchEncryptedTranscriptMessages';

export async function detectLatestSessionTurnActivity(params: Readonly<{
    token: string;
    sessionId: string;
    encryptionMode: 'e2ee' | 'plain';
    encryptionKey: Uint8Array | null;
    encryptionVariant: 'legacy' | 'dataKey' | 'plain';
    afterSeqExclusive?: number;
    transcriptFetchTimeoutMs?: number;
    signal?: AbortSignal;
}>): Promise<SessionTurnActivity> {
    const timeoutMs = resolveTranscriptFetchTimeoutMs(params.transcriptFetchTimeoutMs);
    const deadlineAtMs = Date.now() + timeoutMs;
    try {
        return await withTranscriptReadDeadline({ deadlineAtMs, signal: params.signal }, async (signal) => {
            let projectedActivity: SessionTurnActivity | null = null;
            let refreshedSession: Awaited<ReturnType<typeof fetchSessionById>> = null;
            try {
                refreshedSession = await fetchSessionById({
                    token: params.token,
                    sessionId: params.sessionId,
                    signal,
                });
                signal.throwIfAborted();
                projectedActivity = detectSessionTurnActivityFromProjection(refreshedSession);
                if (projectedActivity) {
                    return projectedActivity;
                }
            } catch (error) {
                if (signal.aborted) throw new SessionTurnActivityUnavailableError(error);
                // Fall back to legacy transcript activity detection below.
            }

            const transcriptActivity = await detectSessionTurnActivity({
                token: params.token,
                sessionId: params.sessionId,
                encryptionMode: params.encryptionMode,
                encryptionKey: params.encryptionKey,
                encryptionVariant: params.encryptionVariant,
                sessionProjection: refreshedSession,
                deadlineAtMs,
                signal,
                ...(typeof params.afterSeqExclusive === 'number' ? { afterSeqExclusive: params.afterSeqExclusive } : {}),
                ...(typeof params.transcriptFetchTimeoutMs === 'number'
                    ? { transcriptFetchTimeoutMs: params.transcriptFetchTimeoutMs }
                    : {}),
            });

            if (transcriptActivity.turnInFlight) {
                return transcriptActivity;
            }

            return projectedActivity ?? transcriptActivity;
        });
    } catch (error) {
        if (error instanceof SessionTurnActivityUnavailableError) throw error;
        throw new SessionTurnActivityUnavailableError(error);
    }
}
