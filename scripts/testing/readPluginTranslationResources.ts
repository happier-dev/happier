import { readFileSync } from 'node:fs';

export const PLUGIN_TRANSLATION_LOCALES = [
    'en', 'ru', 'pl', 'es', 'fr', 'it', 'pt', 'ca', 'zh-Hans', 'zh-Hant', 'ja', 'de',
] as const;

export type PluginTranslationLocale = (typeof PLUGIN_TRANSLATION_LOCALES)[number];
export type PluginTranslationMessages = Readonly<Record<string, string>>;

/** Read the actual packaged test inputs, without executing retired author tables. */
export function readPluginTranslationResources(packageRoot: URL, manifest?: Readonly<{
    contributes: Readonly<{
        ui?: Readonly<{ translations?: readonly Readonly<{ locale: string; resourceId?: string }>[] }>;
        resources?: readonly Readonly<{ id: string; path?: string; kind?: string; contentType?: string }>[];
    }>;
}>): Readonly<Record<PluginTranslationLocale, PluginTranslationMessages>> {
    const entries = PLUGIN_TRANSLATION_LOCALES.map((locale) => {
        const reference = manifest?.contributes.ui?.translations?.find(row => row.locale === locale);
        const resource = reference?.resourceId && manifest?.contributes.resources?.find(row => row.id === reference.resourceId);
        if (manifest && (!resource || resource.kind !== 'asset' || resource.contentType !== 'application/json' || !resource.path)) {
            throw new Error(`${packageRoot.pathname}: missing packaged JSON Resource for ${locale}`);
        }
        const file = new URL(resource ? resource.path! : `assets/i18n/${locale}.json`, packageRoot);
        const messages: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (!messages || typeof messages !== 'object' || Array.isArray(messages)
            || Object.values(messages).some(value => typeof value !== 'string')) {
            throw new Error(`${file.pathname}: expected a string-valued locale map`);
        }
        // JSON values were checked above; every supported locale is read explicitly.
        return [locale, messages as PluginTranslationMessages] as const;
    });
    return Object.fromEntries(entries) as Record<PluginTranslationLocale, PluginTranslationMessages>;
}
