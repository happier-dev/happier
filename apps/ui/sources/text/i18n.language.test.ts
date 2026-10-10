import { afterEach, describe, expect, it } from 'vitest';

import { es } from './translations/es';
import { en } from './translations/en';
import { fr } from './translations/fr';
import { zhHans } from './translations/zh-Hans';
import { zhHant } from './translations/zh-Hant';
import * as i18n from './i18n';

describe('text/i18n language state', () => {
    it('retains synchronous native Chinese locale composition', () => {
        i18n.setPreferredLanguageFromSettings('zh-Hant');
        expect(i18n.t('tabs.inbox')).toBe(zhHant.tabs.inbox);
        i18n.setPreferredLanguageFromSettings('zh-Hans');
        expect(i18n.t('tabs.inbox')).toBe(zhHans.tabs.inbox);
    });
    it('keeps the latest selected locale when settings change during readiness', async () => {
        i18n.setPreferredLanguageFromSettings('es');
        const ready = i18n.preloadTranslations();
        i18n.setPreferredLanguageFromSettings('fr');
        await ready;
        expect(i18n.getPreferredLanguage()).toBe('fr');
        expect(i18n.t('tabs.inbox')).toBe(fr.tabs.inbox);
    });

    it('preloads an explicitly requested voice locale without activating it as UI language', async () => {
        i18n.setPreferredLanguageFromSettings('es');
        await i18n.preloadTranslations('fr');
        expect(i18n.getPreferredLanguage()).toBe('es');
        expect(i18n.t('tabs.inbox')).toBe(es.tabs.inbox);
        expect(i18n.getTranslationValue('voicePresence.welcomeText', 'fr')).toBe(fr.voicePresence.welcomeText);
    });
    afterEach(() => {
        i18n.setPreferredLanguageFromSettings(null);
    });

    it('reports the active preferred language after settings changes', () => {
        expect(typeof i18n.getPreferredLanguage).toBe('function');
        expect(i18n.getPreferredLanguage()).toBe('en');

        i18n.setPreferredLanguageFromSettings('es');

        expect(i18n.getPreferredLanguage()).toBe('es');
    });

    it('resolves a non-default language from its own tree and reverts when cleared', () => {
        // Locale trees are materialised lazily; this is the case that breaks if a deferred tree is
        // never resolved and the lookup silently falls through to English.
        expect(es.tabs.inbox).not.toBe(en.tabs.inbox);

        i18n.setPreferredLanguageFromSettings('es');
        expect(i18n.t('tabs.inbox')).toBe(es.tabs.inbox);

        i18n.setPreferredLanguageFromSettings(null);
        expect(i18n.t('tabs.inbox')).toBe(en.tabs.inbox);
    });

    it('resolves the host-owned form submit label from the active locale', () => {
        expect(en.common.submit).toBe('Submit');
        expect(es.common.submit).toBe('Enviar');

        i18n.setPreferredLanguageFromSettings('es');
        expect(i18n.t('common.submit')).toBe(es.common.submit);
    });

    it('keeps translations when the requested language is not supported', () => {
        i18n.setPreferredLanguageFromSettings('kl');

        expect(i18n.getPreferredLanguage()).toBe('en');
        expect(i18n.t('tabs.inbox')).toBe(en.tabs.inbox);
    });

    it('falls back to canonical English for bundled keys missing from the active locale', () => {
        i18n.setPreferredLanguageFromSettings('es');

        expect(i18n.t('agentInput.connectedServiceLabel.gemini')).toBe('Google Gemini');
    });

    it('uses localized Home setup commands and details from the active locale', () => {
        i18n.setPreferredLanguageFromSettings('es');

        expect(i18n.t('setupOnboarding.webDesktopOnlySetupCommandSubtitle')).toBe(
            es.setupOnboarding.webDesktopOnlySetupCommandSubtitle,
        );
        expect(es.setupOnboarding.webDesktopOnlySetupCommandSubtitle).not.toBe(
            en.setupOnboarding.webDesktopOnlySetupCommandSubtitle,
        );
        expect(i18n.t('setupOnboarding.preAuthTitle')).toBe(es.setupOnboarding.preAuthTitle);
        expect(es.setupOnboarding.preAuthTitle).not.toBe(en.setupOnboarding.preAuthTitle);
        expect(i18n.t('setupOnboarding.thisComputerStages.registerComputerDetails')).toBe(
            es.setupOnboarding.thisComputerStages.registerComputerDetails,
        );
        expect(es.setupOnboarding.thisComputerStages.registerComputerDetails).not.toBe(
            en.setupOnboarding.thisComputerStages.registerComputerDetails,
        );
    });
});
