import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import {
    invalidateLocalServiceInventoryStore,
    resetLocalServiceInventoryStoreForTests,
} from './sharedStore';
import type { LocalServiceInventorySnapshot } from './store';
import type {
    LocalServiceInventorySnapshotClientResult,
    LocalServiceInventoryWatchClientResult,
} from './api';
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
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(spy).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-a' }));
        spy.mockRestore();
    });
    it('surfaces a service started after mount through the daemon inventory watch (no poll)', async () => {
        const mod = await import('./useLocalServiceInventoryState');
        const store = await import('./store');

        const emptySnapshot = { ...snapshot, entries: [] } satisfies LocalServiceInventorySnapshot;
        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => ({
            ok: true,
            snapshot: emptySnapshot,
        }));
        let answerWatch: ((result: LocalServiceInventoryWatchClientResult) => void) | null = null;
        const watchClient = vi.fn(async () => await new Promise<LocalServiceInventoryWatchClientResult>((resolve) => {
            answerWatch = resolve;
        }));

        const hook = await renderHook(() => mod.useLocalServiceInventoryStateController({
            machineId: 'machine-a',
            serverId: 'server-a',
            snapshotClient,
            watchClient,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(store.selectLocalServiceInventoryRows(hook.getCurrent().state)).toEqual([]);
        expect(answerWatch).toBeTypeOf('function');

        // The dev server starts here: the daemon answers the parked watch with the new snapshot.
        await act(async () => {
            answerWatch?.({ ok: true, changed: true, snapshot });
            await Promise.resolve();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(store.selectLocalServiceInventoryRows(hook.getCurrent().state)).toEqual(snapshot.entries);
        // Freshness came from the parked watch, not from a second snapshot fetch.
        expect(snapshotClient).toHaveBeenCalledTimes(1);
    });

    it('re-arms one watch per answer and never schedules a refresh timer', async () => {
        vi.useFakeTimers();
        const mod = await import('./useLocalServiceInventoryState');

        const snapshotClient = vi.fn(async (): Promise<LocalServiceInventorySnapshotClientResult> => ({
            ok: true,
            snapshot,
        }));
        const watchClient = vi.fn(async (): Promise<LocalServiceInventoryWatchClientResult> => ({
            ok: true,
            changed: false,
        }));

        await renderHook(() => mod.useLocalServiceInventoryStateController({
            machineId: 'machine-a',
            serverId: 'server-a',
            snapshotClient,
            watchClient,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        const watchCallsAfterMount = watchClient.mock.calls.length;
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10 * 60_000);
        });

        // No interval anywhere: the only refetch pressure is the daemon answering a parked watch.
        expect(snapshotClient).toHaveBeenCalledTimes(1);
        expect(watchClient.mock.calls.length).toBeGreaterThanOrEqual(watchCallsAfterMount);
    });

    it('invalidates on app foreground so a service started while the app was backgrounded appears', async () => {
        const mod = await import('./useLocalServiceInventoryState');
        const store = await import('./store');
        const appState = await import('react-native').then((rn) => rn.AppState);

        const emptySnapshot = { ...snapshot, entries: [] } satisfies LocalServiceInventorySnapshot;
        const snapshotClient = vi.fn<[], Promise<LocalServiceInventorySnapshotClientResult>>()
            .mockResolvedValueOnce({ ok: true, snapshot: emptySnapshot })
            .mockResolvedValue({ ok: true, snapshot });

        const listeners: Array<(status: string) => void> = [];
        const addEventListener = vi.spyOn(appState, 'addEventListener').mockImplementation(((
            _type: string,
            listener: (status: string) => void,
        ) => {
            listeners.push(listener);
            return { remove: () => {} };
        }) as unknown as typeof appState.addEventListener);

        const hook = await renderHook(() => mod.useLocalServiceInventoryStateController({
            machineId: 'machine-a',
            serverId: 'server-a',
            snapshotClient,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(store.selectLocalServiceInventoryRows(hook.getCurrent().state)).toEqual([]);
        expect(listeners.length).toBeGreaterThan(0);

        await act(async () => {
            for (const listener of listeners) listener('active');
            await Promise.resolve();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(store.selectLocalServiceInventoryRows(hook.getCurrent().state)).toEqual(snapshot.entries);
        addEventListener.mockRestore();
    });
});
