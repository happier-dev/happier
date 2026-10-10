import type { Theme } from '@/theme';
import Color from 'color';
import { buildRaisedEdgeColors, deriveRaisedEdgeInk, deriveSurfaceFinishInk } from '../raisedEdge';
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

// An edge ink the profile set explicitly is kept as set; otherwise it follows the profile's own text ink.
const deriveRaisedEdgeInkForProfile = (theme: Theme, baseTheme: Theme): string => (
    theme.colors.effect.surfaceHighlight !== baseTheme.colors.effect.surfaceHighlight
        ? theme.colors.effect.surfaceHighlight
        : deriveRaisedEdgeInk(theme.colors.text.primary, theme.dark)
);

export const deriveThemeColors = (theme: Theme, baseTheme: Theme, explicitOverrides: ReadonlySet<string> = new Set()): Theme => {
    const raisedEdgeInk = deriveRaisedEdgeInkForProfile(theme, baseTheme);
    const finishInk = explicitOverrides.has('effect.surfaceFinish')
        ? theme.colors.effect.surfaceFinish
        : deriveSurfaceFinishInk(theme.colors.text.primary, theme.dark);
    // Existing profiles authored the shared foreground. Keep that choice exact unless they
    // explicitly set the new text role, even when its value equals the default.
    const statusText = (variant: 'success' | 'warning' | 'attention' | 'danger' | 'info' | 'neutral') => (
        explicitOverrides.has(`state.${variant}.textForeground`)
            ? theme.colors.state[variant].textForeground
            : explicitOverrides.has(`state.${variant}.foreground`)
                ? theme.colors.state[variant].foreground
                : deriveStatusColor(theme.colors.state[variant].foreground, baseTheme.colors.state[variant].foreground, theme.colors.state[variant].textForeground)
    );
    return {
        ...theme,
        colors: {
            ...theme.colors,
            state: {
                ...theme.colors.state,
                success: { ...theme.colors.state.success, textForeground: statusText('success') },
                warning: { ...theme.colors.state.warning, textForeground: statusText('warning') },
                attention: { ...theme.colors.state.attention, textForeground: statusText('attention'),
                    background: explicitOverrides.has('state.attention.background') ? theme.colors.state.attention.background
                        : Color(theme.colors.state.attention.foreground).alpha(0.12).rgb().string() },
                danger: { ...theme.colors.state.danger, textForeground: statusText('danger') },
                info: { ...theme.colors.state.info, textForeground: statusText('info') },
                neutral: { ...theme.colors.state.neutral, textForeground: statusText('neutral') },
            },
            effect: {
                ...theme.colors.effect,
                surfaceHighlight: raisedEdgeInk,
                surfaceFinish: finishInk,
            },
            // Always re-derived: every border role's raised colour follows the profile's borders and ink.
            edge: buildRaisedEdgeColors(theme.colors, raisedEdgeInk, theme.dark, finishInk),
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
    };
};
