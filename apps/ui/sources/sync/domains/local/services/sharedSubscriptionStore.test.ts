import { describe, expect, it, vi } from 'vitest';

import { createLocalServicesSharedSubscriptionStore } from './sharedSubscriptionStore';

type TestInput = Readonly<{
    machineId: string;
    serverId?: string | null;
}>;

type TestState = Readonly<{
    value: number;
    refreshes: number;
}>;

type TestSnapshot = Readonly<{ value: number }>;

describe('createLocalServicesSharedSubscriptionStore', () => {
    it('centralizes keyed subscribe, refresh, publish, and cleanup behavior', async () => {
        const snapshotClient = vi.fn(async () => ({ ok: true as const, snapshot: { value: 7 } }));
        const store = createLocalServicesSharedSubscriptionStore<
            TestInput,
            TestState,
            TestSnapshot,
            typeof snapshotClient
        >({
            emptyState: { value: 0, refreshes: 0 },
            createState: () => ({ value: 0, refreshes: 0 }),
            normalizeInput: (input) => ({ machineId: input.machineId, serverId: input.serverId ?? null }),
            storeKey: (input) => `${input.serverId ?? ''}::${input.machineId}`,
            defaultSnapshotClient: snapshotClient,
            refresh: async ({ state, snapshotClient: client }) => {
                const result = await client();
                return result.ok
                    ? { value: result.snapshot.value, refreshes: state.refreshes + 1 }
                    : { ...state, refreshes: state.refreshes + 1 };
            },
            applySnapshot: (state, snapshot) => ({ ...state, value: snapshot.value }),
        });
        const key = { machineId: 'machine-a', serverId: 'server-a' };
        const listener = vi.fn();

        const unsubscribeA = store.subscribe(key, listener, { snapshotClient });
        const unsubscribeB = store.subscribe(key, () => {}, { snapshotClient });
        await Promise.resolve();
        await Promise.resolve();

        expect(snapshotClient).toHaveBeenCalledTimes(1);
        expect(store.getState(key)).toEqual({ value: 7, refreshes: 1 });

        listener.mockClear();
        store.publish(key, { value: 11 });

        expect(listener).toHaveBeenCalledOnce();
        expect(store.getState(key)).toEqual({ value: 11, refreshes: 1 });

        unsubscribeA();
        unsubscribeB();
        expect(store.getState(key)).toEqual({ value: 0, refreshes: 0 });
    });
});
