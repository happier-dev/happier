import {
    resolveHappierGloss,
    resolveHappierRaisedEdge,
    type HappierRaisedEdge,
    type HappierRaisedEdgeState,
} from '@happier-dev/plugin-ui/presentation';

import { shadowLevelStyle, type ShadowLevels } from '@/shadowElevation';
import type { RaisedEdgeColors } from '@/theme/raisedEdge';

type RaisedEdgeTheme = Readonly<{ dark: boolean; colors: Readonly<{ edge: RaisedEdgeColors }> }>;
type RaisedControlTheme = Readonly<{ dark: boolean; colors: Readonly<{ edge: RaisedEdgeColors; shadowLevels: ShadowLevels }> }>;

/** A border role that has a raised twin in `theme.colors.edge` (the gloss and the fill are not border roles). */
export type ThemeRaisedEdgeRole = Exclude<keyof RaisedEdgeColors, 'gloss' | 'fill' | 'cardFill' | 'floatingFill' | 'rimHi' | 'rimMid' | 'sheen'>;

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

/** The gloss line of a filled accent control and its lift, or `null` while pressed or disabled. */
export function resolveThemeGloss(theme: RaisedControlTheme, state?: HappierRaisedEdgeState): HappierRaisedEdge | null {
    return resolveHappierGloss({ color: theme.colors.edge.gloss, lift: shadowLevelStyle(theme.colors.shadowLevels[1]), state });
}
