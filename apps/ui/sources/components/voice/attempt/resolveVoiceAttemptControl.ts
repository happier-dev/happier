import type { VoiceLightStop } from '@/components/voice/light/voiceLightTokens';
import type { VoiceSurfaceState } from '@/components/voice/surface/resolveVoiceSurfaceState';
import type { VoiceSurfaceStatusTone } from '@/components/voice/surface/resolveVoiceSurfaceStatusPresentation';

import { resolveVoiceAttemptLightStop } from './resolveVoiceAttemptLightStop';

/**
 * Whether a transport is worth presenting at all.
 *
 * `recoverable` still renders — tapping opens the canonical recovery action. `unavailable` does
 * not: a transport that cannot do anything is worse than no transport.
 */
export type VoiceAttemptAvailability = 'ready' | 'recoverable' | 'unavailable';
export type VoiceAttemptPrimaryAction = 'start' | 'end' | 'recover' | null;

export function resolveVoiceAttemptActionability(input: Readonly<{
    canStart: boolean;
    canStop: boolean;
    recoveryAvailable: boolean;
}>): Readonly<{
    availability: VoiceAttemptAvailability;
    primaryAction: VoiceAttemptPrimaryAction;
}> {
    return {
        availability: input.canStop || input.canStart
            ? 'ready'
            : input.recoveryAvailable
                ? 'recoverable'
                : 'unavailable',
        primaryAction: input.canStop
            ? 'end'
            : input.canStart
                ? 'start'
                : input.recoveryAvailable
                    ? 'recover'
                    : null,
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
 * It carries **no placement knowledge**: `surfaceLocation` and `scopeDefault` are Horizon-only
 * policy. If the orb consulted `surfaceLocation`, choosing "session" would silently delete the
 * floating companion.
 */
export type VoiceAttemptControl = Readonly<{
    availability: VoiceAttemptAvailability;
    /** An attempt is running — global or session-bound. The orb mirrors whichever it is. */
    live: boolean;
    canStart: boolean;
    canStop: boolean;
    canMute: boolean;
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
    const { availability, primaryAction } = resolveVoiceAttemptActionability({
        canStart,
        canStop,
        recoveryAvailable,
    });
    return {
        availability,
        live,
        canStart,
        canStop,
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
    };
}
