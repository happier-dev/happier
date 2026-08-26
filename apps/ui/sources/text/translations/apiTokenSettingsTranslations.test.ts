import { describe, expect, it } from 'vitest';

import { auditTranslations, flattenTranslationLeaves } from '../../../tools/i18n/translationAudit';

import { apiTokenSettingsTranslations } from './apiTokenSettingsTranslations';

describe('apiTokenSettingsTranslations', () => {
    it('keeps every supported API token settings surface complete and localized', () => {
        const { en, ...localesByCode } = apiTokenSettingsTranslations;
        const locales = Object.entries(localesByCode).map(([code, root]) => ({ code, root }));
        const expectedLeaves = flattenTranslationLeaves(en.settingsApiTokens)
            .map((leaf) => `${leaf.key}:${leaf.kind}`)
            .sort();

        const shapeMismatches = locales.flatMap(({ code, root }) => {
            const actualLeaves = flattenTranslationLeaves(root.settingsApiTokens)
                .map((leaf) => `${leaf.key}:${leaf.kind}`)
                .sort();
            return JSON.stringify(actualLeaves) === JSON.stringify(expectedLeaves)
                ? []
                : [`${code}: API token settings translation shape differs from English`];
        });
        const untranslated = Object.values(auditTranslations({ en, locales }))
            .flatMap((report) => report.untranslatedStrings)
            .filter((entry) => entry.key.startsWith('settingsApiTokens.'));
        const inheritedFormatters = locales.flatMap(({ code, root }) => {
            const englishRowLabel = en.settingsApiTokens.rowAccessibilityLabel({ label: 'TOKEN_LABEL', state: 'TOKEN_STATE' });
            const englishMoreActionsLabel = en.settingsApiTokens.moreActionsAccessibilityLabel({ label: 'TOKEN_LABEL' });
            const englishRevokeTitle = en.settingsApiTokens.revoke.title({ label: 'TOKEN_LABEL' });
            return [
                root.settingsApiTokens.rowAccessibilityLabel({ label: 'TOKEN_LABEL', state: 'TOKEN_STATE' }) === englishRowLabel
                    ? `${code}: settingsApiTokens.rowAccessibilityLabel falls back to English`
                    : null,
                root.settingsApiTokens.moreActionsAccessibilityLabel({ label: 'TOKEN_LABEL' }) === englishMoreActionsLabel
                    ? `${code}: settingsApiTokens.moreActionsAccessibilityLabel falls back to English`
                    : null,
                root.settingsApiTokens.revoke.title({ label: 'TOKEN_LABEL' }) === englishRevokeTitle
                    ? `${code}: settingsApiTokens.revoke.title falls back to English`
                    : null,
            ].filter((failure): failure is string => failure !== null);
        });

        expect(shapeMismatches).toEqual([]);
        expect(untranslated).toEqual([]);
        expect(inheritedFormatters).toEqual([]);
    });
});
