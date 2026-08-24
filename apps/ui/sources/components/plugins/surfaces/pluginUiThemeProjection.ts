import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';

import { FontWeights, getMonoFont, Typography } from '@/constants/Typography';
import type { Theme } from '@/theme';
import type { ThemeColorTokenId } from '@/theme/tokens/themeColorTokenDefinitions';

/**
 * The semantic theme projection for executable plugin UI (§3.3, UI-D12).
 *
 * `PluginUiThemeV1` is versioned data, not a style-system object. Its values are
 * read from the theme the app is CURRENTLY rendering with — the user's active
 * theme profile resolved through `theme/profiles/**` — so a profile change moves
 * the projected values, not just light/dark.
 *
 * Every colour field names the exact canonical editable token it projects in
 * {@link PLUGIN_UI_THEME_COLOR_TOKEN_IDS} and reads that token's own path off the
 * theme. No palette is authored here: this file contains no colour literal, and
 * `pluginUiThemeProjection.test.ts` proves each field equals the value the theme
 * token registry resolves for its named id, for every built-in profile.
 */
export const PLUGIN_UI_THEME_COLOR_TOKEN_IDS = Object.freeze({
    canvas: 'background.canvas',
    surface: 'surface.base',
    elevatedSurface: 'surface.elevated',
    text: 'text.primary',
    secondaryText: 'text.secondary',
    mutedText: 'text.tertiary',
    // A bounded surface's own outline; `divider` is the separator between rows.
    border: 'border.surface',
    divider: 'border.default',
    // The app's focus ring role. Was `border.strong`, a border-weight token measuring 1.26-1.45:1
    // against every surface where WCAG 1.4.11 asks 3:1 — so every plugin surface inherited an
    // effectively invisible focus ring too.
    focus: 'border.focus',
    accent: 'control.button.primary.background',
    onAccent: 'control.button.primary.foreground',
    success: 'state.success.foreground',
    warning: 'state.warning.foreground',
    danger: 'state.danger.foreground',
    info: 'state.info.foreground',
    control: 'control.input.background',
    controlDisabled: 'control.button.primary.disabled',
    overlay: 'overlay.scrim',
} as const satisfies Readonly<Record<keyof PluginUiThemeV1['colors'], ThemeColorTokenId>>);

/**
 * Plugin surfaces render pill-shaped controls with the same geometry the app
 * uses everywhere. A corner radius is geometry rather than a themed semantic
 * value, so it has no editable token to project (§8.2).
 */
const PLUGIN_UI_PILL_RADIUS = 999;

function readTextStyleMetric(
    style: Readonly<{ fontSize?: number | string; lineHeight?: number | string }>,
    key: 'fontSize' | 'lineHeight',
): number {
    // The canonical typography primitives return platform-selected numbers; the
    // React Native style type widens them, so narrow once here rather than
    // restating the sizes.
    const value = style[key];
    return typeof value === 'number' ? value : Number(value ?? 0);
}

/**
 * Project the canonical Happier theme into the public plugin theme snapshot.
 *
 * Total by construction: every field reads a typed path off `Theme` or a
 * canonical typography/weight primitive, so there is no unresolved-token branch
 * and no fallback palette.
 */
export function projectPluginUiTheme(theme: Theme): PluginUiThemeV1 {
    const title = Typography.rowTitle();
    const body = Typography.rowMeta();
    const label = Typography.pillLabel();
    const caption = Typography.timestamp();
    const code = Typography.keyHint();
    return Object.freeze({
        version: 1,
        colors: Object.freeze({
            canvas: theme.colors.background.canvas,
            surface: theme.colors.surface.base,
            elevatedSurface: theme.colors.surface.elevated,
            text: theme.colors.text.primary,
            secondaryText: theme.colors.text.secondary,
            mutedText: theme.colors.text.tertiary,
            border: theme.colors.border.surface,
            divider: theme.colors.border.default,
            focus: theme.colors.border.focus,
            accent: theme.colors.button.primary.background,
            onAccent: theme.colors.button.primary.tint,
            success: theme.colors.state.success.foreground,
            warning: theme.colors.state.warning.foreground,
            danger: theme.colors.state.danger.foreground,
            info: theme.colors.state.info.foreground,
            control: theme.colors.input.background,
            controlDisabled: theme.colors.button.primary.disabled,
            overlay: theme.colors.overlay.scrim,
        }),
        spacing: Object.freeze({
            xsmall: theme.margins.xs,
            small: theme.margins.sm,
            medium: theme.margins.md,
            large: theme.margins.lg,
            xlarge: theme.margins.xl,
        }),
        radii: Object.freeze({
            small: theme.borderRadius.sm,
            control: theme.borderRadius.md,
            panel: theme.borderRadius.xl,
            pill: PLUGIN_UI_PILL_RADIUS,
        }),
        typography: Object.freeze({
            body: Object.freeze({
                fontSize: readTextStyleMetric(body, 'fontSize'),
                lineHeight: readTextStyleMetric(body, 'lineHeight'),
                fontWeight: FontWeights.regular,
            }),
            label: Object.freeze({
                fontSize: readTextStyleMetric(label, 'fontSize'),
                lineHeight: readTextStyleMetric(label, 'lineHeight'),
                fontWeight: FontWeights.semiBold,
            }),
            title: Object.freeze({
                fontSize: readTextStyleMetric(title, 'fontSize'),
                lineHeight: readTextStyleMetric(title, 'lineHeight'),
                fontWeight: FontWeights.semiBold,
            }),
            caption: Object.freeze({
                fontSize: readTextStyleMetric(caption, 'fontSize'),
                lineHeight: readTextStyleMetric(caption, 'lineHeight'),
                fontWeight: FontWeights.regular,
            }),
            code: Object.freeze({
                fontSize: readTextStyleMetric(code, 'fontSize'),
                lineHeight: readTextStyleMetric(code, 'lineHeight'),
                fontFamily: getMonoFont(),
            }),
        }),
    });
}
