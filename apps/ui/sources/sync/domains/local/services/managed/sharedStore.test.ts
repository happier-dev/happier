import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalServiceManagedSnapshotClientResult } from './api';
import {
    getManagedLocalServicesState,
    publishManagedLocalServicesSnapshot,
    resetManagedLocalServicesStoreForTests,
    subscribeManagedLocalServicesStore,
} from './sharedStore';
import { expectNoWallClockPolling } from '../noPollingTestHelpers';
import { selectManagedLocalServiceRows, type ManagedLocalServicesSnapshot } from './store';

const snapshot = {
    machineId: 'machine-a',
    generatedAt: 1_000,
    refreshState: 'idle',
    rows: [{
        id: 'managed-preview',
        phase: 'running',
        launchMode: 'detectAfterLaunch',
        supportedActions: ['stop_managed'],
        diagnostics: [],
        updatedAt: 1_000,
    }],
    diagnostics: [],
} satisfies ManagedLocalServicesSnapshot;

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('shared managed local-services store', () => {
    afterEach(() => {
        resetManagedLocalServicesStoreForTests();
    });

    it('fetches once for a key regardless of how many consumers subscribe', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServiceManagedSnapshotClientResult> => ({
            ok: true,
            snapshot,
        }));
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };

        const unsubA = subscribeManagedLocalServicesStore(key, () => {}, { snapshotClient });
        const unsubB = subscribeManagedLocalServicesStore(key, () => {}, { snapshotClient });
        await flushMicrotasks();

        expect(snapshotClient).toHaveBeenCalledTimes(1);
        expect(selectManagedLocalServiceRows(getManagedLocalServicesState(key))).toEqual(snapshot.rows);

        unsubA();
        unsubB();
    });

    it('publishes snapshots into the same backing model without polling', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServiceManagedSnapshotClientResult> => ({
            ok: true,
            snapshot: { ...snapshot, rows: [] },
        }));
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const listener = vi.fn();

        const unsub = subscribeManagedLocalServicesStore(key, listener, { snapshotClient });
        await flushMicrotasks();
        listener.mockClear();

        publishManagedLocalServicesSnapshot(key, snapshot);

        expect(listener).toHaveBeenCalled();
        expect(selectManagedLocalServiceRows(getManagedLocalServicesState(key))).toEqual(snapshot.rows);
        expect(snapshotClient).toHaveBeenCalledTimes(1);

        unsub();
    });

    it('does not re-fetch managed services on a wall clock while subscribed', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServiceManagedSnapshotClientResult> => ({
            status: 'ok',
            snapshot,
        }));

        await expectNoWallClockPolling({
            subscribe: () => subscribeManagedLocalServicesStore(key, () => {}, { snapshotClient }),
            fetchSpy: snapshotClient,
        });
    });
});
