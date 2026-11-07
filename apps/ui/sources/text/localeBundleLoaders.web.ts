import type { SupportedLanguage } from './_all';
import type { LocaleBundle } from './localeBundlesSync';
import { LOCALE_ASSETS } from './localeAssets.generated';
import { readBundledAssetBytes } from '@/utils/assets/readBundledAssetBytes';

/** The producer bundles authored translation functions, so these remain executable copy. */
export async function loadLocaleBundle(language: Exclude<SupportedLanguage, 'en'>): Promise<LocaleBundle> {
    const bytes = await readBundledAssetBytes(LOCALE_ASSETS[language]);
    if (!bytes) throw new Error(`Translation asset unavailable: ${language}`);
    // This is the CJS boundary of prepareLocaleAssets, not serialized user content.
    const module: { exports: { bundle?: LocaleBundle } } = { exports: {} };
    new Function('module', 'exports', new TextDecoder().decode(bytes))(module, module.exports);
    return module.exports.bundle!;
}
