import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUPPORTED_LANGUAGE_CODES } from '@/text/i18n';
import { setPreferredLanguageFromSettings } from '@/text';
import { resolveVoiceWelcomeText } from './voiceWelcomeText';

afterEach(() => {
    setPreferredLanguageFromSettings(null);
    vi.unstubAllGlobals();
});

describe('Voice welcome literal', () => {
    it('resolves every app locale when the native runtime has no Intl.Locale constructor', () => {
        const nativeIntl = Object.create(Intl);
        Object.defineProperty(nativeIntl, 'Locale', { value: undefined });
        vi.stubGlobal('Intl', nativeIntl);
        for (const language of SUPPORTED_LANGUAGE_CODES) {
            expect(resolveVoiceWelcomeText(language), language).toEqual(expect.any(String));
        }
        expect(resolveVoiceWelcomeText('zh-TW')).toContain('什麼');
        expect(resolveVoiceWelcomeText('fr-CA')).toMatch(/^Bonjour/);
    });

    it('uses Reply in rather than the app language, including regional tags', () => {
        setPreferredLanguageFromSettings('de');
        expect(resolveVoiceWelcomeText('fr-CA')).toMatch(/^Bonjour/);
        expect(resolveVoiceWelcomeText('en-GB')).toMatch(/^Hi/);
        expect(resolveVoiceWelcomeText('zh-TW')).toContain('什麼');
        expect(resolveVoiceWelcomeText('zh-CN')).toContain('什么');
        expect(resolveVoiceWelcomeText('zh-Hans-TW')).toContain('什么');
        expect(resolveVoiceWelcomeText('zh-u-nu-latn')).toContain('什么');
    });

    it('does not substitute app or English text for an unavailable literal', () => {
        setPreferredLanguageFromSettings('en');
        expect(resolveVoiceWelcomeText('ar-SA')).toBeUndefined();
        expect(resolveVoiceWelcomeText(null)).toBeUndefined();
        expect(resolveVoiceWelcomeText('not a language')).toBeUndefined();
        expect(resolveVoiceWelcomeText('zh-Latn')).toBeUndefined();
    });
});
