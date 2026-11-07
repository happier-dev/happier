import type { SupportedLanguage } from './_all';
import { loadLocaleBundle } from './localeBundleLoaders';
import { en } from './translations/en';
import { BUNDLED_PLUGIN_TRANSLATIONS as englishPlugins } from './bundledPluginTranslations/en.generated';

export type LocaleBundle = Readonly<{
    host: Record<string, unknown>;
    plugins: Readonly<Record<string, string | undefined>>;
}>;

// Platform adapters supply bytes; this owner retains locale choice, caching and retries.
// Native selects the synchronous .native.ts adapter.
const bundles = new Map<SupportedLanguage, LocaleBundle>([['en', { host: en, plugins: englishPlugins }]]);
const pending = new Map<SupportedLanguage, Promise<void>>();
export function readLocaleBundle(language: SupportedLanguage): LocaleBundle | undefined {
    return bundles.get(language);
}

export function preloadLocaleBundle(language: SupportedLanguage): Promise<void> {
    if (language === 'en' || bundles.has(language)) return Promise.resolve();
    const existing = pending.get(language);
    if (existing) return existing;
    const operation = loadLocaleBundle(language).then((bundle) => { bundles.set(language, bundle); }).finally(() => { pending.delete(language); });
    pending.set(language, operation);
    return operation;
}
