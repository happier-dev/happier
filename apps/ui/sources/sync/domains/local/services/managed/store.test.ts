import { describe, expect, it } from 'vitest';

import {
    applyManagedLocalServicesRefreshStarted,
    applyManagedLocalServicesSnapshot,
    createManagedLocalServicesState,
    selectManagedLocalServiceRows,
} from './store';

function row(overrides: Partial<ReturnType<typeof selectManagedLocalServiceRows>[number]> = {}) {
    return {
        id: 'service-1',
        ownerLabel: 'Plugin',
        phase: 'running',
        launchMode: 'detectAfterLaunch',
        routeName: 'plugin-web',
        port: 5173,
        diagnostics: [],
        updatedAt: 1_000,
        ...overrides,
    } as const;
}

describe('managed local services store', () => {
    it('keeps managed rows visible while refreshing', () => {
        const hydrated = applyManagedLocalServicesSnapshot(createManagedLocalServicesState(), {
            generatedAt: 1_000,
            refreshState: 'idle',
            rows: [row()],
            diagnostics: [],
        });

        const refreshing = applyManagedLocalServicesRefreshStarted(hydrated, 2_000);

        expect(refreshing.refreshState).toBe('refreshing');
        expect(selectManagedLocalServiceRows(refreshing)).toHaveLength(1);
    });

    it('preserves row references when a snapshot is semantically unchanged', () => {
        const hydrated = applyManagedLocalServicesSnapshot(createManagedLocalServicesState(), {
            generatedAt: 1_000,
            refreshState: 'idle',
            rows: [row()],
            diagnostics: [],
        });
        const firstRow = selectManagedLocalServiceRows(hydrated)[0];

        const updated = applyManagedLocalServicesSnapshot(hydrated, {
            generatedAt: 2_000,
            refreshState: 'idle',
            rows: [row()],
            diagnostics: [],
        });

        expect(selectManagedLocalServiceRows(updated)[0]).toBe(firstRow);
    });
});
