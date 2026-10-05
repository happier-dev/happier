import * as React from 'react';
import {
    Easing,
    runOnJS,
    useDerivedValue,
    useFrameCallback,
    useSharedValue,
    withTiming,
    type FrameInfo,
    type SharedValue,
} from 'react-native-reanimated';

import { useVoiceLevelSharedValue } from '@/components/voice/surface/useVoiceLevelSharedValue';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useHostActivelyFocused } from '@/utils/runtime/useHostActivelyViewed';
import { voiceRuntimeLevelStore } from '@/voice/runtime/levels/voiceRuntimeLevelStore';

import { resolveVoiceEnergyActive } from './resolveVoiceEnergyActive';

/**
 * How energy moves. Owned here rather than by any one presentation, because the
 * direction is a property of the *conversation*, not of the surface drawing it.
 */
export type VoiceEnergyDirection =
    /** No energy. */
    | 'none'
    /** Gathering toward the centre — the user is being heard. */
    | 'inward'
    /** Radiating from the centre — Happier is speaking. */
    | 'outward'
    /** Slow orbital drift — considering. */
    | 'orbit'
    /** Still and dense — delegated work is running somewhere else. */
    | 'deep'
    /** A single held crescent — something needs a decision. */
    | 'hold'
    /** Irregular, searching — the connection is unhealthy. */
    | 'unsettled';

/**
 * The whole input this provider needs.
 *
 * Deliberately three fields, not a presentation's state object: the energy
 * provider must not know what a "surface state" is, or it becomes coupled to
 * whichever consumer defined that shape first. Consumers project onto this.
 */
export type VoiceEnergyState = Readonly<{
    /** 0..1 resting luminosity. */
    luminosity: number;
    /** Whether a source is producing amplitude. */
    energized: boolean;
    direction: VoiceEnergyDirection;
}>;

/**
 * One clock for the whole app.
 *
 * Every Voice surface animates from these shared values on the UI thread.
 * Nothing here touches React state per frame, so Horizon, the Orb and the
 * composer planet together still cost one frame callback and zero re-renders per
 * audio frame — the discipline `VoiceSurfaceLevelRenderCount.test.tsx` pins.
 *
 * Two rules this implementation exists to hold:
 *
 *  1. **Frame-rate independence.** Smoothing uses `1 - exp(-dt/τ)` with τ in
 *     seconds, not a fixed per-frame coefficient. A per-frame coefficient
 *     converges in half the wall-clock time on a 120 Hz display, which is how a
 *     voice meter ends up feeling different on a MacBook and an iPhone.
 *  2. **The clock runs only while something is happening.** Activation is the
 *     predicate in `resolveVoiceEnergyActive`; a frozen preview and reduced
 *     motion deactivate it entirely.
 * Silent open microphones and connecting attempts do not animate. Production
 * amplitude is real audio; bounded event transforms belong to the shared mark.
 */
export type VoiceEnergy = Readonly<{
    /** Frame time in seconds; frozen when audio/history settles or motion is disallowed. */
    clock: SharedValue<number>;
    /** 0..1 smoothed amplitude envelope. Fast attack, slow release. */
    level: SharedValue<number>;
    /** 1 while an actual input/output source is open, independent of amplitude. */
    sourceActive: SharedValue<number>;
    /** 0..1 resting luminosity for the current state, cross-faded between states. */
    luminosity: SharedValue<number>;
    /** Direction of travel: -1 inward (you are heard), +1 outward (it speaks), 0 otherwise. */
    flow: SharedValue<number>;
    /** Explicit old-artwork preview term only; always zero in production. */
    respiration: SharedValue<number>;
    /** Kept zero until old artwork consumers migrate; no automatic arrival clock. */
    arrival: SharedValue<number>;
    /**
     * Rolling amplitude history, oldest first, newest last.
     *
     * A scrolling meter shows the recent *past*; a symmetric EQ does not, which
     * is why a mirrored bar chart never looks like speech. Sampled at a fixed
     * rate rather than per frame — a 120 Hz display must not scroll twice as
     * fast as a 60 Hz one — and each slot carries the **peak** since the last
     * sample so short consonants are not dropped between ticks.
     */
    history: SharedValue<readonly number[]>;
    /** True when the user asked for reduced motion. */
    reduced: boolean;
}>;

/**
 * The live Voice runtime facts the energy clock's activation depends on.
 *
 * Absent when no Voice runtime is attached — the design lab and frozen previews.
 */
export type VoiceEnergyRuntimeActivation = Readonly<{
    providerReady: boolean;
    attemptActive: boolean;
    /**
     * The microphone is genuinely capturing — `resolveVoiceMicCaptureActive`.
     *
     * Required, and deliberately separate from `attemptActive`: the two answer
     * different questions (§2.4a), and collapsing them is precisely how the
     * planet came to breathe while the runtime was still acquiring the mic.
     */
    micCaptureActive: boolean;
}>;

/** Registration for a surface that is on screen and wants the clock to run. */
export type VoiceEnergyPresence = Readonly<{
    acquire: () => void;
    release: () => void;
}>;

const EnergyContext = React.createContext<VoiceEnergy | null>(null);
const PresenceContext = React.createContext<VoiceEnergyPresence | null>(null);

/**
 * Time constants in seconds, measured against the shipped level store
 * (`voiceRuntimeLevelStore` ATTACK 0.65 / RELEASE 0.25) and the reference
 * implementations surveyed in the audit. The asymmetry is the entire difference
 * between "responsive" and "twitchy".
 */
const TAU_ATTACK = 0.1;
const TAU_RELEASE = 0.3;
const TAU_STATE = 0.28;
const EPSILON = 0.004;

/**
 * The settle back to still, when the clock stops.
 *
 * Derived from `TAU_RELEASE` rather than chosen: the worklet's release is
 * exponential and never literally reaches zero, and three time constants is
 * where an exponential is visually finished (~5% left). Continuing the same
 * release constant is what makes the hand-off invisible — the amplitude keeps
 * falling at the rate it was already falling instead of switching to a second,
 * unrelated curve. Decelerating, because a settle that ends abruptly reads as a
 * cut. This remains an audio-envelope release, not timer-driven breath.
 */
const SETTLE = {
    duration: Math.round(TAU_RELEASE * 3 * 1000),
    easing: Easing.out(Easing.quad),
} as const;

/** Scrolling-meter geometry. 30 Hz matches the rate the shipped level store publishes at. */
export const HISTORY_SLOTS = 28;
const HISTORY_HZ = 30;
const HISTORY_INTERVAL = 1 / HISTORY_HZ;
const EMPTY_HISTORY: readonly number[] = new Array(HISTORY_SLOTS).fill(0);

/**
 * The microphone takes the shape over above ENTER and keeps it until its
 * amplitude falls below EXIT. The band is the whole point: with a single
 * threshold a duplex passage flips channel at the syllable rate, and the meter
 * visibly jumps between two unrelated amplitudes.
 */
const INPUT_TAKEOVER_ENTER = 0.08;
const INPUT_TAKEOVER_EXIT = 0.035;

// React observes only silence↔audio crossings. Per-sample amplitudes continue
// through the existing SharedValue bridge and never update the app tree.
function hasAudioAmplitude(): boolean {
    const sample = voiceRuntimeLevelStore.getSnapshot();
    return (sample.inputSourceActive && sample.inputLevel > 0)
        || (sample.outputSourceActive && sample.outputLevel > 0);
}

function subscribeAmplitudePresence(listener: () => void): () => void {
    const input = voiceRuntimeLevelStore.subscribe('input', listener);
    const output = voiceRuntimeLevelStore.subscribe('output', listener);
    return () => { input(); output(); };
}

/**
 * A speech-shaped amplitude source, used only to give a **frozen preview** an
 * envelope worth looking at.
 *
 * The live path reads the real meter; a screenshot has no meter to read, and a
 * flat preview cannot be judged or diffed. Real speech is a syllable rate gating
 * a faster carrier, with pauses: three incommensurate components plus a slow
 * gate give an envelope that never visibly loops.
 */
function synthesizeAmplitude(t: number, outward: boolean): number {
    const syllable = 0.5 + 0.5 * Math.sin(t * 6.9);
    const carrier = 0.5 + 0.5 * Math.sin(t * 17.3 + 1.7);
    const drift = 0.5 + 0.5 * Math.sin(t * 1.31 + 0.4);
    // Pauses are shallow, not silent: a real room has tone between words, and a
    // meter that flatlines for seconds at a time cannot be judged.
    const gate = Math.max(0.3, Math.sin(t * 0.77 + 2.1) * 1.4 + 0.35);
    const raw = (syllable * 0.55 + carrier * 0.25 + drift * 0.2) * Math.min(1, gate);
    // The assistant's own voice is steadier and louder than a room microphone.
    return outward ? 0.34 + raw * 0.62 : 0.06 + raw * 0.82;
}

export function VoiceEnergyProvider(props: Readonly<{
    state: VoiceEnergyState;
    activation?: VoiceEnergyRuntimeActivation | null;
    /**
     * Freeze the clock at an exact millisecond and render one deterministic
     * frame. Screenshot QA and visual regression are impossible against a live
     * clock; this is how a concept becomes diffable.
     */
    previewTimeMs?: number | null;
    children: React.ReactNode;
}>) {
    const reduced = useReducedMotionPreference();
    const runtimeMotionActive = useHostActivelyFocused();
    const audioAmplitudePresent = React.useSyncExternalStore(subscribeAmplitudePresence, hasAudioAmplitude, () => false);
    // Two calls, two literal channels. `useVoiceLevelSharedValue` samples the
    // store only at mount and re-binds just the subscription, so a dynamic
    // channel argument leaves the shared value holding the other channel's last
    // amplitude until the new one next publishes. The selection happens in the
    // worklet instead, where it costs nothing.
    const { level: inputLevel, sourceActive: inputSourceActive } = useVoiceLevelSharedValue('input');
    const { level: outputLevel, sourceActive: outputSourceActive } = useVoiceLevelSharedValue('output');

    const clock = useSharedValue(0);
    const level = useSharedValue(0);
    const previewSourceActive = props.previewTimeMs != null ? (props.state.energized ? 1 : 0) : null;
    const sourceActive = useDerivedValue<number>(() => {
        'worklet';
        return previewSourceActive ?? (inputSourceActive.get() > 0 || outputSourceActive.get() > 0 ? 1 : 0);
    });
    const luminosity = useSharedValue(props.state.luminosity);
    const flow = useSharedValue(0);
    const respiration = useSharedValue(0);
    const arrival = useSharedValue(0);
    const history = useSharedValue<readonly number[]>(EMPTY_HISTORY);
    // Peak-hold between samples, and the timestamp of the last shift.
    const historyPeak = useSharedValue(0);
    const historyAt = useSharedValue(0);

    // State the worklet reads must itself live in shared values.
    const targetLuminosity = useSharedValue(props.state.luminosity);
    /** Which channel the shape is currently reading: -1 input, +1 output, 0 idle. */
    const channel = useSharedValue(0);

    const { direction, energized: isEnergized, luminosity: stateLuminosity } = props.state;

    React.useEffect(() => {
        targetLuminosity.set(stateLuminosity);
    }, [stateLuminosity, targetLuminosity]);

    /*
     * Consumer presence lives in a ref, and only the 0↔1 crossing is published.
     * Publishing the count instead would re-render every Voice surface whenever
     * any other one mounts.
     */
    const consumerCount = React.useRef(0);
    const [hasVisibleConsumer, setHasVisibleConsumer] = React.useState(false);
    const presence = React.useMemo<VoiceEnergyPresence>(() => ({
        acquire: () => {
            consumerCount.current += 1;
            if (consumerCount.current === 1) setHasVisibleConsumer(true);
        },
        release: () => {
            // An unbalanced release must not push the count negative: a negative
            // count never reaches 1 again, and every later surface would mount
            // into a dead clock.
            if (consumerCount.current === 0) return;
            consumerCount.current -= 1;
            if (consumerCount.current === 0) setHasVisibleConsumer(false);
        },
    }), []);

    // A frozen preview needs no clock at all: resolve every value once and stop.
    const preview = props.previewTimeMs ?? null;
    const motionAllowed = preview === null && !reduced;

    // Runtime absence never selects a synthetic live source. A frozen preview
    // must opt in explicitly with previewTimeMs.
    const runtime = props.activation ?? null;
    const attemptActive = runtime?.attemptActive ?? true;
    const micCaptureActive = runtime?.micCaptureActive ?? (preview !== null);
    const gatesOpen = runtimeMotionActive && (runtime?.providerReady ?? true)
        && motionAllowed && hasVisibleConsumer;
    const active = resolveVoiceEnergyActive({
        runtimeMotionActive,
        providerReady: runtime?.providerReady ?? true,
        motionAllowed,
        hasVisibleConsumer,
        audioAmplitudePresent,
        settleTransitionPending: attemptActive && (level.get() > 0 || history.get().some((slot) => slot > 0)),
    });

    /*
     * A frozen or reduced-motion preview resolves **during render**, not in an
     * effect.
     *
     * Children read these SharedValues inside their own render pass, and every
     * light primitive is `React.memo`. An effect writes one frame too late, and a
     * memoized child never re-renders to pick the value up — so the whole tree
     * paints with `clock = 0` and simply stays there. In the lab that is a
     * one-frame flash of unset motion; in the golden-frame test it silently pins
     * every time-dependent value at zero, which makes the fidelity gate blind to
     * exactly the motion it exists to protect.
     *
     * Writing here is safe: a SharedValue is a mutable container, not React
     * state, so this schedules no update and cannot loop. The writes are pure
     * functions of props and idempotent, so repeating them per render is free.
     */
    if (!motionAllowed) {
        const t = (preview ?? 0) / 1000;
        clock.set(t);
        luminosity.set(stateLuminosity);
        flow.set(direction === 'inward' ? -1 : direction === 'outward' ? 1 : 0);
        /*
         * A frozen preview is a deliberate pose: it resolves respiration from
         * the capture fact so a screenshot shows what that moment looks like.
         * Reduced motion is the opposite — §9.2 stops respiration outright, and
         * it is the one gate that is an accessibility floor rather than an
         * efficiency measure. The arrival gesture has no still pose at all.
         */
        respiration.set(preview !== null && micCaptureActive ? 1 : 0);
        arrival.set(0);
        history.set(EMPTY_HISTORY);
        level.set(
            isEnergized
                ? (preview === null ? 0 : synthesizeAmplitude(t, direction === 'outward'))
                : 0,
        );
    }

    const frameHandle = React.useRef<ReturnType<typeof useFrameCallback> | null>(null);
    const stopSilentFrame = React.useCallback(() => {
        // A newer real sample can wake the owner before this UI→JS callback
        // arrives. Never let an old silence observation stop that new audio.
        if (!hasAudioAmplitude() && level.get() === 0 && history.get().every((slot) => slot === 0)) {
            frameHandle.current?.setActive(false);
        }
    }, [history, level]);

    // Hoisted: `useFrameCallback` re-registers the worklet whenever the callback
    // identity changes, so an inline arrow costs three UI-thread round-trips per
    // render. Every dependency below is a SharedValue, so this identity is stable
    // for the provider's lifetime.
    const onFrame = React.useCallback((info: FrameInfo) => {
        'worklet';
        // First frame has no previous frame; 16ms is the only honest guess.
        const dt = Math.min(0.1, (info.timeSincePreviousFrame ?? 16) / 1000);
        const now = info.timestamp / 1000;
        clock.set(now);

        // Frame-rate-independent exponential smoothing.
        const kState = 1 - Math.exp(-dt / TAU_STATE);
        const lum = luminosity.get();
        luminosity.set(lum + (targetLuminosity.get() - lum) * kState);

        /*
         * Channel priority, with hysteresis.
         *
         * A meaningful microphone amplitude always wins, because barge-in is the
         * moment inward motion carries the most meaning — "whichever side is
         * playing" would hide the user exactly then. The band around the
         * takeover keeps a duplex passage from flipping channel frame to frame.
         *
         * This is visual only: it chooses which amplitude drives the shape and
         * which way energy travels. It asserts nothing about who is speaking and
         * creates no semantic state.
         */
        const inputOpen = inputSourceActive.get() > 0;
        const inputAmplitude = inputLevel.get();
        const outputOpen = outputSourceActive.get() > 0;
        const takeover = channel.get() < 0 ? INPUT_TAKEOVER_EXIT : INPUT_TAKEOVER_ENTER;
        const selected = inputOpen && (inputAmplitude >= takeover || !outputOpen) ? -1 : (outputOpen ? 1 : 0);
        channel.set(selected);

        // With no audio evidence the direction is whatever the conversation state
        // says it is.
        const flowTarget = selected;
        const fl = flow.get();
        flow.set(fl + (flowTarget - fl) * kState);

        const target = selected > 0 ? outputLevel.get() : selected < 0 ? inputAmplitude : 0;
        const current = level.get();
        const k = 1 - Math.exp(-dt / (target > current ? TAU_ATTACK : TAU_RELEASE));
        const next = current + (target - current) * k;
        const settled = next < EPSILON && target < EPSILON ? 0 : next;
        level.set(settled);

        // Scroll the meter on a wall-clock schedule, carrying the peak seen
        // since the last shift so a fast transient still leaves a bar.
        const peak = Math.max(historyPeak.get(), settled);
        historyPeak.set(peak);
        if (now - historyAt.get() >= HISTORY_INTERVAL) {
            historyAt.set(now);
            historyPeak.set(0);
            const prev = history.get();
            const next = new Array(HISTORY_SLOTS);
            for (let i = 0; i < HISTORY_SLOTS - 1; i += 1) next[i] = prev[i + 1] ?? 0;
            next[HISTORY_SLOTS - 1] = peak;
            history.set(next);
        }
        if (target === 0 && settled === 0 && history.get().every((slot) => slot === 0)) {
            runOnJS(stopSilentFrame)();
        }
    }, [
        channel, clock, flow, history,
        historyAt, historyPeak, inputLevel, inputSourceActive, level, luminosity,
        outputLevel, outputSourceActive, stopSilentFrame, targetLuminosity,
    ]);

    // Never `autostart`: it is captured in the hook's `useRef` initializer, so the
    // effect that follows would read a stale value and the loop would never stop.
    const frame = useFrameCallback(onFrame, false);
    React.useEffect(() => {
        frameHandle.current = frame;
        return () => { frameHandle.current = null; };
    }, [frame]);

    // No cleanup: `useFrameCallback` unregisters the worklet on unmount itself,
    // and a `setActive(false)` here would only add a redundant transition.
    React.useEffect(() => {
        frame.setActive(active);
    }, [active, audioAmplitudePresent, frame]);

    React.useEffect(() => {
        if (active || !motionAllowed) return;

        /*
         * §2.4a — "Attempt ends → settles back to still."
         *
         * Stopping the clock is not the same as being still. `level`, `flow`
         * and `history` are written *only* inside the worklet, so a shape that
         * was mid-syllable when the last channel closed would stay frozen at
         * that amplitude, pointing that way, for as long as the surface is on
         * screen. These are the amplitude terms: they ease down, because §2.4a
         * asks the ending to ease rather than cut.
         *
         * Excluded on purpose when motion is not allowed: a frozen preview and
         * reduced motion resolve the entire pose during render, and a settle
         * would immediately overwrite it with zeros.
         */
        level.set(gatesOpen && level.get() > 0 ? withTiming(0, SETTLE) : 0);
        flow.set(gatesOpen && flow.get() !== 0 ? withTiming(0, SETTLE) : 0);
        // Resting brightness is state, not amplitude. The frame callback is the
        // normal cross-fade owner while an attempt is live; once it stops, it
        // cannot finish a transition to a visible idle/error state on its own.
        // Apply the semantic pose even if no audio clock is running.
        luminosity.set(stateLuminosity);
        // Old artwork consumers stay bootable while migrating to the dot mark;
        // neither term drives production motion anymore.
        respiration.set(0);
        arrival.set(0);
        // Not an amplitude: the meter's own bars retarget on a `withTiming` of
        // their own when the slots change, so emptying it here is already an
        // ease rather than a cut.
        history.set(EMPTY_HISTORY);
    }, [
        active, arrival, flow, gatesOpen, history,
        level, luminosity, motionAllowed, respiration, stateLuminosity,
    ]);

    const value = React.useMemo<VoiceEnergy>(
        () => ({
            clock, level, sourceActive, luminosity, flow, respiration, arrival, history, reduced,
        }),
        [
            arrival, clock, flow, history, level, luminosity, reduced, respiration, sourceActive,
        ],
    );

    return (
        <EnergyContext.Provider value={value}>
            <PresenceContext.Provider value={presence}>{props.children}</PresenceContext.Provider>
        </EnergyContext.Provider>
    );
}

export function useVoiceEnergy(): VoiceEnergy {
    const value = React.useContext(EnergyContext);
    if (!value) throw new Error('useVoiceEnergy must be used inside VoiceEnergyProvider');
    return value;
}

/**
 * The energy bus, if this tree has one.
 *
 * `useVoiceEnergy` throws on purpose: a light primitive drawing a planet
 * without a clock is a bug, not a degraded mode. A level meter is the other
 * case — a leaf any host may render, including hosts outside the app shell —
 * and its honest rendering without a clock is the instrument at rest. Returning
 * `null` is what stops that situation from being "solved" with a second frame
 * callback.
 */
export function useVoiceEnergyIfMounted(): VoiceEnergy | null {
    return React.useContext(EnergyContext);
}

export function useVoiceEnergyPresence(): VoiceEnergyPresence {
    const value = React.useContext(PresenceContext);
    if (!value) throw new Error('useVoiceEnergyPresence must be used inside VoiceEnergyProvider');
    return value;
}

/** Presence registration, if this tree has a bus. See `useVoiceEnergyIfMounted`. */
export function useVoiceEnergyPresenceIfMounted(): VoiceEnergyPresence | null {
    return React.useContext(PresenceContext);
}
