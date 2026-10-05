import { StyleSheet } from 'react-native-unistyles';

import { shadowLevelStyle } from '@/shadowElevation';
import { glassSurfacePlaneStyle } from '@/components/ui/glass/glassSurfacePaint';

/**
 * The column's plane: the sidebar grey with its hairline edge against the page. One owner for the
 * docked column and for a peeked column standing in its place, so a peek reads as the column itself.
 */
export const appShellColumnSurface = StyleSheet.create((theme) => ({
    column: {
        flexShrink: 0,
        ...glassSurfacePlaneStyle(theme.colors.surface.inset, 'sidebar'),
        borderRightWidth: StyleSheet.hairlineWidth,
        borderRightColor: theme.colors.border.default,
    },
    /**
     * The plane alone, for a navigation column that stands beside the shell's (a Home console's own
     * sidebar) and for the settings shell's column outside the app shell. Navigation lists never
     * paint it themselves.
     */
    plane: {
        ...glassSurfacePlaneStyle(theme.colors.surface.inset, 'sidebar'),
    },
    /**
     * A peeked column is a layer over the open column or the page: its lift falls on the trailing
     * edge (the content sheet clips the other edges, and the leading one sits against the rail). The
     * same level as the other floating layers (`FloatingOverlay`).
     */
    peekLift: shadowLevelStyle(theme.colors.shadowLevels[4]),
}));
