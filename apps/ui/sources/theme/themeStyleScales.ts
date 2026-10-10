import { deriveHappierRadiusScale, HAPPIER_RADIUS_BASE_PX } from '@happier-dev/plugin-ui/environment';
import { Platform } from 'react-native';

/**
 * The style scales every theme carries: radii, spacing, per-part finish, transcript rhythm and font
 * families. Device finish settings and the embed's `EmbedStyleV1` enter this one resolver through
 * `applyThemeRuntimeSelection`'s `style`; absent part choices inherit the global finish.
 */

export type ThemeRadiusScaleName = 'sharp' | 'soft' | 'round';
export type ThemeDensityName = 'compact' | 'comfortable';
export type ThemeRadiusStep = 'sm' | 'md' | 'lg' | 'xl' | 'xxl' | 'modalCard';
export type ThemeSurfaceFinish = 'flat' | 'soft';
export type ThemePartName = 'userBubble' | 'composer' | 'toolCard' | 'approvalCard' | 'codeBlock' | 'card' | 'floating' | 'primaryButton' | 'secondaryButton';
export const THEME_SURFACE_FINISH_ROLES = ['card', 'floating', 'composer', 'primaryButton', 'secondaryButton'] as const satisfies readonly ThemePartName[];
export type ThemeSurfaceFinishRole = typeof THEME_SURFACE_FINISH_ROLES[number];
export type ThemeSurfaceFinishOverrides = Readonly<Partial<Record<ThemeSurfaceFinishRole, ThemeSurfaceFinish>>>;

type RadiusScale = Readonly<Record<ThemeRadiusStep, number>>;

/**
 * Every scale is one base with the shared derived steps (`@happier-dev/plugin-ui/environment` → `radius.ts`;
 * DESIGN.md → "Radii derive from one base"): sm small marks · md controls and rows · lg menus · xl cards
 * and sheets · xxl dialogs. A modal card is a dialog.
 */
function radiusScaleFromBase(basePx: number): RadiusScale {
    const steps = deriveHappierRadiusScale(basePx);
    return { ...steps, modalCard: steps.xxl };
}

const RADIUS_SCALES: Readonly<Record<ThemeRadiusScaleName, RadiusScale>> = {
    sharp: radiusScaleFromBase(5),
    // Happier's own base: sm 6 · md 8 · lg 10 · xl 14 · xxl 18.
    soft: radiusScaleFromBase(HAPPIER_RADIUS_BASE_PX),
    round: radiusScaleFromBase(14),
};

/** The step each part takes from the active radius scale unless the style picks another. */
const PART_RADIUS_STEPS: Readonly<Record<ThemePartName, ThemeRadiusStep>> = {
    userBubble: 'xl',
    composer: 'xl',
    toolCard: 'md',
    approvalCard: 'xl',
    codeBlock: 'lg',
    card: 'xl',
    floating: 'lg',
    primaryButton: 'md',
    secondaryButton: 'md',
};

/** Android draws the composer stack 4 px rounder than its step. */
const ANDROID_COMPOSER_RADIUS_EXTRA = Platform.OS === 'android' ? 4 : 0;

type Margins = Readonly<{ xs: number; sm: number; md: number; lg: number; xl: number; xxl: number }>;

const DENSITY_SCALES: Readonly<Record<ThemeDensityName, Readonly<{ margins: Margins; transcript: Readonly<{ messageGap: number }> }>>> = {
    // Today's spacing and the transcript's 22 px between messages.
    comfortable: { margins: { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24 }, transcript: { messageGap: 22 } },
    compact: { margins: { xs: 3, sm: 6, md: 10, lg: 12, xl: 16, xxl: 20 }, transcript: { messageGap: 14 } },
};

export type ThemeStyleSelection = Readonly<{
    radius?: ThemeRadiusScaleName;
    density?: ThemeDensityName;
    finish?: ThemeSurfaceFinish;
    parts?: Readonly<Partial<Record<ThemePartName, Readonly<{ radius?: ThemeRadiusStep; finish?: ThemeSurfaceFinish }>>>>;
    /** A font family name; `null`/absent keeps the Happier family. */
    fontFamily?: string | null;
    monoFontFamily?: string | null;
}>;

export type ThemeStyleScales = Readonly<{
    borderRadius: RadiusScale;
    margins: Margins;
    finish: ThemeSurfaceFinish;
    parts: Readonly<Record<ThemePartName, Readonly<{ radius: number; finish: ThemeSurfaceFinish }>>>;
    transcript: Readonly<{ messageGap: number }>;
    typography: Readonly<{ fontFamily: string | null; monoFontFamily: string | null }>;
}>;

const PART_NAMES = Object.keys(PART_RADIUS_STEPS) as ThemePartName[];

function normalizeFamily(value: string | null | undefined): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveThemeStyleScales(selection: ThemeStyleSelection | null = null): ThemeStyleScales {
    const borderRadius = RADIUS_SCALES[selection?.radius ?? 'soft'];
    const density = DENSITY_SCALES[selection?.density ?? 'comfortable'];
    const finish = selection?.finish ?? 'soft';
    const parts = Object.fromEntries(PART_NAMES.map((part) => {
        const step = selection?.parts?.[part]?.radius ?? PART_RADIUS_STEPS[part];
        const extra = part === 'composer' ? ANDROID_COMPOSER_RADIUS_EXTRA : 0;
        return [part, { radius: borderRadius[step] + extra, finish: selection?.parts?.[part]?.finish ?? finish }];
    })) as Record<ThemePartName, { radius: number; finish: ThemeSurfaceFinish }>;

    return {
        borderRadius,
        margins: density.margins,
        finish,
        parts,
        transcript: density.transcript,
        typography: {
            fontFamily: normalizeFamily(selection?.fontFamily),
            monoFontFamily: normalizeFamily(selection?.monoFontFamily),
        },
    };
}

export const DEFAULT_THEME_STYLE_SCALES = resolveThemeStyleScales();

/** Device selection enters the same part resolver as embed styles; absent role values inherit. */
export function themeStyleSelectionFromSurfaceFinish(settings: Readonly<{
    uiSurfaceFinish?: ThemeSurfaceFinish;
    uiSurfaceFinishOverrides?: ThemeSurfaceFinishOverrides;
}>): ThemeStyleSelection {
    return {
        finish: settings.uiSurfaceFinish ?? 'soft',
        parts: Object.fromEntries(THEME_SURFACE_FINISH_ROLES.flatMap(role => {
            const finish = settings.uiSurfaceFinishOverrides?.[role];
            return finish ? [[role, { finish }]] : [];
        })),
    };
}

function readScales(theme: ThemeStyleScales): ThemeStyleScales {
    return {
        borderRadius: theme.borderRadius,
        margins: theme.margins,
        finish: theme.finish,
        parts: theme.parts,
        transcript: theme.transcript,
        typography: theme.typography,
    };
}

/**
 * Returns the theme with these scales; colours and every other field are kept by reference. A theme
 * that already carries equal scales is returned as is, so the full app's themes keep their identity.
 */
export function applyThemeStyleScales<T extends ThemeStyleScales>(theme: T, scales: ThemeStyleScales): T {
    if (JSON.stringify(readScales(theme)) === JSON.stringify(readScales(scales))) return theme;
    return {
        ...theme,
        borderRadius: scales.borderRadius,
        margins: scales.margins,
        finish: scales.finish,
        parts: scales.parts,
        transcript: scales.transcript,
        typography: scales.typography,
    };
}
