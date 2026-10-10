import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';
import type {
    HappierFontFace,
    HappierTypeRole,
    HappierTypeRoleStyle,
    HappierUiPalette,
    HappierUiTypography,
} from '@happier-dev/plugin-ui/environment';
import type { TextStyle } from 'react-native';

import { pageTitleTypography } from '@/components/ui/layout/pageTitleTypography';
import { ITEM_TITLE_TEXT_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { FontWeights, getMonoFont, Typography } from '@/constants/Typography';
import { resolveThemeControlEdge, resolveThemeGloss, resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';
import { shadowLevelStyle } from '@/shadowElevation';
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
    // "Needs you": Brand's attention amber (the host's one attention owner), never the system warning.
    attention: 'state.attention.foreground',
    danger: 'state.danger.foreground',
    info: 'state.info.foreground',
    // Chips, secondary buttons, pickers and field wells. The raised surface,
    // as the host's own raised controls use: `input.background` is an inset
    // well that in the dark theme sits a hair below the page and left every
    // plugin control nearly invisible there.
    control: 'surface.elevated',
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
 * The ONE mapping from plugin type roles to the host's own typography owners.
 *
 * Both projections below read it, so the public snapshot's metrics and the
 * same-realm role styles can never disagree on size:
 *
 * - `heading` — the page title step (`PageHeader`), for a plugin page heading;
 * - `title` — the host's primary item title, for pane and section headings;
 * - `label` — the host row title, for row titles, buttons and tabs;
 * - `body` — the host row meta line, for secondary lines;
 * - `reading` — the host reading prose step, for a detail's prose and a story step's body;
 * - `caption` — the host timestamp role (tabular), for quiet metadata.
 *
 * Each is a descending step, so a heading always reads above a row title and a
 * row title always reads above its own context line.
 */
const PLUGIN_UI_TYPE_ROLES: Readonly<Record<HappierTypeRole, Readonly<{
    style: () => TextStyle;
    fontWeight: string;
}>>> = Object.freeze({
    heading: { style: () => pageTitleTypography(), fontWeight: FontWeights.bold },
    title: {
        style: () => ({ ...Typography.default('semiBold'), ...ITEM_TITLE_TEXT_METRICS.comfortable }),
        fontWeight: FontWeights.semiBold,
    },
    label: { style: () => Typography.rowTitle(), fontWeight: FontWeights.semiBold },
    body: { style: () => Typography.rowMeta(), fontWeight: FontWeights.regular },
    reading: { style: () => Typography.reading(), fontWeight: FontWeights.regular },
    caption: { style: () => Typography.timestamp(), fontWeight: FontWeights.regular },
});

function projectTypeRoleMetric(role: HappierTypeRole) {
    const style = PLUGIN_UI_TYPE_ROLES[role].style();
    return Object.freeze({
        fontSize: readTextStyleMetric(style, 'fontSize'),
        lineHeight: readTextStyleMetric(style, 'lineHeight'),
        fontWeight: PLUGIN_UI_TYPE_ROLES[role].fontWeight,
    });
}

function projectTypeRoleStyle(role: HappierTypeRole): HappierTypeRoleStyle {
    const style = PLUGIN_UI_TYPE_ROLES[role].style();
    return Object.freeze({
        fontSize: readTextStyleMetric(style, 'fontSize'),
        lineHeight: readTextStyleMetric(style, 'lineHeight'),
        // A family that encodes its weight (Inter-SemiBold) carries no
        // `fontWeight`; adding one would ask the browser to synthesize bold.
        ...(typeof style.fontWeight === 'string' ? { fontWeight: style.fontWeight } : {}),
        ...(typeof style.fontFamily === 'string' ? { fontFamily: style.fontFamily } : {}),
        ...(typeof style.letterSpacing === 'number' ? { letterSpacing: style.letterSpacing } : {}),
        ...(Array.isArray(style.fontVariant) && style.fontVariant.includes('tabular-nums')
            ? { fontVariant: ['tabular-nums'] as const }
            : {}),
    });
}

function projectFontFace(style: TextStyle): HappierFontFace {
    return Object.freeze({
        ...(typeof style.fontFamily === 'string' ? { fontFamily: style.fontFamily } : {}),
        ...(typeof style.fontWeight === 'string' ? { fontWeight: style.fontWeight } : {}),
    });
}

let hostTypography: HappierUiTypography | null = null;

/**
 * The same-realm host fact: the real role styles (family, tracking, tabular
 * figures and the heading step) every shared plugin text owner renders with
 * when a plugin surface is mounted inside the app. Platform-selected, not
 * theme-dependent, so it is computed once — on first use, never at import.
 */
export function readPluginUiHostTypography(): HappierUiTypography {
    hostTypography ??= Object.freeze({
        heading: projectTypeRoleStyle('heading'),
        title: projectTypeRoleStyle('title'),
        label: projectTypeRoleStyle('label'),
        body: projectTypeRoleStyle('body'),
        reading: projectTypeRoleStyle('reading'),
        caption: projectTypeRoleStyle('caption'),
        // The face per weight of the configuration-page anatomy (`HAPPIER_PAGE_TEXT`).
        weights: Object.freeze({
            regular: projectFontFace(Typography.default('regular')),
            medium: projectFontFace(Typography.default('medium')),
            semiBold: projectFontFace(Typography.default('semiBold')),
            bold: projectFontFace(Typography.default('bold')),
        }),
    });
    return hostTypography;
}

/**
 * Project the canonical Happier theme into the public plugin theme snapshot.
 *
 * Total by construction: every field reads a typed path off `Theme` or a
 * canonical typography/weight primitive, so there is no unresolved-token branch
 * and no fallback palette.
 */
export function projectPluginUiTheme(theme: Theme): PluginUiThemeV1 {
    const code = Typography.keyHint();
    return Object.freeze({
        version: 1,
        surfaceFinish: Object.fromEntries((['card', 'floating', 'composer', 'primaryButton', 'secondaryButton'] as const).map(role => {
            const gradient = resolveThemeSurfaceFinish(theme, role);
            return [role, gradient ? { ...gradient, colors: [...gradient.colors], ...(gradient.locations ? { locations: [...gradient.locations] } : {}) } : null];
        })) as PluginUiThemeV1['surfaceFinish'],
        statusText: Object.freeze({
            success: theme.colors.state.success.textForeground,
            warning: theme.colors.state.warning.textForeground,
            attention: theme.colors.state.attention.textForeground,
            danger: theme.colors.state.danger.textForeground,
            info: theme.colors.state.info.textForeground,
            neutral: theme.colors.state.neutral.textForeground,
        }),
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
            attention: theme.colors.state.attention.foreground,
            danger: theme.colors.state.danger.foreground,
            info: theme.colors.state.info.foreground,
            control: theme.colors.surface.elevated,
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
            body: projectTypeRoleMetric('body'),
            reading: projectTypeRoleMetric('reading'),
            label: projectTypeRoleMetric('label'),
            title: projectTypeRoleMetric('title'),
            caption: projectTypeRoleMetric('caption'),
            code: Object.freeze({
                fontSize: readTextStyleMetric(code, 'fontSize'),
                lineHeight: readTextStyleMetric(code, 'lineHeight'),
                fontFamily: getMonoFont(),
            }),
        }),
    });
}

const hostPalettes = new WeakMap<Theme, HappierUiPalette>();

/**
 * The same-realm host fact for configuration-page anatomy: the exact colour
 * roles Happier's own pages draw sheets, row seams, field boxes, switches,
 * segmented choices and tiles with, so a mounted plugin page renders in the
 * app's colours rather than the snapshot's nearest roles. Theme-dependent,
 * memoized per resolved theme object.
 */
export function projectPluginUiHostPalette(theme: Theme): HappierUiPalette {
    const existing = hostPalettes.get(theme);
    if (existing) return existing;
    const colors = theme.colors;
    const palette: HappierUiPalette = Object.freeze({
        page: colors.surface.base,
        sheet: colors.surface.sectionTint,
        sheetBorder: colors.border.default,
        rowDivider: colors.border.subtle,
        groupDivider: colors.border.faint,
        controlBorder: colors.border.strong,
        controlEdge: resolveThemeControlEdge(theme, 'strong') ?? undefined,
        fieldBackground: colors.edge.fill,
        placeholder: colors.input.placeholder,
        accentGloss: resolveThemeGloss(theme) ?? undefined,
        selection: colors.button.primary.background,
        switchTrackOn: colors.switch.track.active,
        switchTrackOff: colors.switch.track.inactive,
        switchThumb: colors.switch.thumb.active,
        segmentTrack: colors.segmentedControl.trackBackground,
        segmentThumb: colors.segmentedControl.activeBackground,
        segmentThumbLift: shadowLevelStyle(colors.shadowLevels[1]),
        // A navigation column's rows on the shell plane: the same chip and hover core rows draw
        // (`HAPPIER_COLLECTION_LIST_ROW_STYLE` over `Item`).
        navigationSelected: colors.surface.elevated,
        navigationHover: colors.surface.pressed,
        inset: colors.surface.inset,
        searchFieldRadiusPx: theme.borderRadius.lg,
        searchFieldEdge: resolveThemeControlEdge(theme, 'default') ?? undefined,
    });
    hostPalettes.set(theme, palette);
    return palette;
}
