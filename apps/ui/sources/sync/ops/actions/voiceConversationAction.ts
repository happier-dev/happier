import { VoiceConversationActionInputSchemas, type VoiceConversationActionId, type VoiceConversationStatus } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import { Platform } from 'react-native';
import { storage } from '@/sync/domains/state/storage';
import { voiceSettingsParse, readVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { getFocusedSessionAddress } from '@/sync/domains/session/sessionSurfaceVisibility';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { isRuntimeFeatureEnabled } from '@/sync/domains/features/featureDecisionInputs';
import { getConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveVoiceIdleTarget, useVoiceTargetStore, type VoiceStartIntent, type VoiceIdleTarget } from '@/voice/runtime/voiceTargetStore';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { resolveVoicePresentedProviderId } from '@/voice/settings/resolveVoiceProviderId';
import { resolveVoiceAdapterSurfaceCapabilities } from '@/voice/session/voiceAdapterRegistry';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { getVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { canDismissVoiceSessionFailedAttempt, dismissVoiceSessionEndedAttempt, getVoiceSessionEndedAttempt,
    getVoiceSessionPresentedAttemptId, getVoiceSessionPresentedBinding } from '@/voice/session/voiceSessionStore';
import { resolveVoiceBindingBySessionId } from '@/voice/binding/resolveVoiceBindingBySessionId';
import { resolveVoiceExecutionMachinePresentationFromState } from '@/voice/credentials/useExecutionMachinePresentation';
import { resolveVoiceStartAdmission, resolveCurrentVoiceRuntimePlatform } from '@/components/voice/surface/resolveVoiceStartAdmission';
import { resolveVoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import { resolveVoiceSurfaceRecovery } from '@/components/voice/surface/resolveVoiceSurfaceRecovery';
import { resolveVoiceConnectRecoveryTarget } from '@/components/voice/surface/resolveVoiceConnectRecoveryTarget';
import { resolveVoiceAttemptControl } from '@/components/voice/attempt/resolveVoiceAttemptControl';
import { executeVoiceAttemptRecovery, resolveVoiceAttemptRecoveryAvailable, resolveVoiceAttemptRecoveryRuntimeTarget,
    type VoiceAttemptRecoveryContext } from '@/components/voice/attempt/voiceAttemptRecovery';
import type { VoiceAdapterSurfaceCapabilities } from '@/voice/session/types';
import type { VoiceMachineRecoveryAction } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';

const registry = createDefaultVoiceProviderRegistry();

async function readConversation(target: VoiceStartIntent = { kind: 'default' }): Promise<Readonly<{
    voice: VoiceConversationStatus;
    idleTarget: VoiceIdleTarget;
    context: VoiceAttemptRecoveryContext;
    recoveryAction: VoiceMachineRecoveryAction | null;
    setupIncomplete: boolean;
    capabilities: VoiceAdapterSurfaceCapabilities | null;
}>> {
    let state = storage.getState();
    let voiceSettings = voiceSettingsParse(state.settings.voice);
    let snapshot = voiceSessionManager.getSnapshot();
    let providerId = resolveVoicePresentedProviderId(snapshot, voiceSettings, registry) ?? 'off';
    let capabilities = resolveVoiceAdapterSurfaceCapabilities(providerId, voiceSettings);
    let voiceAgentEnabled = true;
    let voiceEnabled = true;
    // A probe can await a changed selection. Reload its actual inputs without recursive calls or a second cache.
    for (;;) {
        voiceEnabled = snapshot.status !== 'disconnected' || providerId === 'off'
            || await isRuntimeFeatureEnabled({ featureId: 'voice' });
        voiceAgentEnabled = snapshot.status !== 'disconnected' || capabilities?.requiresVoiceAgentFeature !== true
            || await isRuntimeFeatureEnabled({ featureId: 'voice.agent' });
        const latestState = storage.getState();
        const latestSnapshot = voiceSessionManager.getSnapshot();
        if (latestState.settings.voice === state.settings.voice && latestSnapshot.adapterId === snapshot.adapterId) {
            state = latestState;
            break;
        }
        state = latestState;
        voiceSettings = voiceSettingsParse(state.settings.voice);
        snapshot = latestSnapshot;
        providerId = resolveVoicePresentedProviderId(snapshot, voiceSettings, registry) ?? 'off';
        capabilities = resolveVoiceAdapterSurfaceCapabilities(providerId, voiceSettings);
    }
    const idleTarget = resolveVoiceIdleTarget({ intent: target, scopeDefault: voiceSettings.ui.scopeDefault,
        allowsGlobalStart: capabilities?.allowsGlobalStart === true, focusedSessionAddress: getFocusedSessionAddress(),
        lastFocusedSessionAddress: useVoiceTargetStore.getState().lastFocusedSessionAddress });
    const admission = resolveVoiceStartAdmission({ bindingScope: idleTarget.kind,
        daemonLocalVoiceUnavailable: !voiceAgentEnabled, globalStartAuthorized: idleTarget.kind === 'global' && capabilities?.allowsGlobalStart === true,
        providerId, platform: resolveCurrentVoiceRuntimePlatform(Platform.OS), providerSettings: registry.get(providerId)?.providerSettings ?? null,
        registry, startSessionId: idleTarget.kind === 'session' ? idleTarget.sessionAddress?.sessionId ?? null : null, voiceSettings });
    // Feature probes can await: read the incumbent again before any command is offered or dispatched.
    snapshot = voiceSessionManager.getSnapshot();
    const attemptId = getVoiceSessionPresentedAttemptId();
    const capturedTarget = voiceSessionManager.getAttemptTargetSessionAddress();
    const binding = getVoiceSessionPresentedBinding()
        ?? (snapshot.sessionId ? resolveVoiceBindingBySessionId({ sessionId: snapshot.sessionId, adapterId: snapshot.adapterId }) : null);
    const ended = snapshot.status === 'disconnected' ? getVoiceSessionEndedAttempt() : null;
    const visibleEnded = ended && areServerAccountScopesEqual(ended.accountScope, state.profileScope) ? ended : null;
    const bindingScope = attemptId ? (capturedTarget ? 'session' : 'global') : idleTarget.kind;
    const startAddress = idleTarget.kind === 'session' ? idleTarget.sessionAddress : null;
    const recoveryAddress = capturedTarget ?? (attemptId ? null : startAddress);
    const recoverySession = recoveryAddress ? state.sessions[recoveryAddress.sessionId] : null;
    const metadata = recoverySession?.serverId === recoveryAddress?.serverId && recoverySession ? readSessionOwnerMetadataView(recoverySession) : null;
    const executionMachine = resolveVoiceExecutionMachinePresentationFromState(state);
    const agent = capabilities?.agentRuntime;
    const machineId = bindingScope === 'session' ? metadata?.machineId : executionMachine.machineId;
    const runtimeRecoveryTarget = resolveVoiceAttemptRecoveryRuntimeTarget({ agentRuntime: agent ?? null, machineId,
        serverId: bindingScope === 'session' ? recoveryAddress?.serverId : state.profileScope?.serverId });
    const entry = registry.get(providerId);
    const context = { attemptSessionId: snapshot.sessionId, startSessionId: startAddress?.sessionId ?? null,
        globalStartAuthorized: bindingScope === 'global', runtimeRecoveryTarget,
        connectRecoveryTarget: resolveVoiceConnectRecoveryTarget({ agentRuntime: agent ?? null, bindingScope, runtimeTarget: runtimeRecoveryTarget,
            provider: entry ? { sourcePluginId: entry.source.kind === 'bundled' || entry.source.kind === 'external' ? entry.source.pluginId : null,
                connectedServicesBinding: entry.providerSettings?.connectedServicesBinding ?? null } : null,
            providerConfig: bindingScope === 'session' ? null : readVoiceProviderSettingsConfig(voiceSettings, providerId),
            sessionMetadata: metadata, connectedServiceEntries: getConnectedServiceRegistrySnapshot().entries }) };
    const recoveryAction = snapshot.errorRecoveryAction ?? (snapshot.presentationState === 'reconnecting' && snapshot.reconnectRetryAvailable ? 'retry' : null);
    const recovery = resolveVoiceSurfaceRecovery(recoveryAction);
    const setupIncomplete = !admission.connectedServicesBindingReady;
    const surfaceState = resolveVoiceSurfaceState(snapshot);
    const control = resolveVoiceAttemptControl({ surfaceState, tone: resolveVoiceSurfaceStatusPresentation(surfaceState).tone,
        status: snapshot.status, sessionId: snapshot.sessionId, canStop: snapshot.canStop,
        canCommitInput: snapshot.canCommitInput, muted: snapshot.micMuted === true, capturing: false,
        startAdmitted: voiceEnabled && admission.canStart && getVoiceSessionLifecycleController() !== null,
        hasRecovery: resolveVoiceAttemptRecoveryAvailable(recovery, context) || setupIncomplete,
        canDismissFailedAttempt: canDismissVoiceSessionFailedAttempt(snapshot), setupOffered: idleTarget.kind === 'global' || startAddress !== null });
    const voice: VoiceConversationStatus = { attemptId, adapterId: snapshot.adapterId, sessionId: snapshot.sessionId,
        status: snapshot.status, mode: snapshot.mode, target: attemptId
            ? (visibleEnded?.targetSessionAddress ?? capturedTarget) ? { kind: 'session', sessionAddress: visibleEnded?.targetSessionAddress ?? capturedTarget } : { kind: 'global' }
            : idleTarget,
        conversationSessionAddress: ended ? visibleEnded?.conversationSessionAddress ?? null
            : binding?.conversationSessionAddress ?? null,
        targetSessionAddress: ended ? visibleEnded?.targetSessionAddress ?? null
            : binding?.targetSessionAddress ?? capturedTarget,
        canStart: control.canStart, canStop: control.canStop, canMute: control.canMute,
        canCommitInput: control.canCommitInput === true, canHoldToTalk: state.localSettings.voiceHoldToTalkEnabled === true
            && snapshot.status === 'connected' && snapshot.canHoldToTalk === true,
        muted: control.muted, canDismissFailedAttempt: control.canDismissFailedAttempt === true,
        canDismissEnded: ended !== null, recoveryAction, availability: control.availability,
        inUseVoice: snapshot.status === 'connected' ? snapshot.inUseVoice ?? null : null };
    return { voice, idleTarget, context, recoveryAction, setupIncomplete, capabilities };
}

export async function executeVoiceConversationAction(
    actionId: VoiceConversationActionId,
    input: unknown,
    deps: Readonly<{ navigate: (href: unknown) => void; isCurrent?: () => boolean }>,
): Promise<Readonly<{ status: 'completed'; voice: VoiceConversationStatus }> | Readonly<{ status: 'unavailable'; code: string; voice: VoiceConversationStatus }>> {
    const parsed = VoiceConversationActionInputSchemas[actionId].safeParse(input);
    const current = await readConversation(parsed.success && 'target' in parsed.data ? parsed.data.target : undefined);
    const unavailable = (code: string) => ({ status: 'unavailable' as const, code, voice: current.voice });
    if (deps.isCurrent?.() === false) return unavailable('voice_action_account_changed');
    if (!parsed.success) return unavailable('invalid_voice_action_input');
    const value = parsed.data;
    if (actionId === 'ui.voice_global.get') return { status: 'completed', voice: current.voice };
    // Preparation can await feature availability. A start admitted at rest must never become
    // toggle's End command for an attempt another surface started while this caller was waiting.
    if (!voiceSessionManager.matchesAttempt(current.voice.attemptId)) return unavailable('stale_voice_attempt');
    if (actionId === 'ui.voice_global.start') {
        const latest = voiceSessionManager.getSnapshot();
        if (!current.voice.canStart || latest.status !== 'disconnected' || latest.canStop) return unavailable('voice_start_unavailable');
        await voiceSessionManager.toggle(current.idleTarget.kind === 'session' ? current.idleTarget.sessionAddress : null);
    } else {
        if (!('expectedAttempt' in value) || typeof value.expectedAttempt !== 'string'
            || !voiceSessionManager.matchesAttempt(value.expectedAttempt)) return unavailable('stale_voice_attempt');
        const sessionId = current.voice.sessionId;
        switch (actionId) {
            case 'ui.voice_global.end':
                if (!current.voice.canStop || !sessionId) return unavailable('voice_end_unavailable');
                await voiceSessionManager.stop(sessionId); break;
            case 'ui.voice_global.set_muted':
                if (!current.voice.canMute || !sessionId || !('muted' in value) || typeof value.muted !== 'boolean') return unavailable('voice_mute_unavailable');
                await voiceSessionManager.setMuted(sessionId, value.muted); break;
            case 'ui.voice_global.dismiss':
                if (!('kind' in value)) return unavailable('voice_dismiss_unavailable');
                if (value.kind === 'ended' && current.voice.canDismissEnded) dismissVoiceSessionEndedAttempt();
                else if (value.kind === 'failed' && current.voice.canDismissFailedAttempt) await voiceSessionManager.dismissFailedAttempt(sessionId);
                else return unavailable('voice_dismiss_unavailable');
                break;
            case 'ui.voice_global.recover':
                if (!await executeVoiceAttemptRecovery({ ...current, expectedAttempt: value.expectedAttempt, isCurrent: deps.isCurrent, navigate: deps.navigate })) return unavailable('voice_recovery_unavailable');
                break;
            case 'ui.voice_global.turn_control':
                if (!sessionId || !('control' in value)) return unavailable('voice_turn_control_unavailable');
                if (value.control === 'commit_input') {
                    if (!current.voice.canCommitInput) return unavailable('voice_commit_unavailable');
                    await voiceSessionManager.commitInput(sessionId);
                } else if (value.control === 'interrupt') {
                    if (current.capabilities?.bargeInEnabled !== true || current.voice.mode !== 'speaking' || current.voice.muted) return unavailable('voice_interrupt_unavailable');
                    await voiceSessionManager.bargeIn(sessionId);
                } else {
                    if (current.capabilities?.cancelResponse !== 'immediate' || current.voice.status !== 'connected'
                        || (current.voice.mode !== 'thinking' && current.voice.mode !== 'speaking')) return unavailable('voice_cancel_unavailable');
                    await voiceSessionManager.interrupt(sessionId);
                }
                break;
            case 'ui.voice_global.hold_begin': {
                if (!current.voice.canHoldToTalk || !sessionId) return unavailable('voice_hold_unavailable');
                const held = voiceSessionManager.beginHoldToTalk(sessionId);
                if (!held) return unavailable('voice_hold_unavailable');
                if (!await held.ready || deps.isCurrent?.() === false) {
                    await held.cancel();
                    return unavailable('voice_hold_unavailable');
                }
                break;
            }
            case 'ui.voice_global.hold_release':
            case 'ui.voice_global.hold_cancel':
                if (!sessionId || !await voiceSessionManager.finishHoldToTalk(sessionId, actionId === 'ui.voice_global.hold_release' ? 'release' : 'cancel')) return unavailable('voice_hold_unavailable');
                break;
            default: return unavailable('voice_action_unsupported');
        }
    }
    if (deps.isCurrent?.() === false) return unavailable('voice_action_account_changed');
    const resultVoice = (await readConversation(current.idleTarget)).voice;
    if (deps.isCurrent?.() === false) return unavailable('voice_action_account_changed');
    return { status: 'completed', voice: resultVoice };
}
