export type WallpaperHazeLayer = Readonly<{ blur: number; rx: number; ry: number; solid: number }>;
export type WallpaperHazeVeil = Readonly<{ color: string; alpha: number; at: Readonly<{ x: number; y: number }>; rx: number; ry: number; solid: number }>;
export type WallpaperHaze = Readonly<{ layers: readonly WallpaperHazeLayer[]; veil: WallpaperHazeVeil | null; ink: 'theme' | 'page' }>;
export type WallpaperHazeInput = Readonly<{
  heads: Readonly<{ dark: number; light: number; focus: number }> | undefined;
  page: string; primary: string;
  /** The quieter ink the head lines also carry (a secondary action beside the greeting); the veil holds it at AA too. */
  secondary?: string;
  column: Readonly<{ x: number; y: number }>; at: Readonly<{ x: number; y: number }>;
  adaptive: boolean; bandColor?: string; layers: readonly WallpaperHazeLayer[];
  /** Platform theme-token resolution may supply the existing concrete ink choice. */
  fallbackInk?: 'theme' | 'page';
}>;
export function wallpaperHazeLayers(radii: Readonly<{ regular: number; strong: number }>): readonly WallpaperHazeLayer[];
export function resolveWallpaperHaze(input: WallpaperHazeInput): WallpaperHaze;
export function picturePrefersPageInk(primaryLuminance: number, pageLuminance: number, pictureLuminance: number): boolean;
