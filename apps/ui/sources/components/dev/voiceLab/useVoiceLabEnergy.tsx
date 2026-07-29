import * as React from 'react';
import {
    useFrameCallback,
    useSharedValue,
    type SharedValue,
} from 'react-native-reanimated';

import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import type { VoiceLabStateSpec } from './voiceLabModel';

/**
 * One clock for the whole lab.
 *
 * Every concept animates from these shared values on the UI thread. Nothing here
 * touches React state, so mounting nine concepts side by side still costs one
 * frame callback and zero re-renders per frame — the same discipline the
 * production `VoiceLevelVisualizer` already follows and that
 * `VoiceSurfaceLevelRenderCount.test.tsx` pins.
 *
 * Three rules this implementation exists to demonstrate:
 *
 *  1. **Frame-rate independence.** Smoothing uses `1 - exp(-dt/τ)` with τ in
 *     seconds, not a fixed per-frame coefficient. A per-frame coefficient
 *     converges in half the wall-clock time on a 120 Hz display, which is how a
 *     voice meter ends up feeling different on a MacBook and an iPhone.
 *  2. **One shared preview clock.** The callback stays active while animated
 *     preview is enabled, regardless of how many concepts mount. Freeze-frame
 *     and reduced-motion previews deactivate it entirely.
 *  3. **Breath is gated off by real signal.** Ambient motion exists to say
 *     "alive"; the moment real amplitude drives the shape it would only fight it.
 */
export type VoiceLabEnergy = Readonly<{
    /** Monotonic seconds since the clock started. Drives idle breath and drift. */
    clock: SharedValue<number>;
    /** 0..1 smoothed amplitude envelope. Fast attack, slow release. */
    level: SharedValue<number>;
    /** 1 while a source is producing amplitude. */
    sourceActive: SharedValue<number>;
    /** 0..1 resting luminosity for the current state, cross-faded between states. */
    luminosity: SharedValue<number>;
    /** Direction of travel: -1 inward (you are heard), +1 outward (it speaks), 0 otherwise. */
    flow: SharedValue<number>;
    /** 1 when ambient breath should run — i.e. live but not currently driven by amplitude. */
    breathGate: SharedValue<number>;
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

const EnergyContext = React.createContext<VoiceLabEnergy | null>(null);

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

/** Scrolling-meter geometry. 30 Hz matches the rate the shipped level store publishes at. */
export const HISTORY_SLOTS = 28;
const HISTORY_HZ = 30;
const HISTORY_INTERVAL = 1 / HISTORY_HZ;
const EMPTY_HISTORY: readonly number[] = new Array(HISTORY_SLOTS).fill(0);

/**
 * A speech-shaped amplitude source.
 *
 * Real speech is a syllable rate gating a faster carrier, with pauses. Three
 * incommensurate components plus a slow gate give an envelope that never
 * visibly loops — which matters because this surface is on screen for hours.
 */
function synthesizeAmplitude(t: number, outward: boolean): number {
    'worklet';
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

export function VoiceLabEnergyProvider(props: Readonly<{
    state: VoiceLabStateSpec;
    /**
     * Freeze the clock at an exact millisecond and render one deterministic
     * frame. Screenshot QA and visual regression are impossible against a live
     * clock; this is how a concept becomes diffable.
     */
    previewTimeMs?: number | null;
    children: React.ReactNode;
}>) {
    const reduced = useReducedMotionPreference();
    const clock = useSharedValue(0);
    const level = useSharedValue(0);
    const sourceActive = useSharedValue(0);
    const luminosity = useSharedValue(props.state.luminosity);
    const flow = useSharedValue(0);
    const breathGate = useSharedValue(1);
    const history = useSharedValue<readonly number[]>(EMPTY_HISTORY);
    // Peak-hold between samples, and the timestamp of the last shift.
    const historyPeak = useSharedValue(0);
    const historyAt = useSharedValue(0);

    // State the worklet reads must itself live in shared values.
    const energized = useSharedValue(props.state.energized ? 1 : 0);
    const targetLuminosity = useSharedValue(props.state.luminosity);
    const targetFlow = useSharedValue(0);
    const outward = useSharedValue(0);

    const { direction, energized: isEnergized, luminosity: stateLuminosity } = props.state;

    React.useEffect(() => {
        energized.set(isEnergized ? 1 : 0);
        sourceActive.set(isEnergized ? 1 : 0);
        targetLuminosity.set(stateLuminosity);
        targetFlow.set(direction === 'inward' ? -1 : direction === 'outward' ? 1 : 0);
        outward.set(direction === 'outward' ? 1 : 0);
    }, [
        direction, energized, isEnergized, outward, sourceActive,
        stateLuminosity, targetFlow, targetLuminosity,
    ]);

    // A frozen preview needs no clock at all: resolve every value once and stop.
    const preview = props.previewTimeMs ?? null;
    const live = preview === null && !reduced;

    React.useEffect(() => {
        if (live) return;
        const t = (preview ?? 0) / 1000;
        clock.set(t);
        luminosity.set(stateLuminosity);
        flow.set(direction === 'inward' ? -1 : direction === 'outward' ? 1 : 0);
        breathGate.set(0);
        history.set(EMPTY_HISTORY);
        level.set(
            isEnergized
                ? (preview === null ? 0.5 : synthesizeAmplitude(t, direction === 'outward'))
                : 0,
        );
    }, [
        breathGate, clock, direction, flow, history, isEnergized, level, live,
        luminosity, preview, stateLuminosity,
    ]);

    const frame = useFrameCallback((info) => {
        'worklet';
        // First frame has no previous frame; 16ms is the only honest guess.
        const dt = Math.min(0.1, (info.timeSincePreviousFrame ?? 16) / 1000);
        clock.set(info.timestamp / 1000);

        // Frame-rate-independent exponential smoothing.
        const kState = 1 - Math.exp(-dt / TAU_STATE);
        const lum = luminosity.get();
        luminosity.set(lum + (targetLuminosity.get() - lum) * kState);
        const fl = flow.get();
        flow.set(fl + (targetFlow.get() - fl) * kState);

        const target = energized.get() > 0
            ? synthesizeAmplitude(info.timestamp / 1000, outward.get() > 0)
            : 0;
        const current = level.get();
        const k = 1 - Math.exp(-dt / (target > current ? TAU_ATTACK : TAU_RELEASE));
        const next = current + (target - current) * k;
        const settled = next < EPSILON && target < EPSILON ? 0 : next;
        level.set(settled);

        // Ambient breath yields to any real signal rather than fighting it.
        breathGate.set(1 - Math.min(1, settled * 3));

        // Scroll the meter on a wall-clock schedule, carrying the peak seen
        // since the last shift so a fast transient still leaves a bar.
        const now = info.timestamp / 1000;
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
    }, false);

    React.useEffect(() => {
        frame.setActive(live);
        return () => frame.setActive(false);
    }, [frame, live]);

    const value = React.useMemo<VoiceLabEnergy>(
        () => ({ clock, level, sourceActive, luminosity, flow, breathGate, history, reduced }),
        [breathGate, clock, flow, history, level, luminosity, reduced, sourceActive],
    );

    return <EnergyContext.Provider value={value}>{props.children}</EnergyContext.Provider>;
}

export function useVoiceLabEnergy(): VoiceLabEnergy {
    const value = React.useContext(EnergyContext);
    if (!value) throw new Error('useVoiceLabEnergy must be used inside VoiceLabEnergyProvider');
    return value;
}
