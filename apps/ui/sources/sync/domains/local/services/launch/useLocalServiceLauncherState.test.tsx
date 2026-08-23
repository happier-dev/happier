import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook } from '@/dev/testkit';
import * as machineRpc from './machineRpc';
import { resetLocalServiceLauncherStoreForTests } from './sharedStore';
import type { LocalServiceLauncherSnapshotClient } from './useLocalServiceLauncherState';
import type { LocalServiceLauncherSnapshot } from './types';

const initialSnapshot = {
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

const startedSnapshot = {
    ...initialSnapshot,
    updatedAt: 2_000,
    targets: [{
        ...initialSnapshot.targets[0],
        state: 'starting',
        actions: [],
    }],
} satisfies LocalServiceLauncherSnapshot;

describe('useLocalServiceLauncherState', () => {
    afterEach(() => {
        resetLocalServiceLauncherStoreForTests();
        vi.restoreAllMocks();
    });

    it('drives the machine-RPC launcher reader when no snapshot client is injected', async () => {
        const mod = await import('./useLocalServiceLauncherState');

        const spy = vi.spyOn(machineRpc, 'fetchLocalServiceLauncherSnapshotViaMachineRpc')
            .mockResolvedValue({ ok: false, reason: 'unavailable' });
        await renderHook(() => mod.useLocalServiceLauncherStateController({
            machineId: 'machine-a',
            serverId: 'server-a',
            sessionId: 'session-a',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(spy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a',
            serverId: 'server-a',
        }));
    });

    it('lets the launcher state owner replace state from a successful Start response snapshot', async () => {
        const mod = await import('./useLocalServiceLauncherState').catch(() => null);
        const store = await import('./store');

        expect(mod?.useLocalServiceLauncherStateController).toBeTypeOf('function');
        if (!mod?.useLocalServiceLauncherStateController) return;

        const snapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: initialSnapshot,
        })) satisfies LocalServiceLauncherSnapshotClient;
        const hook = await renderHook(() => mod.useLocalServiceLauncherStateController({
            machineId: 'machine-a',
            sessionId: 'session-a',
            snapshotClient,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(store.selectLocalServiceLaunchTargets(hook.getCurrent().state)).toEqual(initialSnapshot.targets);

        await act(async () => {
            hook.getCurrent().applySnapshot(startedSnapshot);
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(store.selectLocalServiceLaunchTargets(hook.getCurrent().state)).toEqual(startedSnapshot.targets);
    });

    it('ignores externally applied Start snapshots for a different session', async () => {
        const mod = await import('./useLocalServiceLauncherState').catch(() => null);
        const store = await import('./store');

        expect(mod?.useLocalServiceLauncherStateController).toBeTypeOf('function');
        if (!mod?.useLocalServiceLauncherStateController) return;

        const snapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: initialSnapshot,
        })) satisfies LocalServiceLauncherSnapshotClient;
        const hook = await renderHook(() => mod.useLocalServiceLauncherStateController({
            machineId: 'machine-a',
            sessionId: 'session-a',
            snapshotClient,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        const otherSessionSnapshot = {
            ...startedSnapshot,
            sessionId: 'session-b',
        } satisfies LocalServiceLauncherSnapshot;

        await act(async () => {
            hook.getCurrent().applySnapshot(otherSessionSnapshot);
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(store.selectLocalServiceLaunchTargets(hook.getCurrent().state)).toEqual(initialSnapshot.targets);
    });
});
