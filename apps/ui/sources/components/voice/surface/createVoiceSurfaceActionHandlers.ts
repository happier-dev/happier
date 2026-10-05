import { teleportVoiceAgentToSessionRoot } from '@/voice/agent/teleportVoiceAgentToSessionRoot';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { fireAndForget } from '@/utils/system/fireAndForget';


/**
 * The Voice surface's own actions. Recovery is **not** one of them: the
 * placement-neutral attempt projection owns the single recovery derivation and
 * dispatch every surface fires (`voiceAttemptRecovery.ts`).
 */
export function createVoiceSurfaceActionHandlers(params: Readonly<{
    sessionId: string | null | undefined;
    snapSessionId: string | null;
}>) {
    return {
        onBargeIn: () => {
            if (typeof params.snapSessionId !== 'string') return;
            const sessionId = params.snapSessionId.trim();
            if (!sessionId) return;
            fireAndForget(voiceSessionManager.bargeIn(sessionId), { tag: 'VoiceSurface.bargeIn' });
        },
        onCancelTurn: () => {
            if (typeof params.snapSessionId !== 'string') return;
            const sessionId = params.snapSessionId.trim();
            if (!sessionId) return;
            fireAndForget(voiceSessionManager.interrupt(sessionId), { tag: 'VoiceSurface.cancelTurn' });
        },
        onTeleport: () => {
            const sessionId = String(params.sessionId ?? '').trim();
            if (!sessionId) return;
            fireAndForget(teleportVoiceAgentToSessionRoot({ sessionId }), { tag: 'VoiceSurface.teleport' });
        },
    };
}
