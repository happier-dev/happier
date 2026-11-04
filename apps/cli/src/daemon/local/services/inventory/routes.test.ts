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
        const routes = createLocalServiceInventoryRoutes({ registry });

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

    it('does not re-arm during an idle minute and reconnects from the retained cursor', async () => {
        vi.useFakeTimers();
        const registry = createLocalServiceInventoryRegistry();
        registry.replaceSnapshot(snapshotAt(1_000));
        const routes = createLocalServiceInventoryRoutes({ registry });
        const disconnected = new AbortController();
        let dispatches = 0;
        let idleAnswerBytes = 0;
        const pending = (async () => {
            while (!disconnected.signal.aborted) {
                dispatches++;
                const result = await routes.watchSnapshot({ sinceGeneratedAt: 1_000, signal: disconnected.signal });
                if (!disconnected.signal.aborted) idleAnswerBytes += Buffer.byteLength(JSON.stringify(result));
                else expect(result).toEqual({ changed: false });
            }
        })();
        try {
            await vi.advanceTimersByTimeAsync(60_000);
            expect({ reArms: dispatches - 1, idleAnswerBytes }).toEqual({ reArms: 0, idleAnswerBytes: 0 });
            expect(routes.watcherCount()).toBe(1);
        } finally { disconnected.abort(); await pending; }
        expect(routes.watcherCount()).toBe(0);
        // The old request is cancelled by transport disconnect. A replacement
        // request catches changes made while disconnected without a timer.
        registry.replaceSnapshot(snapshotAt(2_000, 'entry-reconnected'));
        expect(await routes.watchSnapshot({ sinceGeneratedAt: 1_000 })).toEqual({ changed: true, snapshot: registry.getSnapshot() });
        const reconnected = new AbortController();
        const next = routes.watchSnapshot({ sinceGeneratedAt: 2_000, signal: reconnected.signal });
        registry.replaceSnapshot(snapshotAt(3_000, 'entry-live'));
        expect(await next).toEqual({ changed: true, snapshot: registry.getSnapshot() });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not miss a snapshot produced while demand starts before subscription', async () => {
        vi.useFakeTimers();
        const registry = createLocalServiceInventoryRegistry();
        registry.replaceSnapshot(snapshotAt(1_000));
        const routes = createLocalServiceInventoryRoutes({
            registry,
            onWatcherCountChanged(count) {
                if (count === 1) registry.replaceSnapshot(snapshotAt(2_000, 'entry-new'));
            },
        });

        const pending = routes.watchSnapshot({ sinceGeneratedAt: 1_000 });
        await vi.advanceTimersByTimeAsync(25_000);

        expect(await pending).toEqual({ changed: true, snapshot: registry.getSnapshot() });
        expect(routes.watcherCount()).toBe(0);
    });

    it('releases its watcher slot when the caller aborts', async () => {
        const registry = createLocalServiceInventoryRegistry();
        registry.replaceSnapshot(snapshotAt(1_000));
        const routes = createLocalServiceInventoryRoutes({ registry });
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
