import type { BundledLanguage, LanguageInput } from 'shiki';

/** Native keeps its bundled grammar modules available without a network request. */
export async function loadShikiLanguages(): Promise<Record<BundledLanguage, LanguageInput>> {
    return (await import('shiki/langs')).bundledLanguages;
}
