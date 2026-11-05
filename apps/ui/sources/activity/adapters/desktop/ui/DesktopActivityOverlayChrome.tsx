import { StyleSheet } from 'react-native-unistyles';
import type { UnistylesThemes } from 'react-native-unistyles';

import { resolveHappierFocusRingVisible } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';

import type { DesktopActivityOverlayVisualModeForTestID as DesktopActivityOverlayVisualMode } from './shared/desktopActivityOverlaySelectors';

type Theme = UnistylesThemes[keyof UnistylesThemes];
type InteriorSurfaceKind = 'badge' | 'field' | 'ask';

/**
 * Quiet interior fills on the island: a count or chip is a low-alpha ink pill (`surface.selected`), a
 * text field sits in the theme's input well, and a pending ask is the one raised well on the black
 * (lab `.nt-ask`: elevated surface, inset hairline, `lg` radius), so its decision reads as one object.
 */
export function createDesktopActivityOverlayInteriorSurfaceStyle(
    theme: Theme,
    params: Readonly<{
        visualMode: DesktopActivityOverlayVisualMode;
        kind: InteriorSurfaceKind;
    }>,
): Record<string, unknown> {
    if (params.kind === 'ask') {
        // A whisper of the island's own selection tint, with no edge: a raised grey card read as a
        // foreign object on the black (owner ruling 13, lab ntask C).
        return {
            backgroundColor: theme.colors.surface.selected,
            borderRadius: theme.borderRadius.lg,
        };
    }
    if (params.kind === 'field') {
        return {
            backgroundColor: theme.colors.surface.selected,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.border.surface,
            borderRadius: theme.borderRadius.md,
        };
    }
    return {
        backgroundColor: theme.colors.surface.selected,
        borderRadius: 9999,
    };
}

/**
 * The overlay's keyboard focus ring: the shared ring (`focusRingStyle`) in `border.focus`, inset
 * because the island fills its own window, whose edge clips anything drawn outside a control.
 */
export function createDesktopActivityOverlayFocusRingStyle(theme: Theme, focused: boolean | undefined): ReturnType<typeof focusRingStyle> {
    return focusRingStyle({ focused: resolveHappierFocusRingVisible(focused), color: theme.colors.border.focus, placement: 'inset' });
}
