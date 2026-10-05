import * as React from 'react';
import { Platform, View, type ViewStyle } from 'react-native';
import Color from 'color';

import { darkTheme, lightTheme } from '@/theme';
import { glassSurfaceBackgroundColor } from '@/components/ui/glass/glassSurfacePaint';
import { type GlassSurfaceMaterials, type GlassMaterialSettings, type GlassMaterialEnvironment } from '@/components/ui/glass/glassMaterial';
import { resolveGlassPresentationVariables } from '@/components/ui/glass/glassDocumentPresentation';
import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';

type Palette = Readonly<{
    dark?: boolean;
    colors: Readonly<{
        background: Readonly<{ canvas: string }>;
        surface: Readonly<{ base: string; elevated: string }>;
        border: Readonly<{ default: string; strong: string }>;
    }>;
}>;

const MINIATURE_BAR_HEIGHT = 14;
/** Today's (soft) radii at miniature scale, kept for tiles that do not preview a radius scale. */
const DEFAULT_MINIATURE_RADIUS = 5;

/**
 * A miniature of a Happier window painted from a theme's own tokens, so the tile shows what the theme
 * looks like rather than naming it. This is an illustrative app shell, not a session preview.
 * Static: no subscriptions, no runtime theme reads. Pass any resolved theme (a base theme or a theme
 * profile resolved with `resolveThemeProfile`).
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
}>) {
    const c = props.palette.colors;
    const bubbleRadius = DEFAULT_MINIATURE_RADIUS;
    const composerRadius = DEFAULT_MINIATURE_RADIUS;
    const materials = props.materials;
    const variables = materials ? resolveGlassPresentationVariables(
        props.materialSettings ?? { glassSurfaceMaterials: materials },
        props.materialEnvironment ?? { desktopWindow: true, nativeWindowMaterialLive: true },
    ) : undefined;
    const materialStyle = variables && Platform.OS === 'web' ? variables as unknown as ViewStyle : undefined;
    const paint = (color: string, group: 'chrome' | 'sidebar' | 'content' | 'floating', nested = false) => {
        if (!variables) return color;
        if (Platform.OS === 'web') return glassSurfaceBackgroundColor(color, group, nested);
        // The static native miniature paints the same effective coat; CSS variables are web-only.
        const opacity = Number.parseFloat(variables[`--happier-glass-${group}-${nested ? 'nested-opacity' : 'opacity'}`]!) / 100;
        return Color(color).alpha(opacity).rgb().string();
    };
    const line = (width: `${number}%`, color: string, marginTop = 5) => (
        <View style={{ height: 5, borderRadius: 3, width, backgroundColor: color, marginTop }} />
    );
    return (
        <View style={[{ flex: 1, flexDirection: 'row', overflow: 'hidden', backgroundColor: props.backdrop ? 'transparent' : c.background.canvas }, materialStyle]}>
          {props.backdrop}
          {props.floatingOnly ? <View style={{ flex: 1, padding: 12, backgroundColor: c.surface.base }}>
            {line('92%', c.border.strong, 0)}
            {line('65%', c.border.strong)}
            {line('82%', c.border.strong)}
            <View style={{ position: 'absolute', left: 12, right: 12, bottom: 8, height: 38, overflow: 'hidden', borderRadius: 12 }}>
                {/* The lab's coloured page remains behind the floating coat on this device. */}
                {props.backdrop}
                <View style={[{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', backgroundColor: paint(c.surface.base, 'floating'), borderWidth: 1, borderColor: c.border.default }, Platform.OS === 'web' ? createBackdropWebStyle({ backgroundColor: paint(c.surface.base, 'floating'), blurPx: 0, surfaceGroup: 'floating', fallbackBackgroundColorWhenBlurDisabled: c.surface.base }) as unknown as ViewStyle : null]}>
                    {[0, 1, 2, 3].map(id => <View key={id} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.border.strong }} />)}
                </View>
            </View>
          </View> : <View style={{ flex: 1 }}>
            {props.materials ? <View style={{ height: MINIATURE_BAR_HEIGHT, backgroundColor: paint(c.surface.base, 'chrome') }} /> : null}
            <View style={{ flex: 1, flexDirection: 'row' }}>
            <View style={{ width: '34%', paddingHorizontal: 6, paddingTop: 5, backgroundColor: paint(c.surface.base, 'sidebar'), borderRightWidth: 1, borderRightColor: c.border.default }}>
                {line('70%', c.border.strong, 3)}
                {line('90%', c.surface.elevated)}
                {line('80%', c.surface.elevated)}
                {line('60%', c.surface.elevated)}
            </View>
            <View style={{ flex: 1, paddingHorizontal: 8, paddingTop: 7, backgroundColor: props.materials ? paint(c.background.canvas, 'content') : undefined }}>
                {line('55%', c.border.strong, 0)}
                {line('85%', c.surface.elevated)}
                <View style={{ height: MINIATURE_BAR_HEIGHT, width: '60%', alignSelf: 'flex-end', marginTop: 6, borderRadius: bubbleRadius, backgroundColor: paint(c.surface.elevated, 'content', true) }} />
                <View style={{ position: 'absolute', left: 8, right: 8, bottom: 7, height: MINIATURE_BAR_HEIGHT, borderRadius: composerRadius, backgroundColor: paint(c.surface.base, 'content', true), borderWidth: 1, borderColor: c.border.default }} />
            </View>
            </View>
          </View>}
        </View>
    );
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
