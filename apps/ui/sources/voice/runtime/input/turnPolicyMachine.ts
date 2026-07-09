/**
 * App-policy turn endpointing state machine — the SEPARATE second stage that
 * sits above the acoustic VAD.
 *
 * The VAD's own min-silence / min-speech are kept LOW so `detected` tracks raw
 * sound; this machine applies the conversational hysteresis:
 *   idle → confirming (confirmMs false-start debounce)
 *        → speaking
 *        → ending (silenceMs end-of-turn hangover)
 *        → idle (emit speech_stopped)
 *
 * All timing is in window-time (the monotonic timestamp the caller advances as
 * it feeds audio windows), so the machine is pure and deterministic — no timers,
 * no clock. Ported from the validated Silero VAD session hysteresis.
 */

import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';

export type TurnPolicy = Readonly<{
    /** Sustained detection required before a turn is confirmed (false-start debounce). */
    confirmMs: number;
    /** Trailing silence required to end a confirmed turn (end-of-turn hangover). */
    silenceMs: number;
}>;

/**
 * Research-backed defaults: ~800 ms confirm, ~700 ms silence hangover. Sourced
 * from the canonical voice runtime config owner so the threshold lives in one
 * place (no magic numbers at call sites).
 */
export const DEFAULT_TURN_POLICY: TurnPolicy = Object.freeze({
    confirmMs: VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.endpointHysteresis.confirmMs,
    silenceMs: VOICE_RUNTIME_CONFIG_DEFAULTS.turnTaking.endpointHysteresis.silenceMs,
});

function clampBoundedMs(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.max(0, Math.min(5_000, Math.floor(value)));
}

export function normalizeTurnPolicy(raw: Readonly<{ confirmMs?: unknown; silenceMs?: unknown }>): TurnPolicy {
    return {
        confirmMs: clampBoundedMs(raw.confirmMs, DEFAULT_TURN_POLICY.confirmMs),
        silenceMs: clampBoundedMs(raw.silenceMs, DEFAULT_TURN_POLICY.silenceMs),
    };
}

export type TurnPolicyPhase = 'idle' | 'confirming' | 'speaking' | 'ending';

export type TurnPolicyEvent =
    | Readonly<{ kind: 'speech_started' }>
    | Readonly<{ kind: 'speech_stopped' }>;

export type TurnPolicyMachine = Readonly<{
    /** Advance the machine for one window. Returns an event when a boundary is crossed. */
    step: (args: Readonly<{ detected: boolean; windowTimeMs: number }>) => TurnPolicyEvent | null;
    /** Force-end the current turn (mic stop / abort). Emits speech_stopped if speech was confirmed. */
    flush: (args: Readonly<{ windowTimeMs: number }>) => TurnPolicyEvent | null;
    /** Reset to idle without emitting. */
    reset: () => void;
    phase: () => TurnPolicyPhase;
}>;

type InternalPhase =
    | { state: 'idle' }
    | { state: 'confirming'; startedAt: number }
    | { state: 'speaking' }
    | { state: 'ending'; startedAt: number };

export function createTurnPolicyMachine(args: Readonly<{ policy?: Partial<TurnPolicy> }> = {}): TurnPolicyMachine {
    const policy = normalizeTurnPolicy(args.policy ?? {});
    let phase: InternalPhase = { state: 'idle' };

    const step = ({ detected, windowTimeMs }: Readonly<{ detected: boolean; windowTimeMs: number }>): TurnPolicyEvent | null => {
        switch (phase.state) {
            case 'idle': {
                if (detected) {
                    phase = { state: 'confirming', startedAt: windowTimeMs };
                }
                return null;
            }
            case 'confirming': {
                if (!detected) {
                    phase = { state: 'idle' };
                    return null;
                }
                if (windowTimeMs - phase.startedAt >= policy.confirmMs) {
                    phase = { state: 'speaking' };
                    return { kind: 'speech_started' };
                }
                return null;
            }
            case 'speaking': {
                if (!detected) {
                    phase = { state: 'ending', startedAt: windowTimeMs };
                }
                return null;
            }
            case 'ending': {
                if (detected) {
                    phase = { state: 'speaking' };
                    return null;
                }
                if (windowTimeMs - phase.startedAt >= policy.silenceMs) {
                    phase = { state: 'idle' };
                    return { kind: 'speech_stopped' };
                }
                return null;
            }
        }
    };

    return {
        step,
        flush: ({ windowTimeMs: _windowTimeMs }) => {
            if (phase.state === 'speaking' || phase.state === 'ending') {
                phase = { state: 'idle' };
                return { kind: 'speech_stopped' };
            }
            // An unconfirmed (confirming) turn is discarded silently — a false start.
            phase = { state: 'idle' };
            return null;
        },
        reset: () => {
            phase = { state: 'idle' };
        },
        phase: () => phase.state,
    };
}
