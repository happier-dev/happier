import * as React from 'react';

import { usePathname, useRouter } from 'expo-router';

import { useSetting } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { readVoiceProviderSettingsConfig, voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { t, tLoose } from '@/text';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';
import { isVoiceMachineErrorKind } from '@/voice/runtime/machine/voiceMachineError';
import { resolveVoiceMachineErrorTranslationKey } from '@/voice/runtime/machine/voiceMachineErrorCopy';
import { isHiddenSystemSession } from '@happier-dev/protocol';
import {
    overrideVoiceAttemptRecoveryProjection,
    useVoiceAttemptControl,
    VOICE_ATTEMPT_IDLE_TARGET_GLOBAL,
    type VoiceAttemptControlProjection,
    type VoiceAttemptIdleTarget,
    type VoiceAttemptRecoveryProjectionOverride,
} from '@/components/voice/attempt/useVoiceAttemptControl';

import { createVoiceSurfaceActionHandlers } from './createVoiceSurfaceActionHandlers';
import { useVoiceSurfaceStoreState } from './useVoiceSurfaceStoreState';
import { useVoiceSurfaceTargetState } from './useVoiceSurfaceTargetState';
import { resolveVoiceSurfaceRecovery } from './resolveVoiceSurfaceRecovery';
import type { VoiceSurfaceTranscriptEntry } from './mergeVoiceSurfaceTranscriptEntries';
import type { VoiceSurfaceProps } from './voiceSurfaceTypes';
import { resolveVoiceProviderIdForSurface } from '@/voice/settings/resolveVoiceProviderId';
import { getVoiceSessionAttemptId } from '@/voice/session/voiceSessionStore';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { resolveSelectedVoiceProviderTitleKey } from '@/voice/registry/providerSelection';
import {
    reconcileVoiceActivityFeedExpansion,
    toggleVoiceActivityFeedExpansion,
    useVoiceActivityFeedExpansion,
} from './voiceActivityFeedExpansionStore';
import { voiceSurfaceHaptics } from './voiceSurfaceHaptics';
import { voiceOutputStatusStore } from '@/voice/runtime/outputStatus/voiceOutputStatusStore';
import { useNavigationFocusReturn } from '@/utils/navigation/useNavigationFocusReturn';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useVoiceExecutionMachinePresentation } from '@/voice/credentials/useExecutionMachinePresentation';
import { normalizeNonEmptyString } from '@/voice/shared/normalizeNonEmptyString';
import { useProjectedConnectedServicesRegistry } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { resolveVoiceConnectRecoveryTarget } from './resolveVoiceConnectRecoveryTarget';
import { resolveVoiceStartAdmission } from './resolveVoiceStartAdmission';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

/**
 * Coding work the Voice conversation delegated to a session, kept on its own channel so an
 * agent-authored `display_status` line ("Codex is editing X") can never be confused with the
 * surface's own target/error subtitle.
 */
export type VoiceSurfaceDelegatedWork = Readonly<{
    sessionId: string;
    statusText: string | null;
    thinking: boolean;
}>;

export type VoiceSurfaceViewModel = Readonly<{
    attemptControl: VoiceAttemptControlProjection;
    activityFeedEnabled: boolean;
    canBargeIn: boolean;
    canCancelTurn: boolean;
    canOpenConversation: boolean;
    canTeleportToSessionRoot: boolean;
    controlsDisabled: boolean;
    controlsLoading: boolean;
    delegatedWork: VoiceSurfaceDelegatedWork | null;
    expanded: boolean;
    isMicCaptureActive: boolean;
    mode: string;
    /**
     * What the microphone is actually doing — muted, open, or closed.
     *
     * Distinct from `muteLabel`, which names the *action* a control performs. "Is my microphone
     * open" is the single fact a Voice user checks most often, and a half-duplex provider closes
     * capture while the assistant speaks even though nothing is muted; a presentation that showed
     * only muted/unmuted would report an open microphone that is not recording.
     */
    micStateLabel: string;
    muteLabel: string;
    providerLabel: string | null;
    startStopLabel: string;
    status: 'connecting' | 'connected' | 'error' | 'disconnected';
    subtitle: string | null;
    toggleActivityLabel: string;
    transcriptEntries: readonly VoiceSurfaceTranscriptEntry[];
    variant: VoiceSurfaceProps['variant'];
    visibleTranscriptEntries: readonly VoiceSurfaceTranscriptEntry[];
    onBargeIn: () => void;
    onCancelTurn: () => void;
    onOpenConversation: () => void;
    onTeleport: () => void;
    onToggleExpanded: () => void;
    style?: unknown;
}>;

export function useVoiceSurfaceModel(props: VoiceSurfaceProps): VoiceSurfaceViewModel | null {
    const router = useRouter();
    const navigateWithFocusReturn = useNavigationFocusReturn();
    const pathname = usePathname();
    const activeServerSnapshot = useActiveServerSnapshot();
    const voiceExecutionMachine = useVoiceExecutionMachinePresentation();
    const connectedServicesRegistry = useProjectedConnectedServicesRegistry();
    const snap = useVoiceSessionSnapshot();
    const voice: any = useSetting('voice');
    /*
     * Two full schema parses of the same setting, both memoized on the setting's
     * identity.
     *
     * Unmemoized they were the reason `VoiceSurfaceView`'s `React.memo` never
     * did anything (M2): a fresh `canonicalVoice` every render flows into
     * `connectRecoveryTarget` → `handlers` → `model`, so the seam handed the
     * view a new object on every unrelated parent render and every presentation
     * below it re-rendered. They are also the most expensive work in this hook.
     */
    const voicePrivacy = React.useMemo(() => readVoicePrivacySettings({ voice }), [voice]);
    const canonicalVoice = React.useMemo(() => voiceSettingsParse(voice), [voice]);
    const outputStatusSessionId = snap.sessionId ?? props.sessionId ?? null;
    const outputStatus = React.useSyncExternalStore(
        voiceOutputStatusStore.subscribe,
        () => voiceOutputStatusStore.readForSession(outputStatusSessionId),
        () => voiceOutputStatusStore.readForSession(outputStatusSessionId),
    );
    const providerId = resolveVoiceProviderIdForSurface(
        canonicalVoice,
        voiceProviderRegistry,
    ) ?? 'off';
    const providerEntry = voiceProviderRegistry.get(providerId);
    const providerTitleKey = resolveSelectedVoiceProviderTitleKey(canonicalVoice, voiceProviderRegistry);
    const providerLabel = providerTitleKey ? tLoose(providerTitleKey) : null;
    /*
     * §2.8 — no active Voice surface carries a provider/data-disclosure
     * affordance. The provider's processing disclosure renders in Voice settings
     * from its declaration (`VoiceProviderSection`, `BundledSpeechSettings`), and
     * `VOICE_SETTINGS_PROVIDER_FOCUS_TARGET` remains that screen's focus target;
     * the model does not project a control for it.
     */
    // Cheap synchronous derivation from the voice setting. Computed up front so the
    // store hook can avoid subscribing to (and projecting) sessionMessages when the
    // activity feed is hidden.
    const activityFeedEnabled = voice?.ui?.activityFeedEnabled === true;
    const {
        activeControlSession,
        currentSession,
        fallbackOpenConversationControlSessionId,
        openConversationSessionId,
        transcriptEntries,
        visibleTranscriptEntries,
    } = useVoiceSurfaceStoreState({
        activeControlSessionId: snap.sessionId ?? null,
        providerId,
        surfaceSessionId: props.sessionId ?? null,
        transcriptEnabled: activityFeedEnabled,
        voiceSettings: voice,
        voicePrivacy,
    });
    const {
        agentRuntime,
        bargeInEnabled,
        bindingScope,
        cancelResponseSupported,
        canTeleportToSessionRoot,
        daemonLocalVoiceUnavailable,
        locationAllowsVariant,
        routeSessionId,
        startSessionId,
        targetLabel,
    } = useVoiceSurfaceTargetState({
        pathname,
        providerId,
        sessionId: props.sessionId ?? null,
        variant: props.variant,
        voice,
        voicePrivacy,
    });
    const idleTarget = React.useMemo<VoiceAttemptIdleTarget>(
        () => bindingScope === 'global'
            ? VOICE_ATTEMPT_IDLE_TARGET_GLOBAL
            : { kind: 'session', sessionId: startSessionId ?? '' },
        [bindingScope, startSessionId],
    );
    const baseAttemptControl = useVoiceAttemptControl(idleTarget);
    const activityFeedExpansion = useVoiceActivityFeedExpansion();
    const attemptId = getVoiceSessionAttemptId();
    React.useEffect(() => {
        reconcileVoiceActivityFeedExpansion({
            attemptId,
            feedEnabled: activityFeedEnabled,
            autoExpand: canonicalVoice.ui.activityFeedAutoExpandOnStart,
        });
    }, [activityFeedEnabled, attemptId, canonicalVoice.ui.activityFeedAutoExpandOnStart]);
    const expanded = activityFeedExpansion.expanded;
    const onToggleExpanded = React.useCallback(() => toggleVoiceActivityFeedExpansion(), []);

    const isConnected = snap.status === 'connected';
    const currentSessionOwnerMetadata = currentSession
        ? readSessionOwnerMetadataView(currentSession)
        : null;

    const showSurface =
        providerId !== 'off'
        && locationAllowsVariant
        && !(props.variant === 'session' && isHiddenSystemSession({ metadata: currentSessionOwnerMetadata }));

    const globalStartAuthorized = bindingScope === 'global';
    // Admission has one owner, shared with every other surface that can start a conversation
    // (§5.6). Horizon composes its placement policy *over* that answer; it does not re-derive it.
    const startAdmission = resolveVoiceStartAdmission({
        bindingScope,
        daemonLocalVoiceUnavailable,
        globalStartAuthorized,
        providerId,
        providerSettings: providerEntry?.providerSettings ?? null,
        registry: voiceProviderRegistry,
        startSessionId,
        voiceSettings: canonicalVoice,
    });
    const surfaceState = baseAttemptControl.surfaceState;
    const canStart = baseAttemptControl.canStart;
    const canStop = baseAttemptControl.canStop;
    const isMuted = baseAttemptControl.muted;
    const previousSurfaceStateRef = React.useRef(surfaceState);
    React.useEffect(() => {
        if (surfaceState === 'interrupted' && previousSurfaceStateRef.current !== 'interrupted') {
            voiceSurfaceHaptics.notify('confirmed_interruption');
        }
        previousSurfaceStateRef.current = surfaceState;
    }, [surfaceState]);
    const isSpeaking = surfaceState === 'speaking';
    const recoveryAction = snap.errorRecoveryAction ?? null;
    const recovery = React.useMemo(() => resolveVoiceSurfaceRecovery(recoveryAction), [recoveryAction]);
    const controlsLoading = snap.status === 'connecting' && !canStop;
    const controlsDisabled = !canStop && !canStart;
    const errorSubtitle = isVoiceMachineErrorKind(snap.errorCode)
        ? t(resolveVoiceMachineErrorTranslationKey(snap.errorCode))
        : null;
    // Target/error channel only. Agent-authored `display_status` text now travels on
    // `delegatedWork` so it stops competing with the target label in one flattened string.
    const subtitle = errorSubtitle
        ?? (
            controlsDisabled
                ? (
                    daemonLocalVoiceUnavailable
                        ? t('settingsVoice.local.conversation.resumability.disabledVoiceAgent')
                        : !startAdmission.connectedServicesBindingReady
                            ? t('settingsVoice.realtimeProviders.authentication.referenceRequired')
                            : targetLabel ?? t('voiceSurface.selectSessionToStart')
                )
                : (targetLabel ? `${t('voiceSurface.targetSession')}: ${targetLabel}` : null)
        );
    // The placement-neutral attempt projection owns the runtime capture fact shared by Horizon,
    // the orb and the announcer. Consuming it here keeps every surface on the same predicate.
    const isMicCaptureActive = baseAttemptControl.capturing;
    // The session this surface acts on: the Voice attempt's control session when one exists,
    // otherwise the surface's own session. Owns both recovery targeting and delegated work.
    const controlledSession = activeControlSession ?? currentSession;
    const controlledSessionOwnerMetadata = controlledSession
        ? readSessionOwnerMetadataView(controlledSession)
        : null;
    const delegatedSessionId =
        normalizeNonEmptyString(controlledSession?.id)
        ?? normalizeNonEmptyString(outputStatus?.sessionId);
    const delegatedStatusText = normalizeNonEmptyString(outputStatus?.text);
    const delegatedThinking = controlledSession?.thinking === true;
    const delegatedWork = React.useMemo<VoiceSurfaceDelegatedWork | null>(
        () => (
            delegatedSessionId !== null && (delegatedThinking || delegatedStatusText !== null)
                ? {
                    sessionId: delegatedSessionId,
                    statusText: delegatedStatusText,
                    thinking: delegatedThinking,
                }
                : null
        ),
        [delegatedSessionId, delegatedStatusText, delegatedThinking],
    );
    /*
     * `resolveVoiceAdapterSurfaceCapabilities` freezes a **new** capability object
     * on every call, so `agentRuntime` is a fresh reference every render even when
     * the adapter's answer is unchanged. Only the two ids are ever read from it
     * (`resolveVoiceConnectRecoveryTarget.ts:76-107`), so a stable identity built
     * from those ids is the same value with a usable reference.
     */
    const agentRuntimeIdentity = React.useMemo(
        () => (agentRuntime ? { localId: agentRuntime.localId, pluginId: agentRuntime.pluginId } : null),
        [agentRuntime?.localId, agentRuntime?.pluginId],
    );
    const runtimeRecoveryTarget = React.useMemo(() => {
        const agentId = normalizeNonEmptyString(agentRuntimeIdentity?.localId);
        const pluginId = normalizeNonEmptyString(agentRuntimeIdentity?.pluginId);
        const serverId = normalizeNonEmptyString(
            bindingScope === 'session'
                ? controlledSession?.serverId
                : activeServerSnapshot.serverId,
        );
        const machineId = normalizeNonEmptyString(
            bindingScope === 'session'
                ? controlledSessionOwnerMetadata?.machineId
                : voiceExecutionMachine.machineId,
        );
        if (!agentId || !pluginId || !serverId || !machineId) return null;
        return { agentId, pluginId, machineId, serverId };
    }, [
        activeServerSnapshot.serverId,
        agentRuntimeIdentity,
        bindingScope,
        controlledSessionOwnerMetadata?.machineId,
        controlledSession?.serverId,
        voiceExecutionMachine.machineId,
    ]);

    const connectRecoveryTarget = React.useMemo(() => {
        const providerSourcePluginId = providerEntry?.source.kind === 'bundled'
            || providerEntry?.source.kind === 'external'
            ? providerEntry.source.pluginId
            : null;
        return resolveVoiceConnectRecoveryTarget({
            agentRuntime: agentRuntimeIdentity,
            bindingScope,
            runtimeTarget: runtimeRecoveryTarget,
            provider: providerEntry
                ? {
                    sourcePluginId: providerSourcePluginId,
                    connectedServicesBinding:
                        providerEntry.providerSettings?.connectedServicesBinding
                        ?? null,
                }
                : null,
            providerConfig:
                bindingScope === 'session'
                    ? null
                    : readVoiceProviderSettingsConfig(
                        canonicalVoice,
                        providerId,
                    ),
            sessionMetadata:
                bindingScope === 'session'
                    ? controlledSessionOwnerMetadata
                    : null,
            connectedServiceEntries: connectedServicesRegistry.entries,
        });
    }, [
        agentRuntimeIdentity,
        bindingScope,
        canonicalVoice,
        connectedServicesRegistry.entries,
        providerId,
        providerEntry,
        controlledSessionOwnerMetadata,
        runtimeRecoveryTarget,
    ]);
    const canRecover = recovery !== null && (
        recovery.kind === 'connect_agent'
            ? connectRecoveryTarget.kind !== 'unavailable'
            : recovery.kind === 'install_agent_runtime'
                || recovery.kind === 'update_agent_runtime'
                ? runtimeRecoveryTarget !== null
                : recovery.kind === 'retry'
                    || recovery.kind === 'reconnect'
                    ? normalizeNonEmptyString(snap.sessionId) !== null
                        || normalizeNonEmptyString(startSessionId) !== null
                        || globalStartAuthorized
                    : true
    );
    const canBargeIn =
        bargeInEnabled
        && isSpeaking
        && !isMuted
        && typeof snap.sessionId === 'string'
        && snap.sessionId.trim().length > 0;
    const canCancelTurn =
        isConnected
        && cancelResponseSupported
        && typeof snap.sessionId === 'string'
        && snap.sessionId.trim().length > 0
        && (snap.mode === 'thinking' || snap.mode === 'speaking');
    const handlers = React.useMemo(
        () => createVoiceSurfaceActionHandlers({
            activeAdapterId: snap.adapterId ?? null,
            globalStartAuthorized,
            fallbackOpenConversationControlSessionId,
            openConversationSessionId,
            providerId,
            connectRecoveryTarget,
            recoveryAction,
            runtimeRecoveryTarget,
            routeSessionId,
            router,
            captureNavigationFocusReturn: navigateWithFocusReturn.capture,
            navigateWithFocusReturn,
            sessionId: props.sessionId ?? null,
            snapSessionId: snap.sessionId ?? null,
            startSessionId,
            variant: props.variant,
        }),
        [
            snap.adapterId,
            globalStartAuthorized,
            fallbackOpenConversationControlSessionId,
            openConversationSessionId,
            providerId,
            connectRecoveryTarget,
            recoveryAction,
            runtimeRecoveryTarget,
            routeSessionId,
            router,
            navigateWithFocusReturn,
            props.sessionId,
            snap.sessionId,
            startSessionId,
            props.variant,
        ],
    );

    const recoveryOverride = React.useMemo<VoiceAttemptRecoveryProjectionOverride | undefined>(
        () => recovery === null
            ? undefined
            : canRecover
                ? { label: t(recovery.labelKey), onRecover: handlers.onRecover }
                : null,
        [canRecover, handlers.onRecover, recovery],
    );
    const attemptControl = React.useMemo(
        () => recoveryOverride === undefined
            ? baseAttemptControl
            : overrideVoiceAttemptRecoveryProjection(baseAttemptControl, recoveryOverride),
        [baseAttemptControl, recoveryOverride],
    );


    const model = React.useMemo<VoiceSurfaceViewModel>(() => ({
        attemptControl,
        activityFeedEnabled,
        canBargeIn,
        canCancelTurn,
        canOpenConversation: Boolean(openConversationSessionId),
        canTeleportToSessionRoot,
        controlsDisabled,
        controlsLoading,
        delegatedWork,
        expanded,
        isMicCaptureActive,
        mode: snap.mode,
        micStateLabel: baseAttemptControl.micStateLabel,
        muteLabel: t(isMuted ? 'voiceSurface.a11y.unmute' : 'voiceSurface.a11y.mute'),
        providerLabel,
        startStopLabel: canStop ? t('voiceAssistant.endVoice') : t('voiceAssistant.startVoice'),
        status: snap.status,
        style: props.style,
        subtitle,
        toggleActivityLabel: t('voiceSurface.a11y.toggleActivity'),
        transcriptEntries,
        variant: props.variant,
        visibleTranscriptEntries,
        onBargeIn: handlers.onBargeIn,
        onCancelTurn: handlers.onCancelTurn,
        onOpenConversation: handlers.onOpenConversation,
        onTeleport: handlers.onTeleport,
        onToggleExpanded,
    }), [
        attemptControl,
        activityFeedEnabled,
        canBargeIn,
        canCancelTurn,
        openConversationSessionId,
        canTeleportToSessionRoot,
        snap.status,
        snap.mode,
        providerId,
        providerLabel,
        controlsDisabled,
        controlsLoading,
        delegatedWork,
        snap.sessionId,
        expanded,
        isMicCaptureActive,
        recovery,
        props.style,
        subtitle,
        transcriptEntries,
        props.variant,
        props.sessionId,
        visibleTranscriptEntries,
        handlers,
        onToggleExpanded,
    ]);

    if (!showSurface) {
        return null;
    }

    return model;
}
