import type { VoiceAttemptControlProjection } from '@/components/voice/attempt/useVoiceAttemptControl';
import { resolveVoiceAttemptControl } from '@/components/voice/attempt/resolveVoiceAttemptControl';
import type { VoiceSurfaceTranscriptEntry } from '@/components/voice/surface/mergeVoiceSurfaceTranscriptEntries';
import type { VoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import { resolveVoiceSurfaceStatusPresentation } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import type { VoiceSurfaceViewModel } from '@/components/voice/surface/useVoiceSurfaceModel';
import { resolveVoiceMachineErrorTranslationKey } from '@/voice/runtime/machine/voiceMachineErrorCopy';
import { t } from '@/text';

/**
 * Dev-only attempt projections for the presence specimen (lab `voice-presence` ST): each state is
 * built through the real `resolveVoiceAttemptControl`, so the primitives see exactly the facts a
 * live attempt in that state would give them. Handlers are inert.
 */
export type VoicePresenceFixtureState =
    | 'rest' | 'connecting' | 'live' | 'listening' | 'transcribing' | 'thinking' | 'speaking'
    | 'interrupted' | 'muted' | 'blocked' | 'reconnecting' | 'failed' | 'stop_failed' | 'ended' | 'working' | 'needs_you';

export function isVoicePresenceFixtureState(value: unknown): value is VoicePresenceFixtureState {
    return typeof value === 'string' && Object.hasOwn(SURFACE_STATE, value);
}

export const VOICE_PRESENCE_FIXTURE_STATES: readonly VoicePresenceFixtureState[] = [
    'rest', 'connecting', 'live', 'listening', 'transcribing', 'thinking', 'speaking', 'working',
    'needs_you', 'interrupted', 'muted', 'blocked', 'reconnecting', 'failed', 'ended',
];

const NOOP = (): void => {};
const SPECIMEN_STARTED_AT = Date.now() - 134_000;

const SURFACE_STATE: Readonly<Record<VoicePresenceFixtureState, VoiceSurfaceState>> = {
    rest: 'idle',
    connecting: 'connecting',
    live: 'live',
    listening: 'listening',
    transcribing: 'transcribing',
    thinking: 'thinking',
    speaking: 'speaking',
    interrupted: 'interrupted',
    muted: 'listening',
    blocked: 'permission_required',
    reconnecting: 'reconnecting',
    failed: 'error',
    stop_failed: 'error',
    ended: 'idle',
    working: 'listening',
    needs_you: 'listening',
};

/** `stop_failed`: a Start cancelled while the previous session would not stop; Retry re-runs the ordered Stop. */
const STOP_FAILED_COPY_KEY = resolveVoiceMachineErrorTranslationKey(
    'service_temporarily_unavailable',
    'voice_previous_session_stop_failed',
);

export function buildVoicePresenceFixture(state: VoicePresenceFixtureState): VoiceAttemptControlProjection {
    const failed = state === 'failed' || state === 'stop_failed';
    const surfaceState = SURFACE_STATE[state];
    const status = state === 'rest' || state === 'ended'
        ? 'disconnected' as const
        : state === 'connecting'
            ? 'connecting' as const
            : failed
                ? 'error' as const
                : 'connected' as const;
    const recovery = state === 'blocked' || state === 'reconnecting' || failed;
    const sendable = state === 'listening' || state === 'muted';
    const control = resolveVoiceAttemptControl({
        surfaceState,
        tone: resolveVoiceSurfaceStatusPresentation(surfaceState).tone,
        status,
        sessionId: state === 'rest' || state === 'ended' ? null : 'specimen-voice',
        canStop: state !== 'rest' && !failed && state !== 'ended',
        muted: state === 'muted',
        capturing: state === 'listening' || state === 'muted' || state === 'interrupted',
        startAdmitted: true,
        hasRecovery: recovery,
        canDismissFailedAttempt: failed,
        // Hands-free is off by default, so a listening call waits for Send; a muted one holds what was said.
        canCommitInput: sendable,
    });
    // The real recovery copy (`resolveVoiceSurfaceRecovery`): a denied microphone is allowed, a lost transport retried.
    const recoveryLabel = state === 'blocked' ? t('voicePresence.recovery.allow') : recovery ? t('common.retry') : null;
    const recoveryIcon = state === 'blocked' ? 'microphone' as const : recovery ? 'arrow-clockwise' as const : null;
    // The projection's own failure captions: how to unblock, or the runtime's reason (a lost transport).
    const captionLabel = state === 'blocked'
        ? t('voicePresence.captions.blocked')
        : state === 'failed' ? t(resolveVoiceMachineErrorTranslationKey('transport_disconnect')) : state === 'stop_failed' ? t(STOP_FAILED_COPY_KEY) : state === 'live' ? t('voiceSurface.a11y.microphoneInactive') : '';
    return {
        ...control,
        statusCell: state === 'working' || state === 'needs_you' ? state : control.statusCell,
        statusWord: state === 'working' ? 'Working' : state === 'needs_you' ? 'Needs you' : state === 'ended' ? t('voicePresence.ended') : state === 'muted' ? t('voicePresence.muted') : t(resolveVoiceSurfaceStatusPresentation(surfaceState).wordKey ?? resolveVoiceSurfaceStatusPresentation(surfaceState).labelKey),
        statusLabel: state === 'working' ? 'Working' : state === 'needs_you' ? 'Needs you' : state === 'ended' ? t('voicePresence.ended') : state === 'muted' ? t('voicePresence.muted') : t(resolveVoiceSurfaceStatusPresentation(surfaceState).labelKey),
        ended: state === 'ended' ? { sessionId: 'specimen-voice', adapterId: null, startedAt: SPECIMEN_STARTED_AT - 118_000, endedAt: SPECIMEN_STARTED_AT + 134_000, reason: { kind: 'stopped' as const }, conversationSessionAddress: null, targetSessionAddress: null, transcriptMode: null, accountScope: null, conversationScope: null } : null,
        commitInputLabel: sendable ? t('common.send') : null,
        onCommitInput: sendable ? NOOP : undefined,
        onDismissEnded: NOOP,
        onDismissFailedAttempt: NOOP,
        // A conversation that started 2:14 ago; transcript belongs to the surface fixture below.
        elapsedStartedAt: state === 'rest' || state === 'ended' ? null : SPECIMEN_STARTED_AT,
        canHoldToTalk: false,
        beginHoldToTalk: () => null,
        primaryActionLabel: control.primaryAction === 'end' ? 'End Voice' : 'Talk with Voice',
        primaryActionHint: null,
        recoveryLabel,
        recoveryIcon,
        micStateLabel: t(state === 'muted' ? 'voiceSurface.a11y.microphoneMuted' : control.capturing ? 'voiceSurface.a11y.microphoneActive' : 'voiceSurface.a11y.microphoneInactive'),
        captionLabel,
        onPrimaryAction: NOOP,
        // An executable conversation whose Start continues it: the ended glance also offers New.
        ...(state === 'ended' ? { onNewConversation: async () => false } : {}),
        onToggle: NOOP,
        onToggleMute: NOOP,
        onRecover: NOOP,
        openConversationSessionId: null,
        openConversationSessionAddress: null,
        canOpenConversation: state === 'ended',
        onOpenConversation: NOOP,
    };
}

const SPECIMEN_TURNS: readonly VoiceSurfaceTranscriptEntry[] = Object.freeze([
    Object.freeze({ id: 'specimen-u1', createdAt: 1, kind: 'user' as const, text: 'Where are we on the relay retry?', transcriptState: 'final' as const, announce: false, announcementId: 'specimen-u1' }),
    Object.freeze({ id: 'specimen-a1', createdAt: 2, kind: 'assistant' as const, text: 'Codex finished the backoff and two of five relay tests pass. It’s running the rest now — want me to tell you when they’re done?', transcriptState: 'final' as const, announce: false, announcementId: 'specimen-a1' }),
]);

/** The Voice section's surface model for a fixture state (lab A/C/As): real projection, inert handlers. */
export function buildVoicePresenceSurfaceFixture(state: VoicePresenceFixtureState): VoiceSurfaceViewModel {
    const attemptControl = buildVoicePresenceFixture(state);
    const live = attemptControl.live && attemptControl.canStop;
    return {
        attemptControl,
        activityFeedEnabled: true,
        canBargeIn: state === 'speaking',
        canCancelTurn: false,
        canOpenConversation: state === 'ended',
        controlsDisabled: false,
        controlsLoading: false,
        delegatedWork: live && (state === 'speaking' || state === 'listening')
            ? { sessionId: 'specimen-relay', serverId: null, statusText: 'Relay retry with backoff', thinking: true }
            : null,
        expanded: true,
        isMicCaptureActive: attemptControl.capturing,
        micStateLabel: attemptControl.micStateLabel,
        mode: state,
        muteLabel: '',
        providerLabel: 'OpenAI Realtime',
        startStopLabel: '',
        status: attemptControl.live ? 'connected' : 'disconnected',
        subtitle: state === 'failed' ? 'OpenAI Realtime isn’t set up on this device' : state === 'stop_failed' ? t(STOP_FAILED_COPY_KEY) : null,
        targetLabel: null,
        toggleActivityLabel: '',
        transcriptEntries: SPECIMEN_TURNS,
        variant: 'sidebar',
        visibleTranscriptEntries: live ? SPECIMEN_TURNS : [],
        onBargeIn: NOOP,
        onCancelTurn: NOOP,
        onOpenConversation: NOOP,
        onOpenDelegatedSession: NOOP,
        onToggleExpanded: NOOP,
    };
}
