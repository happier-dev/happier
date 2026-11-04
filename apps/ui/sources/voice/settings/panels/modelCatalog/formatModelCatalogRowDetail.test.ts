import { describe, expect, it } from 'vitest';

import type { ModelCatalogRow } from './buildModelCatalogRows';
import { formatModelCatalogRowDetail } from './formatModelCatalogRowDetail';

function row(overrides: Partial<ModelCatalogRow>): ModelCatalogRow {
    return {
        packId: 'pack',
        kind: 'stt_sherpa',
        displayName: 'Pack',
        model: 'pack',
        state: 'not_installed',
        progress: null,
        loadedArtifactBytes: null,
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
