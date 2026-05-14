import type { ThemeRegistration } from 'shiki';

import { lightTheme, darkTheme } from '@/theme';
import { buildHappierShikiTheme } from '@/components/ui/code/highlighting/shiki/buildHappierShikiTheme';
import { buildHappierShikiThemeKey } from '@/components/ui/code/highlighting/shiki/happierThemeKey';

type HappierThemeLike = typeof lightTheme;
type HappierThemeColorsLike = HappierThemeLike['colors'] | Record<string, unknown>;

export const HAPPIER_TEXTMATE_THEME_IDS = Object.freeze({
    light: 'happier-light',
    dark: 'happier-dark',
} as const);

const themeCache = new Map<string, ThemeRegistration>();
const THEME_REGISTRATION_CACHE_CAP = 8;

function touchCachedRegistration(id: string, registration: ThemeRegistration): ThemeRegistration {
    if (themeCache.has(id)) themeCache.delete(id);
    themeCache.set(id, registration);
    while (themeCache.size > THEME_REGISTRATION_CACHE_CAP) {
        const oldest = themeCache.keys().next().value as string | undefined;
        if (!oldest) break;
        themeCache.delete(oldest);
    }
    return registration;
}

export function resolveHappierTextMateThemeId(params: Readonly<{ isDark: boolean; colors?: HappierThemeColorsLike | null }>): string {
    const type = params.isDark ? 'dark' : 'light';
    if (!params.colors) return params.isDark ? HAPPIER_TEXTMATE_THEME_IDS.dark : HAPPIER_TEXTMATE_THEME_IDS.light;
    return buildHappierShikiThemeKey({ type, colors: params.colors as Record<string, unknown> });
}

export function getHappierTextMateThemeRegistration(params: Readonly<{ isDark: boolean; colors?: HappierThemeColorsLike | null }>): ThemeRegistration {
    const id = resolveHappierTextMateThemeId(params);
    const cached = themeCache.get(id);
    if (cached) return touchCachedRegistration(id, cached);

    const theme = params.isDark ? darkTheme : lightTheme;
    const registration = buildHappierShikiTheme({
        id,
        type: params.isDark ? 'dark' : 'light',
        colors: (params.colors ?? theme.colors) as Record<string, unknown>,
    });
    return touchCachedRegistration(id, registration);
}

export function clearHappierTextMateThemeRegistrationCacheForKey(key: string): void {
    themeCache.delete(key);
}
