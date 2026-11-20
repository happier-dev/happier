import { describe, expect, it } from 'vitest';
import {
  PLANET_MOMENT_TIMINGS,
} from '@happier-dev/brand/planet';
import { createLoadingPlanetScene, planetGlyphLayer } from '@happier-dev/brand/glyph-scene';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';
import {
  loadingPlanetLayers,
  loadingPlanetOrigin,
  loadingPlanetPhase,
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

  it('keeps the loading planet Full and breathing for as long as loading is real', () => {
    const frames = play(null, { reducedMotion: false, toPlanet: true }, 30);
    expect(
      frames
        .filter(({ t }) => t < L4.GRACE)
        .every(({ phase }) => phase.kind === 'none'),
    ).toBe(true);
    const origin = loadingPlanetOrigin(pane);
    const scene = createLoadingPlanetScene();
    const planetAt = (t: number) => loadingPlanetLayers(scene, loadingPlanetPhase(t, null, { reducedMotion: false, toPlanet: true }),
      origin, null).find(layer => layer.kind === 'planet');
    const first = planetAt(L4.GRACE);
    const peak = planetAt(L4.GRACE + 1.8);
    expect(first?.intensity).toBe('full');
    expect(peak?.geometry.R).toBeGreaterThan(first!.geometry.R * 1.02);
    const waiting = frames.filter(({ t }) => t >= L4.GRACE);
    expect(
      waiting.every(
        ({ phase }) =>
          phase.kind === 'assembly' &&
          phase.orbitOpacity === 1 &&
          phase.cover === 1,
      ),
    ).toBe(true);
  });

  it.each([false, true])('resolves the visible planet when readiness lands at grace, reducedMotion=%s', (reducedMotion) => {
    expect(loadingPlanetPhase(L4.GRACE, L4.GRACE, { reducedMotion, toPlanet: true }).kind).toBe('assembly');
  });

  it('resolves on ready and hands off to Home exactly at its placement on a critically damped spring', () => {
    const ready = 2;
    const frames = play(ready, { reducedMotion: false, toPlanet: true });
    const travel = frames.flatMap(({ t, phase }) =>
      phase.kind === 'travel' ? [{ t, phase }] : [],
    );
    expect(travel[0]!.t).toBeGreaterThanOrEqual(ready + L4.RESOLVE);
    // The spring never overshoots: progress only grows, and stays inside the placement.
    expect(
      travel.every(
        ({ phase: { k } }, i) => k >= 0 && k <= 1 && (i === 0 || k >= travel[i - 1]!.phase.k),
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

    const geometry = horizonPlanetGeometry(pane);
    const layer = planetGlyphLayer({ geometry, intensity: 'full', digits: false });
    const target = { kind: 'planet', layer, pane } as const;
    const origin = loadingPlanetOrigin(pane);
    const scene = createLoadingPlanetScene();
    const planetFor = (phase: LoadingPlanetPhase) => loadingPlanetLayers(scene, phase, origin, target)
      .find(result => result.kind === 'planet')!;
    expect(planetFor(landed.phase)).toBe(layer);
    const last = planetFor(travel.at(-1)!.phase);
    expect(Math.abs(last.geometry.cx - geometry.cx)).toBeLessThan(2);
    expect(Math.abs(last.geometry.R - geometry.R)).toBeLessThan(2);
    const first = planetFor({ ...travel[0]!.phase, k: 0 });
    const previous = planetFor(loadingPlanetPhase(ready, ready, { reducedMotion: false, toPlanet: true }));
    expect(first.geometry).toMatchObject(previous.geometry);
    expect(first.intensity).toBe('full');
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
        ({ phase }) => phase.kind === 'assembly' && phase.seconds === ready - L4.GRACE,
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
    // The same still frame from the end of the grace.
    expect(
      waiting.every(
        ({ phase }) =>
          phase.kind === 'assembly' &&
          phase.seconds === 0 &&
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
