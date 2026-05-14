import type { Theme } from '@/theme';
import { createVerticalGradient } from '../verticalGradient';

type ThemeControlGradient = Theme['colors']['button']['primary']['gradient'];

const derivePrimaryButtonGradient = (theme: Theme, baseTheme: Theme): ThemeControlGradient => {
    const primary = theme.colors.button.primary;
    const basePrimary = baseTheme.colors.button.primary;
    if (primary.background === basePrimary.background && primary.tint === basePrimary.tint) {
        return primary.gradient;
    }

    return createVerticalGradient([primary.background, primary.background]);
};

const deriveFabGradient = (theme: Theme, baseTheme: Theme): ThemeControlGradient => {
    const fab = theme.colors.fab;
    const baseFab = baseTheme.colors.fab;
    if (fab.background === baseFab.background && fab.backgroundPressed === baseFab.backgroundPressed) {
        return fab.gradient;
    }

    return createVerticalGradient([fab.background, fab.backgroundPressed]);
};

const deriveSegmentedControlActiveGradient = (theme: Theme, baseTheme: Theme): ThemeControlGradient => {
    const segmentedControl = theme.colors.segmentedControl;
    if (segmentedControl.activeBackground === baseTheme.colors.segmentedControl.activeBackground) {
        return segmentedControl.activeGradient;
    }

    return createVerticalGradient([segmentedControl.activeBackground, segmentedControl.activeBackground]);
};

const deriveStatusColor = (sourceColor: string, baseSourceColor: string, currentStatusColor: string): string => {
    if (sourceColor === baseSourceColor) {
        return currentStatusColor;
    }

    return sourceColor;
};

const deriveFeedCardBackground = (theme: Theme, baseTheme: Theme): string => {
    if (theme.colors.feed.card.background !== baseTheme.colors.feed.card.background) {
        return theme.colors.feed.card.background;
    }

    if (theme.colors.surface.elevated === baseTheme.colors.surface.elevated) {
        return theme.colors.feed.card.background;
    }

    return theme.colors.surface.elevated;
};

export const deriveThemeColors = (theme: Theme, baseTheme: Theme): Theme => ({
    ...theme,
    colors: {
        ...theme.colors,
        button: {
            ...theme.colors.button,
            primary: {
                ...theme.colors.button.primary,
                gradient: derivePrimaryButtonGradient(theme, baseTheme),
            },
        },
        fab: {
            ...theme.colors.fab,
            gradient: deriveFabGradient(theme, baseTheme),
        },
        segmentedControl: {
            ...theme.colors.segmentedControl,
            activeGradient: deriveSegmentedControlActiveGradient(theme, baseTheme),
        },
        feed: {
            ...theme.colors.feed,
            card: {
                ...theme.colors.feed.card,
                background: deriveFeedCardBackground(theme, baseTheme),
            },
        },
        status: {
            connected: deriveStatusColor(
                theme.colors.state.success.foreground,
                baseTheme.colors.state.success.foreground,
                theme.colors.status.connected,
            ),
            actionRequired: deriveStatusColor(
                theme.colors.state.warning.foreground,
                baseTheme.colors.state.warning.foreground,
                theme.colors.status.actionRequired,
            ),
            connecting: deriveStatusColor(
                theme.colors.state.info.foreground,
                baseTheme.colors.state.info.foreground,
                theme.colors.status.connecting,
            ),
            default: deriveStatusColor(
                theme.colors.state.neutral.foreground,
                baseTheme.colors.state.neutral.foreground,
                theme.colors.status.default,
            ),
            disconnected: deriveStatusColor(
                theme.colors.state.neutral.foreground,
                baseTheme.colors.state.neutral.foreground,
                theme.colors.status.disconnected,
            ),
            error: deriveStatusColor(
                theme.colors.state.danger.foreground,
                baseTheme.colors.state.danger.foreground,
                theme.colors.status.error,
            ),
        },
    },
});
