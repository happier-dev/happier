import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import {
    invalidateLocalServiceInventoryStore,
    resetLocalServiceInventoryStoreForTests,
} from './sharedStore';
import type { LocalServiceInventorySnapshot } from './store';
import type { LocalServiceInventorySnapshotClientResult } from './api';
import type { LocalServiceInventorySnapshotClient } from './useLocalServiceInventoryState';

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

describe('useLocalServiceInventoryState', () => {
    afterEach(() => {
        resetLocalServiceInventoryStoreForTests();
        vi.useRealTimers();
    });

    it('surfaces machine-RPC snapshot rows through the controller state', async () => {
        const mod = await import('./useLocalServiceInventoryState').catch(() => null);
        const store = await import('./store');

        expect(mod?.useLocalServiceInventoryStateController).toBeTypeOf('function');
        if (!mod?.useLocalServiceInventoryStateController) return;

        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => ({
            ok: true,
            snapshot,
        }));
        const hook = await renderHook(() => mod.useLocalServiceInventoryStateController({
            machineId: 'machine-a',
            serverId: 'server-a',
            snapshotClient,
            refreshIntervalMs: null,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a',
            serverId: 'server-a',
            refresh: true,
        }));
        expect(store.selectLocalServiceInventoryRows(hook.getCurrent().state)).toEqual(snapshot.entries);
    });

    it('falls closed to an empty list without throwing when the client is unavailable', async () => {
        const mod = await import('./useLocalServiceInventoryState').catch(() => null);
        const store = await import('./store');

        expect(mod?.useLocalServiceInventoryStateController).toBeTypeOf('function');
        if (!mod?.useLocalServiceInventoryStateController) return;

        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => ({
            ok: false,
            reason: 'unavailable',
        }));
        const hook = await renderHook(() => mod.useLocalServiceInventoryStateController({
            machineId: 'machine-a',
            serverId: 'server-a',
            snapshotClient,
            refreshIntervalMs: null,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(store.selectLocalServiceInventoryRows(hook.getCurrent().state)).toEqual([]);
        expect(hook.getCurrent().state.refreshState).toBe('error');
    });

    it('keeps already-hydrated rows visible when an invalidation refresh fails (UX continuity)', async () => {
        const mod = await import('./useLocalServiceInventoryState').catch(() => null);
        const store = await import('./store');

        expect(mod?.useLocalServiceInventoryStateController).toBeTypeOf('function');
        if (!mod?.useLocalServiceInventoryStateController) return;

        const snapshotClient: LocalServiceInventorySnapshotClient = vi.fn()
            .mockResolvedValueOnce({ ok: true as const, snapshot })
            .mockResolvedValueOnce({ ok: false as const, reason: 'request_failed' as const });
        const hook = await renderHook(() => mod.useLocalServiceInventoryStateController({
            machineId: 'machine-a',
            serverId: 'server-a',
            snapshotClient,
        }));

        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(store.selectLocalServiceInventoryRows(hook.getCurrent().state)).toEqual(snapshot.entries);

        await act(async () => {
            invalidateLocalServiceInventoryStore({ machineId: 'machine-a', serverId: 'server-a' });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(snapshotClient).toHaveBeenCalledTimes(2);
        // The transient failure marks an error but does not flash the hydrated list empty.
        expect(hook.getCurrent().state.refreshState).toBe('error');
        expect(store.selectLocalServiceInventoryRows(hook.getCurrent().state)).toEqual(snapshot.entries);
    });

    it('defaults the snapshot client to the machine-RPC inventory reader', async () => {
        const mod = await import('./useLocalServiceInventoryState').catch(() => null);
        const machineRpc = await import('./machineRpc');

        expect(mod?.useLocalServiceInventoryStateController).toBeTypeOf('function');
        if (!mod?.useLocalServiceInventoryStateController) return;

        const spy = vi.spyOn(machineRpc, 'fetchLocalServiceInventorySnapshotViaMachineRpc')
            .mockResolvedValue({ ok: false, reason: 'unavailable' });
        await renderHook(() => mod.useLocalServiceInventoryStateController({
            machineId: 'machine-a',
            serverId: 'server-a',
            refreshIntervalMs: null,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-a' }));
        spy.mockRestore();
    });
});
