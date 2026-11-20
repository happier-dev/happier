import type { PlanetSides } from './planet.mjs';

export type HomePane = Readonly<{ width: number; height: number }>;
/** The pane height where Home's hero stops growing. */
export const HOME_HERO_FULL_PANE_HEIGHT: number;

export type GlyphPlanetGeometry = Readonly<{
  R: number; cx: number; cy: number; rotate: number; halo: Required<PlanetSides>;
  limb?: number; spin?: number; reveal?: number; light?: readonly [number, number, number]; dim?: number; glow?: number;
}>;
export type WelcomePlanetState = 'welcome' | 'welcomeDim' | 'deep' | 'deeper' | 'night' | 'place' | 'placeDeep' | 'team' | 'sheet';
export type WelcomePlanetGeometry = GlyphPlanetGeometry & Readonly<{ limb: number; spin: number }>;
export function horizonPlanetGeometry(pane: HomePane, options?: Readonly<{ phone?: boolean; composerTop?: number; limb?: number; radius?: number }>): GlyphPlanetGeometry & { limb: number };
export function welcomePlanetPose(state: WelcomePlanetState, pane: HomePane, options?: Readonly<{ phone?: boolean }>): WelcomePlanetGeometry;
/** The two poses belong to the same pane. Progress is eased by the step timeline. */
export function interpolateWelcomePlanetPose(from: WelcomePlanetGeometry, to: WelcomePlanetGeometry, progress: number): WelcomePlanetGeometry;
