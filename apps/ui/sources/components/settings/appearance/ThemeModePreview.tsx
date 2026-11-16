import * as React from 'react';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import Color from 'color';

import { darkTheme, lightTheme } from '@/theme';
import { glassElementsCoatColor, glassSurfaceBackgroundColor, glassSurfaceTintColor } from '@/components/ui/glass/glassSurfacePaint';
import { resolveGlassBackdropMap, type GlassSurfaceMaterials, type GlassMaterialSettings, type GlassMaterialEnvironment } from '@/components/ui/glass/glassMaterial';
import { resolveGlassPresentationVariables } from '@/components/ui/glass/glassDocumentPresentation';
import { createBackdropWebStyle } from '@/components/ui/overlays/createBackdropLayerStyle';
import type { ThemeMiniatureData } from '@/theme/profiles/themeProfileTypes';
import type { ThemeRadiusScaleName } from '@happier-dev/protocol/account/settings/themeProfiles';

/** The roles a miniature paints: any resolved theme satisfies it. */
export type ThemePreviewPalette = Palette;
type Palette = Readonly<{
    dark?: boolean;
    colors: Readonly<{
        background: Readonly<{ canvas: string }>;
        surface: Readonly<{ base: string; elevated: string; selected?: string }>;
        text?: Readonly<{ primary: string }>;
        border: Readonly<{ default: string; strong: string }>;
        /** The surface ladder: Elements and floating fills (absent on palettes that predate it). */
        edge?: Readonly<{ cardFill: string; floatingFill: string }>;
        /** The theme's accent (the send mark); a resolved theme carries it, compact palettes pass `accent`. */
        button?: Readonly<{ primary: Readonly<{ background: string }> }>;
        /** Your message's fill (the bubble); falls back to the elevated surface. */
        message?: Readonly<{ user: Readonly<{ background: string }> }>;
    }>;
}>;

/**
 * Which picture of the app the miniature draws: `window` (rail, session column, transcript and
 * composer), `phone` (large title, session rows, floating tab bar and the accent +) for pickers shown
 * on a phone, or `mark` (the transcript corner alone, for a 44 pt header mark or a 32×20 command row).
 */
export type ThemeMiniatureForm = 'window' | 'phone' | 'mark';

/** Today's (soft) radii at miniature scale, kept for tiles that do not preview a radius scale. */
const DEFAULT_MINIATURE_RADIUS = 5;
/** The corner shapes a theme can carry, at miniature scale. */
const MINIATURE_RADIUS_BY_SCALE: Readonly<Record<ThemeRadiusScaleName, number>> = { sharp: 1, soft: DEFAULT_MINIATURE_RADIUS, round: 8 };
const PILL = 999;
const SESSION_ROWS = [0, 1, 2, 3, 4] as const;
const share = (percent: number): `${number}%` => `${percent}%`;

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
}>) {
    const c = props.palette.colors;
    const radius = props.radius ? MINIATURE_RADIUS_BY_SCALE[props.radius] : DEFAULT_MINIATURE_RADIUS;
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
    const ink = c.text?.primary ?? c.border.strong;
    const accent = props.accent ?? c.button?.primary.background ?? ink;
    // Ink at a share of its strength: the miniature's text lines and glyphs.
    const inkBar = (style: ViewStyle, strength: number) => (
        <View style={[{ position: 'absolute', borderRadius: PILL, backgroundColor: ink, opacity: strength }, style]} />
    );

    if (props.floatingOnly) {
        const line = (width: `${number}%`, marginTop = 5) => (
            <View style={{ height: 5, borderRadius: 3, width, backgroundColor: c.border.strong, marginTop }} />
        );
        return (
            <View style={[{ flex: 1, flexDirection: 'row', overflow: 'hidden', backgroundColor: props.backdrop ? 'transparent' : c.background.canvas }, materialStyle]}>
              {props.backdrop}
              <View style={{ flex: 1, padding: 12, backgroundColor: c.surface.base }}>
                {line('92%', 0)}
                {line('65%')}
                {line('82%')}
                <View style={{ position: 'absolute', left: 12, right: 12, bottom: 8, height: 38, overflow: 'hidden', borderRadius: 12 }}>
                    {/* The lab's coloured page remains behind the floating coat on this device. */}
                    {props.backdrop}
                    <View style={[{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', borderRadius: 12, backgroundColor: paint(floatingFill, 'floating'), borderWidth: 1, borderColor: c.border.default }, Platform.OS === 'web' ? createBackdropWebStyle({ backgroundColor: paint(floatingFill, 'floating'), blurPx: 0, surfaceGroup: 'floating', backdropTone, fallbackBackgroundColorWhenBlurDisabled: floatingFill }) as unknown as ViewStyle : null]}>
                        {[0, 1, 2, 3].map(id => <View key={id} style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.border.strong }} />)}
                    </View>
                </View>
              </View>
            </View>
        );
    }

    const selectedRow = c.surface.selected ?? c.surface.elevated;
    const form = props.form ?? 'window';
    if (form === 'phone') {
        return (
            <View style={{ flex: 1, overflow: 'hidden', backgroundColor: c.surface.base }}>
                {inkBar({ top: '9%', left: '8%', width: '42%', height: '5%' }, 0.72)}
                {SESSION_ROWS.map((row) => (
                    <View key={row} style={{ position: 'absolute', left: '6%', right: '6%', top: share(19 + row * 13), height: '11%', borderRadius: radius, backgroundColor: row === 0 ? selectedRow : undefined }}>
                        {inkBar({ top: '24%', left: '5%', width: '64%', height: '22%' }, row === 0 ? 0.55 : 0.3)}
                        {inkBar({ top: '58%', left: '5%', width: '38%', height: '17%' }, 0.14)}
                    </View>
                ))}
                <View style={{ position: 'absolute', left: '8%', width: '62%', bottom: '5%', height: '10%', borderRadius: PILL, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border.default, backgroundColor: c.surface.base, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around' }}>
                    {[0, 1, 2, 3].map((dot) => <View key={dot} style={{ height: '30%', aspectRatio: 1, borderRadius: PILL, backgroundColor: ink, opacity: 0.3 }} />)}
                </View>
                <View style={{ position: 'absolute', right: '8%', bottom: '5%', height: '10%', aspectRatio: 1, borderRadius: PILL, backgroundColor: accent }} />
            </View>
        );
    }

    const bubbleFill = materials ? paint(cardFill, 'card') : c.message?.user.background ?? c.surface.elevated;
    const composerFill = materials ? paint(cardFill, 'card') : c.surface.base;
    // The transcript: a title, your message, the agent's reply and the composer with the accent send.
    const transcript = (
        <>
            {inkBar({ top: '8%', left: '7%', width: '34%', height: '3.6%' }, 0.7)}
            <View style={{ position: 'absolute', top: '19%', right: '7%', width: '44%', height: '11%', borderRadius: radius * 1.1, backgroundColor: bubbleFill }} />
            {inkBar({ top: '37%', left: '7%', width: '67%', height: '3%' }, 0.2)}
            {inkBar({ top: '44%', left: '7%', width: '55%', height: '3%' }, 0.2)}
            {inkBar({ top: '51%', left: '7%', width: '61%', height: '3%' }, 0.2)}
            <View style={{ position: 'absolute', left: '7%', right: '7%', bottom: '6%', height: '13%', borderRadius: radius * 1.2, backgroundColor: composerFill, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border.default, alignItems: 'flex-end', justifyContent: 'center', paddingRight: '2.5%' }}>
                <View style={{ height: '56%', aspectRatio: 1, borderRadius: PILL, backgroundColor: accent }} />
            </View>
        </>
    );
    const mainFill = materials ? paint(c.surface.base, 'content') : c.surface.base;
    if (form === 'mark') {
        return (
            <View style={{ flex: 1, overflow: 'hidden', backgroundColor: c.background.canvas }}>
                <View style={{ position: 'absolute', top: '12%', left: '12%', right: 0, bottom: 0, borderTopLeftRadius: radius, backgroundColor: mainFill, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border.default }}>
                    {transcript}
                </View>
            </View>
        );
    }
    return (
        <View style={[{ flex: 1, overflow: 'hidden', backgroundColor: props.backdrop ? 'transparent' : c.background.canvas }, materialStyle]}>
            {props.backdrop}
            {materials ? <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '9%', backgroundColor: paint(c.surface.base, 'chrome') }} /> : null}
            <View style={{ position: 'absolute', left: 0, width: '9%', top: '9%', height: '36%', alignItems: 'center', justifyContent: 'space-between' }}>
                {[0, 1, 2, 3].map((dot) => <View key={dot} style={{ width: '38%', aspectRatio: 1, borderRadius: Math.min(radius, 2), backgroundColor: ink, opacity: 0.2 }} />)}
            </View>
            <View style={{ position: 'absolute', left: '10.8%', width: '27%', top: '4%', bottom: '4%', borderRadius: radius, backgroundColor: materials ? paint(c.surface.base, 'sidebar') : undefined }}>
                {SESSION_ROWS.map((row) => (
                    <View key={row} style={{ position: 'absolute', left: '6%', right: '6%', top: share(4 + row * 12.5), height: '9.8%', borderRadius: Math.max(1, radius * 0.7), backgroundColor: row === 0 ? selectedRow : undefined }}>
                        {inkBar({ top: '36%', left: '8%', width: '66%', height: '28%' }, row === 0 ? 0.55 : 0.2)}
                    </View>
                ))}
            </View>
            <View style={{ position: 'absolute', left: '39.6%', right: '2.6%', top: '4%', bottom: '4%', borderRadius: radius, backgroundColor: mainFill, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border.default, overflow: 'hidden' }}>
                {transcript}
            </View>
        </View>
    );
}

/**
 * A theme drawn from its compact library header (`ThemeMiniatureData`): the same window miniature, painted from
 * the header's colours, its accent and its corner shape. Static and body-free, so grids, cards, the Store and
 * the command palette can draw any number of themes without opening one.
 */
export const ThemeMiniaturePreview = React.memo(function ThemeMiniaturePreview(props: Readonly<{ miniature: ThemeMiniatureData; form?: ThemeMiniatureForm }>) {
    const palette = React.useMemo(() => miniaturePalette(props.miniature), [props.miniature]);
    return <ThemePalettePreview palette={palette} accent={props.miniature.accent} radius={props.miniature.radius} form={props.form} />;
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
