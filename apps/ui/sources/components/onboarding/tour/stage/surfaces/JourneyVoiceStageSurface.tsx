import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { VoiceSurfaceView } from '@/components/voice/surface/VoiceSurfaceView';
import type { VoiceSurfaceViewModel } from '@/components/voice/surface/useVoiceSurfaceModel';
import { t } from '@/text';

import type { StageDevice } from '../DeviceFrame';
import { StageAppShell } from '../StageAppShell';

// A10 voice: the voice runtime (mic + realtime transport) cannot be demo-seeded
// inside the firewall, so the beat presents the REAL VoiceSurfaceView in a
// designed, resting "listening" state driven by a static view-model with a short
// seeded conversation. No timers, sockets, or store subscriptions are opened.
function noop(): void {}

const SEEDED_TRANSCRIPT = [
    {
        id: 'journey-voice-user-1',
        createdAt: 3,
        kind: 'user' as const,
        text: 'Walk me through the auth change before we ship it.',
        transcriptState: 'final' as const,
        announce: false,
        announcementId: 'journey-voice-user-1:1',
    },
    {
        id: 'journey-voice-assistant-1',
        createdAt: 2,
        kind: 'assistant' as const,
        text: 'The dashboard session now gates on the relay token and falls back to the setup wizard — want me to open the diff?',
        transcriptState: 'final' as const,
        announce: false,
        announcementId: 'journey-voice-assistant-1:1',
    },
    {
        id: 'journey-voice-user-2',
        createdAt: 1,
        kind: 'user' as const,
        text: 'Yes, and queue a follow-up to add the regression test.',
        transcriptState: 'final' as const,
        announce: false,
        announcementId: 'journey-voice-user-2:1',
    },
];

export function buildJourneyVoiceStageModel(): VoiceSurfaceViewModel {
    return {
        attemptControl: {
            availability: 'ready', live: true, canStart: false, canStop: true, canMute: true,
            muted: false, capturing: true, micStateLabel: t('voiceSurface.a11y.microphoneActive'),
            captionLabel: t('voiceSurface.a11y.microphoneActive'), primaryAction: 'end', primaryActionLabel: t('voiceAssistant.endVoice'),
            primaryActionHint: t('voiceSurface.orbEndHint'), recoveryAvailable: false, recoveryLabel: null,
            surfaceState: 'listening', tone: 'active', stop: 'cool', sessionId: 'journey-voice',
            onToggle: noop, onToggleMute: noop, onRecover: noop, onPrimaryAction: noop,
            openConversationSessionId: null, onOpenConversation: noop,
        },
        activityFeedEnabled: true,
        canBargeIn: true,
        canCancelTurn: false,
        canOpenConversation: true,
        canTeleportToSessionRoot: true,
        controlsDisabled: false,
        controlsLoading: false,
        delegatedWork: null,
        expanded: true,
        isMicCaptureActive: true,
        mode: 'listening',
        // Unmuted and capturing, matching `isMicCaptureActive` above: the staged conversation is
        // listening, so the transport must not draw a closed microphone.
        micStateLabel: t('voiceSurface.a11y.microphoneActive'),
        muteLabel: t('voiceSurface.a11y.mute'),
        providerLabel: t('settingsVoice.mode.local'),
        startStopLabel: t('voiceAssistant.endVoice'),
        status: 'connected',
        subtitle: `${t('voiceSurface.targetSession')}: Dashboard auth`,
        toggleActivityLabel: t('voiceSurface.a11y.toggleActivity'),
        transcriptEntries: SEEDED_TRANSCRIPT,
        variant: 'session',
        visibleTranscriptEntries: SEEDED_TRANSCRIPT,
        onBargeIn: noop,
        onCancelTurn: noop,
        onOpenConversation: noop,
        onTeleport: noop,
        onToggleExpanded: noop,
    };
}

const stylesheet = StyleSheet.create((theme) => ({
    detail: {
        backgroundColor: theme.colors.background.canvas,
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        padding: 24,
    },
    panel: {
        flex: 1,
        minHeight: 0,
    },
}));

function JourneyVoiceDetail(): React.ReactElement {
    const styles = stylesheet;
    const model = React.useMemo(() => buildJourneyVoiceStageModel(), []);
    return (
        <View testID="demo-stage-voice-detail" style={styles.detail}>
            <View style={styles.panel} pointerEvents="none">
                <VoiceSurfaceView model={model} />
            </View>
        </View>
    );
}

export function JourneyVoiceStageSurface(props: Readonly<{ device: StageDevice }>): React.ReactElement {
    return (
        <StageAppShell
            device={props.device}
            surface="session-view"
            detail={<JourneyVoiceDetail />}
            detailTestID="demo-stage-voice-shell-detail"
        />
    );
}
