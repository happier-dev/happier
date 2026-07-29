import { describe, expect, it } from 'vitest';

import type { ModelCatalogRow } from './buildModelCatalogRows';
import { formatModelCatalogRowDetail, formatResidentMemory } from './formatModelCatalogRowDetail';

function row(overrides: Partial<ModelCatalogRow>): ModelCatalogRow {
    return {
        packId: 'pack',
        kind: 'stt_sherpa',
        displayName: 'Pack',
        model: 'pack',
        state: 'not_installed',
        progress: null,
        residentMemoryBytes: null,
        lastError: null,
        isDefault: false,
        canInstall: true,
        canRemove: false,
        licenseReview: null,
        sourcePluginId: null,
        ...overrides,
    };
}

describe('formatResidentMemory', () => {
    it('formats binary byte sizes compactly', () => {
        expect(formatResidentMemory(0)).toBe('0 B');
        expect(formatResidentMemory(512)).toBe('512 B');
        expect(formatResidentMemory(1024)).toBe('1 KB');
        expect(formatResidentMemory(1536)).toBe('1.5 KB');
        expect(formatResidentMemory(5 * 1024 * 1024)).toBe('5 MB');
        expect(formatResidentMemory(2 * 1024 * 1024 * 1024)).toBe('2 GB');
    });
});

describe('formatModelCatalogRowDetail', () => {
    it('renders download progress as a percentage', () => {
        const detail = formatModelCatalogRowDetail(row({ state: 'downloading', progress: 0.42 }));
        expect(detail).toContain('42%');
    });

    it('appends resident memory only for resident states', () => {
        const ready = formatModelCatalogRowDetail(row({ state: 'ready', residentMemoryBytes: 5 * 1024 * 1024 }));
        expect(ready).toContain('5 MB');
        // Installed (cold) reports no resident telemetry line even if a value leaks through.
        const installed = formatModelCatalogRowDetail(row({ state: 'installed', residentMemoryBytes: 5 * 1024 * 1024 }));
        expect(installed).not.toContain('5 MB');
    });

    it('appends the last error message for error rows', () => {
        const detail = formatModelCatalogRowDetail(row({ state: 'error', lastError: 'boom' }));
        expect(detail).toContain('boom');
    });
});
