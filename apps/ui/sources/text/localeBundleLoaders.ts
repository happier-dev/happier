import type { SupportedLanguage } from './_all';
import type { LocaleBundle } from './localeBundlesSync';

const load = {
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
} satisfies Record<Exclude<SupportedLanguage, 'en'>, () => Promise<LocaleBundle>>;

export function loadLocaleBundle(language: Exclude<SupportedLanguage, 'en'>): Promise<LocaleBundle> {
    return load[language]();
}
