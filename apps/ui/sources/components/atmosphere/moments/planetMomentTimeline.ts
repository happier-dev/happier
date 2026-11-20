import {
  PLANET_MOMENT_TIMINGS,
  planetMomentFrame,
  type PlanetAssemblyProgress,
} from '@happier-dev/brand/planet';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { planetGlyphLayer, type PlanetGlyphLayer } from '@happier-dev/brand/glyph-scene';
import { horizonPlanetGeometry } from '@happier-dev/brand/planet-placement';
import type { HomePane } from '../homePlanetPlacement';

/**
 * When the Loading planet moment draw what (plan R-11). The frame maths are the brand
 * choreography's (`planetMomentFrame`); this module only decides, for a moment's clock, which of them
 * is on screen, where the planet stands while it travels, and when the moment has landed.
 */
const { L4 } = PLANET_MOMENT_TIMINGS;
/** The cross-fade that ends Loading under reduced motion, or centred when Home shows no planet. */
const CROSSFADE_S = motionTokens.atmosphere.reducedCrossFadeMs / 1000;

/** Where Loading's cloud gathers: the lab's centre of the pane, a sixth of its short side across. */
export type PlanetMomentOrigin = Readonly<{
  cx: number;
  cy: number;
  R: number;
}>;
export function loadingPlanetOrigin(pane: HomePane): PlanetMomentOrigin {
  return {
    cx: Math.round(pane.width / 2),
    cy: Math.round(pane.height * 0.45),
    R: Math.min(pane.width, pane.height) * 0.17,
  };
}

/** What Home shows when Loading resolves: its planet (the travel's end), or no planet (the cloud ends centred). */
export type PlanetMomentTarget =
  | Readonly<{ kind: 'planet'; layer: PlanetGlyphLayer; pane: HomePane }>
  | Readonly<{ kind: 'none' }>;

/** The cold-start front reaches Home's exact layer once its travel finishes. */
export function loadingPlanetLayer(
  phase: LoadingPlanetPhase,
  pane: HomePane,
  origin: PlanetMomentOrigin,
  target: Extract<PlanetMomentTarget, { kind: 'planet' }> | null,
): PlanetGlyphLayer | null {
  if (phase.kind === 'none' || (phase.kind === 'landed' && phase.fast)) return null;
  if (phase.kind === 'landed') return target?.layer ?? null;
  const geometry = { ...horizonPlanetGeometry(pane), ...origin, rotate: target?.layer.geometry.rotate ?? -1.5 };
  if (phase.kind === 'travel' && target) {
    const mix = (from: number, to: number) => from + (to - from) * phase.k;
    const { cx, cy, R } = target.layer.geometry;
    return planetGlyphLayer({
      ...target.layer,
      geometry: { ...target.layer.geometry, cx: mix(origin.cx, cx), cy: mix(origin.cy, cy), R: mix(origin.R, R) },
    });
  }
  if (phase.kind !== 'assembly') return null;
  const entering = Math.min(0.45, Math.max(0, (phase.frame.t - L4.GRACE) / L4.RESOLVE) * 0.45);
  return planetGlyphLayer({
    geometry,
    intensity: target?.layer.intensity ?? 'quiet',
    digits: target?.layer.digits ?? true,
    decode: entering + (1 - entering) * phase.frame.prog,
  });
}

export type LoadingPlanetPhase =
  /** The grace: nothing is drawn yet. */
  | Readonly<{ kind: 'none' }>
  /** The cloud, its resolution, or (frozen at the assembled frame) the centred resting planet. */
  | Readonly<{
      kind: 'assembly';
      frame: PlanetAssemblyProgress;
      opacity: number;
      cover: number;
    }>
  /** The planet travelling and scaling to Home's placement; `k` is the spring's progress 0..1. */
  | Readonly<{ kind: 'travel'; k: number; cover: number }>
  /** Over. `fast` when Home was ready inside the grace and no loader was ever shown. */
  | Readonly<{ kind: 'landed'; fast: boolean }>;

/** The resolution's last frame: the planet fully assembled at the centre, with its haze and field. */
export function loadingAssembledFrame(): PlanetAssemblyProgress {
  // The fully assembled frame does not depend on when Home was ready: every patch has landed.
  const ready = 1;
  const frame = planetMomentFrame('loading', ready + L4.RESOLVE - 1e-6, ready);
  if (!frame.assembly) throw new Error('Loading resolution ended before its assembled frame');
  return frame.frame;
}

/**
 * Loading at `t` seconds of the moment's clock, with Home ready at `ready` (null while it is not).
 * The cloud holds for as long as loading is real; nothing completes before `ready`.
 */
export function loadingPlanetPhase(
  t: number,
  ready: number | null,
  options: Readonly<{ reducedMotion: boolean; toPlanet: boolean }>,
): LoadingPlanetPhase {
  const frame = planetMomentFrame('loading', t, ready);
  if (frame.fast) return { kind: 'landed', fast: true };
  if (t < L4.GRACE) return { kind: 'none' };
  const after = ready === null ? -1 : t - ready;
  if (options.reducedMotion) {
    // No cloud: the resting planet in the centre, then a cross-fade to Home with its planet in place.
    if (after >= CROSSFADE_S) return { kind: 'landed', fast: false };
    const opacity = after < 0 ? 1 : 1 - after / CROSSFADE_S;
    return {
      kind: 'assembly',
      frame: loadingAssembledFrame(),
      opacity,
      cover: opacity,
    };
  }
  if (frame.assembly)
    return {
      kind: 'assembly',
      frame: frame.frame,
      opacity: 1,
      cover: frame.cover ?? 1,
    };
  if (ready === null) return { kind: 'none' };
  if (!options.toPlanet) {
    // Home shows no planet: the assembled planet stays centred and cross-fades away.
    const fade = after - L4.RESOLVE;
    if (fade >= CROSSFADE_S) return { kind: 'landed', fast: false };
    return {
      kind: 'assembly',
      frame: loadingAssembledFrame(),
      opacity: 1 - fade / CROSSFADE_S,
      cover: 0,
    };
  }
  if (frame.rest) return { kind: 'landed', fast: false };
  return { kind: 'travel', k: frame.travel ?? 0, cover: frame.cover ?? 0 };
}
