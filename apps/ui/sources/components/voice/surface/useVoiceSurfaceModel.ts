import * as React from 'react';

import { usePathname, useRouter } from 'expo-router';

import { useSetting } from '@/sync/domains/state/storage';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { t } from '@/text';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';
import {
    VOICE_MACHINE_ERROR_TRANSLATION_KEYS,
    resolveVoiceMachineErrorTranslationKey,
} from '@/voice/runtime/machine/voiceMachineErrorCopy';
import { isHiddenSystemSession } from '@happier-dev/protocol';

import { createVoiceSurfaceActionHandlers } from './createVoiceSurfaceActionHandlers';
import { useVoiceSurfaceE2eFixture } from './useVoiceSurfaceE2eFixture';
import { useVoiceSurfaceStoreState } from './useVoiceSurfaceStoreState';
import { useVoiceSurfaceTargetState } from './useVoiceSurfaceTargetState';
import type { VoiceSurfaceProps } from './voiceSurfaceTypes';

type VoiceSurfaceTranscriptEntry = Readonly<{
    id: string;
    createdAt: number;
    kind: 'user' | 'assistant' | 'note';
    text: string;
}>;

export type VoiceSurfaceViewModel = Readonly<{
    activityFeedEnabled: boolean;
    canBargeIn: boolean;
    canCancelTurn: boolean;
    canMute: boolean;
    canOpenConversation: boolean;
    canTeleportToSessionRoot: boolean;
    canStop: boolean;
    controlsActive: boolean;
    controlsDisabled: boolean;
    controlsLoading: boolean;
    expanded: boolean;
    isConnecting: boolean;
    isListening: boolean;
    isMuted: boolean;
    isSpeaking: boolean;
    mode: string;
    muteLabel: string;
    openLabel: string;
    startStopLabel: string;
    status: 'connecting' | 'connected' | 'error' | 'disconnected';
    subtitle: string | null;
    toggleActivityLabel: string;
    transcriptEntries: readonly VoiceSurfaceTranscriptEntry[];
    variant: VoiceSurfaceProps['variant'];
    visibleTranscriptEntries: readonly VoiceSurfaceTranscriptEntry[];
    onBargeIn: () => void;
    onCancelTurn: () => void;
    onToggleMute: () => void;
    onOpenConversation: () => void;
    onTeleport: () => void;
    onToggleExpanded: () => void;
    onTogglePress: () => void;
    style?: unknown;
}>;

export function useVoiceSurfaceModel(props: VoiceSurfaceProps): VoiceSurfaceViewModel | null {
    const router = useRouter();
    const pathname = usePathname();
    const snap = useVoiceSessionSnapshot();
    const voice: any = useSetting('voice');
    const voicePrivacy = readVoicePrivacySettings({ voice });

    useVoiceSurfaceE2eFixture();

    const providerId = voice?.providerId ?? 'off';
    const localConversationMode =
        providerId === 'local_conversation' ? (voice?.adapters?.local_conversation?.conversationMode ?? 'direct_session') : null;
    const {
        currentSession,
        fallbackOpenConversationControlSessionId,
        openConversationSessionId,
        sessionLabelById,
        transcriptEntries,
        visibleTranscriptEntries,
    } = useVoiceSurfaceStoreState({
        activeControlSessionId: snap.sessionId ?? null,
        localConversationMode,
        providerId,
        surfaceSessionId: props.sessionId ?? null,
        voicePrivacy,
    });
    const {
        activityFeedEnabled,
        allowsGlobalStart,
        canTeleportToSessionRoot,
        daemonLocalVoiceUnavailable,
        locationAllowsVariant,
        routeSessionId,
        startSessionId,
        targetLabel,
    } = useVoiceSurfaceTargetState({
        localConversationMode,
        pathname,
        providerId,
        sessionId: props.sessionId ?? null,
        sessionLabelById,
        variant: props.variant,
        voice,
        voicePrivacy,
    });
    const [expanded, setExpanded] = React.useState(false);

    const showSurface =
        providerId !== 'off'
        && locationAllowsVariant
        && !(props.variant === 'session' && isHiddenSystemSession({ metadata: currentSession?.metadata ?? null }));
    if (!showSurface) {
        return null;
    }

    const canStart = !daemonLocalVoiceUnavailable && (allowsGlobalStart ? true : Boolean(startSessionId));
    const isConnected = snap.status === 'connected';
    const isSpeaking = isConnected && snap.mode === 'speaking';
    const canStop = snap.canStop && snap.status !== 'disconnected';
    const controlsLoading = snap.status === 'connecting' && !canStop;
    const controlsDisabled = !canStop && !canStart;
    const errorSubtitle = typeof snap.errorCode === 'string' && snap.errorCode in VOICE_MACHINE_ERROR_TRANSLATION_KEYS
        ? t(resolveVoiceMachineErrorTranslationKey(snap.errorCode as keyof typeof VOICE_MACHINE_ERROR_TRANSLATION_KEYS))
        : null;
    const subtitle = errorSubtitle
        ?? (
            controlsDisabled
                ? (
                    daemonLocalVoiceUnavailable
                        ? t('settingsVoice.local.conversation.resumability.disabledVoiceAgent')
                        : targetLabel ?? t('voiceSurface.selectSessionToStart')
                )
                : (targetLabel ? `${t('voiceSurface.targetSession')}: ${targetLabel}` : null)
        );
    const bargeInEnabled =
        providerId === 'local_conversation' ? voice?.adapters?.local_conversation?.tts?.bargeInEnabled !== false : false;
    const canBargeIn =
        providerId === 'local_conversation'
        && isSpeaking
        && bargeInEnabled
        && typeof snap.sessionId === 'string'
        && snap.sessionId.trim().length > 0;
    const canCancelTurn =
        isConnected
        && typeof snap.sessionId === 'string'
        && snap.sessionId.trim().length > 0
        && (snap.mode === 'thinking' || snap.mode === 'speaking');
    const canMute =
        canStop
        && typeof snap.sessionId === 'string'
        && snap.sessionId.trim().length > 0;
    const isMuted = snap.micMuted === true;
    const { onBargeIn, onCancelTurn, onOpenConversation, onTeleport, onToggleMute, onTogglePress } = createVoiceSurfaceActionHandlers({
        activeAdapterId: snap.adapterId ?? null,
        allowsGlobalStart,
        canMute,
        canStop,
        fallbackOpenConversationControlSessionId,
        openConversationSessionId,
        providerId,
        routeSessionId,
        router,
        sessionId: props.sessionId ?? null,
        snapSessionId: snap.sessionId ?? null,
        muted: isMuted,
        startSessionId,
        variant: props.variant,
    });

    return {
        activityFeedEnabled,
        canBargeIn,
        canCancelTurn,
        canMute,
        canOpenConversation: Boolean(openConversationSessionId),
        canTeleportToSessionRoot,
        canStop,
        controlsActive: snap.status !== 'disconnected' || providerId !== 'off',
        controlsDisabled,
        controlsLoading,
        expanded,
        isConnecting: snap.status === 'connecting',
        isListening: snap.mode === 'listening',
        isMuted,
        isSpeaking,
        mode: snap.mode,
        muteLabel: t(isMuted ? 'voiceSurface.a11y.unmute' : 'voiceSurface.a11y.mute'),
        openLabel: t('common.open'),
        startStopLabel: canStop ? t('voiceAssistant.tapToEnd') : t('voiceAssistant.label'),
        status: snap.status,
        style: props.style,
        subtitle,
        toggleActivityLabel: t('voiceSurface.a11y.toggleActivity'),
        transcriptEntries,
        variant: props.variant,
        visibleTranscriptEntries,
        onBargeIn,
        onCancelTurn,
        onToggleMute,
        onOpenConversation,
        onTeleport,
        onToggleExpanded: () => setExpanded((value) => !value),
        onTogglePress,
    };
}
