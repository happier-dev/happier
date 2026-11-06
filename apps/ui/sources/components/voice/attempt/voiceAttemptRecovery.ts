import { Linking, Platform } from 'react-native';

import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { buildSettingHref } from '@/components/settings/catalog/settingDeclarations';
import { VOICE_CONVERSATIONS_SETTINGS } from '@/voice/settings/voiceSettingsDeclarations';
import type { VoiceConnectRecoveryTarget } from '@/components/voice/surface/resolveVoiceConnectRecoveryTarget';
import type { VoiceSurfaceRecovery } from '@/components/voice/surface/resolveVoiceSurfaceRecovery';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import type { VoiceMachineRecoveryAction } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import {
    VOICE_SETTINGS_EXECUTION_MACHINE_FOCUS_TARGET,
    VOICE_SETTINGS_PROVIDER_FOCUS_TARGET,
} from '@/voice/settings/voiceSettingsRouteFocus';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolvePortableServerIdentityForRoutingId } from '@/sync/domains/server/resolvePortableServerIdentityForRoutingId';

/**
 * The Agent runtime a recovery would install, update or connect: the exact
 * contribution identity plus the exact machine it must be installed on.
 */
export type VoiceAttemptRecoveryRuntimeTarget = Readonly<{
    agentId: string;
    pluginId: string;
    machineId: string;
    serverIdentityId: string;
}>;

export function resolveVoiceAttemptRecoveryRuntimeTarget(input: Readonly<{
    agentRuntime: Readonly<{ localId: string; pluginId: string }> | null;
    serverId: unknown;
    machineId: unknown;
}>): VoiceAttemptRecoveryRuntimeTarget | null {
    const agentId = normalizeNonEmptyString(input.agentRuntime?.localId);
    const pluginId = normalizeNonEmptyString(input.agentRuntime?.pluginId);
    const machineId = normalizeNonEmptyString(input.machineId);
    const serverIdentityId = resolvePortableServerIdentityForRoutingId(normalizeNonEmptyString(input.serverId));
    return agentId && pluginId && machineId && serverIdentityId ? { agentId, pluginId, machineId, serverIdentityId } : null;
}

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
 * Whether Connect is repaired on the exact Agent's own settings page, on the machine that refused
 * it. Dispatch and the recovery's label read this one answer.
 */
export function opensAgentRuntimeSettings(
    recoveryAction: VoiceMachineRecoveryAction | null,
    context: VoiceAttemptRecoveryContext,
): boolean {
    return recoveryAction === 'connect_agent'
        && context.connectRecoveryTarget.kind === 'default'
        && context.runtimeRecoveryTarget !== null;
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
export async function executeVoiceAttemptRecovery(params: Readonly<{
    expectedAttempt?: string | null;
    isCurrent?: () => boolean;
    recoveryAction: VoiceMachineRecoveryAction | null;
    errorReason?: string | null;
    /**
     * A provider the user selected but has not finished connecting: the same
     * problem as a failed attempt, before it has had a chance to fail. Voice
     * settings is where it is finished.
     */
    setupIncomplete: boolean;
    context: VoiceAttemptRecoveryContext;
    navigate: (href: unknown) => void | Promise<void>;
}>): Promise<boolean> {
    const { context, navigate, recoveryAction, setupIncomplete } = params;
    if (params.isCurrent?.() === false) return false;
    if ('expectedAttempt' in params && !voiceSessionManager.matchesAttempt(params.expectedAttempt ?? null)) return false;
        const connectAgentRuntime = opensAgentRuntimeSettings(recoveryAction, context);
        if (recoveryAction === 'connect_agent' && !connectAgentRuntime) {
            if (context.connectRecoveryTarget.kind === 'unavailable') return false;
            await navigate(
                context.connectRecoveryTarget.kind === 'exact'
                    ? context.connectRecoveryTarget.route
                    : context.connectRecoveryTarget.kind === 'provider_settings'
                        ? VOICE_SETTINGS_PROVIDER_FOCUS_TARGET
                        : SETTINGS_ROUTES.agents,
            );
            return true;
        }
        if (connectAgentRuntime || recoveryAction === 'install_agent_runtime' || recoveryAction === 'update_agent_runtime') {
            const runtimeRecoveryTarget = context.runtimeRecoveryTarget;
            if (!runtimeRecoveryTarget) return false;
            await navigate({
                pathname: '/(app)/settings/agents/[agentId]',
                params: {
                    agentId: runtimeRecoveryTarget.agentId,
                    pluginId: runtimeRecoveryTarget.pluginId,
                    machineId: runtimeRecoveryTarget.machineId,
                    serverIdentityId: runtimeRecoveryTarget.serverIdentityId,
                    ...(!connectAgentRuntime
                        ? { installIntent: recoveryAction === 'update_agent_runtime' ? 'update' : 'install' }
                        : {}),
                },
            });
            return true;
        }
        if (recoveryAction === 'review_credentials') {
            await navigate(VOICE_SETTINGS_PROVIDER_FOCUS_TARGET);
            return true;
        }
        if (recoveryAction === 'select_execution_machine') {
            await navigate(VOICE_SETTINGS_EXECUTION_MACHINE_FOCUS_TARGET);
            return true;
        }
        if (recoveryAction === 'select_speech_engine') {
            await navigate(buildSettingHref(SETTINGS_ROUTES.voiceConversations, VOICE_CONVERSATIONS_SETTINGS.settings.sttProvider));
            return true;
        }
        if (recoveryAction === 'open_settings' || recoveryAction === 'open_settings_then_reconnect') {
            if (params.errorReason === 'usage_limit') {
                await navigate(buildSettingHref(SETTINGS_ROUTES.voiceConversations, VOICE_CONVERSATIONS_SETTINGS.settings.connectedServices));
                return true;
            }
            if (Platform.OS === 'web') {
                await navigate(SETTINGS_ROUTES.voice);
                return true;
            }
            await Linking.openSettings().catch(async () => {
                if (params.isCurrent?.() !== false) await navigate(SETTINGS_ROUTES.voice);
            });
            return params.isCurrent?.() !== false;
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
            if (retrySessionId === null) return false;
            await voiceSessionManager.retry(retrySessionId);
            return true;
        }
        if (setupIncomplete) {
            await navigate(VOICE_SETTINGS_PROVIDER_FOCUS_TARGET);
            return true;
        }
        return false;
}

export function createVoiceAttemptRecoveryDispatch(params: Parameters<typeof executeVoiceAttemptRecovery>[0]): () => Promise<boolean> {
    return () => {
        const pending = executeVoiceAttemptRecovery(params);
        fireAndForget(pending, { tag: 'VoiceAttemptControl.recover' });
        return pending;
    };
}
