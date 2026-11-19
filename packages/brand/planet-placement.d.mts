import type { PlanetSceneOptions, PlanetSides } from './planet.mjs';

export type HomePlanetPlacement = 'corner' | 'side' | 'rise';
export type HomePlanetStyle = 'airy' | 'balanced' | 'rich';
export type HomePane = Readonly<{ width: number; height: number }>;
export type HomePlanetGeometry = Readonly<{
  R: number; cx: number; cy: number; rotate: number; fullness: number;
  halo: PlanetSides; tail: number; fall: number; reach: PlanetSides; around?: number;
}>;
/** The pane height where Home's hero stops growing; Corner and Side are sized no larger than this. */
export const HOME_HERO_FULL_PANE_HEIGHT: number;
export function homePlanetGeometry(
  placement: HomePlanetPlacement,
  pane: HomePane,
  options?: Readonly<{ phone?: boolean; widgets?: boolean; limb?: number; /** Rise only: the planet's radius in place of the pane's. */ radius?: number }>,
): HomePlanetGeometry;
export function homePlanetSceneOptions(
  geometry: HomePlanetGeometry,
  pane: HomePane,
  look: Readonly<{ theme: 'light' | 'dark'; style: HomePlanetStyle; digits: boolean }>,
): PlanetSceneOptions;

export type GlyphPlanetGeometry = Readonly<{
  R: number; cx: number; cy: number; rotate: number; halo: Required<PlanetSides>;
  limb?: number; spin?: number; reveal?: number; light?: readonly [number, number, number]; dim?: number; glow?: number;
}>;
export type WelcomePlanetState = 'welcome' | 'welcomeDim' | 'deep' | 'deeper' | 'night' | 'place' | 'placeDeep' | 'team' | 'sheet';
export function horizonPlanetGeometry(pane: HomePane, options?: Readonly<{ phone?: boolean; composerTop?: number; limb?: number; radius?: number }>): GlyphPlanetGeometry & { limb: number };
export function welcomePlanetPose(state: WelcomePlanetState, pane: HomePane, options?: Readonly<{ phone?: boolean }>): GlyphPlanetGeometry & { limb: number };
