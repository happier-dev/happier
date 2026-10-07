import { getTranslationValue, preloadTranslations, resolveSupportedLanguageFromTag } from '@/text/i18n';

function resolveWelcomeLanguage(assistantLanguage: string | null | undefined) {
    return assistantLanguage?.trim() ? resolveSupportedLanguageFromTag(assistantLanguage) : null;
}

export function isVoiceWelcomeLanguageSupported(assistantLanguage: string | null | undefined): boolean {
    return resolveWelcomeLanguage(assistantLanguage) !== null;
}

export async function preloadVoiceWelcomeText(assistantLanguage: string | null | undefined): Promise<void> {
    const supported = resolveWelcomeLanguage(assistantLanguage);
    if (supported) await preloadTranslations(supported);
}

/** A literal follows Reply in only; automatic and unsupported languages stay model-generated. */
export function resolveVoiceWelcomeText(assistantLanguage: string | null | undefined): string | undefined {
    const supported = resolveWelcomeLanguage(assistantLanguage);
    if (!supported) return undefined;
    const text = getTranslationValue('voicePresence.welcomeText', supported);
    return typeof text === 'string' && text.trim() ? text : undefined;
}
