import { teleportVoiceAgentToSessionRoot } from '@/voice/agent/teleportVoiceAgentToSessionRoot';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import { localVoiceRuntimeController } from '@/voice/local/localVoiceRuntimeController';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { fireAndForget } from '@/utils/system/fireAndForget';

import type { VoiceSurfaceVariant } from './voiceSurfaceTypes';

export function createVoiceSurfaceActionHandlers(params: Readonly<{
    activeAdapterId: string | null;
    allowsGlobalStart: boolean;
    canMute: boolean;
    canStop: boolean;
    fallbackOpenConversationControlSessionId: string | null;
    openConversationSessionId: string | null;
    providerId: string;
    routeSessionId: string | null;
    router: { push: (href: any) => void };
    sessionId: string | null | undefined;
    snapSessionId: string | null;
    muted: boolean;
    startSessionId: string | null;
    variant: VoiceSurfaceVariant;
}>) {
    return {
        onBargeIn: () => {
            if (typeof params.snapSessionId !== 'string') return;
            const sessionId = params.snapSessionId.trim();
            if (!sessionId) return;
            fireAndForget(localVoiceRuntimeController.toggleTurn(sessionId), { tag: 'VoiceSurface.bargeIn' });
        },
        onCancelTurn: () => {
            if (typeof params.snapSessionId !== 'string') return;
            const sessionId = params.snapSessionId.trim();
            if (!sessionId) return;
            fireAndForget(voiceSessionManager.interrupt(sessionId), { tag: 'VoiceSurface.cancelTurn' });
        },
        onToggleMute: () => {
            if (!params.canMute || typeof params.snapSessionId !== 'string') return;
            const sessionId = params.snapSessionId.trim();
            if (!sessionId) return;
            fireAndForget(voiceSessionManager.setMuted(sessionId, !params.muted), { tag: 'VoiceSurface.mute' });
        },
        onOpenConversation: () => {
            fireAndForget((async () => {
                if (!params.openConversationSessionId) return;
                let nextSessionId = params.openConversationSessionId;
                const requestedTargetSessionId =
                    normalizeNonEmptyString(
                        params.variant === 'session' ? (params.sessionId ?? null) : (params.routeSessionId ?? null),
                    );
                const existingBinding =
                    voiceConversationBindingResolver.resolveByConversationSessionId({
                        conversationSessionId: params.openConversationSessionId,
                    })
                    ?? null;
                const shouldRebindOpenConversation =
                    !existingBinding
                    || normalizeNonEmptyString(existingBinding.targetSessionId) !== requestedTargetSessionId;
                const rebindAdapterId =
                    normalizeNonEmptyString(existingBinding?.adapterId)
                    ?? normalizeNonEmptyString(params.activeAdapterId)
                    ?? normalizeNonEmptyString(params.providerId);
                if (shouldRebindOpenConversation && params.fallbackOpenConversationControlSessionId && rebindAdapterId) {
                    const rebound = await voiceSessionBindingManager.ensureBound({
                        adapterId: rebindAdapterId,
                        controlSessionId: params.fallbackOpenConversationControlSessionId,
                        requestedTargetSessionId,
                    }).catch(() => null);
                    if (rebound?.conversationSessionId) {
                        nextSessionId = rebound.conversationSessionId;
                    }
                }
                params.router.push(`/session/${nextSessionId}` as any);
            })(), { tag: 'VoiceSurface.openConversation' });
        },
        onTeleport: () => {
            const sessionId = String(params.sessionId ?? '').trim();
            if (!sessionId) return;
            fireAndForget(teleportVoiceAgentToSessionRoot({ sessionId }), { tag: 'VoiceSurface.teleport' });
        },
        onTogglePress: () => {
            if (params.canStop) {
                const sessionId = typeof params.snapSessionId === 'string' ? params.snapSessionId.trim() : '';
                if (!sessionId) return;
                fireAndForget(voiceSessionManager.stop(sessionId), { tag: 'VoiceSurface.stop' });
                return;
            }
            const resolvedStartSessionId = params.allowsGlobalStart ? (params.startSessionId ?? '') : params.startSessionId;
            if (!resolvedStartSessionId && !params.allowsGlobalStart) return;
            fireAndForget(voiceSessionManager.toggle(resolvedStartSessionId ?? ''), { tag: 'VoiceSurface.toggle' });
        },
    };
}
