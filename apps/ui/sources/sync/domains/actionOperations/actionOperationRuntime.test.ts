import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, createMachineFixture, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import { ActionOperationSnapshotV1Schema, MachineServiceRowV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol';
import { ACTION_OPERATION_RPC_METHODS_V2, projectActionOperationSnapshotForV1Reader } from '@happier-dev/protocol/actions/operations/v1';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { listActionOperations, type ActionOperationRpc } from '@/sync/ops/actionOperations';
import { createDeferred, flushHookEffects } from '@/dev/testkit';
import { clearMachineRequestReachabilityForMachine } from '@/sync/domains/machines/reachability/machineReachability';

const transport = vi.hoisted(() => ({ call: vi.fn() }));
// The daemon RPC is the system boundary; reconciliation, schemas and recovery stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(transport.call);
});

import { createActionOperationStore } from './actionOperationStore';
import { createActionOperationSelectors } from './actionOperationSelectors';
import { actionOperationAddressKey, actionOperationMachineAddressKey } from './qualifiedActionOperation';
import {
    bindActionOperationRuntimeToAccountLifetime,
    ActionOperationRuntime,
    reconcileActionOperationsOnce,
    createActionOperationRuntimeCoordinator,
    type ActionOperationMachineRuntimeScope,
} from './actionOperationRuntime';

const scope: ActionOperationMachineRuntimeScope = {
    accountId: 'account-1',
    machineId: 'machine-1',
    serverId: 'server-1',
};

function operation(overrides: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    return {
        version: 1,
        operationId: 'operation-1',
        revision: 1,
        actionId: 'session.spawn_new',
        state: 'accepted',
        scope: {
            accountId: scope.accountId,
            machineId: scope.machineId,
        },
        title: 'Create session',
        createdAt: 1_000,
        cancellation: 'unsupported',
        ...overrides,
    };
}

describe('action operation observation runtime', () => {
    it('settles the surviving reboot holder from changed boot and restored healthless services, without polling or losing its result', async () => {
        const store = createActionOperationStore();
        const reboot = ActionOperationSnapshotV1Schema.parse({ ...operation(), actionId: 'machines.reboot', state: 'running', startedAt: 1000,
            domainRef: { kind: 'machineReboot', serverId: scope.serverId, machineId: scope.machineId, installationId: 'installation',
                task: { id: 'task', taskKind: 'machine.reboot.v1' }, basis: { bootedAt: 1000,
                    expectedRunningServiceIds: ['worker'], expectedRunningServicesKnown: true, dispatchStarted: true } } });
        store.mergeSnapshots({ serverId: scope.serverId, snapshots: [reboot] });
        const restored = MachineServiceRowV1Schema.parse({ serviceId: 'worker', name: 'Worker', authority: 'project',
            lifecyclePurpose: 'development', generation: 'new-generation', state: 'running',
            native: { phase: 'running', readiness: 'not_reported' },
            capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false } });
        // External Machine reads only: the new daemon has no old operation, and
        // ordinary admitted facts describe its actual new boot/services.
        const rpc = (async () => ({ items: [], nextCursor: null })) as ActionOperationRpc;
        const facts = vi.fn(async () => ({ installationId: 'installation', bootedAt: 2000, services: [restored] }));
        const params = { scope, store, list: (input: Parameters<typeof listActionOperations>[0]) => listActionOperations({ ...input, rpc }),
            readRebootFacts: facts };
        await reconcileActionOperationsOnce(params);
        const selectors = createActionOperationSelectors();
        expect(selectors.selectById(store.getSnapshot(), { serverId: scope.serverId, operationId: reboot.operationId }))
            .toMatchObject({ snapshot: { state: 'succeeded', progress: { phase: 'reboot.restored_unverified' } }, observation: 'available' });
        let publications = 0;
        const release = store.subscribe(() => { publications++; });
        await reconcileActionOperationsOnce(params);
        expect(selectors.selectById(store.getSnapshot(), { serverId: scope.serverId, operationId: reboot.operationId })?.snapshot.state).toBe('succeeded');
        expect(publications).toBe(0);
        expect(facts).toHaveBeenCalledTimes(1);
        release();
    });
    it.each(['missing-service', 'different-installation', 'same-boot', 'unknown-current-boot', 'unknown-before-facts', 'failed-service', 'not-ready', 'unavailable-facts'] as const)(
        'keeps lost reboot outcome explicitly unknown for %s and equal observations publish nothing', async condition => {
            const store = createActionOperationStore();
            const reboot = ActionOperationSnapshotV1Schema.parse({ ...operation(), actionId: 'machines.reboot', state: 'running', startedAt: 1000,
                domainRef: { kind: 'machineReboot', serverId: scope.serverId, machineId: scope.machineId, installationId: 'installation',
                    task: { id: 'task', taskKind: 'machine.reboot.v1' }, basis: { bootedAt: 1000,
                        expectedRunningServiceIds: ['worker'], expectedRunningServicesKnown: condition !== 'unknown-before-facts', dispatchStarted: true } } });
            store.mergeSnapshots({ serverId: scope.serverId, snapshots: [reboot] });
            const row = MachineServiceRowV1Schema.parse({ serviceId: 'worker', name: 'Worker', authority: 'project',
                lifecyclePurpose: 'development', generation: 'new-generation', state: condition === 'failed-service' ? 'failed' : 'running',
                native: { phase: 'running', readiness: condition === 'not-ready' ? 'not_ready' : 'not_reported' },
                capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false } });
            const rpc = (async () => ({ items: [], nextCursor: null })) as ActionOperationRpc;
            const params = { scope, store, list: (input: Parameters<typeof listActionOperations>[0]) => listActionOperations({ ...input, rpc }),
                readRebootFacts: async () => ({ installationId: condition === 'different-installation' ? 'replacement' : 'installation',
                    bootedAt: condition === 'unknown-current-boot' ? null : condition === 'same-boot' ? 1000 : 2000,
                    services: condition === 'missing-service' ? [] : condition === 'unavailable-facts' ? null : [row] }) };
            await reconcileActionOperationsOnce(params);
            const retained = () => createActionOperationSelectors().selectById(store.getSnapshot(), { serverId: scope.serverId, operationId: reboot.operationId });
            expect(retained()).toMatchObject({ snapshot: { state: 'running', observation: { kind: 'outcome_uncertain', code: 'action_outcome_unknown' } }, observation: 'unavailable' });
            let publications = 0;
            const release = store.subscribe(() => { publications++; });
            await reconcileActionOperationsOnce(params);
            expect(publications).toBe(0);
            release();
        },
    );
    it('hydrates retained setup after a pushed Machine recovery, sharing bursts and stopping retired reads without polling', async () => {
        const { actionOperationStore } = await import('./actionOperationStore');
        actionOperationStore.reset();
        transport.call.mockReset();
        const retained = operation({ actionId: 'projects.prepare', state: 'failed', startedAt: 1_000, settledAt: 1_001,
            error: { errorCode: 'project_setup_step_failed', error: 'Setup failed' }, domainRef: {
                kind: 'projectCommand', purpose: 'setup', serverId: scope.serverId, machineId: scope.machineId,
                workspaceRefId: 'workspace', cwd: '/project', terminalId: 'output', exitCode: 1,
            } });
        const recovery = createDeferred<{ items: ActionOperationSnapshotV1[]; nextCursor: null }>();
        transport.call.mockRejectedValueOnce(Object.assign(new Error('Transport disconnected'), { rpcErrorCode: 'MACHINE_RPC_UNREACHABLE' }))
            .mockReturnValueOnce(recovery.promise).mockResolvedValue({ items: [retained], nextCursor: null });
        const coordinator = createActionOperationRuntimeCoordinator();
        const address = actionOperationAddressKey({ serverId: scope.serverId, operationId: retained.operationId });
        const observation = () => actionOperationStore.getSnapshot().machineObservationByKey.get(actionOperationMachineAddressKey(scope));
        try {
            coordinator.reconcile([scope]);
            await flushHookEffects();
            expect(observation()).toBe('reconnecting');
            expect(transport.call).toHaveBeenCalledTimes(1);
            clearMachineRequestReachabilityForMachine({ ...scope, accountId: 'other-account' }, scope.machineId);
            clearMachineRequestReachabilityForMachine(scope, 'other-machine');
            await flushHookEffects();
            expect(transport.call).toHaveBeenCalledTimes(1);
            clearMachineRequestReachabilityForMachine(scope, scope.machineId);
            await flushHookEffects();
            expect(transport.call).toHaveBeenCalledTimes(2);
            for (let arrival = 0; arrival < 100; arrival++) clearMachineRequestReachabilityForMachine(scope, scope.machineId);
            await flushHookEffects();
            expect(transport.call).toHaveBeenCalledTimes(2);
            recovery.resolve({ items: [retained], nextCursor: null });
            await flushHookEffects();
            expect(actionOperationStore.getSnapshot().operationsByKey.get(address)?.snapshot).toEqual(retained);
            expect(observation()).toBe('available');
            // A recovery during a pending read needs one fresh reconciliation, never one per wake.
            expect(transport.call).toHaveBeenCalledTimes(3);
            const published = actionOperationStore.getSnapshot();
            vi.useFakeTimers();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(transport.call).toHaveBeenCalledTimes(3);
            expect(actionOperationStore.getSnapshot()).toBe(published);
            vi.useRealTimers();
            const retired = createDeferred<{ items: ActionOperationSnapshotV1[]; nextCursor: null }>();
            transport.call.mockReturnValueOnce(retired.promise);
            clearMachineRequestReachabilityForMachine(scope, scope.machineId);
            await flushHookEffects();
            const signal = transport.call.mock.calls.at(-1)?.[0].signal as AbortSignal;
            coordinator.stopAll();
            expect(signal.aborted).toBe(true);
            retired.resolve({ items: [], nextCursor: null });
            clearMachineRequestReachabilityForMachine(scope, scope.machineId);
            await flushHookEffects();
            expect(actionOperationStore.getSnapshot()).toBe(published);
            expect(transport.call).toHaveBeenCalledTimes(4);
        } finally {
            vi.useRealTimers();
            coordinator.stopAll();
            actionOperationStore.reset();
        }
    });
    it('does not commit its mounted runtime when visible Machine details change without membership changes', async () => {
        const previous = storage.getState();
        const serverId = getActiveServerSnapshot().serverId;
        let machine = createMachineFixture({ id: 'quiet-operation-machine', activeAt: Date.now() });
        const publish = () => storage.setState({
            profileScope: null,
            machines: { [machine.id]: machine },
            machineListByServerId: { [serverId]: [machine] },
        });
        let commits = 0;
        publish();
        const screen = await renderScreen(React.createElement(React.Profiler, {
            id: 'operation-runtime', onRender: () => { commits++; },
        }, React.createElement(ActionOperationRuntime)));
        try {
            const before = commits;
            for (let tick = 1; tick <= 5; tick++) {
                machine = { ...machine, updatedAt: machine.updatedAt + 1, daemonStateVersion: tick };
                await act(async () => publish());
            }
            expect(commits - before).toBe(0);
        } finally {
            await screen.unmount();
            storage.setState(previous, true);
        }
    });

    it.each(['retained before reconnect', 'arrives during predecessor read'] as const)(
        'preserves current rich facts when they are %s and V2 is unavailable', async timing => {
            const store = createActionOperationStore();
            const rich = operation({ actionId: 'projects.script.run', domainRef: {
                kind: 'projectCommand', purpose: 'script', serverId: scope.serverId, machineId: scope.machineId,
                workspaceRefId: 'workspace', cwd: '/project',
            } });
            if (timing === 'retained before reconnect') store.mergeSnapshots({ serverId: scope.serverId, snapshots: [rich] });
            const rpc = (async ({ method }: Parameters<ActionOperationRpc>[0]) => {
                if (method === ACTION_OPERATION_RPC_METHODS_V2.list) return {
                    error: 'Method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
                };
                // Network list completion races a real current push/store update.
                if (timing === 'arrives during predecessor read') store.mergeSnapshots({ serverId: scope.serverId, snapshots: [rich] });
                return { items: [projectActionOperationSnapshotForV1Reader({ ...rich, revision: 2 })], nextCursor: null };
            }) as ActionOperationRpc;
            await expect(reconcileActionOperationsOnce({ scope, store,
                list: params => listActionOperations({ ...params, rpc }),
            })).rejects.toMatchObject({ rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE });
            expect(store.getSnapshot().operationsByKey.get(actionOperationAddressKey({
                serverId: scope.serverId, operationId: rich.operationId,
            }))?.snapshot).toStrictEqual(rich);
        },
    );

    it('retains ordinary predecessor reconciliation while qualifying its Account', async () => {
        const store = createActionOperationStore();
        const accepted = operation();
        const rpc = (async request => {
            expect(request).toMatchObject({ accountId: scope.accountId, machineId: scope.machineId, serverId: scope.serverId });
            return request.method === ACTION_OPERATION_RPC_METHODS_V2.list
                ? { error: 'Method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }
                : { items: [accepted], nextCursor: null };
        }) as ActionOperationRpc;
        await reconcileActionOperationsOnce({ scope, store, list: params => listActionOperations({ ...params, rpc }) });
        expect([...store.getSnapshot().operationsByKey.values()]).toStrictEqual([{ serverId: scope.serverId, snapshot: accepted }]);
    });

    it('hydrates list pages once and leaves later revisions to pushed observations', async () => {
        const store = createActionOperationStore();
        const accepted = operation();
        const otherAccount = operation({
            operationId: 'wrong-account',
            scope: { accountId: 'account-2', machineId: scope.machineId },
        });
        const otherMachine = operation({
            operationId: 'wrong-machine',
            scope: { accountId: scope.accountId, machineId: 'machine-2' },
        });
        const list = vi.fn()
            .mockResolvedValueOnce({ items: [accepted, otherAccount], nextCursor: 'page-2' })
            .mockResolvedValueOnce({ items: [otherMachine], nextCursor: null });

        await reconcileActionOperationsOnce({
            scope,
            store,
            list,
        });

        expect(list).toHaveBeenNthCalledWith(1, {
            machineId: scope.machineId,
            serverId: scope.serverId,
            accountId: scope.accountId,
            requireCurrentDomainFacts: expect.any(Function),
            request: {},
        });
        expect(list).toHaveBeenNthCalledWith(2, {
            machineId: scope.machineId,
            serverId: scope.serverId,
            accountId: scope.accountId,
            requireCurrentDomainFacts: expect.any(Function),
            request: { cursor: 'page-2' },
        });
        expect([...store.getSnapshot().operationsByKey.keys()]).toEqual([
            actionOperationAddressKey({ serverId: scope.serverId, operationId: accepted.operationId }),
        ]);
        expect([...store.getSnapshot().operationsByKey.values()][0]).toEqual({ serverId: scope.serverId, snapshot: accepted });
        expect([...store.getSnapshot().machineObservationByKey.values()]).toEqual(['available']);
    });

    it('retains cached active rows as unavailable when a complete post-restart list is empty', async () => {
        const store = createActionOperationStore();
        const cached = operation();
        store.mergeSnapshots({ serverId: scope.serverId, snapshots: [cached] });

        await reconcileActionOperationsOnce({
            scope,
            store,
            list: async () => ({ items: [], nextCursor: null }),
        });

        expect(store.getSnapshot().operationsByKey.get(actionOperationAddressKey({ serverId: scope.serverId, operationId: cached.operationId }))?.snapshot).toBe(cached);
        expect(store.getSnapshot().machineObservationByKey.get(actionOperationMachineAddressKey({ serverId: scope.serverId, machineId: scope.machineId }))).toBe('available');
        expect(createActionOperationSelectors().selectById(store.getSnapshot(), {
            serverId: scope.serverId,
            operationId: cached.operationId,
        })?.observation).toBe('unavailable');
    });

    it('retains cached rows when pagination fails before the daemon projection is complete', async () => {
        const store = createActionOperationStore();
        const cached = operation();
        store.mergeSnapshots({ serverId: scope.serverId, snapshots: [cached] });
        const list = vi.fn()
            .mockResolvedValueOnce({ items: [], nextCursor: 'page-2' })
            .mockRejectedValueOnce(new Error('connection lost'));

        await expect(reconcileActionOperationsOnce({
            scope,
            store,
            list,
        })).rejects.toThrow('connection lost');

        expect(store.getSnapshot().operationsByKey.get(actionOperationAddressKey({ serverId: scope.serverId, operationId: cached.operationId }))?.snapshot).toBe(cached);
    });

    it('retires the singleton projection with the active server/account lifetime', () => {
        const store = createActionOperationStore();
        store.mergeSnapshots({ serverId: scope.serverId, snapshots: [operation()] });
        const stopAll = vi.fn();
        const retirement = { current: null as (() => void) | null };
        const lifetime = {
            scope: { accountId: scope.accountId, serverId: scope.serverId! },
            isCurrent: () => true,
            onRetire(callback: () => void) {
                retirement.current = callback;
                return { dispose: vi.fn() };
            },
        };

        bindActionOperationRuntimeToAccountLifetime({ lifetime, coordinator: { stopAll }, store });
        retirement.current?.();

        expect(stopAll).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot().operationsByKey.size).toBe(0);
    });
});
