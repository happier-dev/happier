import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocalServiceLauncherSnapshotClientResult } from './api';
import {
    getLocalServiceLauncherState,
    publishLocalServiceLauncherSnapshot,
    resetLocalServiceLauncherStoreForTests,
    subscribeLocalServiceLauncherStore,
} from './sharedStore';
import { expectNoWallClockPolling } from '../noPollingTestHelpers';
import { selectLocalServiceLaunchTargets } from './store';
import type { LocalServiceLauncherSnapshot } from './types';

const snapshot = {
    v: 1,
    machineId: 'machine-a',
    sessionId: 'session-a',
    updatedAt: 1_000,
    targets: [{
        id: 'managed:preview',
        source: 'managed_service',
        sourceClass: { kind: 'managed_service', managedServiceId: 'preview' },
        machineId: 'machine-a',
        sessionId: 'session-a',
        title: 'Preview',
        confidence: 'medium',
        state: 'available',
        actions: ['start'],
    }],
} satisfies LocalServiceLauncherSnapshot;

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('shared local-service launcher store', () => {
    afterEach(() => {
        resetLocalServiceLauncherStoreForTests();
    });

    it('fetches once for a key regardless of how many consumers subscribe', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServiceLauncherSnapshotClientResult> => ({
            ok: true,
            snapshot,
        }));
        const key = {
            machineId: 'machine-a',
            serverId: 'server-a',
            sessionId: 'session-a',
            scope: 'workspace' as const,
            workspaceRoot: '/repo',
        };

        const unsubA = subscribeLocalServiceLauncherStore(key, () => {}, { snapshotClient });
        const unsubB = subscribeLocalServiceLauncherStore(key, () => {}, { snapshotClient });
        await flushMicrotasks();

        expect(snapshotClient).toHaveBeenCalledTimes(1);
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toEqual(snapshot.targets);

        unsubA();
        unsubB();
    });

    it('publishes action snapshots into the same backing model without polling', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServiceLauncherSnapshotClientResult> => ({
            ok: true,
            snapshot: { ...snapshot, targets: [] },
        }));
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const listener = vi.fn();

        const unsub = subscribeLocalServiceLauncherStore(key, listener, { snapshotClient });
        await flushMicrotasks();
        listener.mockClear();

        publishLocalServiceLauncherSnapshot(key, snapshot);

        expect(listener).toHaveBeenCalled();
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toEqual(snapshot.targets);
        expect(snapshotClient).toHaveBeenCalledTimes(1);

        unsub();
    });

    it('does not re-fetch launch targets on a wall clock while subscribed', async () => {
        const snapshotClient = vi.fn(async (): Promise<LocalServiceLauncherSnapshotClientResult> => ({
            status: 'ok',
            snapshot,
        }));

        await expectNoWallClockPolling({
            subscribe: () => subscribeLocalServiceLauncherStore(key, () => {}, { snapshotClient }),
            fetchSpy: snapshotClient,
        });
    });
});
