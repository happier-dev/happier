import { describe, expect, it } from 'vitest';
import { LocalServiceInventoryUpdateEventV1Schema } from '@happier-dev/protocol';

import { createLocalServiceInventoryRegistry } from './registry';

const snapshot = {
    v: 1,
    machineId: 'machine-a',
    generatedAt: 1_000,
    refreshState: 'idle',
    diagnostics: [],
    entries: [{
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
    }],
} as const;

describe('createLocalServiceInventoryRegistry', () => {
    it('publishes snapshots and applies labels only to existing entries', () => {
        const events: unknown[] = [];
        const registry = createLocalServiceInventoryRegistry();
        const unsubscribe = registry.subscribe((event) => events.push(event));

        registry.replaceSnapshot(snapshot);
        expect(registry.getSnapshot().entries[0]?.labels).toEqual([]);

        expect(registry.applyLabelPatch({
            inventoryId: 'entry-1',
            text: 'Web app',
            source: 'user',
            updatedAt: 1_500,
        })).toEqual({ ok: true });

        expect(registry.applyLabelPatch({
            inventoryId: 'missing',
            text: 'Missing',
            source: 'user',
            updatedAt: 1_600,
        })).toEqual({ ok: false, reason: 'unknown_inventory_entry' });
        expect(registry.getSnapshot().entries[0]?.labels.map((label) => label.text)).toEqual(['Web app']);
        expect(events.map((event) => LocalServiceInventoryUpdateEventV1Schema.parse(event).kind)).toEqual([
            'snapshot',
            'entry_upserted',
        ]);
        expect(events).toEqual([
            expect.objectContaining({ v: 1, kind: 'snapshot' }),
            expect.objectContaining({ v: 1, kind: 'entry_upserted' }),
        ]);

        unsubscribe();
    });

    it('retains labels by machine address and port when process-derived ids change', () => {
        const registry = createLocalServiceInventoryRegistry();
        registry.replaceSnapshot(snapshot);

        expect(registry.applyLabelPatch({
            inventoryId: 'entry-1',
            text: 'Web app',
            source: 'user',
            updatedAt: 1_500,
        })).toEqual({ ok: true });

        registry.replaceSnapshot({
            ...snapshot,
            entries: [{
                ...snapshot.entries[0],
                id: 'entry-2',
            }],
        });

        expect(registry.getSnapshot().entries[0]?.labels.map((label) => label.text)).toEqual(['Web app']);
    });
});
