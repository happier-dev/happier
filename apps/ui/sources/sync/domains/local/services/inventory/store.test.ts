import { describe, expect, it } from 'vitest';

import {
    applyLocalServiceInventoryRefreshStarted,
    applyLocalServiceInventorySnapshot,
    createLocalServiceInventoryState,
    selectLocalServiceInventoryRows,
} from './store';

function entry(overrides: Partial<ReturnType<typeof selectLocalServiceInventoryRows>[number]> = {}) {
    return {
        id: 'entry-1',
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port: 5173,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 1_000,
        state: 'listening',
        source: 'detected',
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'medium',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        ...overrides,
    } as const;
}

describe('local service inventory store', () => {
    it('keeps last-known rows visible while a refresh is in flight', () => {
        const initial = createLocalServiceInventoryState();
        const hydrated = applyLocalServiceInventorySnapshot(initial, {
            v: 1,
            machineId: 'machine-a',
            generatedAt: 1_000,
            refreshState: 'idle',
            entries: [entry()],
            diagnostics: [],
        });
        const refreshing = applyLocalServiceInventoryRefreshStarted(hydrated, 'machine-a', 2_000);

        expect(refreshing.refreshState).toBe('refreshing');
        expect(selectLocalServiceInventoryRows(refreshing)).toHaveLength(1);
    });

    it('clears cached rows when a refresh starts for a different machine', () => {
        const hydrated = applyLocalServiceInventorySnapshot(createLocalServiceInventoryState(), {
            v: 1,
            machineId: 'machine-a',
            generatedAt: 1_000,
            refreshState: 'idle',
            entries: [entry()],
            diagnostics: [{ code: 'previous_machine', severity: 'warning' }],
        });

        const refreshing = applyLocalServiceInventoryRefreshStarted(hydrated, 'machine-b', 2_000);

        expect(refreshing.machineId).toBe('machine-b');
        expect(refreshing.refreshState).toBe('refreshing');
        expect(selectLocalServiceInventoryRows(refreshing)).toHaveLength(0);
        expect(refreshing.diagnostics).toEqual([]);
    });

    it('preserves row references when a snapshot does not change an entry semantically', () => {
        const hydrated = applyLocalServiceInventorySnapshot(createLocalServiceInventoryState(), {
            v: 1,
            machineId: 'machine-a',
            generatedAt: 1_000,
            refreshState: 'idle',
            entries: [entry()],
            diagnostics: [],
        });
        const firstRow = selectLocalServiceInventoryRows(hydrated)[0];

        const updated = applyLocalServiceInventorySnapshot(hydrated, {
            v: 1,
            machineId: 'machine-a',
            generatedAt: 2_000,
            refreshState: 'idle',
            entries: [entry()],
            diagnostics: [],
        });

        expect(selectLocalServiceInventoryRows(updated)[0]).toBe(firstRow);
    });
});
