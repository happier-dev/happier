import { describe, expect, it } from 'vitest';

import { createLocalServiceInventoryLabelStore } from './labels';

const target = {
    id: 'entry-1',
    machineId: 'machine-a',
    address: { kind: 'loopback', host: '127.0.0.1' },
    port: 5173,
} as const;

describe('createLocalServiceInventoryLabelStore', () => {
    it('rejects labels for unknown inventory entries instead of creating service facts', () => {
        const store = createLocalServiceInventoryLabelStore();

        const result = store.applyPatch({
            knownEntries: [target],
            inventoryId: 'missing-entry',
            text: 'Web app',
            source: 'user',
            updatedAt: 1_000,
        });

        expect(result).toEqual({ ok: false, reason: 'unknown_inventory_entry' });
        expect(store.labelsFor({ ...target, id: 'missing-entry' })).toEqual([]);
    });

    it('stores annotations for known inventory entries', () => {
        const store = createLocalServiceInventoryLabelStore();

        const result = store.applyPatch({
            knownEntries: [target],
            inventoryId: 'entry-1',
            text: 'Web app',
            source: 'user',
            updatedAt: 1_000,
        });

        expect(result).toEqual({ ok: true });
        expect(store.labelsFor(target)).toEqual([
            {
                id: 'user:entry-1',
                text: 'Web app',
                source: 'user',
                updatedAt: 1_000,
            },
        ]);
    });
});
