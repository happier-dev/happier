import type { SupportedLanguage } from './_all';
import type { LocaleBundle } from './localeBundlesSync';
import { en } from './translations/en';
import { BUNDLED_PLUGIN_TRANSLATIONS as englishPlugins } from './bundledPluginTranslations/en.generated';

// Match the native loader's import basename so Metro selects this demand loader
// on web. English stays synchronous; other payloads are requested at readiness.
const bundles = new Map<SupportedLanguage, LocaleBundle>([['en', { host: en, plugins: englishPlugins }]]);
const pending = new Map<SupportedLanguage, Promise<void>>();
const load = {
    en: async () => bundles.get('en')!,
    ca: async () => { const [host, plugins] = await Promise.all([import('./translations/ca'), import('./bundledPluginTranslations/ca.generated')]); return { host: host.ca, plugins: plugins.BUNDLED_PLUGIN_TRANSLATIONS }; },
    de: async () => { const [host, plugins] = await Promise.all([import('./translations/de'), import('./bundledPluginTranslations/de.generated')]); return { host: host.de, plugins: plugins.BUNDLED_PLUGIN_TRANSLATIONS }; },
    es: async () => { const [host, plugins] = await Promise.all([import('./translations/es'), import('./bundledPluginTranslations/es.generated')]); return { host: host.es, plugins: plugins.BUNDLED_PLUGIN_TRANSLATIONS }; },
    fr: async () => { const [host, plugins] = await Promise.all([import('./translations/fr'), import('./bundledPluginTranslations/fr.generated')]); return { host: host.fr, plugins: plugins.BUNDLED_PLUGIN_TRANSLATIONS }; },
    it: async () => { const [host, plugins] = await Promise.all([import('./translations/it'), import('./bundledPluginTranslations/it.generated')]); return { host: host.it, plugins: plugins.BUNDLED_PLUGIN_TRANSLATIONS }; },
    ja: async () => { const [host, plugins] = await Promise.all([import('./translations/ja'), import('./bundledPluginTranslations/ja.generated')]); return { host: host.ja, plugins: plugins.BUNDLED_PLUGIN_TRANSLATIONS }; },
    pl: async () => { const [host, plugins] = await Promise.all([import('./translations/pl'), import('./bundledPluginTranslations/pl.generated')]); return { host: host.pl, plugins: plugins.BUNDLED_PLUGIN_TRANSLATIONS }; },
    pt: async () => { const [host, plugins] = await Promise.all([import('./translations/pt'), import('./bundledPluginTranslations/pt.generated')]); return { host: host.pt, plugins: plugins.BUNDLED_PLUGIN_TRANSLATIONS }; },
    ru: async () => { const [host, plugins] = await Promise.all([import('./translations/ru'), import('./bundledPluginTranslations/ru.generated')]); return { host: host.ru, plugins: plugins.BUNDLED_PLUGIN_TRANSLATIONS }; },
    'zh-Hans': async () => { const [host, plugins] = await Promise.all([import('./translations/zh-Hans'), import('./bundledPluginTranslations/zh-Hans.generated')]); return { host: host.zhHans, plugins: plugins.BUNDLED_PLUGIN_TRANSLATIONS }; },
    'zh-Hant': async () => { const [base, host, plugins] = await Promise.all([import('./translations/zh-Hans'), import('./translations/zh-HantOverrides'), import('./bundledPluginTranslations/zh-Hant.generated')]); return { host: host.createZhHant(base.zhHans), plugins: plugins.BUNDLED_PLUGIN_TRANSLATIONS }; },
} satisfies Record<SupportedLanguage, () => Promise<LocaleBundle>>;

export function readLocaleBundle(language: SupportedLanguage): LocaleBundle | undefined {
    return bundles.get(language);
}

export function preloadLocaleBundle(language: SupportedLanguage): Promise<void> {
    if (bundles.has(language)) return Promise.resolve();
    const existing = pending.get(language);
    if (existing) return existing;
    const operation = load[language]().then((bundle) => { bundles.set(language, bundle); }).finally(() => { pending.delete(language); });
    pending.set(language, operation);
    return operation;
}
