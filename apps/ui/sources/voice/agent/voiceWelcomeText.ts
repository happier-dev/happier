import { getTranslationValue, resolveSupportedLanguageFromTag } from '@/text/i18n';

/** A literal follows Reply in only; automatic and unsupported languages stay model-generated. */
export function resolveVoiceWelcomeText(assistantLanguage: string | null | undefined): string | undefined {
    if (!assistantLanguage?.trim()) return undefined;
    const supported = resolveSupportedLanguageFromTag(assistantLanguage);
    if (!supported) return undefined;
    const text = getTranslationValue('voicePresence.welcomeText', supported);
    return typeof text === 'string' && text.trim() ? text : undefined;
}
