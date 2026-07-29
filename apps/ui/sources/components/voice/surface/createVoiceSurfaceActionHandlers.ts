import { teleportVoiceAgentToSessionRoot } from '@/voice/agent/teleportVoiceAgentToSessionRoot';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { VoiceMachineRecoveryAction } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import { Linking, Platform } from 'react-native';
import type { NavigationFocusReturnCapture } from '@/utils/navigation/useNavigationFocusReturn';

import type { VoiceSurfaceVariant } from './voiceSurfaceTypes';
import { voiceSurfaceHaptics } from './voiceSurfaceHaptics';
import type { VoiceConnectRecoveryTarget } from './resolveVoiceConnectRecoveryTarget';

export function createVoiceSurfaceActionHandlers(params: Readonly<{
    activeAdapterId: string | null;
    globalStartAuthorized: boolean;
    canMute: boolean;
    canStop: boolean;
    fallbackOpenConversationControlSessionId: string | null;
    openConversationSessionId: string | null;
    providerId: string;
    connectRecoveryTarget: VoiceConnectRecoveryTarget;
    recoveryAction: VoiceMachineRecoveryAction | null;
    runtimeRecoveryTarget: Readonly<{
        agentId: string;
        pluginId: string;
        machineId: string;
        serverId: string;
    }> | null;
    routeSessionId: string | null;
    router: { push: (href: any) => void };
    captureNavigationFocusReturn?: () => NavigationFocusReturnCapture;
    navigateWithFocusReturn?: (navigate: () => void) => void;
    sessionId: string | null | undefined;
    snapSessionId: string | null;
    muted: boolean;
    startSessionId: string | null;
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
        onToggleMute: () => {
            if (!params.canMute || typeof params.snapSessionId !== 'string') return;
            const sessionId = params.snapSessionId.trim();
            if (!sessionId) return;
            fireAndForget(voiceSessionManager.setMuted(sessionId, !params.muted), { tag: 'VoiceSurface.mute' });
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
                        focusReturn?.cancel();
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
        onRecover: () => {
            if (params.recoveryAction === 'connect_agent') {
                if (params.connectRecoveryTarget.kind === 'unavailable') return;
                navigate(
                    params.connectRecoveryTarget.kind === 'exact'
                        ? params.connectRecoveryTarget.route
                        : params.connectRecoveryTarget.kind === 'provider_settings'
                            ? SETTINGS_ROUTES.voice
                            : SETTINGS_ROUTES.connectedServices,
                );
                return;
            }
            if (
                params.recoveryAction === 'install_agent_runtime'
                || params.recoveryAction === 'update_agent_runtime'
            ) {
                if (!params.runtimeRecoveryTarget) return;
                navigate({
                    pathname: '/(app)/settings/agents/[agentId]',
                    params: {
                        agentId: params.runtimeRecoveryTarget.agentId,
                        pluginId: params.runtimeRecoveryTarget.pluginId,
                        machineId: params.runtimeRecoveryTarget.machineId,
                        serverId: params.runtimeRecoveryTarget.serverId,
                        installIntent:
                            params.recoveryAction === 'update_agent_runtime'
                                ? 'update'
                                : 'install',
                    },
                });
                return;
            }
            if (params.recoveryAction === 'review_credentials') {
                navigate(SETTINGS_ROUTES.voice);
                return;
            }
            if (params.recoveryAction === 'open_settings' || params.recoveryAction === 'open_settings_then_reconnect') {
                if (Platform.OS === 'web') {
                    navigate(SETTINGS_ROUTES.voice);
                    return;
                }
                fireAndForget(
                    Linking.openSettings().catch(() => navigate(SETTINGS_ROUTES.voice)),
                    { tag: 'VoiceSurface.openSettings' },
                );
                return;
            }
            if (params.recoveryAction === 'retry' || params.recoveryAction === 'reconnect') {
                const retrySessionId = normalizeNonEmptyString(params.snapSessionId)
                    ?? normalizeNonEmptyString(params.startSessionId)
                    ?? (params.globalStartAuthorized ? '' : null);
                if (retrySessionId === null) return;
                fireAndForget(voiceSessionManager.toggle(retrySessionId), { tag: 'VoiceSurface.recover' });
            }
        },
        onTogglePress: () => {
            if (params.canStop) {
                const sessionId = typeof params.snapSessionId === 'string' ? params.snapSessionId.trim() : '';
                if (!sessionId) return;
                voiceSurfaceHaptics.notify('start_stop');
                fireAndForget(voiceSessionManager.stop(sessionId), { tag: 'VoiceSurface.stop' });
                return;
            }
            const resolvedStartSessionId = params.globalStartAuthorized ? (params.startSessionId ?? '') : params.startSessionId;
            if (!resolvedStartSessionId && !params.globalStartAuthorized) return;
            voiceSurfaceHaptics.notify('start_stop');
            fireAndForget(voiceSessionManager.toggle(resolvedStartSessionId ?? ''), { tag: 'VoiceSurface.toggle' });
        },
    };
}
