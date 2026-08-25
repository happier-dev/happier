import { describe, expect, it } from 'vitest';
import { LocalServiceInventoryUpdateEventV1Schema } from '@happier-dev/protocol';

import {
    createLocalServiceInventoryRegistry,
    type LocalServiceInventoryAnnotationStore,
    type LocalServiceInventoryAnnotationsV1,
} from './registry';

/** In-memory stand-in for the daemon's annotations file — the one genuine boundary here. */
function createAnnotationStoreDouble(): LocalServiceInventoryAnnotationStore & { written: number } {
    let stored: LocalServiceInventoryAnnotationsV1 | null = null;
    const store = {
        written: 0,
        read: () => stored,
        write: (annotations: LocalServiceInventoryAnnotationsV1) => {
            stored = annotations;
            store.written += 1;
        },
    };
    return store;
}

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

    it('stops suppressing a dismissed endpoint when a new process run owns the same port', () => {
        const registry = createLocalServiceInventoryRegistry();
        const firstRun = {
            ...snapshot,
            entries: [{
                ...snapshot.entries[0],
                id: 'entry-pid-400-start-1000',
                provenance: {
                    process: {
                        pid: 400,
                        processStartTimeMs: 1_000,
                        lineagePids: [400],
                        command: 'npm run dev',
                        redacted: true,
                    },
                },
            }],
        } as const;
        registry.replaceSnapshot(firstRun);

        expect(registry.forgetEntry({ inventoryId: 'entry-pid-400-start-1000', updatedAt: 1_500 })).toEqual({ ok: true });
        expect(registry.getSnapshot().entries).toEqual([]);

        registry.replaceSnapshot({
            ...snapshot,
            generatedAt: 2_000,
            entries: [{
                ...snapshot.entries[0],
                id: 'entry-pid-400-start-2000',
                lastSeenAt: 2_000,
                provenance: {
                    process: {
                        pid: 400,
                        processStartTimeMs: 2_000,
                        lineagePids: [400],
                        command: 'npm run dev',
                        redacted: true,
                    },
                },
            }],
        });

        expect(registry.getSnapshot().entries.map((entry) => entry.id)).toEqual(['entry-pid-400-start-2000']);
    });

    it('bounds forgotten suppression state by capacity', () => {
        const registry = createLocalServiceInventoryRegistry({ maxForgottenEntries: 2 });
        const entryFor = (index: number) => ({
            ...snapshot.entries[0],
            id: `entry-${index}`,
            port: 5_170 + index,
        });

        for (const index of [1, 2, 3]) {
            registry.replaceSnapshot({
                ...snapshot,
                generatedAt: 1_000 + index,
                entries: [entryFor(index)],
            });
            expect(registry.forgetEntry({ inventoryId: `entry-${index}`, updatedAt: 1_100 + index })).toEqual({ ok: true });
        }

        registry.replaceSnapshot({
            ...snapshot,
            generatedAt: 2_000,
            entries: [entryFor(1)],
        });

        expect(registry.getSnapshot().entries.map((entry) => entry.id)).toEqual(['entry-1']);
    });
    it('carries a user label across a daemon restart (tunnels audit 4.8)', () => {
        const annotations = createAnnotationStoreDouble();
        const first = createLocalServiceInventoryRegistry({ annotations });
        first.replaceSnapshot(snapshot);
        expect(first.applyLabelPatch({
            inventoryId: 'entry-1',
            text: 'Storefront',
            source: 'user',
            updatedAt: 2_000,
        })).toEqual({ ok: true });
        expect(annotations.written).toBeGreaterThan(0);

        // The daemon restarts: a brand-new registry, and the next scan re-mints inventory ids.
        const restarted = createLocalServiceInventoryRegistry({ annotations });
        restarted.replaceSnapshot({
            ...snapshot,
            generatedAt: 9_000,
            entries: [{ ...snapshot.entries[0]!, id: 'entry-1-rescanned', detectedAt: 9_000, lastSeenAt: 9_000 }],
        });

        expect(restarted.getSnapshot().entries[0]?.labels.map((label) => label.text)).toEqual(['Storefront']);
    });

    it('keeps a forgotten service hidden across a daemon restart', () => {
        const annotations = createAnnotationStoreDouble();
        const first = createLocalServiceInventoryRegistry({ annotations });
        first.replaceSnapshot(snapshot);
        expect(first.forgetEntry({ inventoryId: 'entry-1', updatedAt: 2_000 })).toEqual({ ok: true });
        expect(first.getSnapshot().entries).toHaveLength(0);

        const restarted = createLocalServiceInventoryRegistry({ annotations });
        restarted.replaceSnapshot({
            ...snapshot,
            generatedAt: 3_000,
            entries: [{ ...snapshot.entries[0]!, id: 'entry-1-rescanned' }],
        });

        // Same process, same address: the user's decision to hide it still holds.
        expect(restarted.getSnapshot().entries).toHaveLength(0);
    });

    it('works with no annotation store at all', () => {
        const registry = createLocalServiceInventoryRegistry();
        registry.replaceSnapshot(snapshot);
        expect(registry.applyLabelPatch({
            inventoryId: 'entry-1',
            text: 'Storefront',
            source: 'user',
            updatedAt: 2_000,
        })).toEqual({ ok: true });
        expect(registry.getSnapshot().entries[0]?.labels.map((label) => label.text)).toEqual(['Storefront']);
    });
});
