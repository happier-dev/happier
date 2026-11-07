import { fireAndForget } from '@/utils/system/fireAndForget';
import { createFrontDoorActionExecute, createFrontDoorUiActionExecutor, requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { getVoiceSessionPresentedAttemptId } from '@/voice/session/voiceSessionStore';
import { VoiceConversationActionOutputSchemas } from '@happier-dev/protocol/actions/voiceConversationActionFamily';

const executeAction = createFrontDoorUiActionExecutor();
const executeScopedAction = createFrontDoorActionExecute();


/**
 * The Voice surface's own actions. Recovery is **not** one of them: the
 * placement-neutral attempt projection owns the single recovery derivation and
 * dispatch every surface fires (`voiceAttemptRecovery.ts`).
 */
export function createVoiceSurfaceActionHandlers(params: Readonly<{
    snapSessionId: string | null;
    expectedAttempt?: string | null;
}>) {
    const expectedAttempt = params.expectedAttempt ?? getVoiceSessionPresentedAttemptId();
    const turnControl = async (control: 'interrupt' | 'cancel') => {
        if (!params.snapSessionId?.trim() || !expectedAttempt) return false;
        try {
            const result = await executeAction('ui.voice_global.turn_control', { expectedAttempt, control });
            return VoiceConversationActionOutputSchemas['ui.voice_global.turn_control'].parse(result).status === 'completed';
        } catch (error) {
            fireAndForget(Promise.reject(error), { tag: `VoiceSurface.${control}` });
            return false;
        }
    };
    return {
        onBargeIn: () => turnControl('interrupt'),
        onCancelTurn: () => turnControl('cancel'),
        /** Ordinary navigation to a Session through `session.open`; moving the Voice agent is teleport's job. */
        onOpenSession: (address: Readonly<{ sessionId: string; serverId: string | null }>) => {
            const sessionId = address.sessionId.trim();
            if (!sessionId) return;
            const serverId = address.serverId;
            // The Session target resolves against the context Home, so the exact Home travels there too.
            fireAndForget((async () => requireActionSuccess(await executeScopedAction(
                'session.open',
                { sessionId, ...(serverId ? { serverId } : {}) },
                { surface: 'ui', defaultSessionId: sessionId, ...(serverId ? { serverId } : {}) },
            )))(), { tag: 'VoiceSurface.openSession' });
        },
    };
}
