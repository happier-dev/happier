import { afterEach, describe, expect, it, vi } from 'vitest';
import { SUPPORTED_LANGUAGE_CODES } from '@/text/i18n';
import { setPreferredLanguageFromSettings } from '@/text';
import { resolveVoiceWelcomeText } from './voiceWelcomeText';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';

afterEach(() => {
    setPreferredLanguageFromSettings(null);
    vi.unstubAllGlobals();
});

describe('Voice welcome literal', () => {
    it('names only the explicitly admitted bound target while the global default stays unchanged', () => {
        expect(resolveVoiceWelcomeText('en', { targetDisplayName: 'Atlas' })).toContain('Atlas');
        expect(resolveVoiceWelcomeText('en')).not.toContain('Atlas');
        expect(resolveVoiceWelcomeText('fr', { targetDisplayName: 'Atlas' })).toContain('Atlas');
        expect(resolveVoiceWelcomeText('ar', { targetDisplayName: 'Atlas' })).toBeUndefined();
    });

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

describe('selected Voice welcome Doc', () => {
    it('reads current selected Doc bytes through its qualified Account and refuses a missing selection', async () => {
        const fixture = await createPlainArtifactHomeFixture('https://voice-welcome-doc.example');
        const account = await captureLazyActionAccountContext(fixture.home.id);
        const text = '  Hello, human.\nDo not append a Session name.  ';
        try {
            await account.createArtifactDocument({ artifactId: 'welcome-doc',
                header: { v: 1, kind: 'prompt_doc.v2', title: 'Welcome' },
                body: JSON.stringify({ v: 1, markdown: text, createdAtMs: 1, updatedAtMs: 1 }) });
            const { resolveSelectedVoiceWelcomeText } = await import('./voiceWelcomeText');
            const input = { assistantLanguage: 'en', welcome: { enabled: true, templateId: 'welcome-doc' },
                targetDisplayName: 'Atlas', serverId: fixture.home.id, accountContext: account };
            expect(await resolveSelectedVoiceWelcomeText(input)).toBe(text);
            const artifact = await account.workflowArtifacts.read('welcome-doc');
            expect(artifact).not.toBeNull();
            await account.workflowArtifacts.update({ artifactId: 'welcome-doc', expectedRevision: artifact!.revision,
                header: { v: 1, kind: 'prompt_doc.v2', title: 'Welcome' },
                body: JSON.stringify({ v: 1, markdown: `${text}\nEdited`, createdAtMs: 1, updatedAtMs: 2 }) });
            expect(await resolveSelectedVoiceWelcomeText(input)).toBe(`${text}\nEdited`);
            await expect(resolveSelectedVoiceWelcomeText({ ...input, welcome: { enabled: true, templateId: 'missing' } }))
                .rejects.toMatchObject({ reason: 'not_found' });
            await expect(resolveSelectedVoiceWelcomeText({ ...input, welcome: { enabled: true, templateId: '' } }))
                .rejects.toMatchObject({ name: 'PromptStackPreparationError' });
            expect(await resolveSelectedVoiceWelcomeText({ ...input, welcome: { enabled: false, templateId: '' } }))
                .toBeUndefined();
            const cancellation = new AbortController();
            cancellation.abort();
            await expect(resolveSelectedVoiceWelcomeText({ ...input, signal: cancellation.signal })).rejects.toThrow();
        } finally { account.dispose(); fixture.dispose(); }
    });
});
