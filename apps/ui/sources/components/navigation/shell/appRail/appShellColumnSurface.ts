import { StyleSheet } from 'react-native-unistyles';

import { shadowLevelStyle } from '@/shadowElevation';
import { appShellColumnPlanePaint, resolveSidebarPaint } from './sidebarPaint';

/**
 * The navigation plane's colour: the canvas the rail and title strip stand on. A navigation column
 * (the shell's, a peeked one, Settings' and a Home console's) reads as part of that one quiet plane,
 * and only the page is lifted off it (calm-shell `csedge.S1`). Every plane and peek coat reads it here.
 */
export function appShellColumnPlaneColor(colors: Readonly<{ background: Readonly<{ canvas: string }> }>): string {
    return appShellColumnPlanePaint(colors).color;
}

/**
 * The column's plane: the navigation canvas, with no edge of its own. The page's seam shadow is what
 * separates it from the page. One owner for the docked column and for a peeked column standing in its
 * place, so a peek reads as the column itself.
 */
export const appShellColumnSurface = StyleSheet.create((theme) => ({
    column: {
        flexShrink: 0,
        backgroundColor: resolveSidebarPaint(theme, 'root').background.color,
    },
    /**
     * The plane alone, for a navigation column that stands beside the shell's (a Home console's own
     * sidebar) and for the settings shell's column outside the app shell. Navigation lists never
     * paint it themselves.
     */
    plane: {
        backgroundColor: resolveSidebarPaint(theme, 'root').background.color,
    },
    /**
     * A peeked column is a layer over the open column or the page: its lift falls on the trailing
     * edge (the leading one sits against the rail). The same level as the other floating layers
     * (`FloatingOverlay`); no hairline, the lift is the edge.
     */
    peekLift: shadowLevelStyle(theme.colors.shadowLevels[4]),
}));
