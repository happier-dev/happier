import { registerCustomTheme } from '@pierre/diffs';
import { getHappierTextMateThemeRegistration, HAPPIER_TEXTMATE_THEME_IDS } from '@/components/ui/code/highlighting/shiki/happierTextMateTheme';

let registered = false;

export const HAPPIER_PIERRE_THEME_IDS = Object.freeze({
    light: HAPPIER_TEXTMATE_THEME_IDS.light,
    dark: HAPPIER_TEXTMATE_THEME_IDS.dark,
} as const);

export function ensureHappierPierreThemesRegistered(): void {
    if (registered) return;
    registered = true;

    registerCustomTheme(HAPPIER_PIERRE_THEME_IDS.light, async () => (
        getHappierTextMateThemeRegistration({ isDark: false })
    ));

    registerCustomTheme(HAPPIER_PIERRE_THEME_IDS.dark, async () => (
        getHappierTextMateThemeRegistration({ isDark: true })
    ));
}
