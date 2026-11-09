import { useLocalSetting } from '@/sync/domains/state/storage';
import { useGlassContentOverWallpaper } from '@/components/ui/glass/GlassSurface';
import { useAtmosphereBandBoundary } from '@/components/atmosphere/atmosphereBandBoundary';

import type { WidgetFramePlacement, WidgetFrameStyle } from './WidgetFrame';
import { resolveWidgetFrameStyle, WIDGET_FRAME_PLACEMENT_DEFAULTS } from './widgetFrameStyle';

const SURFACE_SETTING = {
    home: 'widgetFrameStyleHome',
    board: 'widgetFrameStyleBoard',
    companion: 'widgetFrameStyleCompanion',
} as const satisfies Record<WidgetFramePlacement, string>;

/** This device's Appearance default for one surface (subscribes to that one key only). */
export function useWidgetFrameSurfaceDefault(placement: WidgetFramePlacement): WidgetFrameStyle {
    return useLocalSetting(SURFACE_SETTING[placement]);
}

/** The effective frame style of one widget on one surface. */
export function useWidgetFrameStyle(placement: WidgetFramePlacement, override?: WidgetFrameStyle | null): WidgetFrameStyle {
    const surfaceDefault = useWidgetFrameSurfaceDefault(placement);
    return resolveWidgetFrameStyle({ placement, surfaceDefault, override: override ?? null });
}

/**
 * How a widget area (a Project or plugin page) frames one widget. A frame the person chose applies as set,
 * Plain included. A widget with no choice follows the area's default: where the page's content stands on
 * the Wallpaper picture itself that default is the card (Elements, atmosphere amendment A1), since a
 * frameless default would put its text on raw pixels. A Project page that draws its planet behind the widgets
 * is the same case (QA-PROJECTS D8): their text would sit on its dots. Elsewhere it is the placement's default. Home needs
 * no branch here: its default is already the card, and its Appearance choice is the person's own.
 */
export function useWidgetAreaFrame(placement: WidgetFramePlacement, override?: WidgetFrameStyle | null): Readonly<{
    style: WidgetFrameStyle;
    /** What "no choice" resolves to here; the frame menu's way back. */
    areaDefault: WidgetFrameStyle;
}> {
    const overPlanet = useAtmosphereBandBoundary()?.planet === true;
    const areaDefault = useGlassContentOverWallpaper() || overPlanet ? 'card' : WIDGET_FRAME_PLACEMENT_DEFAULTS[placement];
    return { style: resolveWidgetFrameStyle({ placement, surfaceDefault: areaDefault, override: override ?? null }), areaDefault };
}
