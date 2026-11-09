import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createMachineFixture, createSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createWorkspaceSyncHarness } from '@/dev/testkit/harness/workspaceSyncHarness';
import { observeMachinePresenceForTest } from '@/dev/testkit/harness/machinePresence';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';

vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

// The daemon's Socket.IO reply is the boundary; the probe and scoped Machine RPC stay real.
const daemon = {
    probes: [] as string[],
    reply: (): unknown => new Promise<never>(() => undefined),
};
const home = createWorkspaceSyncHarness(input => {
    if (input.method !== RPC_METHODS.CAPABILITIES_DESCRIBE) throw new Error(`Unexpected RPC: ${input.method}`);
    daemon.probes.push(input.machineId);
    return daemon.reply();
});
await home.ready;
const {
    invalidateCachedTransferRoutesForServer,
    recordCachedMachineRpcDirectRouteUnavailable,
    recordCachedMachineRpcDirectRouteViable,
} = await import('@/sync/domains/transfers/runtime/transferRouteCache');
const { useSessionHandoffSourceReachability } = await import('./useSessionHandoffSourceReachability');
const { useSessionHandoffAction } = await import('./useSessionHandoffAction');
const { storage } = await import('@/sync/domains/state/storage');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { Modal } = await import('@/modal');

const failProbe = () => { throw new Error('source daemon unavailable'); };

describe('useSessionHandoffSourceReachability', () => {
    beforeEach(async () => {
        await home.reset();
        daemon.probes.length = 0;
        daemon.reply = () => new Promise<never>(() => undefined);
        invalidateCachedTransferRoutesForServer({ serverId: home.serverId });
        vi.mocked(Modal.show).mockClear();
        vi.mocked(Modal.alert).mockClear();
    });

    afterEach(async () => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        standardCleanup();
        invalidateCachedTransferRoutesForServer({ serverId: home.serverId });
        await home.dispose();
    });

    it('downgrades from reachable to unknown when the server-scoped cache is invalidated', async () => {
        recordCachedMachineRpcDirectRouteViable({ serverId: home.serverId, remoteMachineId: 'unknown-machine' });

        const hook = await renderHook(() => useSessionHandoffSourceReachability({
            serverId: home.serverId,
            sourceMachineId: 'unknown-machine',
        }));

        expect(hook.getCurrent()).toBe('reachable');

        await act(async () => {
            invalidateCachedTransferRoutesForServer({ serverId: home.serverId });
        });

        expect(hook.getCurrent()).toBe('unknown');

        await hook.unmount();
    });

    it('retains unavailable direct-route evidence without suppressing a pushed online source', async () => {
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-b', active: false, activeAt: Date.now() })], false,
            { sourceServerId: home.serverId, sourceAccountId: home.accountId });
        observeMachinePresenceForTest({ serverId: home.serverId, accountId: home.accountId }, ['machine-b']);
        recordCachedMachineRpcDirectRouteUnavailable({ serverId: home.serverId, remoteMachineId: 'machine-b' },
            'machine_rpc_direct_unavailable');

        const hook = await renderHook(() => useSessionHandoffSourceReachability({
            serverId: home.serverId,
            sourceMachineId: 'machine-b',
        }));
        await act(async () => { await Promise.resolve(); });

        expect(hook.getCurrent()).toBe('unavailable');
        expect(daemon.probes).toEqual([]);

        await act(async () => {
            storage.getState().applyMachines([createMachineFixture({ id: 'machine-b', active: true, activeAt: Date.now() })], false,
                { sourceServerId: home.serverId, sourceAccountId: home.accountId });
            observeMachinePresenceForTest({ serverId: home.serverId, accountId: home.accountId }, ['machine-b']);
        });
        expect(hook.getCurrent()).toBe('reachable');
        expect(daemon.probes).toEqual([]);

        await hook.unmount();
    });

    it('opens and remains idle without probing, then follows pushed source presence in both directions', async () => {
        daemon.reply = failProbe;
        vi.useFakeTimers();
        const scope = { serverId: home.serverId, accountId: home.accountId };
        const publish = (active: boolean) => {
            storage.getState().applyMachines([createMachineFixture({ id: 'machine-c', active, activeAt: Date.now() })], false,
                { sourceServerId: home.serverId, sourceAccountId: home.accountId });
            observeMachinePresenceForTest(scope, ['machine-c']);
        };
        publish(false);
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useSessionHandoffSourceReachability({ serverId: home.serverId, sourceMachineId: 'machine-c' });
        });
        const settledRenders = renders;
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(daemon.probes).toEqual([]);
        expect(renders).toBe(settledRenders);
        expect(hook.getCurrent()).toBe('unavailable');
        await act(async () => publish(true));
        expect(hook.getCurrent()).toBe('reachable');
        await act(async () => publish(false));
        expect(hook.getCurrent()).toBe('unavailable');
        expect(daemon.probes).toEqual([]);
        await hook.unmount();
    });

    it.each(['session_action_menu', 'session_info'] as const)('probes only when Handoff is pressed at %s and visibly fails before opening a picker', async placement => {
        const features = createRootLayoutFeaturesResponse();
        for (const id of ['sessions', 'sessions.handoff', 'machines', 'machines.transfer', 'machines.transfer.directPeer'] as const) {
            expect(tryWriteServerEnabledBitInPlace(features, id, true)).toBe(true);
        }
        expect(tryWriteServerEnabledBitInPlace(features, 'machines.transfer.serverRouted', false)).toBe(true);
        primeServerFeaturesSnapshot({ serverId: home.serverId, snapshot: { status: 'ready', features } });
        const session = createSessionFixture({ id: 'handoff-session', serverId: home.serverId,
            metadata: { machineId: 'machine-a', path: '/repo', host: 'source' } });
        const execute = vi.fn(async () => ({ ok: false as const, errorCode: 'unexpected', error: 'Unexpected transfer' }));
        daemon.reply = () => ({});
        const publish = (active: boolean) => {
            storage.getState().applyMachines([createMachineFixture({ id: 'machine-a', active, activeAt: Date.now() })], false,
                { sourceServerId: home.serverId, sourceAccountId: home.accountId });
            observeMachinePresenceForTest({ serverId: home.serverId, accountId: home.accountId }, ['machine-a']);
        };
        publish(false);
        const hook = await renderHook(() => useSessionHandoffAction({ sessionId: session.id, session, serverId: home.serverId,
            reachableMachineId: 'machine-a', sessionHandoffFeatureEnabled: true, execute, placement }));
        expect(daemon.probes).toEqual([]);
        expect(hook.getCurrent().availability.available).toBe(false);
        await act(async () => publish(true));
        expect(hook.getCurrent().availability).toEqual({ available: true, reason: 'available' });
        let run!: ReturnType<ReturnType<typeof useSessionHandoffAction>['run']>;
        await act(async () => { run = hook.getCurrent().run(); });
        await vi.waitFor(() => expect(Modal.show).toHaveBeenCalledOnce());
        expect(daemon.probes).toEqual(['machine-a']);
        vi.mocked(Modal.show).mock.calls[0]?.[0].onRequestClose?.();
        await expect(run).resolves.toBeNull();
        vi.mocked(Modal.show).mockClear();
        daemon.probes.length = 0;
        daemon.reply = failProbe;
        await act(async () => { await hook.getCurrent().run(); });
        expect(daemon.probes).toEqual(['machine-a']);
        expect(Modal.alert).toHaveBeenCalledOnce();
        expect(Modal.show).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
