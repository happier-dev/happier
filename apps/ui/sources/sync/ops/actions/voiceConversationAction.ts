import { getCurrentAppShellVoiceProviderActivation } from '@/components/appShell/plugins/committedPluginUiProjection';
import { VoiceConversationActionInputSchemas, type VoiceConversationActionId, type VoiceConversationStatus } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import { Linking, Platform } from 'react-native';
import { readMicrophonePermissionState, requestMicrophonePermission, type MicrophonePermissionState } from '@/utils/platform/microphonePermissions';
import { storage } from '@/sync/domains/state/storage';
import { voiceSettingsParse, readVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { getFocusedSessionAddress } from '@/sync/domains/session/sessionSurfaceVisibility';
import { getFocusedDesktopAppWindowSurface } from '@/desktop/window/appWindowSurface';
import { resolveDesktopWindowContext } from '@/desktop/window/isDesktopAuxiliaryWindowContext';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { isRuntimeFeatureEnabled } from '@/sync/domains/features/featureDecisionInputs';
import { getConnectedServiceRegistrySnapshot } from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { resolveVoiceIdleTarget, useVoiceTargetStore, type VoiceStartIntent, type VoiceIdleTarget } from '@/voice/runtime/voiceTargetStore';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { resolveVoicePresentedProviderId } from '@/voice/settings/resolveVoiceProviderId';
import { getVoiceAdapterRegistry, canVoiceAdapterStartNewConversation, resolveVoiceAdapterSurfaceCapabilities } from '@/voice/session/voiceAdapterRegistry';
import { voiceSessionManager } from '@/voice/session/voiceSession';
import { getVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { canDismissVoiceSessionFailedAttempt, dismissVoiceSessionEndedAttempt, getVoiceSessionEndedAttempt,
    getVoiceSessionPresentedAttemptId, getVoiceSessionPresentedBinding, getVoiceSessionRestartTarget } from '@/voice/session/voiceSessionStore';
import { resolveVoiceBindingBySessionId } from '@/voice/binding/resolveVoiceBindingBySessionId';
import { resolveVoiceExecutionMachinePresentationFromState } from '@/voice/credentials/useExecutionMachinePresentation';
import { resolveVoiceStartAdmission, resolveCurrentVoiceRuntimePlatform } from '@/components/voice/surface/resolveVoiceStartAdmission';
import { resolveVoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import { resolveVoiceSurfaceRecovery } from '@/components/voice/surface/resolveVoiceSurfaceRecovery';
import { resolveVoiceConnectRecoveryTarget } from '@/components/voice/surface/resolveVoiceConnectRecoveryTarget';
import { resolveVoiceAttemptControl } from '@/components/voice/attempt/resolveVoiceAttemptControl';
import { projectVoiceAttemptPresentation } from '@/components/voice/attempt/projectVoiceAttemptPresentation';
import { readSafeVoiceRuntimeFailureCode } from '@/voice/runtime/voiceRuntimeFailureCode';
import { resolveAgentCatalogTitle } from '@/agents/backendCatalog/agentCatalogProjection';
import { resolveVoiceServiceTitle } from '@/voice/registry/voiceProviderPresentation';
import { createPluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { t, tLoose } from '@/text';
import { executeVoiceAttemptRecovery, resolveVoiceAttemptRecoveryAvailable, resolveVoiceAttemptRecoveryRuntimeTarget,
    type VoiceAttemptRecoveryContext } from '@/components/voice/attempt/voiceAttemptRecovery';
import type { VoiceAdapterSurfaceCapabilities } from '@/voice/session/types';
import type { VoiceMachineRecoveryAction } from '@/voice/runtime/machine/voiceConversationRuntimeTypes';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { resolveVoiceConversationNavigationAddress } from '@/voice/binding/resolveVoiceConversationNavigationAddress';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { hasVoiceTranscriptPresentation, revealVoiceCompanionSection, setVoiceGlanceOpen, setVoiceSetupOpen, setVoicePresencePosition } from '@/components/voice/presence/voiceCompanionSectionReveal';
import { setVoiceActivityFeedExpanded } from '@/components/voice/surface/voiceActivityFeedExpansionStore';

import { createUiSessionSpawnUserAttemptId } from '@/sync/domains/session/spawn/spawnSessionNonce';
import type { VoiceConversationSelection } from '@/voice/binding/voiceConversationBindingTypes';

const registry = createDefaultVoiceProviderRegistry();

async function readConversation(target: VoiceStartIntent = { kind: 'default' }): Promise<Readonly<{
    ownsVoiceRuntime: boolean;
    voice: VoiceConversationStatus;
    idleTarget: VoiceIdleTarget;
    context: VoiceAttemptRecoveryContext;
    recoveryAction: VoiceMachineRecoveryAction | null;
    setupIncomplete: boolean;
    capabilities: VoiceAdapterSurfaceCapabilities | null;
    navigation: Readonly<{ href: unknown }> | null;
}>> {
    const ownsVoiceRuntime = resolveDesktopWindowContext().role === 'primary';
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
        restartTarget: getVoiceSessionRestartTarget(providerId, state.profileScope),
        allowsGlobalStart: capabilities?.allowsGlobalStart === true, focusedSessionAddress: getFocusedSessionAddress(),
        focusedWindowSurface: getFocusedDesktopAppWindowSurface(), currentAccountId: state.profileScope?.accountId,
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
    const executionMachine = attemptId ? null : resolveVoiceExecutionMachinePresentationFromState(state);
    const admittedRecovery = snapshot.recoveryTarget;
    const agent = attemptId ? admittedRecovery?.agentRuntime : capabilities?.agentRuntime;
    const machineId = attemptId ? admittedRecovery?.machineId
        : bindingScope === 'session' ? metadata?.machineId : executionMachine?.machineId;
    const runtimeRecoveryTarget = resolveVoiceAttemptRecoveryRuntimeTarget({ agentRuntime: agent ?? null, machineId,
        serverId: attemptId ? admittedRecovery?.serverId
            : bindingScope === 'session' ? recoveryAddress?.serverId : state.profileScope?.serverId });
    const entry = registry.get(providerId);
    const context = { attemptSessionId: snapshot.sessionId, startSessionId: startAddress?.sessionId ?? null,
        globalStartAuthorized: bindingScope === 'global', runtimeRecoveryTarget,
        connectRecoveryTarget: resolveVoiceConnectRecoveryTarget({ uxDiagnostic: snapshot.errorConnectedServiceDiagnostic,
            agentRuntime: agent ?? null, bindingScope, runtimeTarget: runtimeRecoveryTarget,
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
        startAdmitted: ownsVoiceRuntime && voiceEnabled && admission.canStart && getVoiceSessionLifecycleController() !== null,
        hasRecovery: ownsVoiceRuntime && (resolveVoiceAttemptRecoveryAvailable(recovery, context) || setupIncomplete),
        canDismissFailedAttempt: canDismissVoiceSessionFailedAttempt(snapshot),
        setupOffered: ownsVoiceRuntime && (idleTarget.kind === 'global' || startAddress !== null) });
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
        inUseVoice: snapshot.status === 'connected' ? snapshot.inUseVoice ?? null : null,
        presentation: projectVoiceAttemptPresentation({
            control, attemptId, ended: visibleEnded !== null, errorCode: snapshot.errorCode, errorMessage: snapshot.errorMessage,
            errorConnectedServiceDiagnostic: snapshot.errorConnectedServiceDiagnostic,
            errorProviderMessage: snapshot.errorProviderMessage,
            recoveryAction, recoveryContext: context,
            serviceTitle: entry ? resolveVoiceServiceTitle(entry, tLoose, createPluginLocalizedTextResolver({ projection: null })) : t('voicePresence.title'),
            agentTitle: agent ? resolveAgentCatalogTitle(agent.localId) : null,
            agentMachineLabel: attemptId ? admittedRecovery?.machineLabel ?? null
                : runtimeRecoveryTarget?.machineId === executionMachine?.machineId ? executionMachine?.machineLabel ?? null : null,
        }) };
    const navigationBinding = ended ? visibleEnded : binding;
    const navigationAddress = navigationBinding && navigationBinding.conversationSessionAddress
        ? resolveVoiceConversationNavigationAddress({ ...navigationBinding, conversationSessionAddress: navigationBinding.conversationSessionAddress }) : null;
    const navigation = navigationBinding ? { href: navigationAddress
        ? buildScopedSessionRouteHref({ sessionId: navigationAddress.sessionId, serverId: navigationAddress.serverId })
        : SETTINGS_ROUTES.voiceHistory } : null;
    return { ownsVoiceRuntime, voice, idleTarget, context, recoveryAction, setupIncomplete, capabilities, navigation };
}

export async function executeVoiceConversationAction(
    actionId: VoiceConversationActionId,
    input: unknown,
    deps: Readonly<{ navigate: (href: unknown) => void | Promise<void>; isCurrent?: () => boolean; signal?: AbortSignal }>,
): Promise<Readonly<{ status: 'completed'; voice: VoiceConversationStatus; permission?: MicrophonePermissionState }>
    | Readonly<{ status: 'unavailable'; code: string; voice: VoiceConversationStatus; permission?: MicrophonePermissionState }>> {
    const parsed = VoiceConversationActionInputSchemas[actionId].safeParse(input);
    if (parsed.success && ['ui.voice_global.start', 'ui.voice_global.new_conversation', 'ui.voice_global.continue_conversation'].includes(actionId)
        && resolveDesktopWindowContext().role === 'primary') {
        const providerId = resolveVoicePresentedProviderId(voiceSessionManager.getSnapshot(),
            voiceSettingsParse(storage.getState().settings.voice), registry);
        if (providerId && !getVoiceAdapterRegistry().get(providerId)) {
            await getCurrentAppShellVoiceProviderActivation(providerId);
        }
    }
    const current = await readConversation(parsed.success && 'target' in parsed.data ? parsed.data.target : undefined);
    const unavailable = (code: string) => ({ status: 'unavailable' as const, code, voice: current.voice,
        ...(actionId === 'ui.voice_global.setup.microphone.permission.request' ? { permission: 'unknown' as const } : {}) });
    if (deps.isCurrent?.() === false) return unavailable('voice_action_account_changed');
    if (!parsed.success) return unavailable('invalid_voice_action_input');
    // History is ordinary local navigation. The retained primary owns every Voice runtime effect.
    if (!current.ownsVoiceRuntime && actionId !== 'ui.voice_global.conversations.open') return unavailable('voice_presentation_unavailable');
    const value = parsed.data;
    if (actionId === 'ui.voice_global.get') return { status: 'completed', voice: current.voice };
    if (actionId === 'ui.voice_global.setup.microphone.permission.request') {
        const permission = readMicrophonePermissionState(await requestMicrophonePermission());
        return permission === 'granted' ? { status: 'completed', permission, voice: current.voice }
            : { status: 'unavailable', permission, code: permission === 'denied' ? 'voice_microphone_permission_denied'
                : permission === 'unavailable' ? 'voice_microphone_unavailable' : 'voice_microphone_permission_unavailable', voice: current.voice };
    }
    if (actionId === 'ui.voice_global.setup.system_settings.open') {
        if (Platform.OS === 'web') return unavailable('voice_system_settings_unavailable');
        try { await Linking.openSettings(); }
        catch { return unavailable('voice_system_settings_unavailable'); }
        return { status: 'completed', voice: current.voice };
    }
    let presented: boolean | null = null;
    switch (actionId) {
        case 'ui.voice_global.glance.open': presented = setVoiceGlanceOpen(true); break;
        case 'ui.voice_global.glance.close': presented = setVoiceGlanceOpen(false); break;
        case 'ui.voice_global.companion.reveal': presented = revealVoiceCompanionSection(); break;
        case 'ui.voice_global.setup.open': presented = setVoiceSetupOpen(true); break;
        case 'ui.voice_global.setup.close': presented = setVoiceSetupOpen(false); break;
        case 'ui.voice_global.position.set':
            presented = 'x' in value && 'y' in value && setVoicePresencePosition({ x: value.x, y: value.y }); break;
        case 'ui.voice_global.transcript.set_visible':
            if (!('visible' in value)) return unavailable('invalid_voice_action_input');
            if (!hasVoiceTranscriptPresentation()) return unavailable('voice_presentation_unavailable');
            if (value.visible && !voiceSettingsParse(storage.getState().settings.voice).ui.activityFeedEnabled) return unavailable('voice_transcript_unavailable');
            presented = !value.visible || revealVoiceCompanionSection() || setVoiceGlanceOpen(true);
            if (presented) setVoiceActivityFeedExpanded(value.visible);
            break;
    }
    if (presented !== null) return presented ? { status: 'completed', voice: current.voice } : unavailable('voice_presentation_unavailable');
    // Preparation can await feature availability. A start admitted at rest must never become
    // toggle's End command for an attempt another surface started while this caller was waiting.
    if (!voiceSessionManager.matchesAttempt(current.voice.attemptId)) return unavailable('stale_voice_attempt');
    let conversationSelection: VoiceConversationSelection | undefined;
    let startFailureCode: string | null = null;
    if (actionId === 'ui.voice_global.start' || actionId === 'ui.voice_global.new_conversation') {
        const latest = voiceSessionManager.getSnapshot();
        if (!current.voice.canStart || latest.status !== 'disconnected' || latest.canStop) return unavailable('voice_start_unavailable');
        if (actionId === 'ui.voice_global.new_conversation') {
            if (!canVoiceAdapterStartNewConversation(current.capabilities, current.idleTarget.kind)) {
                return unavailable('voice_new_conversation_unavailable');
            }
            conversationSelection = { kind: 'new', creationKey: createUiSessionSpawnUserAttemptId() };
        }
        try {
            await voiceSessionManager.toggle(current.idleTarget.kind === 'session' ? current.idleTarget.sessionAddress : null, conversationSelection);
        } catch (error) {
            startFailureCode = readSafeVoiceRuntimeFailureCode(error);
            if (!startFailureCode) throw error;
        }
    } else {
        if (!('expectedAttempt' in value) || typeof value.expectedAttempt !== 'string'
            || !voiceSessionManager.matchesAttempt(value.expectedAttempt)) return unavailable('stale_voice_attempt');
        const sessionId = current.voice.sessionId;
        switch (actionId) {
            case 'ui.voice_global.open_conversation':
                if (!current.navigation) return unavailable('voice_conversation_navigation_unavailable');
                await deps.navigate(current.navigation.href); break;
            case 'ui.voice_global.end':
                if ((!current.voice.canStop && !current.voice.canDismissFailedAttempt) || !sessionId) return unavailable('voice_end_unavailable');
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
                // Retire a pending capture immediately; waiting for ready before cancel can reopen the mic after release.
                const cancel = () => { void held.cancel().catch(() => undefined); };
                deps.signal?.addEventListener('abort', cancel, { once: true });
                try {
                    if (deps.signal?.aborted) cancel();
                    if (!await held.ready || deps.isCurrent?.() === false || deps.signal?.aborted) {
                        await held.cancel();
                        return unavailable('voice_hold_unavailable');
                    }
                } finally { deps.signal?.removeEventListener('abort', cancel); }
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
    return startFailureCode
        ? { status: 'unavailable', code: startFailureCode, voice: resultVoice }
        : { status: 'completed', voice: resultVoice };
}
