import { teleportVoiceAgentToSessionRoot } from '@/voice/agent/teleportVoiceAgentToSessionRoot';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { NavigationFocusReturnCapture } from '@/utils/navigation/useNavigationFocusReturn';

import type { VoiceSurfaceVariant } from './voiceSurfaceTypes';

/**
 * The Voice surface's own actions. Recovery is **not** one of them: the
 * placement-neutral attempt projection owns the single recovery derivation and
 * dispatch every surface fires (`voiceAttemptRecovery.ts`).
 */
export function createVoiceSurfaceActionHandlers(params: Readonly<{
    activeAdapterId: string | null;
    fallbackOpenConversationControlSessionId: string | null;
    openConversationSessionId: string | null;
    providerId: string;
    routeSessionId: string | null;
    router: { push: (href: any) => void };
    captureNavigationFocusReturn?: () => NavigationFocusReturnCapture;
    navigateWithFocusReturn?: (navigate: () => void) => void;
    sessionId: string | null | undefined;
    snapSessionId: string | null;
    variant: VoiceSurfaceVariant;
}>) {
    const navigate = (href: unknown) => {
        const performNavigation = () => params.router.push(href as any);
        if (params.navigateWithFocusReturn) {
            params.navigateWithFocusReturn(performNavigation);
            return;
        }
        performNavigation();
    };

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
        onOpenConversation: () => {
            const openConversationSessionId = params.openConversationSessionId;
            if (!openConversationSessionId) return;
            const focusReturn = params.captureNavigationFocusReturn?.();
            fireAndForget((async () => {
                try {
                    // The binding owner decides whether to rebind on open; the surface
                    // only requests "open conversation X for control session Y targeting Z".
                    const requestedTargetSessionId =
                        normalizeNonEmptyString(
                            params.variant === 'session' ? (params.sessionId ?? null) : (params.routeSessionId ?? null),
                        );
                    const result = await voiceSessionBindingManager.ensureBoundForOpenConversation({
                        openConversationSessionId,
                        fallbackControlSessionId: params.fallbackOpenConversationControlSessionId,
                        activeAdapterId: params.activeAdapterId,
                        providerId: params.providerId,
                        requestedTargetSessionId,
                    });
                    const nextSessionId = result
                        ? result.conversationSessionId
                        : openConversationSessionId;
                    if (!nextSessionId) {
                        // A targetless direct-media attempt is attached to the hidden
                        // Voice History carrier. Ordinary session routes intentionally
                        // reject that carrier, so its only valid projection is History.
                        const performNavigation = () => params.router.push(SETTINGS_ROUTES.voiceHistory);
                        if (focusReturn) {
                            focusReturn.navigate(performNavigation);
                            return;
                        }
                        navigate(SETTINGS_ROUTES.voiceHistory);
                        return;
                    }
                    const performNavigation = () => params.router.push(`/session/${nextSessionId}` as any);
                    if (focusReturn) {
                        focusReturn.navigate(performNavigation);
                        return;
                    }
                    navigate(`/session/${nextSessionId}`);
                } catch (error) {
                    focusReturn?.cancel();
                    throw error;
                }
            })(), { tag: 'VoiceSurface.openConversation' });
        },
        onTeleport: () => {
            const sessionId = String(params.sessionId ?? '').trim();
            if (!sessionId) return;
            fireAndForget(teleportVoiceAgentToSessionRoot({ sessionId }), { tag: 'VoiceSurface.teleport' });
        },
    };
}
