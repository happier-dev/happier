import { describe, expect, it } from 'vitest';

import {
    LOADING_INDICATOR_PAUSE_IDS,
    LOADING_INDICATOR_SPEED_IDS,
    LOADING_INDICATOR_STYLE_IDS,
    normalizeLoadingIndicatorTiming,
    isLoadingIndicatorStyleId,
} from '@/sync/domains/settings/registry/local/loadingIndicatorStyleSetting';
import {
    DOT_SPINNER_FRAMES_PER_SECOND,
    getDotSpinnerFrames,
    unwrapHueSeries,
} from './dotSpinnerFrames';
import {
    DOT_REST_OPACITY,
    DOT_SPINNER_STYLES,
    loadingIndicatorTimingControls,
    type DotSpinnerStyleId,
    type DotSpinnerTiming,
} from './dotSpinnerStyles';

const DOT_STYLE_IDS = LOADING_INDICATOR_STYLE_IDS.filter((id): id is DotSpinnerStyleId => id !== 'classicRing');
const DEFAULT: DotSpinnerTiming = { speed: 'normal', pause: 'short' };
const FRAME_MS = 1000 / DOT_SPINNER_FRAMES_PER_SECOND;

function dotSeries(styleId: DotSpinnerStyleId, dotId: string, timing: DotSpinnerTiming = DEFAULT): number[] {
    const frames = getDotSpinnerFrames(styleId, timing);
    const index = frames.dots.findIndex((dot) => dot.id === dotId);
    return Array.from({ length: frames.frameCount }, (_, frame) => frames.opacity[frame * frames.dots.length + index]!);
}

describe('dot spinner frames', () => {
    it('draws the Happier mark by default and retains the seven-dot H as a selectable style', () => {
        const mark = getDotSpinnerFrames('wave', DEFAULT);
        expect(mark.dots).toHaveLength(8);
        expect(mark.dots.some((dot) => dot.id === 'BC')).toBe(true);
        expect(isLoadingIndicatorStyleId('hWave')).toBe(true);
        if (!isLoadingIndicatorStyleId('hWave')) return;
        const h = getDotSpinnerFrames('hWave', DEFAULT);
        expect(h.dots).toHaveLength(7);
        expect(h.key).not.toBe(mark.key);
        expect(h.cycleMs).toBe(mark.cycleMs);
    });

    it.each(DOT_STYLE_IDS.filter((id) => !id.startsWith('h') || id === 'handwritten'))('%s animates the bottom-centre dot with the rest of the mark', (styleId) => {
        const frames = getDotSpinnerFrames(styleId, DEFAULT);
        expect(frames.dots.some((dot) => dot.id === 'BC')).toBe(true);
        const index = frames.dots.findIndex((dot) => dot.id === 'BC');
        const signal = frames.hue ?? frames.opacity;
        const series = Array.from({ length: frames.frameCount }, (_, frame) => signal[frame * frames.dots.length + index]!);
        expect(Math.max(...series) - Math.min(...series)).toBeGreaterThan(0.5);
    });

    it('gives every selectable dot style a style definition', () => {
        expect(Object.keys(DOT_SPINNER_STYLES).sort()).toEqual([...DOT_STYLE_IDS].sort());
    });

    it.each(DOT_STYLE_IDS)('%s plays at the shared frame rate, loops without a seam, and visibly moves', (styleId) => {
        const style = DOT_SPINNER_STYLES[styleId];
        const frames = getDotSpinnerFrames(styleId, DEFAULT);

        expect(frames.frameCount).toBe(Math.round((frames.cycleMs * DOT_SPINNER_FRAMES_PER_SECOND) / 1000));
        expect(frames.opacity).toHaveLength(frames.frameCount * frames.dots.length);
        expect(frames.opacity.every((value) => value >= 0 && value <= 1)).toBe(true);

        for (const dot of frames.dots) {
            if (style.loop === 'continuous') {
                expect(style.opacity(dot, style.motionMs)).toBeCloseTo(style.opacity(dot, 0), 5);
                if (style.hue) expect(style.hue(dot, style.motionMs) % 1).toBeCloseTo(style.hue(dot, 0) % 1, 5);
            } else {
                // A resting style's motion ends with every dot back at rest, so the pause joins it seamlessly.
                expect(style.opacity(dot, style.motionMs)).toBeCloseTo(DOT_REST_OPACITY, 2);
            }
        }

        const signal = frames.hue ?? frames.opacity;
        const swing = Math.max(...frames.dots.map((_, i) => {
            const series = Array.from({ length: frames.frameCount }, (_, f) => signal[f * frames.dots.length + i]!);
            return Math.max(...series) - Math.min(...series);
        }));
        expect(swing).toBeGreaterThan(0.5);
    });

    it('plays the wave as its motion (first dot lit to last dot at rest) then the chosen pause', () => {
        // 4 diagonal steps of 110 ms plus a 364 ms lit envelope: 804 ms of motion.
        expect(getDotSpinnerFrames('wave', { speed: 'normal', pause: 'none' }).cycleMs).toBe(804);
        expect(getDotSpinnerFrames('wave', { speed: 'normal', pause: 'short' }).cycleMs).toBe(1004);
        expect(getDotSpinnerFrames('wave', { speed: 'normal', pause: 'long' }).cycleMs).toBe(1304);

        const frames = getDotSpinnerFrames('wave', { speed: 'normal', pause: 'short' });
        // Apart from the motion's first frame (the foot about to light), the pause is the only rest.
        const restingFrames = Array.from({ length: frames.frameCount }, (_, frame) => frames.opacity
            .slice(frame * frames.dots.length, (frame + 1) * frames.dots.length)
            .every((value) => value <= DOT_REST_OPACITY)).filter(Boolean).length;
        expect(restingFrames * FRAME_MS).toBeGreaterThanOrEqual(190);
        expect(restingFrames * FRAME_MS).toBeLessThanOrEqual(240);
    });

    it('scales the motion by the speed and keeps the pause in absolute ms', () => {
        expect(getDotSpinnerFrames('wave', { speed: 'fast', pause: 'short' }).cycleMs).toBe(Math.round(804 / 1.5 + 200));
        expect(getDotSpinnerFrames('wave', { speed: 'slow', pause: 'short' }).cycleMs).toBe(Math.round(804 / 0.75 + 200));
        expect(getDotSpinnerFrames('wave', { speed: 'fast', pause: 'long' }).cycleMs).toBe(Math.round(804 / 1.5 + 500));

        const litMs = (timing: DotSpinnerTiming) => dotSeries('wave', 'BL', timing).filter((value) => value > DOT_REST_OPACITY).length * FRAME_MS;
        expect(litMs({ speed: 'normal', pause: 'short' })).toBeCloseTo(364, -2);
        expect(litMs({ speed: 'normal', pause: 'long' })).toBeCloseTo(litMs({ speed: 'normal', pause: 'none' }), -1);
        expect(litMs({ speed: 'fast', pause: 'short' })).toBeCloseTo(364 / 1.5, -2);
    });

    it('loops continuous styles straight on: the speed applies, the pause does not', () => {
        const radar = (timing: DotSpinnerTiming) => getDotSpinnerFrames('radar', timing);

        expect(radar({ speed: 'normal', pause: 'none' }).cycleMs).toBe(1100);
        expect(radar({ speed: 'normal', pause: 'long' })).toBe(radar({ speed: 'normal', pause: 'none' }));
        expect(radar({ speed: 'fast', pause: 'short' }).cycleMs).toBe(733);
        expect(loadingIndicatorTimingControls('radar')).toEqual({ speed: true, pause: false });
        expect(loadingIndicatorTimingControls('wave')).toEqual({ speed: true, pause: true });
        expect(loadingIndicatorTimingControls('classicRing')).toEqual({ speed: false, pause: false });
    });

    it('shares one table per distinct style and timing', () => {
        const tables = new Set<unknown>();
        for (const speed of LOADING_INDICATOR_SPEED_IDS) {
            for (const pause of LOADING_INDICATOR_PAUSE_IDS) {
                const frames = getDotSpinnerFrames('wave', { speed, pause });
                expect(getDotSpinnerFrames('wave', { speed, pause })).toBe(frames);
                tables.add(frames.key);
            }
        }
        expect(tables.size).toBe(9);
    });

    it('plays unknown stored speeds and pauses at the defaults', () => {
        expect(normalizeLoadingIndicatorTiming('fast', 'none')).toEqual({ speed: 'fast', pause: 'none' });
        expect(normalizeLoadingIndicatorTiming('warp', 42)).toEqual({ speed: 'normal', pause: 'short' });
        expect(normalizeLoadingIndicatorTiming(undefined, undefined)).toEqual(DEFAULT);
    });

    it('lights the wave from the bottom-left foot to the top-right corner', () => {
        const peakFrame = (dotId: string) => {
            const series = dotSeries('wave', dotId);
            return series.indexOf(Math.max(...series));
        };

        expect(peakFrame('BL')).toBeLessThan(peakFrame('ML'));
        expect(peakFrame('ML')).toBeLessThan(peakFrame('TL'));
        expect(peakFrame('TL')).toBe(peakFrame('MC'));
        expect(peakFrame('MC')).toBe(peakFrame('BR'));
        expect(peakFrame('BR')).toBeLessThan(peakFrame('MR'));
        expect(peakFrame('MR')).toBeLessThan(peakFrame('TR'));
    });
});

describe('unwrapHueSeries', () => {
    it('removes wraps so neighbouring frames never interpolate the long way round the accent gradient', () => {
        const round = (series: number[]) => series.map((value) => Math.round(value * 100) / 100);
        expect(round(unwrapHueSeries([0.9, 0.98, 0.02, 0.1]))).toEqual([0.9, 0.98, 1.02, 1.1]);
        expect(round(unwrapHueSeries([0.1, 0.02, 0.98, 0.9]))).toEqual([0.1, 0.02, -0.02, -0.1]);
    });

    it('keeps every aurora frame step under half a gradient lap', () => {
        const frames = getDotSpinnerFrames('aurora', DEFAULT);
        for (let dot = 0; dot < frames.dots.length; dot++) {
            const series = unwrapHueSeries(Array.from({ length: frames.frameCount }, (_, frame) => frames.hue![frame * frames.dots.length + dot]!));
            for (let i = 1; i < series.length; i++) expect(Math.abs(series[i]! - series[i - 1]!)).toBeLessThanOrEqual(0.5);
        }
    });
});
