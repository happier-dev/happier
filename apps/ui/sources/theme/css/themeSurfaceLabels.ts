import { isThemeSurfaceAddress, THEME_SURFACE_REGISTRY, type SurfaceId } from '@happier-dev/plugin-sdk/ui';
import { t } from '@/text';

/** Surface names come from the emitted-address registry, shared by cards, coverage and picking. */
export function themeSurfaceLabel(surface: string): string {
    return isThemeSurfaceAddress(surface)
        ? t(THEME_SURFACE_REGISTRY[surface as SurfaceId].labelKey)
        : t('themeSurfaceLabels.unknown');
}
