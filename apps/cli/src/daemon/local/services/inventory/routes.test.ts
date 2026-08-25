import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLocalServiceInventoryRegistry } from './registry';
import { createLocalServiceInventoryRoutes } from './routes';

function snapshotAt(generatedAt: number, entryId = 'entry-1') {
    return {
        v: 1 as const,
        machineId: 'machine-a',
        generatedAt,
        refreshState: 'idle' as const,
        diagnostics: [],
        entries: [{
            id: entryId,
            machineId: 'machine-a',
            address: { kind: 'loopback' as const, host: '127.0.0.1', family: 'ipv4' as const },
            port: 5173,
            protocol: 'tcp' as const,
            detectedAt: generatedAt,
            lastSeenAt: generatedAt,
            state: 'listening' as const,
            source: 'detected' as const,
            labels: [],
            confidence: 'high' as const,
            processOwnershipConfidence: 'medium' as const,
            workspaceAssociationConfidence: 'high' as const,
            diagnostics: [],
        }],
    };
}

describe('createLocalServiceInventoryRoutes', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('reads snapshots and applies label patches through the inventory registry', async () => {
        const registry = createLocalServiceInventoryRegistry();
        registry.replaceSnapshot({
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
        });
        const routes = createLocalServiceInventoryRoutes({ registry });

        expect((await routes.getSnapshot()).entries).toHaveLength(1);
        expect(await routes.patchLabel({
            inventoryId: 'entry-1',
            label: { text: 'Web app' },
            source: 'user',
            now: 2_000,
        })).toEqual({ ok: true });
        expect((await routes.getSnapshot()).entries[0]?.labels.map((label) => label.text)).toEqual(['Web app']);
    });
    it('answers a watch immediately when it already has a snapshot newer than the caller holds', async () => {
        const registry = createLocalServiceInventoryRegistry();
        registry.replaceSnapshot(snapshotAt(2_000));
        const routes = createLocalServiceInventoryRoutes({ registry });

        const result = await routes.watchSnapshot({ sinceGeneratedAt: 1_000 });

        expect(result).toEqual({ changed: true, snapshot: registry.getSnapshot() });
        // Nothing parked, so the scan loop is not kept alive by a call that returned instantly.
        expect(routes.watcherCount()).toBe(0);
    });

    it('parks on the registry event producer and answers when the inventory changes', async () => {
        const registry = createLocalServiceInventoryRegistry();
        registry.replaceSnapshot(snapshotAt(1_000));
        const routes = createLocalServiceInventoryRoutes({ registry, watchWindowMs: 25_000 });

        const pending = routes.watchSnapshot({ sinceGeneratedAt: 1_000 });
        await Promise.resolve();
        expect(routes.watcherCount()).toBe(1);

        // A dev server starts: the next scan replaces the snapshot.
        registry.replaceSnapshot(snapshotAt(2_000, 'entry-2'));

        const result = await pending;
        expect(result.changed).toBe(true);
        expect(result.changed && result.snapshot.entries.map((entry) => entry.id)).toEqual(['entry-2']);
        expect(routes.watcherCount()).toBe(0);
    });

    it('holds the watch open for its whole window when nothing changes', async () => {
        vi.useFakeTimers();
        const registry = createLocalServiceInventoryRegistry();
        registry.replaceSnapshot(snapshotAt(1_000));
        const routes = createLocalServiceInventoryRoutes({ registry, watchWindowMs: 25_000 });

        const pending = routes.watchSnapshot({ sinceGeneratedAt: 1_000 });
        let settled = false;
        void pending.then(() => {
            settled = true;
        });

        // This is the contract the client relies on to re-arm without a timer or a backoff: an
        // answer means the window elapsed, so re-arming per answer cannot become a busy loop.
        await vi.advanceTimersByTimeAsync(24_000);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(await pending).toEqual({ changed: false });
        expect(routes.watcherCount()).toBe(0);
    });

    it('releases its watcher slot when the caller aborts', async () => {
        const registry = createLocalServiceInventoryRegistry();
        registry.replaceSnapshot(snapshotAt(1_000));
        const routes = createLocalServiceInventoryRoutes({ registry, watchWindowMs: 25_000 });
        const controller = new AbortController();

        const pending = routes.watchSnapshot({ sinceGeneratedAt: 1_000, signal: controller.signal });
        await Promise.resolve();
        expect(routes.watcherCount()).toBe(1);

        controller.abort();
        expect(await pending).toEqual({ changed: false });
        expect(routes.watcherCount()).toBe(0);
    });

    it('refreshes a stale snapshot for a reader that is not watching', async () => {
        const registry = createLocalServiceInventoryRegistry();
        registry.replaceSnapshot(snapshotAt(1_000));
        const ensureFreshSnapshot = vi.fn(async () => {
            registry.replaceSnapshot(snapshotAt(9_000, 'entry-fresh'));
        });
        const routes = createLocalServiceInventoryRoutes({ registry, ensureFreshSnapshot });

        const snapshot = await routes.getSnapshot();

        expect(ensureFreshSnapshot).toHaveBeenCalledTimes(1);
        expect(snapshot.entries.map((entry) => entry.id)).toEqual(['entry-fresh']);
    });
});
