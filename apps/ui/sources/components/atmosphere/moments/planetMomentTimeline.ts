import {
  PLANET_MOMENT_TIMINGS,
  PLANET_SAMPLER,
  planetMomentFrame,
} from '@happier-dev/brand/planet';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { loadingPlanetDecodeS, planetGlyphLayer, type createLoadingPlanetScene, type GlyphLayer, type PlanetGlyphLayer } from '@happier-dev/brand/glyph-scene';
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
  if (phase.kind === 'assembly') return loading(phase.seconds, origin, phase.orbitOpacity, phase.decode ? L4.GRACE : undefined);
  if (!target) return [];
  const [departing] = loading(phase.seconds, origin, 0, L4.GRACE);
  const from = departing.geometry;
  const { cx, cy, R, rotate, halo, glow = 1 } = target.layer.geometry;
  const mix = (start: number, finish: number) => start + (finish - start) * phase.k;
  const lightOf = (geometry: typeof from) => geometry.light ?? PLANET_SAMPLER.lightForReveal(geometry.reveal ?? 1);
  const [fromLight, toLight] = [lightOf(from), lightOf(target.layer.geometry)];
  const light = fromLight.map((value, axis) => mix(value, toLight[axis]!));
  const length = Math.hypot(...light);
  return [planetGlyphLayer({
    ...target.layer,
    geometry: {
      ...target.layer.geometry,
      cx: mix(from.cx, cx), cy: mix(from.cy, cy), R: mix(from.R, R), rotate: mix(from.rotate, rotate),
      glow: mix(from.glow ?? 1, glow),
      light: [light[0]! / length, light[1]! / length, light[2]! / length],
      halo: { top: mix(from.halo.top, halo.top), right: mix(from.halo.right, halo.right),
        bottom: mix(from.halo.bottom, halo.bottom), left: mix(from.halo.left, halo.left) },
    },
    settle: { startS: phase.startS, durationS: L4.TRAVEL },
  })];
}

export type LoadingPlanetPhase =
  /** The grace: nothing is drawn yet. */
  | Readonly<{ kind: 'none' }>
  /** The centred planet on the moment's clock: decoding in from the grace (`decode`), then breathing while digits gather into it. */
  | Readonly<{
      kind: 'assembly';
      seconds: number;
      decode: boolean;
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
 * The centred planet keeps breathing for as long as loading is real. Home's readiness lifts the cover at once;
 * the planet first finishes decoding in, so it never leaves half-built.
 */
export function loadingPlanetPhase(
  t: number,
  ready: number | null,
  options: Readonly<{ reducedMotion: boolean; toPlanet: boolean }>,
): LoadingPlanetPhase {
  const { cover = 1, fast } = planetMomentFrame('loading', t, ready);
  if (fast) return { kind: 'landed', fast: true };
  if (t < L4.GRACE) return { kind: 'none' };
  if (options.reducedMotion) {
    const after = ready === null ? -1 : t - ready;
    if (after >= CROSSFADE_S) return { kind: 'landed', fast: false };
    const opacity = after < 0 ? 1 : 1 - after / CROSSFADE_S;
    return { kind: 'assembly', seconds: 0, decode: false, orbitOpacity: 1, opacity, cover: opacity };
  }
  const seconds = t;
  const settled = ready === null ? null : Math.max(ready, L4.GRACE + loadingPlanetDecodeS - L4.RESOLVE);
  const frame = planetMomentFrame('loading', t, settled);
  const after = settled === null ? -1 : t - settled;
  if (frame.assembly)
    return {
      kind: 'assembly',
      seconds,
      decode: true,
      orbitOpacity: options.toPlanet && after > 0 ? 1 - Math.min(1, after / L4.RESOLVE) : 1,
      opacity: 1,
      cover,
    };
  if (settled === null) return { kind: 'none' };
  if (!options.toPlanet) {
    // Home shows no planet: the whole planet stays centred and cross-fades away.
    const fade = after - L4.RESOLVE;
    if (fade >= CROSSFADE_S) return { kind: 'landed', fast: false };
    return { kind: 'assembly', seconds, decode: true, orbitOpacity: 1, opacity: 1 - fade / CROSSFADE_S, cover: 0 };
  }
  if (frame.rest) return { kind: 'landed', fast: false };
  const startS = settled + L4.RESOLVE;
  return { kind: 'travel', k: frame.travel ?? 0, cover, seconds: startS, startS };
}
