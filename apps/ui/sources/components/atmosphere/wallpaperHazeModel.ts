import { GLASS_BLUR_RADIUS_PX, type GlassAtmosphereTone } from '@/components/ui/glass/glassMaterial';
import { glassPictureInk } from '@/components/ui/glass/glassBackedInk';
import { resolveWallpaperHaze as resolveSharedWallpaperHaze, wallpaperHazeLayers,
    type WallpaperHaze, type WallpaperHazeInput } from '@happier-dev/brand/atmosphere-haze';

export type { WallpaperHaze, WallpaperHazeLayer, WallpaperHazeVeil } from '@happier-dev/brand/atmosphere-haze';

/** Glass owns the radii; Brand owns the shared layer/veil composition. */
export const WALLPAPER_HAZE_LAYERS = wallpaperHazeLayers(GLASS_BLUR_RADIUS_PX);

/** Platform theme-token resolution stays local; static output consumes the same Brand decision. */
export function resolveWallpaperHaze(input: Omit<WallpaperHazeInput, 'layers' | 'fallbackInk' | 'heads'> & Readonly<{
    heads: GlassAtmosphereTone | undefined;
}>): WallpaperHaze {
    return resolveSharedWallpaperHaze({ ...input, layers: WALLPAPER_HAZE_LAYERS,
        fallbackInk: glassPictureInk(input.primary, input.page, input.heads?.focus) === input.page ? 'page' : 'theme' });
}
