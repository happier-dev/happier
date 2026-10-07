import type { SupportedLanguage } from './_all';
import { ca } from './translations/ca';
import { de } from './translations/de';
import { en } from './translations/en';
import { es } from './translations/es';
import { fr } from './translations/fr';
import { it } from './translations/it';
import { ja } from './translations/ja';
import { pl } from './translations/pl';
import { pt } from './translations/pt';
import { ru } from './translations/ru';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';
import { BUNDLED_PLUGIN_TRANSLATIONS } from './bundledPluginTranslations.generated';

export type LocaleBundle = Readonly<{
    host: Record<string, unknown>;
    plugins: Readonly<Record<string, string | undefined>>;
}>;

// Native retains synchronous locale lookup. Metro inlineRequires evaluates only requested trees.
const hostBundles = {
    en: () => en, ca: () => ca, de: () => de, es: () => es, fr: () => fr, it: () => it,
    ja: () => ja, pl: () => pl, pt: () => pt, ru: () => ru,
    'zh-Hans': () => zhHans, 'zh-Hant': () => zhHant,
} satisfies Record<SupportedLanguage, () => Record<string, unknown>>;

export function readLocaleBundle(language: SupportedLanguage): LocaleBundle | undefined {
    return { host: hostBundles[language](), plugins: BUNDLED_PLUGIN_TRANSLATIONS[language] ?? {} };
}

export async function preloadLocaleBundle(language: SupportedLanguage): Promise<void> {
    readLocaleBundle(language);
}
