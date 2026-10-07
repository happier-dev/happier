import * as React from 'react';
import { StyleSheet } from 'react-native';
import Svg, { Defs, RadialGradient, Rect, Stop } from 'react-native-svg';
import { useUnistyles } from 'react-native-unistyles';

import type { Theme } from '@/theme';

import { surfaceUsesRim, type SurfaceEdgeRole } from './surfaceEdgeTreatment';

/**
 * The corner light falls off across the surface's own box (so a tooltip and a dialog read the same), on
 * an ellipse 1 × 1.6 of the box anchored top-left: `edge.rimHi` at the corner, `edge.rimMid` at 22%, gone
 * by 35%. A whisper, not a frame (design lab calibration: `radial-gradient(100% 160% at 0 0, …)`).
 */
const RIM_MID_OFFSET = 0.22;
const RIM_END_OFFSET = 0.35;
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
    /** The border role whose hairline the rim draws under its light (the surface's own `border.<role>`). */
    border: 'default' | 'surface' | 'modal';
    /** A static preview's theme; defaults to the active one. */
    theme?: Theme;
}>) {
    const { theme: activeTheme } = useUnistyles();
    const theme = props.theme ?? activeTheme;
    const id = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!surfaceUsesRim(props.role, theme.dark)) return null;
    const edge = theme.colors.edge;
    const stroke = HAIRLINE * 2; // centred on the edge: the outer half falls outside and only the inner hairline shows
    const rect = { x: 0, y: 0, width: '100%', height: '100%', rx: props.radius, ry: props.radius } as const;
    return (
        <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width="100%" height="100%" aria-hidden>
            <Defs>
                <RadialGradient id={`${id}l`} cx={0} cy={0} r={1} gradientUnits="objectBoundingBox" gradientTransform={RIM_LIGHT_ELLIPSE}>
                    <Stop offset={0} stopColor={edge.rimHi} />
                    <Stop offset={RIM_MID_OFFSET} stopColor={edge.rimMid} />
                    <Stop offset={RIM_END_OFFSET} stopColor={edge.rimMid} stopOpacity={0} />
                </RadialGradient>
                <RadialGradient id={`${id}s`} cx={0} cy={0} r={SHEEN_RADIUS} gradientUnits="objectBoundingBox" gradientTransform={SHEEN_ELLIPSE}>
                    <Stop offset={0} stopColor={edge.sheen} />
                    <Stop offset={1} stopColor={edge.sheen} stopOpacity={0} />
                </RadialGradient>
            </Defs>
            <Rect {...rect} fill={`url(#${id}s)`} />
            <Rect {...rect} fill="none" stroke={theme.colors.border[props.border]} strokeWidth={stroke} />
            <Rect {...rect} fill="none" stroke={`url(#${id}l)`} strokeWidth={stroke} />
        </Svg>
    );
});
