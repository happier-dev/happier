import {
    detectSessionTurnActivity,
    detectSessionTurnActivityFromProjection,
    type SessionTurnActivity,
} from '@/session/query/detectSessionTurnInFlight';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';

export async function detectLatestSessionTurnActivity(params: Readonly<{
    token: string;
    sessionId: string;
    encryptionMode: 'e2ee' | 'plain';
    encryptionKey: Uint8Array | null;
    encryptionVariant: 'legacy' | 'dataKey' | null;
    afterSeqExclusive?: number;
    transcriptFetchTimeoutMs?: number;
}>): Promise<SessionTurnActivity> {
    let projectedActivity: SessionTurnActivity | null = null;
    try {
        const refreshedSession = await fetchSessionById({
            token: params.token,
            sessionId: params.sessionId,
        });
        projectedActivity = detectSessionTurnActivityFromProjection(refreshedSession);
        if (projectedActivity) {
            return projectedActivity;
        }
    } catch {
        // Fall back to legacy transcript activity detection below.
    }

    const transcriptActivity = await detectSessionTurnActivity({
        token: params.token,
        sessionId: params.sessionId,
        encryptionMode: params.encryptionMode,
        encryptionKey: params.encryptionKey,
        encryptionVariant: params.encryptionVariant,
        ...(typeof params.afterSeqExclusive === 'number' ? { afterSeqExclusive: params.afterSeqExclusive } : {}),
        ...(typeof params.transcriptFetchTimeoutMs === 'number'
            ? { transcriptFetchTimeoutMs: params.transcriptFetchTimeoutMs }
            : {}),
    });
    if (transcriptActivity.turnInFlight) {
        return transcriptActivity;
    }

    return projectedActivity ?? transcriptActivity;
}
