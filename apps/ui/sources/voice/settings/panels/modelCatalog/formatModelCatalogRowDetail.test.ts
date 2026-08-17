import { describe, expect, it } from 'vitest';

import type { ModelCatalogRow } from './buildModelCatalogRows';
import { formatArtifactBytes, formatModelCatalogRowDetail } from './formatModelCatalogRowDetail';

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
        licenseReview: null,
        sourcePluginId: null,
        ...overrides,
    };
}

describe('formatArtifactBytes', () => {
    it('formats binary byte sizes compactly', () => {
        expect(formatArtifactBytes(0)).toBe('0 B');
        expect(formatArtifactBytes(512)).toBe('512 B');
        expect(formatArtifactBytes(1024)).toBe('1 KB');
        expect(formatArtifactBytes(1536)).toBe('1.5 KB');
        expect(formatArtifactBytes(5 * 1024 * 1024)).toBe('5 MB');
        expect(formatArtifactBytes(2 * 1024 * 1024 * 1024)).toBe('2 GB');
    });
});

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
        expect(ready).toContain('5 MB model files');
        // Installed (cold) reports no loaded-artifact line even if a value leaks through.
        const installed = formatModelCatalogRowDetail(row({
            state: 'installed',
            loadedArtifactBytes,
        }));
        expect(installed).not.toContain('5 MB');
    });

    it('appends the last error message for error rows', () => {
        const detail = formatModelCatalogRowDetail(row({ state: 'error', lastError: 'boom' }));
        expect(detail).toContain('boom');
    });
});
