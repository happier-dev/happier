import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalServiceInventoryUpdateEventV1Schema } from '@happier-dev/protocol/local/services/inventory';
import { createLocalServiceInventoryAnnotationsFileStore } from './annotationsFile';

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
    it.each(['process', 'unattributed'] as const)('restores extended stored annotations and writes canonical %s suppression data', (kind) => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-inventory-extensions-'));
        try {
            const path = join(dir, 'annotations.json');
            const annotations = createLocalServiceInventoryAnnotationsFileStore({ path });
            const current = {
                ...snapshot,
                entries: [{ ...snapshot.entries[0], ...(kind === 'process' ? {
                    provenance: { process: { pid: 400, processStartTimeMs: 1_000, lineagePids: [400], command: 'vite', redacted: true as const } },
                } : {}) }],
            } as const;
            const first = createLocalServiceInventoryRegistry({ annotations });
            first.replaceSnapshot(current);
            first.applyLabelPatch({ inventoryId: 'entry-1', text: 'Storefront', source: 'user', updatedAt: 2_000 });
            const forgotten = first.forgetEntry({ inventoryId: 'entry-1', updatedAt: 3_000 });
            if (!forgotten.ok) throw new Error('Expected forgotten service');
            const canonical = annotations.read();
            if (!canonical) throw new Error('Expected stored annotations');
            const extended = {
                ...canonical, futureRoot: true,
                labelsByFallbackKey: canonical.labelsByFallbackKey.map(([key, labels]) => [key, labels.map((label) => ({ ...label, futureLabel: true }))]),
                forgottenFallbackKeys: canonical.forgottenFallbackKeys.map(([key, suppression]) => [key, {
                    ...suppression, futureSuppression: true, runIdentity: { ...suppression.runIdentity, futureIdentity: true },
                }]),
            };
            writeFileSync(path, JSON.stringify(extended));
            expect(annotations.read()).toEqual(canonical);
            const extendedWrite = { ...canonical, futureRoot: true };
            annotations.write(extendedWrite);
            expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(canonical);
            const restarted = createLocalServiceInventoryRegistry({ annotations });
            restarted.replaceSnapshot(current);
            expect(restarted.getSnapshot().entries).toEqual([]);
            expect(restarted.undoForget(forgotten.undoKey)).toEqual({ ok: true });
            restarted.replaceSnapshot(current);
            expect(restarted.getSnapshot().entries[0]?.labels.map((label) => label.text)).toEqual(['Storefront']);
            expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ...canonical, forgottenFallbackKeys: [] });
            writeFileSync(path, JSON.stringify({ ...canonical, v: 2, futureRoot: true }));
            expect(annotations.read()).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

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

    it('stops suppressing a dismissed endpoint when a new process run owns the same port and inventory id', () => {
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

        expect(registry.forgetEntry({ inventoryId: 'entry-pid-400-start-1000', updatedAt: 1_500 })).toMatchObject({ ok: true });
        expect(registry.getSnapshot().entries).toEqual([]);

        registry.replaceSnapshot({
            ...snapshot,
            generatedAt: 2_000,
            entries: [{
                ...snapshot.entries[0],
                id: 'entry-pid-400-start-1000',
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

        expect(registry.getSnapshot().entries.map((entry) => entry.id)).toEqual(['entry-pid-400-start-1000']);
    });

    it('retains forgotten services beyond the former count and time cutoffs across restart', () => {
        const annotations = createAnnotationStoreDouble();
        const registry = createLocalServiceInventoryRegistry({ annotations });
        const entryFor = (index: number) => ({
            ...snapshot.entries[0],
            id: `entry-${index}`,
            port: 5_170 + index,
        });

        for (let index = 1; index <= 513; index += 1) {
            registry.replaceSnapshot({
                ...snapshot,
                generatedAt: 1_000 + index,
                entries: [entryFor(index)],
            });
            expect(registry.forgetEntry({ inventoryId: `entry-${index}`, updatedAt: 1_100 + index })).toMatchObject({ ok: true });
        }

        const restarted = createLocalServiceInventoryRegistry({ annotations });
        restarted.replaceSnapshot({
            ...snapshot,
            generatedAt: 31 * 60_000,
            entries: [entryFor(1)],
        });

        expect(restarted.getSnapshot().entries).toEqual([]);
    });

    it('acknowledges label and Forget only after the latest complete annotations are on disk', () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-inventory-annotations-'));
        try {
            const annotations = createLocalServiceInventoryAnnotationsFileStore({ path: join(dir, 'annotations.json') });
            const registry = createLocalServiceInventoryRegistry({ annotations });
            registry.replaceSnapshot(snapshot);
            expect(registry.applyLabelPatch({ inventoryId: 'entry-1', text: 'First', source: 'user', updatedAt: 2_000 })).toEqual({ ok: true });
            expect(registry.applyLabelPatch({ inventoryId: 'entry-1', text: 'Latest', source: 'user', updatedAt: 3_000 })).toEqual({ ok: true });
            expect(registry.forgetEntry({ inventoryId: 'entry-1', updatedAt: 4_000 })).toMatchObject({ ok: true });
            const stored = annotations.read();
            expect(stored?.labelsByFallbackKey[0]?.[1][0]?.text).toBe('Latest');
            expect(stored?.forgottenFallbackKeys).toHaveLength(1);
            const restarted = createLocalServiceInventoryRegistry({ annotations });
            restarted.replaceSnapshot({ ...snapshot, generatedAt: 31 * 60_000 });
            expect(restarted.getSnapshot().entries).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('surfaces disk failure without publishing or retaining a failed annotation mutation', () => {
        const dir = mkdtempSync(join(tmpdir(), 'happier-inventory-annotations-failure-'));
        try {
            const blocker = join(dir, 'not-a-directory');
            writeFileSync(blocker, 'block writes');
            const annotations = createLocalServiceInventoryAnnotationsFileStore({ path: join(blocker, 'annotations.json') });
            const registry = createLocalServiceInventoryRegistry({ annotations });
            registry.replaceSnapshot(snapshot);
            const events: unknown[] = [];
            registry.subscribe((event) => events.push(event));
            expect(() => registry.applyLabelPatch({ inventoryId: 'entry-1', text: 'Failed', source: 'user', updatedAt: 2_000 })).toThrow();
            expect(() => registry.forgetEntry({ inventoryId: 'entry-1', updatedAt: 3_000 })).toThrow();
            registry.replaceSnapshot(snapshot);
            expect(registry.getSnapshot().entries).toEqual(snapshot.entries);
            expect(events).toHaveLength(1); // Only the later census, no acknowledged mutation.
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
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
        expect(first.forgetEntry({ inventoryId: 'entry-1', updatedAt: 2_000 })).toMatchObject({ ok: true });
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

    it('does not acknowledge a failed Undo write or revive an entry absent from the latest scan', () => {
        const stored = createAnnotationStoreDouble();
        let rejectWrites = false;
        const registry = createLocalServiceInventoryRegistry({ annotations: {
            read: stored.read,
            write: (next) => {
                if (rejectWrites) throw new Error('disk unavailable');
                stored.write(next);
            },
        } });
        registry.replaceSnapshot(snapshot);
        const forgotten = registry.forgetEntry({ inventoryId: 'entry-1', updatedAt: 2_000 });
        expect(forgotten.ok).toBe(true);
        if (!forgotten.ok) throw new Error('Forget must succeed');
        const events: unknown[] = [];
        registry.subscribe((event) => events.push(event));
        rejectWrites = true;
        expect(() => registry.undoForget(forgotten.undoKey)).toThrow('disk unavailable');
        expect(events).toEqual([]);
        expect(stored.read()?.forgottenFallbackKeys).toHaveLength(1);
        registry.replaceSnapshot({ ...snapshot, generatedAt: 3_000, entries: [] });
        rejectWrites = false;
        expect(registry.undoForget(forgotten.undoKey)).toEqual({ ok: true });
        expect(registry.getSnapshot().entries).toEqual([]);
        expect(stored.read()?.forgottenFallbackKeys).toEqual([]);
        registry.replaceSnapshot(snapshot);
        expect(registry.getSnapshot().entries).toHaveLength(1);
    });
});
