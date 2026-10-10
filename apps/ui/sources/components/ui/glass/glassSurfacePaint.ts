import { Platform } from 'react-native';
import { happierMaterialBackgroundColor } from '@happier-dev/plugin-ui/presentation';
import { readGlassPreset, resolveGlassSurfaceMaterial, type GlassMaterialSettings, type GlassMaterialEnvironment, type GlassSurfaceGroup } from './glassMaterial';

/** Named dark floating coats use low-alpha ink; custom and solid retain their authored color. */
export function glassSurfaceTintColor(input: Readonly<{ color: string; ink: string; dark: boolean; settings: GlassMaterialSettings; group: GlassSurfaceGroup; environment?: GlassMaterialEnvironment }>): string {
    return input.dark && input.group === 'floating' && readGlassPreset(input.settings) !== 'custom'
        && resolveGlassSurfaceMaterial(input.settings, input.group, input.environment).material.opacity < 1
        ? input.ink : input.color;
}

/** Shared presentation owner changes only paint alpha, never foreground opacity. */
export function glassSurfaceBackgroundColor(color: string, group: GlassSurfaceGroup, nested = false): string {
    return happierMaterialBackgroundColor(color, group, Platform.OS === 'web', nested);
}

/**
 * The shell owns one coat plane per group; inner paints only inherit it. A plane lies on the window
 * canvas, so there is nothing behind it a CSS blur could reach (a desktop window's blur is its native
 * material). It paints the tint only: a `backdrop-filter` here would make the plane a backdrop root and
 * cut every floating surface opened inside it (a column's menus and popovers) off the page behind.
 * A plane that floats over content (the column peek) paints through `GlassSurface` instead.
 */
export function glassSurfacePlaneStyle(color: string, group: GlassSurfaceGroup): Readonly<{ backgroundColor: string }> {
    return { backgroundColor: glassSurfaceBackgroundColor(color, group) };
}
