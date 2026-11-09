import { describe, expect, it } from 'vitest';

import { flattenTranslationLeaves } from '../../../tools/i18n/translationAudit';
import { en } from './en';
import { workspaceSyncDiagnosticTranslations, workspaceSyncTranslations } from './workspaceSyncDiagnosticTranslations';

describe('workspaceSyncDiagnosticTranslations', () => {
    it('localizes diagnostic, update-required, and destructive-resolution copy for every non-English locale', () => {
        const locales = Object.values(workspaceSyncDiagnosticTranslations);
        expect(locales).toHaveLength(11);
        for (const locale of locales) {
            expect(locale.diagnostics.title).not.toBe('Diagnostics');
            expect(locale.diagnostics.relationshipId).not.toBe('Relationship ID');
            expect(locale.error.updateRequired).not.toBe('Update Happier on the source computer before trying this workspace handoff again. Other session and computer actions are still available.');
            expect(locale.resolve.title).not.toBe('Resolve workspace conflict?');
            expect(locale.resolve.body({ path: 'src/index.ts', side: 'Local' })).not.toBe("Keep Local's version of src/index.ts? The other version will be removed after its latest file state is verified.");
            expect(locale.resolve.unverifiedFile).not.toContain('current file fingerprint');
        }
    });

    it('owns the complete workspace-sync namespace in every non-English locale', () => {
        const englishKeys = flattenTranslationLeaves(en.workspaceSync).map((leaf) => leaf.key).sort();

        expect(Object.keys(workspaceSyncTranslations).sort()).toEqual([
            'ca', 'de', 'es', 'fr', 'it', 'ja', 'pl', 'pt', 'ru', 'zh-Hans', 'zh-Hant',
        ]);

        for (const [locale, copy] of Object.entries(workspaceSyncTranslations)) {
            expect(
                flattenTranslationLeaves(copy).map((leaf) => leaf.key).sort(),
                `${locale} workspace-sync shape`,
            ).toEqual(englishKeys);
            expect(copy.title, `${locale} title`).not.toBe(en.workspaceSync.title);
            expect(copy.footer, `${locale} footer`).not.toBe(en.workspaceSync.footer);
            expect(copy.error.needsAttention, `${locale} recovery guidance`).not.toBe(en.workspaceSync.error.needsAttention);
            expect(copy.state.loading, `${locale} loading ellipsis`).toContain('…');
            expect(copy.state.working, `${locale} working ellipsis`).toContain('…');
            expect(copy.engine.checking, `${locale} engine ellipsis`).toContain('…');
        }
    });
});
