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
    | 'rest' | 'connecting' | 'listening' | 'transcribing' | 'thinking' | 'speaking'
    | 'interrupted' | 'muted' | 'blocked' | 'reconnecting' | 'failed' | 'ended' | 'working' | 'needs_you';

export function isVoicePresenceFixtureState(value: unknown): value is VoicePresenceFixtureState {
    return typeof value === 'string' && Object.hasOwn(SURFACE_STATE, value);
}

export const VOICE_PRESENCE_FIXTURE_STATES: readonly VoicePresenceFixtureState[] = [
    'rest', 'connecting', 'listening', 'transcribing', 'thinking', 'speaking', 'working',
    'needs_you', 'interrupted', 'muted', 'blocked', 'reconnecting', 'failed', 'ended',
];

const NOOP = (): void => {};
const SPECIMEN_STARTED_AT = Date.now() - 134_000;

const SURFACE_STATE: Readonly<Record<VoicePresenceFixtureState, VoiceSurfaceState>> = {
    rest: 'idle',
    connecting: 'connecting',
    listening: 'listening',
    transcribing: 'transcribing',
    thinking: 'thinking',
    speaking: 'speaking',
    interrupted: 'interrupted',
    muted: 'listening',
    blocked: 'permission_required',
    reconnecting: 'reconnecting',
    failed: 'error',
    ended: 'idle',
    working: 'listening',
    needs_you: 'listening',
};

export function buildVoicePresenceFixture(state: VoicePresenceFixtureState): VoiceAttemptControlProjection {
    const surfaceState = SURFACE_STATE[state];
    const status = state === 'rest' || state === 'ended'
        ? 'disconnected' as const
        : state === 'connecting'
            ? 'connecting' as const
            : state === 'failed'
                ? 'error' as const
                : 'connected' as const;
    const recovery = state === 'blocked' || state === 'reconnecting' || state === 'failed';
    const control = resolveVoiceAttemptControl({
        surfaceState,
        tone: resolveVoiceSurfaceStatusPresentation(surfaceState).tone,
        status,
        sessionId: state === 'rest' || state === 'ended' ? null : 'specimen-voice',
        canStop: state !== 'rest' && state !== 'failed' && state !== 'ended',
        muted: state === 'muted',
        capturing: state === 'listening' || state === 'muted' || state === 'interrupted',
        startAdmitted: true,
        hasRecovery: recovery,
        canDismissFailedAttempt: state === 'failed',
    });
    // The real recovery copy (`resolveVoiceSurfaceRecovery`): a denied microphone opens settings.
    const recoveryLabel = state === 'blocked' ? t('modals.openSettings') : recovery ? t('common.retry') : null;
    const recoveryShortLabel = state === 'blocked' ? t('voicePresence.recovery.allow') : recoveryLabel;
    // The projection's own failure captions: how to unblock, or the runtime's reason (a lost transport).
    const captionLabel = state === 'blocked'
        ? t('voicePresence.captions.blocked')
        : state === 'failed' ? t(resolveVoiceMachineErrorTranslationKey('transport_disconnect')) : '';
    return {
        ...control,
        statusCell: state === 'working' || state === 'needs_you' ? state : control.statusCell,
        statusWord: state === 'working' ? 'Working' : state === 'needs_you' ? 'Needs you' : state === 'ended' ? t('voicePresence.ended') : state === 'muted' ? t('voicePresence.muted') : t(resolveVoiceSurfaceStatusPresentation(surfaceState).wordKey ?? resolveVoiceSurfaceStatusPresentation(surfaceState).labelKey),
        statusLabel: state === 'working' ? 'Working' : state === 'needs_you' ? 'Needs you' : state === 'ended' ? t('voicePresence.ended') : state === 'muted' ? t('voicePresence.muted') : t(resolveVoiceSurfaceStatusPresentation(surfaceState).labelKey),
        ended: state === 'ended' ? { sessionId: 'specimen-voice', adapterId: null, startedAt: SPECIMEN_STARTED_AT - 118_000, endedAt: SPECIMEN_STARTED_AT + 134_000, reason: { kind: 'stopped' as const }, conversationSessionAddress: null, targetSessionAddress: null, transcriptMode: null, accountScope: null, conversationScope: null } : null,
        onDismissEnded: NOOP,
        onDismissFailedAttempt: NOOP,
        // A conversation that started 2:14 ago; transcript belongs to the surface fixture below.
        elapsedStartedAt: state === 'rest' || state === 'ended' ? null : SPECIMEN_STARTED_AT,
        canHoldToTalk: false,
        beginHoldToTalk: () => null,
        primaryActionLabel: control.primaryAction === 'end' ? 'End Voice' : 'Talk with Voice',
        primaryActionHint: null,
        recoveryLabel,
        recoveryShortLabel,
        micStateLabel: t(state === 'muted' ? 'voiceSurface.a11y.microphoneMuted' : control.capturing ? 'voiceSurface.a11y.microphoneActive' : 'voiceSurface.a11y.microphoneInactive'),
        captionLabel,
        onPrimaryAction: NOOP,
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
        canTeleportToSessionRoot: false,
        controlsDisabled: false,
        controlsLoading: false,
        delegatedWork: live && (state === 'speaking' || state === 'listening')
            ? { sessionId: 'specimen-relay', statusText: 'Relay retry with backoff', thinking: true }
            : null,
        expanded: true,
        isMicCaptureActive: attemptControl.capturing,
        micStateLabel: attemptControl.micStateLabel,
        mode: state,
        muteLabel: '',
        providerLabel: 'OpenAI Realtime',
        startStopLabel: '',
        status: attemptControl.live ? 'connected' : 'disconnected',
        subtitle: state === 'failed' ? 'OpenAI Realtime isn’t set up on this device' : null,
        targetLabel: null,
        toggleActivityLabel: '',
        transcriptEntries: SPECIMEN_TURNS,
        variant: 'sidebar',
        visibleTranscriptEntries: live ? SPECIMEN_TURNS : [],
        onBargeIn: NOOP,
        onCancelTurn: NOOP,
        onOpenConversation: NOOP,
        onTeleport: NOOP,
        onToggleExpanded: NOOP,
    };
}
