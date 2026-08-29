import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { resolveVoiceAttemptControl } from '@/components/voice/attempt/resolveVoiceAttemptControl';
import type { VoiceControlAction, VoiceControlId } from '@/components/voice/controls/VoiceControls';
import type { VoiceOrbLabels } from '@/components/voice/orb/VoiceOrb';
import type { VoiceSurfaceTranscriptEntry } from '@/components/voice/surface/mergeVoiceSurfaceTranscriptEntries';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import type { VoiceSurfaceViewModel } from '@/components/voice/surface/useVoiceSurfaceModel';

import type { VoiceConceptProps } from '../conceptTypes';
import { controlsForState, VOICE_LAB_TRANSCRIPT } from '../voiceLabModel';

function projectTranscript(): readonly VoiceSurfaceTranscriptEntry[] {
    return VOICE_LAB_TRANSCRIPT.map((entry, index) => ({
        id: entry.id,
        createdAt: index + 1,
        kind: entry.kind === 'spoken-user'
            ? 'user'
            : entry.kind === 'spoken-assistant'
                ? 'assistant'
                : 'note',
        text: entry.text,
        interrupted: false,
        transcriptState: entry.provisional ? 'partial' : 'final',
        announce: false,
        announcementId: `voice-lab:${entry.id}`,
    }));
}

const LAB_TRANSCRIPT = projectTranscript();

export function createProductionVoiceConceptFixture(props: VoiceConceptProps): Readonly<{
    control: VoiceAttemptControlProjection;
    extraControls: readonly VoiceControlAction[];
    horizonModel: VoiceSurfaceViewModel;
    orbLabels: VoiceOrbLabels;
}> {
    const controls = controlsForState(props.state.id, props.provider, props.surface === 'session');
    const controlById = new Map(controls.map((control) => [control.id, control]));
    const canStart = controlById.has('start');
    const canStop = controlById.has('end');
    const recovery = controlById.get('retry') ?? controlById.get('settings') ?? null;
    const recoveryAvailable = recovery !== null;
    /*
     * `modelState` is the audited state-basis ledger's current production
     * projection. Proposed states deliberately have no production semantic and
     * therefore exercise the canonical neutral state instead of inventing one.
     */
    const surfaceState = props.state.modelState ?? 'idle';
    const status: VoiceSurfaceViewModel['status'] = surfaceState === 'error'
        || surfaceState === 'permission_required'
        ? 'error'
        : surfaceState === 'connecting' || surfaceState === 'reconnecting'
            ? 'connecting'
            : canStop
                ? 'connected'
                : 'disconnected';
    const sessionId = status === 'disconnected' ? null : 'voice-lab-session';
    const baseControl = resolveVoiceAttemptControl({
        surfaceState,
        tone: resolveVoiceSurfaceStatusPresentation(surfaceState).tone,
        status,
        sessionId,
        canStop,
        muted: props.muted,
        capturing: props.state.energized && !props.muted,
        startAdmitted: canStart,
        hasRecovery: recoveryAvailable,
    });
    const primaryAction = baseControl.primaryAction;
    const primaryActionLabel = primaryAction === 'end'
        ? controlById.get('end')?.label ?? 'End Voice'
        : primaryAction === 'start'
            ? controlById.get('start')?.label ?? 'Start Voice'
            : recovery?.label ?? null;
    const micStateLabel = props.muted
        ? 'Microphone muted'
        : baseControl.capturing
            ? 'Microphone active'
            : 'Microphone inactive';
    const invoke = (id: VoiceControlId | null) => {
        if (id) props.onAction(id);
    };
    const primaryControlId: VoiceControlId | null = primaryAction === 'recover'
        ? recovery?.id ?? null
        : primaryAction;
    const control: VoiceAttemptControlProjection = {
        ...baseControl,
        micStateLabel,
        captionLabel: props.state.caption ?? micStateLabel,
        primaryAction,
        primaryActionLabel,
        primaryActionHint: primaryActionLabel,
        recoveryLabel: recovery?.label ?? null,
        onPrimaryAction: () => invoke(primaryControlId),
        onToggle: () => invoke(canStop ? 'end' : canStart ? 'start' : null),
        onToggleMute: props.onToggleMute,
        onRecover: () => invoke(recovery?.id ?? null),
        openConversationSessionId: controlById.has('openConversation') ? sessionId : null,
        onOpenConversation: () => invoke('openConversation'),
    };
    const extraControls = controls.filter((item) => (
        !['start', 'end', 'mute', 'retry', 'settings'].includes(item.id)
    ));
    const startStopLabel = primaryActionLabel ?? (canStop ? 'End Voice' : 'Start Voice');
    const horizonModel: VoiceSurfaceViewModel = {
        attemptControl: control,
        activityFeedEnabled: true,
        canBargeIn: controlById.has('bargeIn'),
        canCancelTurn: controlById.has('cancelTurn'),
        canOpenConversation: controlById.has('openConversation'),
        canTeleportToSessionRoot: controlById.has('returnToSession'),
        controlsDisabled: primaryAction === null,
        controlsLoading: false,
        delegatedWork: props.state.id === 'working'
            ? { sessionId: 'voice-lab-session', statusText: props.state.caption, thinking: true }
            : null,
        expanded: props.expanded,
        isMicCaptureActive: control.capturing,
        micStateLabel,
        mode: surfaceState,
        muteLabel: props.muted ? 'Unmute microphone' : 'Mute microphone',
        providerLabel: props.provider.label,
        startStopLabel,
        status,
        subtitle: props.state.caption,
        toggleActivityLabel: props.expanded ? 'Collapse voice activity' : 'Expand voice activity',
        transcriptEntries: LAB_TRANSCRIPT,
        visibleTranscriptEntries: LAB_TRANSCRIPT,
        variant: props.surface === 'session' ? 'session' : 'sidebar',
        onBargeIn: () => invoke('bargeIn'),
        onCancelTurn: () => invoke('cancelTurn'),
        onOpenConversation: () => invoke('openConversation'),
        onTeleport: () => invoke('returnToSession'),
        onToggleExpanded: props.onToggleExpanded,
    };
    const orbLabels: VoiceOrbLabels = {
        orb: `Voice. ${props.state.label}. ${micStateLabel}`,
        startHint: 'Starts a spoken conversation',
        endHint: 'Ends the spoken conversation',
        expandAction: 'Expand Voice',
        collapseAction: 'Collapse Voice',
        startAction: 'Start Voice',
        endAction: 'End Voice',
        status: props.state.label,
        caption: props.state.caption,
        transport: {
            start: startStopLabel,
            end: startStopLabel,
            startHint: startStopLabel,
            endHint: startStopLabel,
            startText: startStopLabel,
            endText: startStopLabel,
            mute: 'Mute microphone',
            unmute: 'Unmute microphone',
            micState: micStateLabel,
        },
    };
    return { control, extraControls, horizonModel, orbLabels };
}
