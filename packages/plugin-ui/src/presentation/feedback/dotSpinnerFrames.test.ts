import { describe, expect, it } from 'vitest';

import {
  buildDotSpinnerFilmstripSvg,
  buildDotSpinnerStillSvg,
  DOT_SPINNER_FRAMES_PER_SECOND,
  getDotSpinnerFrames,
  readDotSeries,
  resolveAuroraBlend,
  unwrapHueSeries,
} from './dotSpinnerFrames.js';
import {
  DEFAULT_HAPPIER_SPINNER_TIMING,
  DOT_REST_OPACITY,
  DOT_SPINNER_STYLES,
  HAPPIER_SPINNER_PAUSE_IDS,
  HAPPIER_SPINNER_SPEED_IDS,
  HAPPIER_SPINNER_STYLE_IDS,
  happierSpinnerStyleTimingControls,
  normalizeHappierSpinnerStyleId,
  isHappierSpinnerStyleId,
  normalizeHappierSpinnerTiming,
  type DotSpinnerStyleId,
  type HappierSpinnerTiming,
} from './spinnerStyles.js';

const DOT_STYLE_IDS = HAPPIER_SPINNER_STYLE_IDS.filter((id): id is DotSpinnerStyleId => id !== 'classicRing');
const DEFAULT = DEFAULT_HAPPIER_SPINNER_TIMING;
const FRAME_MS = 1000 / DOT_SPINNER_FRAMES_PER_SECOND;

function dotSeries(styleId: DotSpinnerStyleId, dotId: string, timing: HappierSpinnerTiming = DEFAULT): number[] {
  const frames = getDotSpinnerFrames(styleId, timing);
  return readDotSeries(frames, frames.opacity, frames.dots.findIndex((dot) => dot.id === dotId));
}

describe('dot spinner frames', () => {
  it('draws the Happier mark by default and retains the seven-dot H as a selectable style', () => {
    const ink = { color: 'red' };
    const mark = getDotSpinnerFrames('wave', DEFAULT);
    expect(buildDotSpinnerStillSvg(mark, ink).match(/<circle /g)).toHaveLength(8);
    expect(buildDotSpinnerStillSvg(mark, ink)).toContain('cx="1.5" cy="2.5"');
    expect(isHappierSpinnerStyleId('hWave')).toBe(true);
    if (!isHappierSpinnerStyleId('hWave')) return;
    const h = getDotSpinnerFrames('hWave', DEFAULT);
    expect(buildDotSpinnerStillSvg(h, ink).match(/<circle /g)).toHaveLength(7);
    expect(h.key).not.toBe(mark.key);
    expect(h.cycleMs).toBe(mark.cycleMs);
  });

  it.each(DOT_STYLE_IDS.filter((id) => !id.startsWith('h') || id === 'handwritten'))('%s animates the bottom-centre dot with the rest of the mark', (styleId) => {
    const frames = getDotSpinnerFrames(styleId, DEFAULT);
    const index = frames.dots.findIndex((dot) => dot.id === 'BC');
    expect(index).toBeGreaterThanOrEqual(0);
    const series = readDotSeries(frames, frames.hue ?? frames.opacity, index);
    expect(Math.max(...series) - Math.min(...series)).toBeGreaterThan(0.5);
  });

  it('gives every selectable dot style a style definition', () => {
    expect(Object.keys(DOT_SPINNER_STYLES).sort()).toEqual([...DOT_STYLE_IDS].sort());
  });

  it('draws the wave for an id this build does not know', () => {
    expect(normalizeHappierSpinnerStyleId('radar')).toBe('radar');
    expect(normalizeHappierSpinnerStyleId('retiredStyle')).toBe('wave');
    expect(normalizeHappierSpinnerStyleId(undefined)).toBe('wave');
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
      const series = readDotSeries(frames, signal, i);
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

    const litMs = (timing: HappierSpinnerTiming) => dotSeries('wave', 'BL', timing).filter((value) => value > DOT_REST_OPACITY).length * FRAME_MS;
    expect(litMs({ speed: 'normal', pause: 'short' })).toBeCloseTo(364, -2);
    expect(litMs({ speed: 'normal', pause: 'long' })).toBeCloseTo(litMs({ speed: 'normal', pause: 'none' }), -1);
    expect(litMs({ speed: 'fast', pause: 'short' })).toBeCloseTo(364 / 1.5, -2);
  });

  it('loops continuous styles straight on: the speed applies, the pause does not', () => {
    const radar = (timing: HappierSpinnerTiming) => getDotSpinnerFrames('radar', timing);

    expect(radar({ speed: 'normal', pause: 'none' }).cycleMs).toBe(1100);
    expect(radar({ speed: 'normal', pause: 'long' })).toBe(radar({ speed: 'normal', pause: 'none' }));
    expect(radar({ speed: 'fast', pause: 'short' }).cycleMs).toBe(733);
    expect(happierSpinnerStyleTimingControls('radar')).toEqual({ speed: true, pause: false });
    expect(happierSpinnerStyleTimingControls('wave')).toEqual({ speed: true, pause: true });
    expect(happierSpinnerStyleTimingControls('classicRing')).toEqual({ speed: false, pause: false });
  });

  it('shares one table per distinct style and timing', () => {
    const tables = new Set<unknown>();
    for (const speed of HAPPIER_SPINNER_SPEED_IDS) {
      for (const pause of HAPPIER_SPINNER_PAUSE_IDS) {
        const frames = getDotSpinnerFrames('wave', { speed, pause });
        expect(getDotSpinnerFrames('wave', { speed, pause })).toBe(frames);
        tables.add(frames.key);
      }
    }
    expect(tables.size).toBe(9);
  });

  it('plays unknown stored speeds and pauses at the defaults', () => {
    expect(normalizeHappierSpinnerTiming('fast', 'none')).toEqual({ speed: 'fast', pause: 'none' });
    expect(normalizeHappierSpinnerTiming('warp', 42)).toEqual({ speed: 'normal', pause: 'short' });
    expect(normalizeHappierSpinnerTiming(undefined, undefined)).toEqual(DEFAULT);
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

  it('draws every frame of a strip in the requested ink', () => {
    const frames = getDotSpinnerFrames('wave', DEFAULT);
    const svg = buildDotSpinnerFilmstripSvg(frames, { color: '#123456' });

    expect(svg).toContain(`viewBox="0 0 ${frames.frameCount * 3} 3"`);
    expect(svg).toContain('fill="#123456"');
    expect(svg.match(/<circle /g)).toHaveLength(frames.frameCount * frames.dots.length);
    expect(buildDotSpinnerStillSvg(frames, { color: '#123456' }).match(/<circle /g)).toHaveLength(frames.dots.length);
  });

  it('blends aurora dots across the three accent colors and keeps color values out of the markup syntax', () => {
    expect(resolveAuroraBlend(0)).toEqual({ from: 0, to: 1, mix: 0 });
    expect(resolveAuroraBlend(0.5)).toEqual({ from: 1, to: 2, mix: 0.5 });
    expect(resolveAuroraBlend(0.9)).toEqual({ from: 2, to: 0, mix: 0.7 });

    const svg = buildDotSpinnerFilmstripSvg(getDotSpinnerFrames('aurora', DEFAULT), { aurora: ['#111111', 'rgb(1, 2, 3)', '"><x'] });
    expect(svg).toContain('fill="#111111"');
    expect(svg).toContain('fill="rgb(1, 2, 3)"');
    expect(svg).not.toContain('"><x');
  });

  it('removes hue wraps so neighbouring frames never sweep the long way round the gradient', () => {
    expect(unwrapHueSeries([0.1, 0.02, 0.95, 0.9])).toEqual([0.1, 0.02, -0.05, -0.1].map((value) => expect.closeTo(value, 5)));

    const frames = getDotSpinnerFrames('aurora', DEFAULT);
    for (let i = 0; i < frames.dots.length; i++) {
      const series = unwrapHueSeries(readDotSeries(frames, frames.hue!, i));
      for (let frame = 1; frame < series.length; frame++) {
        expect(Math.abs(series[frame]! - series[frame - 1]!)).toBeLessThan(0.1);
      }
    }
  });
});
