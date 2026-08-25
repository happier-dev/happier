import { afterEach, describe, expect, it, vi } from 'vitest';

import { expectNoWallClockPolling } from '../noPollingTestHelpers';
import type { LocalServiceInventorySnapshotClientResult } from './api';
import {
    getLocalServiceInventoryState,
    invalidateLocalServiceInventoryStore,
    publishLocalServiceInventorySnapshot,
    resetLocalServiceInventoryStoreForTests,
    subscribeLocalServiceInventoryStore,
} from './sharedStore';
import { selectLocalServiceInventoryRows, type LocalServiceInventorySnapshot } from './store';

const snapshot = {
    v: 1,
    machineId: 'machine-a',
    generatedAt: 1_000,
    refreshState: 'idle',
    entries: [{
        id: 'vite-5173',
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
    diagnostics: [],
} satisfies LocalServiceInventorySnapshot;

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('shared local-service inventory store', () => {
    afterEach(() => {
        resetLocalServiceInventoryStoreForTests();
    });

    it('fetches once for a key regardless of how many consumers subscribe', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => ({
            ok: true,
            snapshot,
        }));
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };

        const unsubA = subscribeLocalServiceInventoryStore(key, () => {}, { snapshotClient });
        const unsubB = subscribeLocalServiceInventoryStore(key, () => {}, { snapshotClient });
        await flushMicrotasks();

        expect(snapshotClient).toHaveBeenCalledTimes(1);
        expect(selectLocalServiceInventoryRows(getLocalServiceInventoryState(key))).toEqual(snapshot.entries);

        unsubA();
        unsubB();
    });

    it('publishes action-read snapshots into the same backing model without polling', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => ({
            ok: true,
            snapshot: { ...snapshot, entries: [] },
        }));
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const listener = vi.fn();

        const unsub = subscribeLocalServiceInventoryStore(key, listener, { snapshotClient });
        await flushMicrotasks();
        listener.mockClear();

        publishLocalServiceInventorySnapshot(key, snapshot);

        expect(listener).toHaveBeenCalled();
        expect(selectLocalServiceInventoryRows(getLocalServiceInventoryState(key))).toEqual(snapshot.entries);
        expect(snapshotClient).toHaveBeenCalledTimes(1);

        unsub();
    });

    it('does not fabricate a daemon generation when a refresh fails', async () => {
        // F-1: the same lying-generation defect the refresh-STARTED path had, on the failure path.
        // A failed read produces no daemon generation — the rows on screen are still the last real
        // one's. Stamping the client clock here re-creates both consequences: the surface host sees
        // a phantom "the daemon rescanned" and re-reads the launcher feed, and the watch's
        // `sinceGeneratedAt` cursor becomes a client clock reading the daemon cannot compare.
        let succeed = true;
        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => (
            succeed ? { ok: true, snapshot } : { ok: false, reason: 'unavailable' }
        ));
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };

        const unsub = subscribeLocalServiceInventoryStore(key, () => {}, { snapshotClient });
        await flushMicrotasks();
        expect(getLocalServiceInventoryState(key).generatedAt).toBe(1_000);

        succeed = false;
        invalidateLocalServiceInventoryStore(key);
        await flushMicrotasks();

        const failed = getLocalServiceInventoryState(key);
        expect(failed.refreshState).toBe('error');
        // Keep-last-good still holds, and the generation still names the snapshot those rows are from.
        expect(selectLocalServiceInventoryRows(failed)).toEqual(snapshot.entries);
        expect(failed.generatedAt).toBe(1_000);

        unsub();
    });

    it('does not re-fetch the inventory on a wall clock while subscribed', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => ({
            ok: true,
            snapshot,
        }));
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };

        await expectNoWallClockPolling({
            subscribe: () => subscribeLocalServiceInventoryStore(key, () => {}, { snapshotClient }),
            fetchSpy: snapshotClient,
        });
    });
});
