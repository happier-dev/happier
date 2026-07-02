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
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    afterSeqExclusive?: number;
}>): Promise<SessionTurnActivity> {
    try {
        const refreshedSession = await fetchSessionById({
            token: params.token,
            sessionId: params.sessionId,
        });
        const projectedActivity = detectSessionTurnActivityFromProjection(refreshedSession);
        if (projectedActivity) {
            return projectedActivity;
        }
    } catch {
        // Fall back to legacy transcript activity detection below.
    }

    return detectSessionTurnActivity({
        token: params.token,
        sessionId: params.sessionId,
        encryptionMode: params.encryptionMode,
        encryptionKey: params.encryptionKey,
        encryptionVariant: params.encryptionVariant,
        ...(typeof params.afterSeqExclusive === 'number' ? { afterSeqExclusive: params.afterSeqExclusive } : {}),
    });
}
