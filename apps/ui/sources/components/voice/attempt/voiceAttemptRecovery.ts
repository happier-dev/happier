import { Linking, Platform } from 'react-native';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import type { VoiceConnectRecoveryTarget } from '@/components/voice/surface/resolveVoiceConnectRecoveryTarget';
import type { VoiceSurfaceRecovery } from '@/components/voice/surface/resolveVoiceSurfaceRecovery';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import type { VoiceMachineRecoveryAction } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import { VOICE_SETTINGS_PROVIDER_FOCUS_TARGET } from '@/voice/settings/voiceSettingsRouteFocus';
import { fireAndForget } from '@/utils/system/fireAndForget';

/**
 * The Agent runtime a recovery would install, update or connect: the exact
 * contribution identity plus the exact machine it must be installed on.
 */
export type VoiceAttemptRecoveryRuntimeTarget = Readonly<{
    agentId: string;
    pluginId: string;
    machineId: string;
    serverId: string;
}>;

export type VoiceAttemptRecoveryContext = Readonly<{
    connectRecoveryTarget: VoiceConnectRecoveryTarget;
    runtimeRecoveryTarget: VoiceAttemptRecoveryRuntimeTarget | null;
    /** The running attempt's control session, when one exists. */
    attemptSessionId: string | null;
    /** The conversation the caller would start when nothing is running. */
    startSessionId: string | null;
    globalStartAuthorized: boolean;
}>;

/**
 * Whether the offered recovery can actually reach somewhere that fixes the
 * failure.
 *
 * A recovery affordance that resolves to nothing is worse than none: it reads
 * as help and does nothing. `connect_agent` needs a resolvable Connected
 * Account, the Agent-runtime recoveries need the exact agent/machine identity,
 * and a retry needs some conversation to retry.
 */
export function resolveVoiceAttemptRecoveryAvailable(
    recovery: VoiceSurfaceRecovery | null,
    context: VoiceAttemptRecoveryContext,
): boolean {
    if (recovery === null) return false;
    switch (recovery.kind) {
        case 'connect_agent':
            return context.connectRecoveryTarget.kind !== 'unavailable';
        case 'install_agent_runtime':
        case 'update_agent_runtime':
            return context.runtimeRecoveryTarget !== null;
        case 'retry':
        case 'reconnect':
            return normalizeNonEmptyString(context.attemptSessionId) !== null
                || normalizeNonEmptyString(context.startSessionId) !== null
                || context.globalStartAuthorized;
        default:
            return true;
    }
}

/**
 * The one recovery dispatch every Voice surface fires.
 *
 * Horizon, the orb and the composer planet all reach the *same* remedy for the
 * same failure: the exact Connected Account route, the exact Agent runtime
 * install screen, the platform microphone settings, or a retry of the exact
 * conversation. Placement decides where the affordance is drawn, never what it
 * does.
 */
export function createVoiceAttemptRecoveryDispatch(params: Readonly<{
    recoveryAction: VoiceMachineRecoveryAction | null;
    /**
     * A provider the user selected but has not finished connecting: the same
     * problem as a failed attempt, before it has had a chance to fail. Voice
     * settings is where it is finished.
     */
    setupIncomplete: boolean;
    context: VoiceAttemptRecoveryContext;
    navigate: (href: unknown) => void;
}>): () => void {
    const { context, navigate, recoveryAction, setupIncomplete } = params;
    return () => {
        if (recoveryAction === 'connect_agent') {
            if (context.connectRecoveryTarget.kind === 'unavailable') return;
            navigate(
                context.connectRecoveryTarget.kind === 'exact'
                    ? context.connectRecoveryTarget.route
                    : context.connectRecoveryTarget.kind === 'provider_settings'
                        ? VOICE_SETTINGS_PROVIDER_FOCUS_TARGET
                        : SETTINGS_ROUTES.connectedServices,
            );
            return;
        }
        if (recoveryAction === 'install_agent_runtime' || recoveryAction === 'update_agent_runtime') {
            const runtimeRecoveryTarget = context.runtimeRecoveryTarget;
            if (!runtimeRecoveryTarget) return;
            navigate({
                pathname: '/(app)/settings/agents/[agentId]',
                params: {
                    agentId: runtimeRecoveryTarget.agentId,
                    pluginId: runtimeRecoveryTarget.pluginId,
                    machineId: runtimeRecoveryTarget.machineId,
                    serverId: runtimeRecoveryTarget.serverId,
                    installIntent: recoveryAction === 'update_agent_runtime' ? 'update' : 'install',
                },
            });
            return;
        }
        if (recoveryAction === 'review_credentials') {
            navigate(VOICE_SETTINGS_PROVIDER_FOCUS_TARGET);
            return;
        }
        if (recoveryAction === 'open_settings' || recoveryAction === 'open_settings_then_reconnect') {
            if (Platform.OS === 'web') {
                navigate(SETTINGS_ROUTES.voice);
                return;
            }
            fireAndForget(
                Linking.openSettings().catch(() => navigate(SETTINGS_ROUTES.voice)),
                { tag: 'VoiceAttemptControl.openSettings' },
            );
            return;
        }
        if (recoveryAction === 'retry' || recoveryAction === 'reconnect') {
            /*
             * The running attempt first, then the caller's stated target. A retry
             * that fell back to the global start whenever no attempt was running
             * would start a *different* conversation from the one the surface
             * named — the retarget the attempt contract forbids.
             */
            const retrySessionId = normalizeNonEmptyString(context.attemptSessionId)
                ?? normalizeNonEmptyString(context.startSessionId)
                ?? (context.globalStartAuthorized ? '' : null);
            if (retrySessionId === null) return;
            fireAndForget(
                voiceSessionManager.toggle(retrySessionId),
                { tag: 'VoiceAttemptControl.recover' },
            );
            return;
        }
        if (setupIncomplete) navigate(VOICE_SETTINGS_PROVIDER_FOCUS_TARGET);
    };
}
