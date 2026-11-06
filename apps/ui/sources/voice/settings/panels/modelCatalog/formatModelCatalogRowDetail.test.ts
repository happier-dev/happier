import { describe, expect, it } from 'vitest';

import type { ModelCatalogRow } from './buildModelCatalogRows';
import { formatModelCatalogRowDetail, formatModelCatalogRowFacts } from './formatModelCatalogRowDetail';

function row(overrides: Partial<ModelCatalogRow>): ModelCatalogRow {
    return {
        packId: 'pack',
        kind: 'stt_sherpa',
        displayName: 'Pack',
        model: 'pack',
        state: 'not_installed',
        progress: null,
        loadedArtifactBytes: null,
        languages: null,
        archiveBytes: null,
        inUse: null,
        lastError: null,
        isDefault: false,
        canInstall: true,
        canRemove: false,
        canSetDefault: false,
        licenseReview: null,
        sourcePluginId: null,
        ...overrides,
    };
}

describe('formatModelCatalogRowDetail', () => {
    it('renders download progress as a percentage', () => {
        const detail = formatModelCatalogRowDetail(row({ state: 'downloading', progress: 0.42 }));
        expect(detail).toContain('42%');
    });

    it('appends declared loaded artifact bytes only for loaded states', () => {
        const loadedArtifactBytes = 5 * 1024 * 1024;
        const ready = formatModelCatalogRowDetail(row({
            state: 'ready',
            loadedArtifactBytes,
        }));
        expect(ready).toContain('5.24 MB model files');
        // Installed (cold) reports no loaded-artifact line even if a value leaks through.
        const installed = formatModelCatalogRowDetail(row({
            state: 'installed',
            loadedArtifactBytes,
        }));
        expect(installed).not.toContain('model files');
    });

    it('appends the last error message for error rows', () => {
        const detail = formatModelCatalogRowDetail(row({ state: 'error', lastError: 'boom' }));
        expect(detail).toContain('boom');
    });
});

describe('formatModelCatalogRowFacts', () => {
    it('says unknown languages and size as unknown instead of omitting or guessing them', () => {
        const facts = formatModelCatalogRowFacts(row({ languages: null, archiveBytes: null }));
        expect(facts).toBe('Languages not listed · Download size unknown');
    });

    it('names one or two languages and counts longer lists, with the archive size as a download', () => {
        expect(formatModelCatalogRowFacts(row({ languages: ['en'], archiveBytes: 487_170_055 })))
            .toBe('English · 487 MB download');
        expect(formatModelCatalogRowFacts(row({ languages: ['bg', 'hr', 'cs', 'da', 'nl'], archiveBytes: null })))
            .toBe('5 languages · Download size unknown');
    });

    it('drops the download once the model is on the machine, so an installed row says only what it covers', () => {
        for (const state of ['installed', 'ready', 'warming', 'evicted'] as const) {
            expect(formatModelCatalogRowFacts(row({ state, languages: ['en'], archiveBytes: null }))).toBe('English');
        }
        expect(formatModelCatalogRowFacts(row({ state: 'installed', languages: null, archiveBytes: 487_170_055 })))
            .toBe('Languages not listed');
        expect(formatModelCatalogRowFacts(row({ state: 'error', languages: ['en'], archiveBytes: null })))
            .toBe('English · Download size unknown');
    });
});

describe('formatModelCatalogRowDetail in-use', () => {
    it('says In use only when the daemon reported a live lease on an installed pack', () => {
        expect(formatModelCatalogRowDetail(row({ state: 'ready', inUse: true }))).toBe('In use');
        expect(formatModelCatalogRowDetail(row({ state: 'ready', inUse: null }))).toBe('Ready');
        expect(formatModelCatalogRowDetail(row({ state: 'not_installed', inUse: true }))).toBe('Not installed');
    });
});
