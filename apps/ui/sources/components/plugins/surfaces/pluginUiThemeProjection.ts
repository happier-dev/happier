import * as React from 'react';
import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';
import type {
    HappierFontFace,
    HappierTypeRole,
    HappierTypeRoleStyle,
    HappierUiPalette,
    HappierUiTypography,
} from '@happier-dev/plugin-ui/environment';
import type { TextStyle } from 'react-native';

import { HAPPIER_TYPE_SCALE, HAPPIER_TYPE_WEIGHT } from '@happier-dev/plugin-ui/presentation';
import { getMonoFont, Typography } from '@/constants/Typography';
import { resolveBundledTypefaceFace } from '@/constants/bundledFonts';
import { DEFAULT_THEME_STYLE_SCALES } from '@/theme/themeStyleScales';
import { resolveThemeCardEdge, resolveThemeControlEdge, resolveThemeGloss, resolveThemeSurfaceFinish } from '@/components/ui/surfaces/themeRaisedEdge';
import { useGlassBackedInk } from '@/components/ui/glass/glassBackedInk';
import { resolveAttentionStateColors } from '@/components/ui/status/StatusPill';
import { shadowLevelStyle } from '@/shadowElevation';
import type { Theme } from '@/theme';
import type { ThemeColorTokenId } from '@/theme/tokens/themeColorTokenDefinitions';
import { getThemeStylesheetCss, subscribeThemeStylesheet } from '@/theme/css/themeStylesheet';

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
 * theme. `blue` and `purple` are the exceptions to the editable-token map: they project the
 * theme's named-hue palette (`accent.blue`/`accent.purple`, the hues a session's colour presets
 * use), which is internal rather than editable, so a label a person colours Blue or Purple
 * reads as that hue in every profile. No palette is authored here: this file contains no colour literal, and
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
    // Charts and meters share Usage's signature accent, so a plugin's unnamed series and Usage read as one palette.
    dataAccent: 'text.link',
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
} as const satisfies Readonly<Record<Exclude<keyof PluginUiThemeV1['colors'], 'blue' | 'purple'>, ThemeColorTokenId>>);

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
 * Project one role table through the font owner. Public snapshot keys stay
 * stable: title takes heading, caption takes micro; body, reading and label
 * take their same-named roles. Same-realm facts expose all eight roles.
 */
function projectTypeRoleMetric(role: HappierTypeRole, family: string | null) {
    const style = Typography.variant(role);
    return Object.freeze({
        fontSize: readTextStyleMetric(style, 'fontSize'),
        lineHeight: readTextStyleMetric(style, 'lineHeight'),
        fontWeight: HAPPIER_TYPE_WEIGHT[HAPPIER_TYPE_SCALE[role].weight],
        ...(family ? { fontFamily: resolveBundledTypefaceFace(family, HAPPIER_TYPE_SCALE[role].weight) ?? family } : {}),
    });
}

function projectTypeRoleStyle(role: HappierTypeRole, themeFamily: string | null): HappierTypeRoleStyle {
    const style: TextStyle = Typography.variant(role, undefined, themeFamily);
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

const hostTypography = new WeakMap<Theme['typography'], HappierUiTypography>();

/**
 * The same-realm host fact: the real role styles (family, tracking, tabular
 * figures and the heading step) every shared plugin text owner renders with
 * when a plugin surface is mounted inside the app. The current theme's typography
 * owns the family; equal reads retain the published provider value.
 */
export function readPluginUiHostTypography(theme?: Pick<Theme, 'typography'>): HappierUiTypography {
    const typography = theme?.typography ?? DEFAULT_THEME_STYLE_SCALES.typography;
    const cached = hostTypography.get(typography);
    if (cached) return cached;
    const family = typography.fontFamily;
    const projected = Object.freeze({
        display: projectTypeRoleStyle('display', family),
        title: projectTypeRoleStyle('title', family),
        heading: projectTypeRoleStyle('heading', family),
        label: projectTypeRoleStyle('label', family),
        body: projectTypeRoleStyle('body', family),
        reading: projectTypeRoleStyle('reading', family),
        meta: projectTypeRoleStyle('meta', family),
        micro: projectTypeRoleStyle('micro', family),
        // The face per weight of the configuration-page anatomy (`HAPPIER_PAGE_TEXT`).
        weights: Object.freeze({
            regular: projectFontFace(Typography.default('regular', family)),
            medium: projectFontFace(Typography.default('medium', family)),
            semiBold: projectFontFace(Typography.default('semiBold', family)),
            bold: projectFontFace(Typography.default('bold', family)),
        }),
        mono: projectFontFace(Typography.mono('regular')),
    });
    hostTypography.set(typography, projected);
    return projected;
}

/**
 * The plugin UI theme a render draws with: the current theme's projection, on the material it is drawn on. Plugin UI
 * reads its faint inks from this snapshot rather than through core `Text`, so on glass with a picture behind it (a Home
 * widget card: a table's column headers, a metric's caption, a snapshot's meta) the snapshot carries the containing
 * material's stronger faint ink (DESIGN.md → Materials), the same step core text takes there. Elsewhere it is the
 * projection itself. Render code takes its plugin theme here; `projectPluginUiTheme` is the pure projection.
 */
export function usePluginUiTheme(theme: Theme, spinner?: PluginUiThemeV1['spinner']): PluginUiThemeV1 {
    const sanitizedCss = React.useSyncExternalStore(subscribeThemeStylesheet, getThemeStylesheetCss, getThemeStylesheetCss);
    // Unistyles replaces its outer Proxy each render, not the resolved fields. Read those fields
    // here (also registering the theme dependency) rather than invalidating on the wrapper.
    const projected = React.useMemo(() => projectPluginUiTheme(theme, spinner, sanitizedCss), [
        theme.colors, theme.dark, theme.space, theme.borderRadius, theme.finish, theme.parts, theme.typography, theme.surfaces, spinner, sanitizedCss,
    ]);
    const faintInk = useGlassBackedInk();
    return React.useMemo(() => {
        const secondaryText = faintInk(projected.colors.secondaryText) ?? projected.colors.secondaryText;
        const mutedText = faintInk(projected.colors.mutedText) ?? projected.colors.mutedText;
        return secondaryText === projected.colors.secondaryText && mutedText === projected.colors.mutedText
            ? projected
            : Object.freeze({ ...projected, colors: Object.freeze({ ...projected.colors, secondaryText, mutedText }) });
    }, [faintInk, projected]);
}

/**
 * Project the canonical Happier theme into the public plugin theme snapshot.
 *
 * Total by construction: every field reads a typed path off `Theme` or a
 * canonical typography/weight primitive, so there is no unresolved-token branch
 * and no fallback palette.
 */
export function projectPluginUiTheme(theme: Theme, spinner?: PluginUiThemeV1['spinner'], sanitizedCss: string | null = null): PluginUiThemeV1 {
    const code = ({ ...Typography.variant('micro', 'regular'), ...Typography.mono(), ...Typography.tabular() });
    const surfaceFinish: NonNullable<PluginUiThemeV1['surfaceFinish']> = {};
    for (const role of ['card', 'floating', 'composer', 'primaryButton', 'secondaryButton'] as const) {
        const gradient = resolveThemeSurfaceFinish(theme, role);
        if (!gradient) {
            surfaceFinish[role] = null;
            continue;
        }
        // Own every nested value before freezing: the app theme remains mutable
        // independently of the immutable snapshot shared with plugin renderers.
        const finish: NonNullable<(typeof surfaceFinish)[typeof role]> = {
            colors: [...gradient.colors],
            ...(gradient.locations ? { locations: [...gradient.locations] } : {}),
            ...(gradient.start ? { start: { ...gradient.start } } : {}),
            ...(gradient.end ? { end: { ...gradient.end } } : {}),
            ...(gradient.band ? { band: { ...gradient.band } } : {}),
        };
        Object.freeze(finish.colors);
        if (finish.locations) Object.freeze(finish.locations);
        if (finish.start) Object.freeze(finish.start);
        if (finish.end) Object.freeze(finish.end);
        if (finish.band) Object.freeze(finish.band);
        surfaceFinish[role] = Object.freeze(finish);
    }
    Object.freeze(surfaceFinish);
    return Object.freeze({
        version: 1,
        ...(sanitizedCss === null ? {} : { sanitizedCss }),
        ...(theme.surfaces ? { surfaces: theme.surfaces } : {}),
        ...(spinner ? { spinner: Object.freeze({ ...spinner }) } : {}),
        surfaceFinish,
        statusText: Object.freeze({
            success: theme.colors.state.success.textForeground,
            warning: theme.colors.state.warning.textForeground,
            attention: theme.colors.state.attention.textForeground,
            danger: theme.colors.state.danger.textForeground,
            info: theme.colors.state.info.textForeground,
            neutral: theme.colors.state.neutral.textForeground,
        }),
        statusTint: Object.freeze({
            success: theme.colors.state.success.background,
            warning: theme.colors.state.warning.background,
            attention: resolveAttentionStateColors(theme.colors.state).background,
            danger: theme.colors.state.danger.background,
            info: theme.colors.state.info.background,
            neutral: theme.colors.state.neutral.background,
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
            dataAccent: theme.colors.text.link,
            blue: theme.colors.accent.blue,
            purple: theme.colors.accent.purple,
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
            xsmall: theme.space.s4,
            small: theme.space.s8,
            medium: theme.space.s12,
            large: theme.space.s16,
            xlarge: theme.space.s20,
        }),
        radii: Object.freeze({
            small: theme.borderRadius.sm,
            control: theme.borderRadius.md,
            panel: theme.borderRadius.xl,
            pill: PLUGIN_UI_PILL_RADIUS,
        }),
        typography: Object.freeze({
            body: projectTypeRoleMetric('body', theme.typography.fontFamily),
            reading: projectTypeRoleMetric('reading', theme.typography.fontFamily),
            label: projectTypeRoleMetric('label', theme.typography.fontFamily),
            title: projectTypeRoleMetric('heading', theme.typography.fontFamily),
            caption: projectTypeRoleMetric('micro', theme.typography.fontFamily),
            code: Object.freeze({
                fontSize: readTextStyleMetric(code, 'fontSize'),
                lineHeight: readTextStyleMetric(code, 'lineHeight'),
                fontFamily: theme.typography.monoFontFamily ?? getMonoFont(),
            }),
        }),
    });
}

/** Retain a mount's palette across Unistyles Proxy replacement; independent scoped themes never evict each other. */
export function usePluginUiHostPalette(theme: Theme): HappierUiPalette {
    const { colors, dark } = theme;
    const searchFieldRadiusPx = theme.borderRadius.lg;
    return React.useMemo(() => projectPluginUiHostPalette({ colors, dark, borderRadius: { lg: searchFieldRadiusPx } }),
        [colors, dark, searchFieldRadiusPx]);
}

/**
 * The same-realm host fact for configuration-page anatomy: the exact colour
 * roles Happier's own pages draw sheets, row seams, field boxes, switches,
 * segmented choices and tiles with, so a mounted plugin page renders in the
 * app's colours rather than the snapshot's nearest roles. Theme-dependent,
 * projected from the resolved colour graph and the geometry/mode it consumes.
 */
export function projectPluginUiHostPalette(theme: Pick<Theme, 'colors' | 'dark'> & Readonly<{ borderRadius: Pick<Theme['borderRadius'], 'lg'> }>): HappierUiPalette {
    const colors = theme.colors;
    const palette: HappierUiPalette = Object.freeze({
        page: colors.surface.base,
        // A page sheet is the app's in-flow card (W3 on light): its fill, and its lip and grounding below.
        sheet: colors.edge.cardFill,
        sheetBorder: colors.border.default,
        sheetEdge: resolveThemeCardEdge(theme) ?? undefined,
        rowDivider: colors.border.subtle,
        listRowRule: colors.border.divider,
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
        // Menus and a field's choices stand on the menu step core's FloatingOverlay draws.
        menuLift: shadowLevelStyle(colors.shadowLevels[2]),
        // A navigation column's rows on the shell plane: the same chip and hover core rows draw
        // (`HAPPIER_COLLECTION_LIST_ROW_STYLE` over `Item`).
        navigationSelected: colors.surface.elevated,
        navigationHover: colors.surface.hover,
        // The page-tab selection core's plain SegmentedTabBar draws (`surface.selected`).
        pageTabSelected: colors.surface.selected,
        inset: colors.surface.inset,
        skeleton: colors.surface.skeleton,
        versionControlAdded: colors.versionControl.added.foreground,
        versionControlRemoved: colors.versionControl.removed.foreground,
        // Find's marks, the same roles core's FindHighlightedText draws (`theme.colors.find`).
        findMatch: colors.find.matchAll,
        findMatchCurrent: colors.find.matchCurrent,
        findMatchCurrentForeground: colors.find.matchCurrentForeground,
        searchFieldRadiusPx: theme.borderRadius.lg,
        searchFieldEdge: resolveThemeControlEdge(theme, 'default') ?? undefined,
    });
    return palette;
}
