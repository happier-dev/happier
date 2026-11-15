import {
    resolveHappierGloss,
    resolveHappierRaisedEdge,
    type HappierRaisedEdge,
    type HappierRaisedEdgeState,
    resolveHappierSurfaceFinish,
    type HappierSurfaceFinishRole,
} from '@happier-dev/plugin-ui/presentation';

import { Platform } from 'react-native';

import { shadowLevelStyle, type ShadowElevationToken, type ShadowLevels } from '@/shadowElevation';
import { parseThemeColor } from '@/theme/parseThemeColor';
import type { RaisedEdgeColors } from '@/theme/raisedEdge';

import { resolveThemeSurfaceChromeStyle, type ThemeSurfaceChromeStyle } from './resolveThemeHairlineBorderStyle';

const ANDROID_UNLIFTED = { elevation: 0 } as const;

/**
 * Android paints an `elevation` shadow through a translucent fill: the surface reads as a grey band around its
 * own colour. A surface whose fill is translucent there stands unlifted (QA-NATIVE F8/Voice); an opaque one,
 * and every surface on iOS and web, keeps its lift. Append the result after the surface's lift.
 */
export function resolveAndroidTranslucentUnlift(backgroundColor: unknown): typeof ANDROID_UNLIFTED | null {
    if (Platform.OS !== 'android' || typeof backgroundColor !== 'string') return null;
    return backgroundColor === 'transparent' || (parseThemeColor(backgroundColor)?.alpha() ?? 1) < 1 ? ANDROID_UNLIFTED : null;
}

type RaisedEdgeTheme = Readonly<{ dark: boolean; colors: Readonly<{ edge: RaisedEdgeColors }> }>;
type RaisedControlTheme = Readonly<{ dark: boolean; colors: Readonly<{ edge: RaisedEdgeColors; shadowLevels: ShadowLevels }> }>;
type CardTheme = Readonly<{ dark: boolean; colors: Readonly<{ edge: RaisedEdgeColors; shadowCard: ShadowElevationToken; border: Readonly<{ surface: string }> }> }>;

/** A border role that has a raised twin in `theme.colors.edge` (the gloss and the fill are not border roles). */
export type ThemeRaisedEdgeRole = Exclude<keyof RaisedEdgeColors, 'gloss' | 'fill' | 'cardFill' | 'floatingFill' | 'rimHi' | 'rimMid' | 'sheen' | 'finishGradient' | 'cardFinishGradient' | 'primaryFinishGradient' | 'secondaryFinishGradient'>;

export function resolveThemeSurfaceFinish(theme: RaisedEdgeTheme & Readonly<{
    finish?: 'flat' | 'soft';
    parts?: Partial<Record<HappierSurfaceFinishRole, Readonly<{ finish?: 'flat' | 'soft' }>>>;
}>, role: HappierSurfaceFinishRole, state?: HappierRaisedEdgeState, nested = false) {
    return resolveHappierSurfaceFinish({
        role, finish: theme.finish, parts: theme.parts, state, nested,
        gradients: {
            card: theme.colors.edge.cardFinishGradient,
            floating: theme.colors.edge.finishGradient,
            composer: theme.colors.edge.finishGradient,
            primaryButton: theme.colors.edge.primaryFinishGradient,
            secondaryButton: theme.colors.edge.secondaryFinishGradient,
        },
    });
}

/**
 * The raised edge of a surface drawn with `border.<role>` (or `state.danger.border` for `danger`) in
 * this theme. A surface carries its own elevation (`resolveThemeSurfaceChromeStyle`).
 */
export function resolveThemeRaisedEdge(
    theme: RaisedEdgeTheme,
    role: ThemeRaisedEdgeRole,
    state?: HappierRaisedEdgeState,
): HappierRaisedEdge | null {
    return resolveHappierRaisedEdge({ colorScheme: theme.dark ? 'dark' : 'light', color: theme.colors.edge[role], state });
}

/**
 * The raised edge of a bordered control (field box, outline button, search field) and the lowest
 * elevation it stands on, or `null` while it sits flat (pressed, disabled, focused, invalid). Every
 * core control takes its edge here, so side, colour, lift and flat states have one owner.
 */
export function resolveThemeControlEdge(
    theme: RaisedControlTheme,
    role: ThemeRaisedEdgeRole,
    state?: HappierRaisedEdgeState,
): HappierRaisedEdge | null {
    return resolveHappierRaisedEdge({
        colorScheme: theme.dark ? 'dark' : 'light',
        color: theme.colors.edge[role],
        lift: shadowLevelStyle(theme.colors.shadowLevels[1]),
        state,
    });
}

/**
 * The edge an in-flow card stands on (grouped and page sheets, widgets, `SurfaceCard`): its lip on
 * `border.surface` and its own grounding (`shadowCard`), never a control's level-1 step. Core cards and
 * the plugin page sheet (`HappierUiPalette.sheetEdge`) both take it here.
 */
export function resolveThemeCardEdge(theme: CardTheme): HappierRaisedEdge | null {
    return resolveHappierRaisedEdge({
        colorScheme: theme.dark ? 'dark' : 'light',
        color: theme.colors.edge.surface,
        lift: shadowLevelStyle(theme.colors.shadowCard),
    });
}

/** An in-flow card's chrome: its hairline, its lip and its grounding (fill: `edge.cardFill`). */
export function resolveThemeCardChromeStyle(theme: CardTheme): ThemeSurfaceChromeStyle {
    return resolveThemeSurfaceChromeStyle({
        borderColor: theme.colors.border.surface,
        edge: resolveThemeRaisedEdge(theme, 'surface'),
        shadowStyle: shadowLevelStyle(theme.colors.shadowCard),
    });
}

/** The gloss line of a filled accent control and its lift, or `null` while pressed or disabled. */
export function resolveThemeGloss(theme: RaisedControlTheme, state?: HappierRaisedEdgeState): HappierRaisedEdge | null {
    return resolveHappierGloss({ color: theme.colors.edge.gloss, lift: shadowLevelStyle(theme.colors.shadowLevels[1]), state });
}
