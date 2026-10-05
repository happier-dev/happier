import type { VoiceLightStop } from '@/components/voice/light/voiceLightTokens';
import type { VoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import type { VoiceSurfaceStatusTone } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';
import type { SessionAwarenessPresentationV1 } from '@/utils/sessions/sessionUtils';

import { resolveVoiceAttemptLightStop } from './resolveVoiceAttemptLightStop';

/**
 * Whether a transport is worth presenting at all.
 *
 * `recoverable` still renders — tapping opens the canonical recovery action. `setup` renders the
 * rest mic of a Voice that is switched on but cannot start yet; tapping opens Voice setup, so Voice
 * stays discoverable before it works. `unavailable` does not render: a live attempt that can do
 * nothing is worse than no transport.
 */
export type VoiceAttemptAvailability = 'ready' | 'recoverable' | 'setup' | 'unavailable';
export type VoiceAttemptPrimaryAction = 'start' | 'end' | 'recover' | 'setup' | null;
export type VoiceAttemptMarkPose = 'mic' | 'light' | 'shadow' | 'blocked';
export type VoiceAttemptStatusCell = 'thinking' | 'working' | 'needs_you' | null;

export function resolveVoiceAttemptActionability(input: Readonly<{
    canStart: boolean;
    canStop: boolean;
    recoveryAvailable: boolean;
    canDismissFailedAttempt?: boolean;
    /** Voice is on and idle: when nothing else is possible, its setup is. */
    setupOffered?: boolean;
}>): Readonly<{
    availability: VoiceAttemptAvailability;
    primaryAction: VoiceAttemptPrimaryAction;
}> {
    return {
        availability: input.canStop || input.canStart
            ? 'ready'
            : input.recoveryAvailable || input.canDismissFailedAttempt === true
                ? 'recoverable'
                : input.setupOffered === true ? 'setup' : 'unavailable',
        primaryAction: input.canStop
            ? 'end'
            : input.canStart
                ? 'start'
                : input.recoveryAvailable
                    ? 'recover'
                    : input.setupOffered === true ? 'setup' : null,
    };
}

/**
 * A read-only presentation adapter over the single canonical Voice attempt (§2.5).
 *
 * It **enforces nothing.** `voiceSessionLifecycleController` owns the exact active attempt, its
 * immutable session binding, and stop/end/toggle routing; this projection selects facts from the
 * canonical snapshot and routes user actions back to that owner. An adapter that "enforced"
 * targeting would be a second lifecycle decision-maker — the split-brain it exists to prevent.
 *
 * It carries no placement knowledge. Idle target policy belongs at the target/admission seam;
 * device-local container selection never changes the admitted attempt's lifecycle or binding.
 */
export type VoiceAttemptControl = Readonly<{
    availability: VoiceAttemptAvailability;
    /** An attempt is running — global or session-bound. The orb mirrors whichever it is. */
    live: boolean;
    canStart: boolean;
    canStop: boolean;
    canMute: boolean;
    canDismissFailedAttempt?: boolean;
    canCommitInput?: boolean;
    muted: boolean;
    /** The canonical runtime capture fact; distinct from the user's mute preference. */
    capturing: boolean;
    /** The one action an attempt transport performs. Presentations name and dispatch this fact. */
    primaryAction: VoiceAttemptPrimaryAction;
    recoveryAvailable: boolean;
    surfaceState: VoiceSurfaceState;
    tone: VoiceSurfaceStatusTone;
    /** The light stop the presence burns at, shared by every Voice surface. */
    stop: VoiceLightStop;
    /** The attempt's control session. Immutable while an attempt runs; never re-targeted here. */
    sessionId: string | null;
    markPose: VoiceAttemptMarkPose;
    statusCell: VoiceAttemptStatusCell;
}>;

/**
 * Pure projection of the canonical snapshot facts the floating transport needs.
 *
 * Kept separate from the hook so the availability ladder — the part that decides whether a
 * transport renders at all — is testable without a store.
 */
export function resolveVoiceAttemptControl(input: Readonly<{
    surfaceState: VoiceSurfaceState;
    tone: VoiceSurfaceStatusTone;
    status: 'connecting' | 'connected' | 'error' | 'disconnected';
    sessionId: string | null;
    canStop: boolean;
    muted: boolean;
    canCommitInput?: boolean;
    capturing: boolean;
    /**
     * The canonical start-admission answer from `resolveVoiceStartAdmission`.
     *
     * Passed in, never re-derived: admission has one owner shared with the surface model, and a
     * second rule here is what made the orb offer a Start the lifecycle owner refused.
     */
    startAdmitted: boolean;
    /** A canonical recovery action exists for the current error. */
    hasRecovery: boolean;
    /** Terminal acknowledgement eligibility from the canonical lifecycle/store owner. */
    canDismissFailedAttempt?: boolean;
    /**
     * Voice is switched on for this person. An idle Voice that cannot start then still offers its
     * setup (the rest mic opens Voice setup) instead of disappearing.
     */
    setupOffered?: boolean;
    /** Already projected by the shared Session awareness owner; never provider-authored copy. */
    sessionStatus?: Pick<SessionAwarenessPresentationV1, 'state' | 'statusText'> | null;
}>): VoiceAttemptControl {
    const live = input.status !== 'disconnected';
    const canStop = input.canStop && input.status !== 'disconnected';
    // Not admission: §2.5's mirroring rule. An attempt is already running, so this transport
    // controls *that* one rather than starting a competing second attempt.
    const canStart = !live && input.startAdmitted;
    /*
     * Availability is a statement about *commands*, not about presence.
     *
     * `live` only says an attempt object exists — `status: 'error'` is not `disconnected`, so an
     * attempt that has already failed still reads as live. Deriving readiness from it published
     * `ready` for a state where nothing can be stopped and nothing can be started, and the surface
     * duly rendered an enabled transport the lifecycle owner refuses: §2.2's dead control. Asking
     * "is there an action behind this?" is the same question the user's press asks.
     */
    const recoveryAvailable = input.hasRecovery;
    const canDismissFailedAttempt = !canStop && input.canDismissFailedAttempt === true;
    const { availability, primaryAction } = resolveVoiceAttemptActionability({
        canStart,
        canStop,
        canDismissFailedAttempt,
        recoveryAvailable,
        // Only at rest: a live attempt that can do nothing is not a setup entry point.
        setupOffered: input.setupOffered === true && !live,
    });
    return {
        availability,
        live,
        canStart,
        canStop,
        canDismissFailedAttempt,
        canCommitInput: input.status === 'connected' && Boolean(input.sessionId)
            && input.canCommitInput === true,
        // Muting is available for a connected attempt even while a half-duplex provider has
        // temporarily closed capture; the preference still governs the next capture window.
        canMute:
            input.status === 'connected'
            && canStop
            && typeof input.sessionId === 'string'
            && input.sessionId.trim().length > 0,
        muted: input.muted,
        capturing: input.capturing,
        primaryAction,
        recoveryAvailable,
        surfaceState: input.surfaceState,
        tone: input.tone,
        stop: resolveVoiceAttemptLightStop(input.surfaceState),
        sessionId: input.sessionId,
        markPose: input.surfaceState === 'error' || input.surfaceState === 'permission_required'
            ? 'blocked'
            : input.surfaceState === 'connecting' || input.surfaceState === 'reconnecting'
                ? 'shadow'
                : input.status === 'disconnected' ? 'mic' : 'light',
        statusCell: input.status !== 'connected' ? null
            : input.sessionStatus?.state === 'permission_required' || input.sessionStatus?.state === 'action_required'
                ? 'needs_you'
                : input.sessionStatus?.state === 'thinking' ? 'working'
                    : input.surfaceState === 'thinking' ? 'thinking' : null,
    };
}
