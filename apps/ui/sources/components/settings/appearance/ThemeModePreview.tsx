import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import Color from 'color';

import { darkTheme, lightTheme } from '@/theme';
import { glassElementsCoatColor, glassSurfaceBackgroundColor, glassSurfaceTintColor } from '@/components/ui/glass/glassSurfacePaint';
import { resolveGlassBackdropMap, type GlassSurfaceMaterials, type GlassMaterialSettings, type GlassMaterialEnvironment } from '@/components/ui/glass/glassMaterial';
import { resolveGlassPresentationVariables } from '@/components/ui/glass/glassDocumentPresentation';
import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import type { ThemeMiniatureData } from '@/theme/profiles/themeProfileTypes';
import type { ThemeSurfaceStyleTable } from '@/theme/css/types';
import type { ThemeRadiusScaleName } from '@happier-dev/protocol/account/settings/themeProfiles';

import {
    ThemePalettePreview as SharedThemePalettePreview,
    type ThemeMiniatureForm,
    type ThemePreviewPalette,
    type ThemePreviewPaint,
} from '@happier-dev/plugin-ui/presentation';

export type { ThemeMiniatureForm, ThemePreviewPalette };
type Palette = ThemePreviewPalette;

/** The soft scale uses the shared drawing's default; the other scales override it. */
const MINIATURE_RADIUS_BY_SCALE: Readonly<Record<ThemeRadiusScaleName, number | undefined>> = { sharp: 1, soft: undefined, round: 8 };

/**
 * A miniature of a Happier window painted from a theme's own tokens, so the tile shows what the theme
 * looks like rather than naming it. This is an illustrative app shell, not a session preview.
 * Static: no subscriptions, no runtime theme reads. Pass any resolved theme (a base theme or a theme
 * profile resolved with `resolveThemeProfile`). Every position is a share of the miniature, so one
 * drawing serves a grid tile, the editor's preview and a header mark.
 */
export function ThemePalettePreview(props: Readonly<{
    palette: Palette;
    /** Static material table: preview-local variables use the same paint owner as the live shell. */
    materials?: GlassSurfaceMaterials;
    materialSettings?: GlassMaterialSettings;
    materialEnvironment?: GlassMaterialEnvironment;
    backdrop?: React.ReactNode;
    /** Browsers and phones preview their floating layer over page content, not desktop glass. */
    floatingOnly?: boolean;
    /** The theme's accent, drawn as the composer's send mark (a compact theme header carries it). */
    accent?: string;
    /** The theme's corner shape at miniature scale; tiles that do not preview one keep today's soft radii. */
    radius?: ThemeRadiusScaleName;
    form?: ThemeMiniatureForm;
    /** Already-prepared supported styles, supplied only by an opened detail or preview. */
    surfaceStyles?: ThemeSurfaceStyleTable;
}>) {
    const c = props.palette.colors;
    const radius = props.radius ? MINIATURE_RADIUS_BY_SCALE[props.radius] : undefined;
    const materials = props.materials;
    // Material-bearing objects take their real roles and ladder fills, as GlassSurface paints them live.
    const cardFill = glassElementsCoatColor(c.edge?.cardFill ?? c.surface.base, c.surface.base);
    const floatingFill = c.edge?.floatingFill ?? c.surface.base;
    // The one backdrop treatment the live surface resolves: its tone and the effective coat opacity.
    const backdropMap = (group: 'card' | 'floating', solid: string) => materials ? resolveGlassBackdropMap(
        props.materialSettings ?? { glassSurfaceMaterials: materials }, group, props.palette.dark === true,
        props.materialEnvironment ?? { desktopWindow: true, nativeWindowMaterialLive: true },
        { page: c.surface.base, solid },
    ) : null;
    const backdropTone = materials ? backdropMap('floating', floatingFill)?.tone ?? '' : undefined;
    const variables = materials ? resolveGlassPresentationVariables(
        props.materialSettings ?? { glassSurfaceMaterials: materials },
        props.materialEnvironment ?? { desktopWindow: true, nativeWindowMaterialLive: true },
    ) : undefined;
    const materialStyle = variables && Platform.OS === 'web' ? variables as unknown as ViewStyle : undefined;
    const paint = (color: string, group: 'chrome' | 'sidebar' | 'content' | 'card' | 'floating', nested = false) => {
        if (!variables) return color;
        const tintColor = glassSurfaceTintColor({ color, ink: c.text?.primary ?? color, dark: props.palette.dark === true,
            settings: props.materialSettings ?? { glassSurfaceMaterials: materials }, group,
            environment: props.materialEnvironment ?? { desktopWindow: true, nativeWindowMaterialLive: true }, page: c.surface.base });
        if (Platform.OS === 'web') {
            const coatOpacity = group === 'card' || group === 'floating' ? backdropMap(group, color)?.opacity : undefined;
            return glassSurfaceBackgroundColor(tintColor, group, nested, false, coatOpacity);
        }
        // The static native miniature paints the same effective coat; CSS variables are web-only.
        const opacity = Number.parseFloat(variables[`--happier-glass-${group}-${nested ? 'nested-opacity' : 'opacity'}`]!) / 100;
        return Color(tintColor).alpha(opacity).rgb().string();
    };
    const floatingBackground = paint(floatingFill, 'floating');
    const resolvedPaint: ThemePreviewPaint = {
        ...(materials ? {
            chrome: paint(c.surface.base, 'chrome'),
            sidebar: paint(c.surface.base, 'sidebar'),
            content: paint(c.surface.base, 'content'),
            card: paint(cardFill, 'card'),
        } : {}),
        floating: floatingBackground,
        rootStyle: materialStyle as unknown as ThemePreviewPaint['rootStyle'],
        floatingStyle: Platform.OS === 'web' ? createBackdropWebStyle({ backgroundColor: floatingBackground,
            blurPx: 0, surfaceGroup: 'floating', backdropTone,
            fallbackBackgroundColorWhenBlurDisabled: floatingFill }) as unknown as ThemePreviewPaint['floatingStyle'] : undefined,
    };
    return <SharedThemePalettePreview palette={props.palette} paint={resolvedPaint} backdrop={props.backdrop}
        floatingOnly={props.floatingOnly} accent={props.accent} radius={radius} form={props.form}
        surfaceStyles={props.surfaceStyles} />;
}

/**
 * A theme drawn from its compact library header (`ThemeMiniatureData`): the same window miniature, painted from
 * the header's colours, its accent and its corner shape. Static and body-free, so grids, cards, the Store and
 * the command palette can draw any number of themes without opening one.
 */
export const ThemeMiniaturePreview = React.memo(function ThemeMiniaturePreview(props: Readonly<{ miniature: ThemeMiniatureData; form?: ThemeMiniatureForm; surfaceStyles?: ThemeSurfaceStyleTable }>) {
    const palette = React.useMemo(() => miniaturePalette(props.miniature), [props.miniature]);
    return <ThemePalettePreview palette={palette} accent={props.miniature.accent} radius={props.miniature.radius} form={props.form} surfaceStyles={props.surfaceStyles} />;
});

/**
 * A theme's mark in a command row (⌘K Change theme): the same miniature, drawn at a window's proportions and
 * scaled to the row's mark box, so its lines and corners keep their proportion instead of crowding.
 */
export const ThemeCommandMark = React.memo(function ThemeCommandMark(props: Readonly<{ miniature: ThemeMiniatureData }>) {
    return (
        <View style={COMMAND_MARK_FRAME} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <View style={COMMAND_MARK_CANVAS}><ThemeMiniaturePreview miniature={props.miniature} /></View>
        </View>
    );
});

const COMMAND_MARK_SCALE = 0.25;
const COMMAND_MARK_FRAME: ViewStyle = { width: 32, height: 20, borderRadius: 4, overflow: 'hidden' };
const COMMAND_MARK_CANVAS: ViewStyle = {
    width: 32 / COMMAND_MARK_SCALE, height: 20 / COMMAND_MARK_SCALE,
    transform: [{ scale: COMMAND_MARK_SCALE }], transformOrigin: 'top left',
};

/** The header's roles in the miniature's palette shape: the page, the raised paper, ink and hairlines. */
function miniaturePalette(m: ThemeMiniatureData): Palette {
    const tint = Color(m.mutedText).alpha(0.22).rgb().string();
    return {
        dark: m.mode === 'dark',
        colors: {
            background: { canvas: m.canvas },
            surface: { base: m.raised, elevated: tint, selected: tint },
            text: { primary: m.text },
            border: { default: m.border, strong: Color(m.text).alpha(0.55).rgb().string() },
        },
    };
}

export const ThemeModePreview = React.memo(function ThemeModePreview(props: Readonly<{ mode: 'adaptive' | 'light' | 'dark' }>) {
    if (props.mode === 'adaptive') {
        return (
            <View style={{ flex: 1, flexDirection: 'row' }}>
                <View style={{ flex: 1, overflow: 'hidden' }}>
                    <View style={{ width: '200%', height: '100%' }}><ThemePalettePreview palette={lightTheme} /></View>
                </View>
                <View style={{ flex: 1, overflow: 'hidden' }}>
                    <View style={{ width: '200%', height: '100%', marginLeft: '-100%' }}><ThemePalettePreview palette={darkTheme} /></View>
                </View>
            </View>
        );
    }
    return <ThemePalettePreview palette={props.mode === 'dark' ? darkTheme : lightTheme} />;
});
