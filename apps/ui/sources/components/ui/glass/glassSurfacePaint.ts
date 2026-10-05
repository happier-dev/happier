import { Platform } from 'react-native';
import { happierMaterialBackgroundColor } from '@happier-dev/plugin-ui/presentation';
import type { GlassSurfaceGroup } from './glassMaterial';
import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';

/** Shared presentation owner changes only paint alpha, never foreground opacity. */
export function glassSurfaceBackgroundColor(color: string, group: GlassSurfaceGroup, nested = false): string {
    return happierMaterialBackgroundColor(color, group, Platform.OS === 'web', nested);
}

/** The shell owns one coat/blur plane per group; inner paints only inherit it. */
export function glassSurfacePlaneStyle(color: string, group: GlassSurfaceGroup): Readonly<{
    backgroundColor: string;
    backdropFilter?: string;
    WebkitBackdropFilter?: string;
}> {
    if (Platform.OS !== 'web') return { backgroundColor: color };
    const backgroundColor = glassSurfaceBackgroundColor(color, group);
    const webStyle = createBackdropWebStyle({ backgroundColor, surfaceGroup: group, blurPx: 0 });
    return { backgroundColor, backdropFilter: webStyle.backdropFilter, WebkitBackdropFilter: webStyle.WebkitBackdropFilter };
}
