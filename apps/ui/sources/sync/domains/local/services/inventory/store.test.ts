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
        const refreshing = applyLocalServiceInventoryRefreshStarted(hydrated, 'machine-a');

        expect(refreshing.refreshState).toBe('refreshing');
        expect(selectLocalServiceInventoryRows(refreshing)).toHaveLength(1);
    });

    it('does not fabricate a generation when a refresh starts', () => {
        // `generatedAt` means "the daemon generation these rows came from". Starting a refresh
        // produces no generation at all — the rows on screen are still the previous one's. Stamping
        // the local clock here made every mount look like a fresh daemon scan to
        // `LocalServicesSurfaceHost`, which re-read the launcher feed for a scan that never
        // happened, and it made the watch's `sinceGeneratedAt` cursor a client clock reading
        // instead of the daemon's own.
        const hydrated = applyLocalServiceInventorySnapshot(createLocalServiceInventoryState(), {
            v: 1,
            machineId: 'machine-a',
            generatedAt: 1_000,
            refreshState: 'idle',
            entries: [entry()],
            diagnostics: [],
        });

        expect(applyLocalServiceInventoryRefreshStarted(hydrated, 'machine-a').generatedAt).toBe(1_000);
        // Nothing has been read for the new machine yet, so there is no generation to report.
        expect(applyLocalServiceInventoryRefreshStarted(hydrated, 'machine-b').generatedAt).toBeNull();
        // The very first refresh, before any snapshot, likewise reports no generation.
        expect(
            applyLocalServiceInventoryRefreshStarted(createLocalServiceInventoryState(), 'machine-a').generatedAt,
        ).toBeNull();
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

        const refreshing = applyLocalServiceInventoryRefreshStarted(hydrated, 'machine-b');

        expect(refreshing.machineId).toBe('machine-b');
        expect(refreshing.refreshState).toBe('refreshing');
        expect(selectLocalServiceInventoryRows(refreshing)).toHaveLength(0);
        expect(refreshing.diagnostics).toEqual([]);
    });

    it('rejects an injected/rehydrated plain-object state shape instead of throwing mid-render (L0-4)', () => {
        // A rehydrated or injected state where `rowsById` is a plain object (not a Map) must be
        // caught at the selector contract boundary with a clear error, not crash the Local
        // Services tab via `rowsById.get is not a function` mid-render.
        const malformed = {
            machineId: 'machine-a',
            generatedAt: 1_000,
            refreshState: 'idle' as const,
            rowIds: ['entry-1'],
            rowsById: { 'entry-1': entry() } as unknown as ReturnType<
                typeof createLocalServiceInventoryState
            >['rowsById'],
            diagnostics: [],
        };

        expect(() => selectLocalServiceInventoryRows(malformed)).toThrowError(/must be a Map/);
    });

    it('selects rows from canonical Map-backed state without throwing (L0-4)', () => {
        const state = createLocalServiceInventoryState();
        expect(selectLocalServiceInventoryRows(state)).toEqual([]);
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
