import type { Theme } from '@/theme';
import Color from 'color';
import { HAPPIER_SKELETON_INK_ALPHA } from '@happier-dev/plugin-ui/environment';
import { buildRaisedEdgeColorsWithPaint, deriveRaisedEdgeInk, resolveSurfaceFinishPaint, type RaisedSurfacePaints } from '../raisedEdge';
import { createVerticalGradient } from '../verticalGradient';
import { deriveHoverInk, deriveSelectionFocusInk } from '../selectionInk';
import { deriveThemePaint, fixedThemePaint, tokenThemePaint, type ThemePaint } from './themePaint';

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

export const resolveGlassComposerPaint = (theme: Theme, baseTheme: Theme): ThemePaint => {
    const surface = theme.dark ? 'elevated' : 'base';
    return theme.colors.surface[surface] === baseTheme.colors.surface[surface]
        ? fixedThemePaint(theme.colors.glass.composerSurface)
        : deriveThemePaint([tokenThemePaint(theme, theme.dark ? 'surface.elevated' : 'surface.base')], color => color);
};

// An edge ink the profile set explicitly is kept as set; otherwise it follows the profile's own text ink.
export const resolveRaisedEdgeInkPaint = (theme: Theme, baseTheme: Theme): ThemePaint => (
    theme.colors.effect.surfaceHighlight !== baseTheme.colors.effect.surfaceHighlight
        ? tokenThemePaint(theme, 'effect.surfaceHighlight')
        : deriveThemePaint([tokenThemePaint(theme, 'text.primary')], ink => deriveRaisedEdgeInk(ink, theme.dark))
);

// Loading placeholders take the profile's own text ink at the shared strength (`@happier-dev/plugin-ui/environment`
// → `skeletonInk.ts`), so they stay visible on every profile's surfaces; the base themes carry the same values.
// A skeleton ink the profile set explicitly is kept as set.
const deriveSkeletonInk = (theme: Theme, explicitOverrides: ReadonlySet<string>): string => (
    explicitOverrides.has('surface.skeleton')
        ? theme.colors.surface.skeleton
        : Color(theme.colors.text.primary).alpha(HAPPIER_SKELETON_INK_ALPHA).rgb().string()
);

export type ResolvedThemePaints = RaisedSurfacePaints & Readonly<{
    glassComposer: ThemePaint;
    selectedFocused: ThemePaint;
    selectedUnfocused: ThemePaint;
    hover: ThemePaint;
    edgeHighlight: ThemePaint;
    edgeFinish: ThemePaint;
}>;

export const deriveThemeColors = (theme: Theme, baseTheme: Theme, explicitOverrides: ReadonlySet<string> = new Set()): Theme => (
    deriveThemeColorsWithPaint(theme, baseTheme, explicitOverrides).theme
);

export function deriveThemeColorsWithPaint(theme: Theme, baseTheme: Theme,
    explicitOverrides: ReadonlySet<string> = new Set()): Readonly<{ theme: Theme; paint: ResolvedThemePaints }> {
    const raisedEdgeInk = resolveRaisedEdgeInkPaint(theme, baseTheme);
    const finishInk = explicitOverrides.has('effect.surfaceFinish')
        ? tokenThemePaint(theme, 'effect.surfaceFinish')
        : resolveSurfaceFinishPaint(theme.colors, theme.dark);
    const glassComposer = resolveGlassComposerPaint(theme, baseTheme);
    const text = tokenThemePaint(theme, 'text.primary');
    const selectedFocused = deriveThemePaint([text], ink => deriveSelectionFocusInk(ink, theme.dark).focused);
    const selectedUnfocused = deriveThemePaint([text], ink => deriveSelectionFocusInk(ink, theme.dark).unfocused);
    const hover = deriveThemePaint([text], ink => deriveHoverInk(ink, theme.dark));
    const edge = buildRaisedEdgeColorsWithPaint(theme.colors, raisedEdgeInk.color, theme.dark, finishInk.color);
    // Existing profiles authored the shared foreground. Keep that choice exact unless they
    // explicitly set the new text role, even when its value equals the default.
    const statusText = (variant: 'success' | 'warning' | 'attention' | 'danger' | 'info' | 'neutral' | 'active') => (
        explicitOverrides.has(`state.${variant}.textForeground`)
            ? theme.colors.state[variant].textForeground
            : explicitOverrides.has(`state.${variant}.foreground`)
                ? theme.colors.state[variant].foreground
                : deriveStatusColor(theme.colors.state[variant].foreground, baseTheme.colors.state[variant].foreground, theme.colors.state[variant].textForeground)
    );
    return { paint: { ...edge.paint, glassComposer, selectedFocused, selectedUnfocused, hover,
        edgeHighlight: raisedEdgeInk, edgeFinish: finishInk }, theme: {
        ...theme,
        colors: {
            ...theme.colors,
            glass: {
                ...theme.colors.glass,
                composerSurface: glassComposer.color,
            },
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
                active: { ...theme.colors.state.active, textForeground: statusText('active') },
            },
            surface: {
                ...theme.colors.surface,
                skeleton: deriveSkeletonInk(theme, explicitOverrides),
                // The open tab's fills always follow the profile's own text ink.
                selectedFocused: selectedFocused.color,
                selectedUnfocused: selectedUnfocused.color,
                // Hover follows the profile's own text ink too, always a lighter touch than its selection.
                hover: hover.color,
            },
            effect: {
                ...theme.colors.effect,
                surfaceHighlight: raisedEdgeInk.color,
                surfaceFinish: finishInk.color,
            },
            // Always re-derived: every border role's raised colour follows the profile's borders and ink.
            edge: edge.colors,
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
            // The selected dot sits inside an unfilled ring on the row's own surface, so it takes the
            // ring's selection ink. A dot the profile set explicitly is kept as set.
            radio: {
                ...theme.colors.radio,
                dot: explicitOverrides.has('control.radio.dot') ? theme.colors.radio.dot : theme.colors.radio.active,
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
    } };
}
