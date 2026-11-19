import { describe, expect, it } from 'vitest';
import {
  PLANET_MOMENT_TIMINGS,
  type PlanetSceneOptions,
} from '@happier-dev/brand/planet';
import {
  homePlanetGeometry,
  homePlanetSceneOptions,
} from '../homePlanetPlacement';
import {
  loadingPlanetOrigin,
  loadingPlanetPhase,
  loadingPlanetSource,
  loadingPlanetTravel,
  type LoadingPlanetPhase,
} from './planetMomentTimeline';

const { L4 } = PLANET_MOMENT_TIMINGS;
const FRAME = 1 / 60;
const pane = { width: 1150, height: 900 };

/** Plays Loading on a fake 60 Hz clock: Home reports ready at `readyAt` (the caller sees it from then on). */
function play(
  readyAt: number | null,
  options: Readonly<{ reducedMotion: boolean; toPlanet: boolean }>,
  until = 6,
) {
  const frames: Array<Readonly<{ t: number; phase: LoadingPlanetPhase }>> = [];
  for (let n = 0; n * FRAME <= until; n++) {
    const t = n * FRAME;
    const ready = readyAt !== null && t >= readyAt ? readyAt : null;
    frames.push({ t, phase: loadingPlanetPhase(t, ready, options) });
  }
  return frames;
}

function corner(): PlanetSceneOptions {
  return homePlanetSceneOptions(homePlanetGeometry('corner', pane), pane, {
    theme: 'dark',
    style: 'balanced',
    digits: true,
  });
}

describe('Loading planet timeline', () => {
  it('shows no loader at all when Home is ready inside the 0.25 s grace', () => {
    const frames = play(0.2, { reducedMotion: false, toPlanet: true });
    expect(
      frames.every(
        ({ phase }) => phase.kind === 'none' || phase.kind === 'landed',
      ),
    ).toBe(true);
    expect(frames.at(-1)?.phase).toEqual({ kind: 'landed', fast: true });
    // Under reduced motion too.
    expect(
      play(0.2, { reducedMotion: true, toPlanet: true }).some(
        ({ phase }) => phase.kind === 'assembly',
      ),
    ).toBe(false);
  });

  it('holds the cloud for as long as loading is real, and never completes before ready', () => {
    const frames = play(null, { reducedMotion: false, toPlanet: true }, 30);
    expect(
      frames
        .filter(({ t }) => t < L4.GRACE)
        .every(({ phase }) => phase.kind === 'none'),
    ).toBe(true);
    const waiting = frames.filter(({ t }) => t >= L4.GRACE);
    expect(
      waiting.every(
        ({ phase }) =>
          phase.kind === 'assembly' &&
          phase.frame.prog === 0 &&
          phase.cover === 1,
      ),
    ).toBe(true);
  });

  it('resolves on ready and hands off to Home exactly at its placement on a critically damped spring', () => {
    const ready = 2;
    const frames = play(ready, { reducedMotion: false, toPlanet: true });
    const travel = frames.flatMap(({ t, phase }) =>
      phase.kind === 'travel' ? [{ t, k: phase.k }] : [],
    );
    expect(travel[0]!.t).toBeGreaterThanOrEqual(ready + L4.RESOLVE);
    // The spring never overshoots: progress only grows, and stays inside the placement.
    expect(
      travel.every(
        ({ k }, i) => k >= 0 && k <= 1 && (i === 0 || k >= travel[i - 1]!.k),
      ),
    ).toBe(true);
    const landed = frames.find(({ phase }) => phase.kind === 'landed')!;
    expect(landed.t).toBeGreaterThanOrEqual(ready + L4.RESOLVE + L4.TRAVEL);
    expect(landed.t).toBeLessThan(ready + L4.RESOLVE + L4.TRAVEL + 2 * FRAME);
    expect(landed.phase).toEqual({ kind: 'landed', fast: false });
    // The cover has lifted long before the travel: Home is usable from 0.14 s after ready.
    expect(
      frames
        .filter(({ t }) => t >= ready + L4.FADE)
        .every(({ phase }) => phase.kind === 'landed' || phase.kind === 'none' || phase.cover === 0),
    ).toBe(true);

    const target = corner();
    const source = loadingPlanetSource(
      loadingPlanetOrigin(pane),
      { rotate: target.rotate ?? 0, mirror: false },
      { theme: 'dark', pane, dpr: 2 },
    );
    // The landed frame is Home's own planet, not a value a rounding step away from it.
    expect(loadingPlanetTravel(source, target, 1)).toBe(target);
    const last = loadingPlanetTravel(source, target, travel.at(-1)!.k);
    expect(Math.abs(last.cx! - target.cx!)).toBeLessThan(2);
    expect(Math.abs(last.R! - target.R!)).toBeLessThan(2);
    // It travels from the cloud's centre, a sixth of the pane across.
    const first = loadingPlanetTravel(source, target, 0);
    expect([first.cx, first.cy, first.R]).toEqual([575, 405, 900 * 0.17]);
    expect(first.style).toBe(target.style);
  });

  it('ends centred and cross-fades when Home shows no planet', () => {
    const ready = 1;
    const frames = play(ready, { reducedMotion: false, toPlanet: false });
    expect(frames.some(({ phase }) => phase.kind === 'travel')).toBe(false);
    const fading = frames.filter(
      ({ t, phase }) => t >= ready + L4.RESOLVE && phase.kind === 'assembly',
    );
    expect(fading.length).toBeGreaterThan(0);
    expect(
      fading.every(
        ({ phase }) => phase.kind === 'assembly' && phase.frame.prog === 1,
      ),
    ).toBe(true);
    expect(frames.find(({ phase }) => phase.kind === 'landed')!.t).toBeLessThan(
      ready + L4.RESOLVE + 0.14 + 2 * FRAME,
    );
  });

  it('under reduced motion shows the centred resting planet, then a 140 ms cross-fade', () => {
    const ready = 2;
    const frames = play(ready, { reducedMotion: true, toPlanet: true });
    expect(frames.some(({ phase }) => phase.kind === 'travel')).toBe(false);
    const waiting = frames.filter(({ t }) => t >= L4.GRACE && t < ready);
    // No cloud: the assembled planet at rest, fully drawn, from the end of the grace.
    expect(
      waiting.every(
        ({ phase }) =>
          phase.kind === 'assembly' &&
          phase.frame.prog === 1 &&
          phase.opacity === 1,
      ),
    ).toBe(true);
    const fade = frames.filter(({ t }) => t >= ready && t < ready + 0.14);
    expect(
      fade.every(
        ({ phase }, i) =>
          phase.kind === 'assembly' &&
          (i === 0 ||
            phase.opacity <
              (fade[i - 1]!.phase as { opacity: number }).opacity),
      ),
    ).toBe(true);
    expect(frames.find(({ phase }) => phase.kind === 'landed')!.t).toBeLessThan(
      ready + 0.14 + 2 * FRAME,
    );
  });
});
