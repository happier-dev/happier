import {
    DOT_REST_OPACITY,
    DOT_SPINNER_PAUSE_MS,
    DOT_SPINNER_SPEED_RATES,
    DOT_SPINNER_STYLES,
    type SpinnerDot,
    type DotSpinnerStyleId,
    type DotSpinnerTiming,
} from './dotSpinnerStyles';

/**
 * Dot styles are rendered as pre-sampled frames stepped at a fixed rate instead of animating each
 * dot continuously. Why sampled at all: measured in headless Chromium with 1000 copies on screen,
 * per-dot opacity animation at 60 fps cost ≈113% CPU (the compositor thread ticks one animation per
 * dot), and that cost scales with the frame rate. 30 fps is a deliberate point: four times the old
 * stepped ring's ≈7 fps, which read as laggy, at a fraction of the 60 fps per-dot cost.
 *
 * The renderers consume the table as data: web turns each dot's series into `element.animate()`
 * keyframes (`DotSpinnerWeb`), native interpolates it against a shared clock
 * (`DotSpinnerNative`). No platform builds SVG or image assets from it.
 */
export const DOT_SPINNER_FRAMES_PER_SECOND = 30;

/** Every dot at this ink is the still pose: paused spinners and reduced motion. */
export const DOT_SPINNER_STILL_OPACITY = 0.85;

export type DotSpinnerFrames = Readonly<{
    styleId: DotSpinnerStyleId;
    dots: readonly SpinnerDot[];
    /**
     * Identifies this table among every style and timing: the same key is the same frames. Pauses a
     * style ignores do not change it.
     */
    key: string;
    /** One loop as played: the motion at the chosen speed, then (for a resting style) the pause. */
    cycleMs: number;
    frameCount: number;
    ink: 'mono' | 'aurora';
    /** `frameCount × dots.length`, frame-major. */
    opacity: readonly number[];
    /** Same layout as `opacity`; only for aurora. Position on the looping accent gradient, 0–1. */
    hue: readonly number[] | null;
}>;

const framesCache = new Map<string, DotSpinnerFrames>();

function round2(value: number): number {
    return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

/**
 * The frame table for one style at one speed and pause. Speed divides the motion's duration; the
 * pause is appended as absolute ms with every dot at rest. Tables are built once per distinct timing
 * and shared, so every spinner of the same style, speed and pause draws the same frames.
 */
export function getDotSpinnerFrames(styleId: DotSpinnerStyleId, timing: DotSpinnerTiming): DotSpinnerFrames {
    const style = DOT_SPINNER_STYLES[styleId];
    const rate = DOT_SPINNER_SPEED_RATES[timing.speed];
    const restMs = style.loop === 'rests' ? DOT_SPINNER_PAUSE_MS[timing.pause] : 0;
    const key = `${styleId}.${timing.speed}.${restMs}`;
    const cached = framesCache.get(key);
    if (cached) return cached;

    const playedMotionMs = style.motionMs / rate;
    const playedCycleMs = playedMotionMs + restMs;
    const frameCount = Math.max(1, Math.round((playedCycleMs * DOT_SPINNER_FRAMES_PER_SECOND) / 1000));
    const opacity: number[] = [];
    const hue: number[] | null = style.hue ? [] : null;
    for (let frame = 0; frame < frameCount; frame++) {
        const playedMs = (frame * playedCycleMs) / frameCount;
        const resting = playedMs >= playedMotionMs;
        const tMs = playedMs * rate;
        for (const dot of style.dots) {
            opacity.push(round2(resting ? DOT_REST_OPACITY : style.opacity(dot, tMs)));
            if (hue && style.hue) hue.push(round2(style.hue(dot, resting ? style.motionMs : tMs)));
        }
    }
    const frames: DotSpinnerFrames = {
        styleId,
        dots: style.dots,
        key,
        cycleMs: Math.round(playedCycleMs),
        frameCount,
        ink: style.ink,
        opacity,
        hue,
    };
    framesCache.set(key, frames);
    return frames;
}

/** One dot's values across every frame of a frame-major table. */
export function readDotSeries(frames: DotSpinnerFrames, table: readonly number[], dotIndex: number): number[] {
    const series: number[] = [];
    for (let frame = 0; frame < frames.frameCount; frame++) series.push(table[frame * frames.dots.length + dotIndex]!);
    return series;
}

/**
 * A hue series with its wraps removed, so moving between neighbouring frames never sweeps the long
 * way round the gradient (0.98 → 0.02 would otherwise travel back through every accent). Renderers
 * keep the unwrapped position: a gradient or interpolation repeated per lap lands on it exactly.
 */
export function unwrapHueSeries(series: readonly number[]): number[] {
    const unwrapped: number[] = [];
    for (const value of series) {
        const previous = unwrapped[unwrapped.length - 1];
        let next = value;
        if (previous !== undefined) {
            while (next - previous > 0.5) next -= 1;
            while (previous - next > 0.5) next += 1;
        }
        unwrapped.push(next);
    }
    return unwrapped;
}

export type DotSpinnerInk = Readonly<{ color: string }> | Readonly<{ aurora: readonly [string, string, string] }>;
