import { HAPPIER_DEFAULT_SURFACE_COLORS, HAPPIER_RADIUS_V1, HAPPIER_SPACE_STEPS, type HappierUiTheme, type HappierUiTypography } from '@happier-dev/plugin-ui/environment';
import { resolveHappierTypeScale, HAPPIER_TYPE_WEIGHT } from '@happier-dev/plugin-ui/presentation/typeScale';
import type { PublicProfileAssetPalette } from './publicProfileSvg';

export const PUBLIC_PROFILE_FONT_FAMILY = 'Inter, "Noto Sans Arabic", "Noto Sans CJK SC", "Noto Emoji"';
function typeRole(name: Parameters<typeof resolveHappierTypeScale>[0]) {
    const value = resolveHappierTypeScale(name, 'web');
    return { fontSize: value.fontSize, lineHeight: value.lineHeight, fontWeight: HAPPIER_TYPE_WEIGHT[value.weight],
        letterSpacing: value.letterSpacing, fontFamily: PUBLIC_PROFILE_FONT_FAMILY };
}
export const PUBLIC_PROFILE_TYPOGRAPHY: HappierUiTypography = {
    display: typeRole('display'), title: typeRole('title'), heading: typeRole('heading'), label: typeRole('label'),
    reading: typeRole('reading'), body: typeRole('body'), meta: typeRole('meta'), micro: typeRole('micro'),
    weights: { regular: { fontFamily: PUBLIC_PROFILE_FONT_FAMILY, fontWeight: '400' },
        medium: { fontFamily: PUBLIC_PROFILE_FONT_FAMILY, fontWeight: '500' },
        semiBold: { fontFamily: PUBLIC_PROFILE_FONT_FAMILY, fontWeight: '600' },
        bold: { fontFamily: PUBLIC_PROFILE_FONT_FAMILY, fontWeight: '600' } },
};

/** Anonymous pages use the app's default surface ink and shared type/space/radius owners. */
export function createPublicProfileTheme(scheme: 'light' | 'dark'): HappierUiTheme {
    const ink = HAPPIER_DEFAULT_SURFACE_COLORS[scheme];
    return {
        version: 1,
        colors: { canvas: ink.background, surface: ink.background, elevatedSurface: ink.background,
            text: ink.foreground, secondaryText: ink.secondary, mutedText: ink.secondary, border: ink.border,
            divider: ink.border, focus: ink.foreground, accent: ink.link, onAccent: ink.background,
            success: ink.foreground, warning: ink.foreground, attention: ink.foreground, danger: ink.foreground,
            info: ink.foreground, control: ink.elevated, controlDisabled: ink.background, overlay: ink.background },
        spacing: { xsmall: HAPPIER_SPACE_STEPS.s4, small: HAPPIER_SPACE_STEPS.s8, medium: HAPPIER_SPACE_STEPS.s12,
            large: HAPPIER_SPACE_STEPS.s16, xlarge: HAPPIER_SPACE_STEPS.s20 },
        radii: { small: HAPPIER_RADIUS_V1.sm, control: HAPPIER_RADIUS_V1.md, panel: HAPPIER_RADIUS_V1.xl, pill: HAPPIER_RADIUS_V1.xxl },
        typography: { body: typeRole('body'), reading: typeRole('reading'), label: typeRole('label'), title: typeRole('title'),
            caption: typeRole('meta'), code: { ...typeRole('body'), fontFamily: 'monospace' } },
    };
}

function assetPalette(scheme: 'light' | 'dark'): PublicProfileAssetPalette {
    const ink = HAPPIER_DEFAULT_SURFACE_COLORS[scheme];
    const channel = (offset: number) => Number.parseInt(ink.background.slice(offset, offset + 2), 16);
    return { ...ink, backgroundRgb: [channel(1), channel(3), channel(5)] };
}
export const PUBLIC_PROFILE_PALETTES = { light: assetPalette('light'), dark: assetPalette('dark') } as const;
