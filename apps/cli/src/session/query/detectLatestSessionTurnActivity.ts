import {
    detectSessionTurnActivity,
    SessionTurnActivityUnavailableError,
    type SessionTurnActivity,
} from '@/session/query/detectSessionTurnInFlight';
import { resolveTranscriptFetchTimeoutMs, withTranscriptReadDeadline } from '@/session/replay/fetchEncryptedTranscriptMessages';

export async function detectLatestSessionTurnActivity(params: Readonly<{
    token: string;
    sessionId: string;
    encryptionMode: 'e2ee' | 'plain';
    encryptionKey: Uint8Array | null;
    encryptionVariant: 'legacy' | 'dataKey' | null;
    afterSeqExclusive?: number;
    transcriptFetchTimeoutMs?: number;
    resolveAuthorizationHeaders?: Parameters<typeof detectSessionTurnActivity>[0]['resolveAuthorizationHeaders'];
    signal?: AbortSignal;
}>): Promise<SessionTurnActivity> {
    const timeoutMs = resolveTranscriptFetchTimeoutMs(params.transcriptFetchTimeoutMs);
    const deadlineAtMs = Date.now() + timeoutMs;
    try {
        return await withTranscriptReadDeadline({ deadlineAtMs, signal: params.signal }, async (signal) => {
            const transcriptActivity = await detectSessionTurnActivity({
                token: params.token,
                sessionId: params.sessionId,
                ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
                signal,
                deadlineAtMs,
                encryptionMode: params.encryptionMode,
                encryptionKey: params.encryptionKey,
                encryptionVariant: params.encryptionVariant,
                ...(typeof params.afterSeqExclusive === 'number' ? { afterSeqExclusive: params.afterSeqExclusive } : {}),
                ...(typeof params.transcriptFetchTimeoutMs === 'number'
                    ? { transcriptFetchTimeoutMs: params.transcriptFetchTimeoutMs }
                    : {}),
            });
            return transcriptActivity;
        });
    } catch (error) {
        if (error instanceof SessionTurnActivityUnavailableError) throw error;
        throw new SessionTurnActivityUnavailableError(error);
    }
}
