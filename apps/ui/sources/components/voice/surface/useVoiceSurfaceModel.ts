import * as React from 'react';

import { usePathname, useRouter } from 'expo-router';

import { useSetting } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import {
    readVoiceProviderSettingsConfig,
    voiceSettingsParse,
} from '@/sync/domains/settings/voiceSettings';
import { t, tLoose } from '@/text';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';
import { isVoiceMachineErrorKind } from '@/voice/runtime/machine/voiceMachineError';
import { resolveVoiceMachineErrorTranslationKey } from '@/voice/runtime/machine/voiceMachineErrorCopy';
import { isHiddenSystemSession } from '@happier-dev/protocol';

import { createVoiceSurfaceActionHandlers } from './createVoiceSurfaceActionHandlers';
import { useVoiceSurfaceStoreState } from './useVoiceSurfaceStoreState';
import { useVoiceSurfaceTargetState } from './useVoiceSurfaceTargetState';
import { resolveVoiceSurfaceState, type VoiceSurfaceState } from './resolveVoiceSurfaceState';
import { resolveVoiceSurfaceRecovery } from './resolveVoiceSurfaceRecovery';
import type { VoiceSurfaceTranscriptEntry } from './mergeVoiceSurfaceTranscriptEntries';
import type { VoiceSurfaceProps } from './voiceSurfaceTypes';
import {
    resolveVoiceProviderId,
    resolveVoiceProviderIdFromSettings,
} from '@/voice/settings/resolveVoiceProviderId';
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
import {
    isExternalVoiceProviderConnectedServicesBindingReady,
} from '@/voice/settings/externalProviderSettings';
import { useVoiceLevelSourceActive } from './useVoiceLevelSourceActive';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { VOICE_SETTINGS_PROVIDER_FOCUS_TARGET } from '@/voice/settings/voiceSettingsRouteFocus';

const voiceProviderRegistry = createDefaultVoiceProviderRegistry();

export type VoiceSurfaceViewModel = Readonly<{
    activityFeedEnabled: boolean;
    canBargeIn: boolean;
    canCancelTurn: boolean;
    canMute: boolean;
    canOpenConversation: boolean;
    canRecover: boolean;
    canTeleportToSessionRoot: boolean;
    canStop: boolean;
    controlsActive: boolean;
    controlsDisabled: boolean;
    controlsLoading: boolean;
    diagnosticsSessionId: string | null;
    expanded: boolean;
    hasProviderDataDisclosure: boolean;
    isMicCaptureActive: boolean;
    isMuted: boolean;
    isSpeaking: boolean;
    mode: string;
    surfaceState: VoiceSurfaceState;
    muteLabel: string;
    openLabel: string;
    providerLabel: string | null;
    recoveryLabel: string;
    startStopLabel: string;
    status: 'connecting' | 'connected' | 'error' | 'disconnected';
    subtitle: string | null;
    toggleActivityLabel: string;
    transcriptEntries: readonly VoiceSurfaceTranscriptEntry[];
    variant: VoiceSurfaceProps['variant'];
    visibleTranscriptEntries: readonly VoiceSurfaceTranscriptEntry[];
    onBargeIn: () => void;
    onCancelTurn: () => void;
    onOpenDataDisclosure: () => void;
    onToggleMute: () => void;
    onOpenConversation: () => void;
    onRecover: () => void;
    onTeleport: () => void;
    onToggleExpanded: () => void;
    onTogglePress: () => void;
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
    const inputSourceActive = useVoiceLevelSourceActive('input');
    const voice: any = useSetting('voice');
    const voicePrivacy = readVoicePrivacySettings({ voice });

    const canonicalVoice = voiceSettingsParse(voice);
    const outputStatusSessionId = snap.sessionId ?? props.sessionId ?? null;
    const outputStatus = React.useSyncExternalStore(
        voiceOutputStatusStore.subscribe,
        () => voiceOutputStatusStore.readForSession(outputStatusSessionId),
        () => voiceOutputStatusStore.readForSession(outputStatusSessionId),
    );
    const selectedProviderId = resolveVoiceProviderId(
        canonicalVoice.providerId,
        voiceProviderRegistry,
    );
    const selectedProviderEntry = selectedProviderId
        ? voiceProviderRegistry.get(selectedProviderId)
        : null;
    const providerId = resolveVoiceProviderIdFromSettings(
        canonicalVoice,
        voiceProviderRegistry,
    ) ?? (
        selectedProviderEntry?.providerSettings?.connectedServicesBinding
            ? selectedProviderId
            : null
    ) ?? 'off';
    const providerEntry = voiceProviderRegistry.get(providerId);
    const providerTitleKey = resolveSelectedVoiceProviderTitleKey(canonicalVoice, voiceProviderRegistry);
    const providerLabel = providerTitleKey ? tLoose(providerTitleKey) : null;
    const hasProviderDataDisclosure = providerEntry?.providerSettings?.privacyDisclosure != null;
    const onOpenDataDisclosure = React.useCallback(() => {
        if (!hasProviderDataDisclosure) return;
        router.push(VOICE_SETTINGS_PROVIDER_FOCUS_TARGET);
    }, [hasProviderDataDisclosure, router]);
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

    const globalConnectedServicesBindingReady =
        bindingScope === 'session'
        || !providerEntry?.providerSettings
        || isExternalVoiceProviderConnectedServicesBindingReady(
            canonicalVoice.providers[providerId] ?? null,
            providerEntry.providerSettings,
        );
    const globalStartAuthorized = bindingScope === 'global';
    const canStart =
        !daemonLocalVoiceUnavailable
        && globalConnectedServicesBindingReady
        && (globalStartAuthorized || Boolean(startSessionId));
    const surfaceState = resolveVoiceSurfaceState({
        status: snap.status,
        mode: snap.mode,
        errorPresentation: snap.errorPresentation,
        presentationState: snap.presentationState,
    });
    const previousSurfaceStateRef = React.useRef<VoiceSurfaceState>(surfaceState);
    React.useEffect(() => {
        if (surfaceState === 'interrupted' && previousSurfaceStateRef.current !== 'interrupted') {
            voiceSurfaceHaptics.notify('confirmed_interruption');
        }
        previousSurfaceStateRef.current = surfaceState;
    }, [surfaceState]);
    const isSpeaking = surfaceState === 'speaking';
    const canStop = snap.canStop && snap.status !== 'disconnected';
    const recoveryAction = snap.errorRecoveryAction ?? null;
    const recovery = resolveVoiceSurfaceRecovery(recoveryAction);
    const controlsLoading = snap.status === 'connecting' && !canStop;
    const controlsDisabled = !canStop && !canStart;
    const errorSubtitle = isVoiceMachineErrorKind(snap.errorCode)
        ? t(resolveVoiceMachineErrorTranslationKey(snap.errorCode))
        : null;
    const subtitle = errorSubtitle
        ?? outputStatus?.text
        ?? (
            controlsDisabled
                ? (
                    daemonLocalVoiceUnavailable
                        ? t('settingsVoice.local.conversation.resumability.disabledVoiceAgent')
                        : targetLabel ?? t('voiceSurface.selectSessionToStart')
                )
                : (targetLabel ? `${t('voiceSurface.targetSession')}: ${targetLabel}` : null)
        );
    const isMuted = snap.micMuted === true;
    const isMicCaptureActive = snap.status === 'connected' && inputSourceActive;
    const recoverySession = activeControlSession ?? currentSession;
    const recoverySessionOwnerMetadata = recoverySession
        ? readSessionOwnerMetadataView(recoverySession)
        : null;
    const runtimeRecoveryTarget = React.useMemo(() => {
        const agentId = normalizeNonEmptyString(agentRuntime?.localId);
        const pluginId = normalizeNonEmptyString(agentRuntime?.pluginId);
        const serverId = normalizeNonEmptyString(
            bindingScope === 'session'
                ? recoverySession?.serverId
                : activeServerSnapshot.serverId,
        );
        const machineId = normalizeNonEmptyString(
            bindingScope === 'session'
                ? recoverySessionOwnerMetadata?.machineId
                : voiceExecutionMachine.machineId,
        );
        if (!agentId || !pluginId || !serverId || !machineId) return null;
        return { agentId, pluginId, machineId, serverId };
    }, [
        activeServerSnapshot.serverId,
        agentRuntime?.localId,
        agentRuntime?.pluginId,
        bindingScope,
        recoverySessionOwnerMetadata?.machineId,
        recoverySession?.serverId,
        voiceExecutionMachine.machineId,
    ]);
    const connectRecoveryTarget = React.useMemo(() => {
        const providerSourcePluginId = providerEntry?.source.kind === 'bundled'
            || providerEntry?.source.kind === 'external'
            ? providerEntry.source.pluginId
            : null;
        return resolveVoiceConnectRecoveryTarget({
            agentRuntime,
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
                    ? recoverySessionOwnerMetadata
                    : null,
            connectedServiceEntries: connectedServicesRegistry.entries,
        });
    }, [
        agentRuntime,
        bindingScope,
        canonicalVoice,
        connectedServicesRegistry.entries,
        providerId,
        providerEntry,
        recoverySessionOwnerMetadata,
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
    const canMute =
        canStop
        && typeof snap.sessionId === 'string'
        && snap.sessionId.trim().length > 0;

    const handlers = React.useMemo(
        () => createVoiceSurfaceActionHandlers({
            activeAdapterId: snap.adapterId ?? null,
            globalStartAuthorized,
            canMute,
            canStop,
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
            muted: isMuted,
            startSessionId,
            variant: props.variant,
        }),
        [
            snap.adapterId,
            globalStartAuthorized,
            canMute,
            canStop,
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
            isMuted,
            startSessionId,
            props.variant,
        ],
    );

    const model = React.useMemo<VoiceSurfaceViewModel>(() => ({
        activityFeedEnabled,
        canBargeIn,
        canCancelTurn,
        canMute,
        canOpenConversation: Boolean(openConversationSessionId),
        canRecover,
        canTeleportToSessionRoot,
        canStop,
        controlsActive: canStop,
        controlsDisabled,
        controlsLoading,
        diagnosticsSessionId: snap.sessionId ?? props.sessionId ?? null,
        expanded,
        hasProviderDataDisclosure,
        isMicCaptureActive,
        isMuted,
        isSpeaking,
        mode: snap.mode,
        surfaceState,
        muteLabel: t(isMuted ? 'voiceSurface.a11y.unmute' : 'voiceSurface.a11y.mute'),
        openLabel: t('common.open'),
        providerLabel,
        recoveryLabel: recovery ? t(recovery.labelKey) : '',
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
        onOpenDataDisclosure,
        onToggleMute: handlers.onToggleMute,
        onOpenConversation: handlers.onOpenConversation,
        onRecover: handlers.onRecover,
        onTeleport: handlers.onTeleport,
        onToggleExpanded,
        onTogglePress: handlers.onTogglePress,
    }), [
        activityFeedEnabled,
        canBargeIn,
        canCancelTurn,
        canMute,
        openConversationSessionId,
        canRecover,
        canTeleportToSessionRoot,
        canStop,
        snap.status,
        snap.mode,
        providerId,
        providerLabel,
        controlsDisabled,
        controlsLoading,
        snap.sessionId,
        expanded,
        hasProviderDataDisclosure,
        isMicCaptureActive,
        isMuted,
        isSpeaking,
        surfaceState,
        recovery,
        props.style,
        subtitle,
        outputStatus,
        transcriptEntries,
        props.variant,
        props.sessionId,
        visibleTranscriptEntries,
        handlers,
        onOpenDataDisclosure,
        onToggleExpanded,
    ]);

    if (!showSurface) {
        return null;
    }

    return model;
}
