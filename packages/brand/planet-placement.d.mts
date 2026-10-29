import type { PlanetSceneOptions, PlanetSides } from './planet.mjs';

export type HomePlanetPlacement = 'corner' | 'side' | 'rise';
export type HomePlanetStyle = 'airy' | 'balanced' | 'rich';
export type HomePane = Readonly<{ width: number; height: number }>;
export type HomePlanetGeometry = Readonly<{
  R: number; cx: number; cy: number; rotate: number; fullness: number;
  halo: PlanetSides; tail: number; fall: number; reach: PlanetSides; around?: number;
}>;
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
