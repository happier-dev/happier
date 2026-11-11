import * as React from 'react';
import { Platform, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';
import { happierSvgGradientStop } from '@happier-dev/plugin-ui/presentation';

import type { Theme } from '@/theme';

import { surfaceUsesRim, type SurfaceEdgeRole } from './surfaceEdgeTreatment';

/**
 * The corner light falls off across the surface's own box (so a tooltip and a dialog read the same), on
 * an ellipse 1 × 1.6 of the box anchored top-left: `edge.rimHi` at the corner, `edge.rimMid` at 22%, then
 * easing to a share of `edge.rimMid` at the far corners. It never ends part way along an edge: a light that
 * was gone by 35% read as a cut in the seam on every large surface (owner, 2026-11-11 desktop #12).
 */
const RIM_MID_OFFSET = 0.22;
const RIM_END_OFFSET = 1;
/** What remains of `edge.rimMid` at the far end of the edges: a whisper over the hairline, never zero. */
const RIM_TAIL_SHARE = 0.35;
const RIM_LIGHT_ELLIPSE = 'scale(1 1.6)';
/** The sheen stays short: a soft glow in the corner's first third (lab: an ellipse 32% × 46% of the box). */
const SHEEN_RADIUS = 0.32;
const SHEEN_ELLIPSE = `scale(1 ${0.46 / 0.32})`;
const HAIRLINE = StyleSheet.hairlineWidth || 1;

/**
 * The directional rim of a floating surface: its hairline drawn with one corner light anchored top-left —
 * strongest at that corner, fading along the top edge and down the left side — plus a short sheen inside
 * the corner. In the theme's own ink: lighter on dark, a breath darker on light, never white.
 *
 * It draws the surface's whole hairline, so a surface whose role uses the rim has no border of its own
 * (`resolveThemeSurfaceBorderStyle({ rim })`). Mount it as the surface's last child; it fills the surface,
 * matches its corner radius and never takes a touch. Where the role's treatment is the flat edge
 * (`SURFACE_EDGE_TREATMENT`), it renders nothing.
 * One SVG on every platform React Native renders to: the same rim on web, iOS and Android.
 */
export const SurfaceRim = React.memo(function SurfaceRim(props: Readonly<{
    role: SurfaceEdgeRole;
    radius: number;
    /**
     * The border role whose hairline the rim draws under its light (the surface's own `border.<role>`), or `null`
     * for the light alone: a tooltip is too small to box in a full hairline (owner, 2026-11-11).
     */
    border: 'default' | 'surface' | 'modal' | null;
    /** The corner the light stands in; a surface flush against a screen edge moves it to a free corner. */
    anchor?: 'top-left' | 'bottom-left';
    /** A static preview's theme; defaults to the active one. */
    theme?: Theme;
}>) {
    const { theme: activeTheme } = useUnistyles();
    const theme = props.theme ?? activeTheme;
    const id = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
    // Native SVG resolves "100%" against the view's first layout and keeps it when the surface resizes (a phone
    // popover lays out at 370 then 378 pt), which drew a second, smaller border inside it. The rim draws at the
    // laid-out size instead.
    const [size, setSize] = React.useState<Readonly<{ width: number; height: number }> | null>(null);
    const handleLayout = React.useCallback((event: LayoutChangeEvent) => {
        const { width, height } = event.nativeEvent.layout;
        setSize(current => current?.width === width && current.height === height ? current : { width, height });
    }, []);
    if (!surfaceUsesRim(props.role, theme.dark)) return null;
    const edge = theme.colors.edge;
    const stroke = HAIRLINE * 2; // centred on the edge: the outer half falls outside and only the inner hairline shows
    // The browser resolves "100%" against the live box; only native needs the measured size. A measured size on
    // the web pinned a pane's rim to the box it had while opening (owner 2026-11-11 desktop #12: the seam and its
    // sheen stopped part way along an overlay pane).
    const drawn = Platform.OS === 'web' ? null : size;
    const rect = { x: 0, y: 0, width: drawn?.width ?? '100%', height: drawn?.height ?? '100%', rx: props.radius, ry: props.radius } as const;
    const cy = props.anchor === 'bottom-left' ? 1 : 0;
    const anchored = (ellipse: string) => cy === 0 ? ellipse : `translate(0 ${cy}) ${ellipse} translate(0 ${-cy})`;
    return (
        // A plain view measures the surface (react-native-svg's view reports only its first layout on Fabric, and
        // its width/height props would pin the view's own size); the drawing takes that measured size.
        <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={handleLayout}>
        {/* On the web the drawing spans the surface: an unsized <svg> is the browser's 300 × 150 default box (the owner's cut
            seam). Native keeps no size props: they pin react-native-svg's view to its first layout. */}
        <Svg pointerEvents="none" style={StyleSheet.absoluteFill} {...(Platform.OS === 'web' ? { width: '100%', height: '100%' } : null)}>
            <Defs>
                <RadialGradient id={`${id}l`} cx={0} cy={cy} r={1} gradientUnits="objectBoundingBox" gradientTransform={anchored(RIM_LIGHT_ELLIPSE)}>
                    <Stop offset={0} {...happierSvgGradientStop(edge.rimHi)} />
                    <Stop offset={RIM_MID_OFFSET} {...happierSvgGradientStop(edge.rimMid)} />
                    <Stop offset={RIM_END_OFFSET} {...happierSvgGradientStop(edge.rimMid, RIM_TAIL_SHARE)} />
                </RadialGradient>
                <RadialGradient id={`${id}s`} cx={0} cy={cy} r={SHEEN_RADIUS} gradientUnits="objectBoundingBox" gradientTransform={anchored(SHEEN_ELLIPSE)}>
                    <Stop offset={0} {...happierSvgGradientStop(edge.sheen)} />
                    <Stop offset={1} {...happierSvgGradientStop(edge.sheen, 0)} />
                </RadialGradient>
            </Defs>
            <Rect {...rect} fill={`url(#${id}s)`} />
            {props.border ? <Rect {...rect} fill="none" stroke={theme.colors.border[props.border]} strokeWidth={stroke} /> : null}
            <Rect {...rect} fill="none" stroke={`url(#${id}l)`} strokeWidth={stroke} />
        </Svg>
        </View>
    );
});
