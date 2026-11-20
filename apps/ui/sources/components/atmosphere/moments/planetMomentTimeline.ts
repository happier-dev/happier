import {
  PLANET_MOMENT_TIMINGS,
  planetMomentFrame,
} from '@happier-dev/brand/planet';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { planetGlyphLayer, type createLoadingPlanetScene, type GlyphLayer, type PlanetGlyphLayer } from '@happier-dev/brand/glyph-scene';
import type { HomePane } from '../homePlanetPlacement';

/**
 * When the Loading planet moment draw what (plan R-11). The frame maths are the brand
 * choreography's (`planetMomentFrame`); this module only decides, for a moment's clock, which of them
 * is on screen, where the planet stands while it travels, and when the moment has landed.
 */
const { L4 } = PLANET_MOMENT_TIMINGS;
/** The cross-fade that ends Loading under reduced motion, or centred when Home shows no planet. */
const CROSSFADE_S = motionTokens.atmosphere.reducedCrossFadeMs / 1000;

/** Where Loading waits in Home: the lab's centred pose, sized from the short side. */
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

/** What Home shows when Loading resolves: its resting planet or no planet. */
export type PlanetMomentTarget =
  | Readonly<{ kind: 'planet'; layer: PlanetGlyphLayer; pane: HomePane }>
  | Readonly<{ kind: 'none' }>;

/** The cold-start front reaches Home's exact layer once its travel finishes. */
export function loadingPlanetLayers(
  loading: ReturnType<typeof createLoadingPlanetScene>,
  phase: LoadingPlanetPhase,
  origin: PlanetMomentOrigin,
  target: Extract<PlanetMomentTarget, { kind: 'planet' }> | null,
): readonly GlyphLayer[] {
  if (phase.kind === 'none') return [];
  if (phase.kind === 'landed') return !phase.fast && target ? [target.layer] : [];
  if (phase.kind === 'assembly') return loading(phase.seconds, origin, phase.orbitOpacity);
  if (!target) return [];
  const [departing] = loading(phase.seconds, origin, 0);
  const from = departing.geometry;
  const { cx, cy, R, rotate, halo } = target.layer.geometry;
  const mix = (start: number, finish: number) => start + (finish - start) * phase.k;
  return [planetGlyphLayer({
    ...target.layer,
    geometry: {
      ...target.layer.geometry,
      cx: mix(from.cx, cx), cy: mix(from.cy, cy), R: mix(from.R, R), rotate: mix(from.rotate, rotate),
      halo: { top: mix(from.halo.top, halo.top), right: mix(from.halo.right, halo.right),
        bottom: mix(from.halo.bottom, halo.bottom), left: mix(from.halo.left, halo.left) },
    },
    settle: { startS: phase.startS, durationS: L4.TRAVEL },
  })];
}

export type LoadingPlanetPhase =
  /** The grace: nothing is drawn yet. */
  | Readonly<{ kind: 'none' }>
  /** The centred planet and its floating digits. Breathing stops at readiness. */
  | Readonly<{
      kind: 'assembly';
      seconds: number;
      orbitOpacity: number;
      opacity: number;
      cover: number;
    }>
  /** The planet travelling and scaling to Home's placement; `k` is the spring's progress 0..1. */
  | Readonly<{ kind: 'travel'; k: number; cover: number; seconds: number; startS: number }>
  /** Over. `fast` when Home was ready inside the grace and no loader was ever shown. */
  | Readonly<{ kind: 'landed'; fast: boolean }>;

/**
 * Loading at `t` seconds of the moment's clock, with Home ready at `ready` (null while it is not).
 * The centred planet holds for as long as loading is real.
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
  const seconds = options.reducedMotion ? 0 : Math.max(0, Math.min(t, ready ?? t) - L4.GRACE);
  if (options.reducedMotion) {
    if (after >= CROSSFADE_S) return { kind: 'landed', fast: false };
    const opacity = after < 0 ? 1 : 1 - after / CROSSFADE_S;
    return {
      kind: 'assembly',
      seconds,
      orbitOpacity: 1,
      opacity,
      cover: opacity,
    };
  }
  if (frame.assembly)
    return {
      kind: 'assembly',
      seconds,
      orbitOpacity: options.toPlanet && after > 0 ? 1 - Math.min(1, after / L4.RESOLVE) : 1,
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
      seconds,
      orbitOpacity: 1,
      opacity: 1 - fade / CROSSFADE_S,
      cover: 0,
    };
  }
  if (frame.rest) return { kind: 'landed', fast: false };
  return { kind: 'travel', k: frame.travel ?? 0, cover: frame.cover ?? 0, seconds, startS: ready + L4.RESOLVE };
}
