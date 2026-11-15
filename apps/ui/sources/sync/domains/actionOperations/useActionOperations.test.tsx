import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, renderScreen } from '@/dev/testkit';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { actionOperationStore } from './actionOperationStore';
import { readAllActionOperations, useActionOperation, useActionOperationsHaveAttention, useManagedMachineActionOperation, useTerminalActionOperationState, useDeploymentTargetLinkOperations } from './useActionOperations';
// Collect the real lazy reader graph before tests hold a finite owner answer pending.
import './observeActionOperationByRequestId';

// Only the Machine RPC boundary is substituted; the reader, lifecycle and store remain real.
const operationRpc = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: operationRpc }));

describe('useActionOperations', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    beforeEach(() => operationRpc.mockReset());

    afterEach(() => {
        if (tree) act(() => tree?.unmount());
        tree = null;
        actionOperationStore.reset();
        vi.restoreAllMocks();
    });

    it.each(['owner', 'manage-grantee'])('settles an accepted %s operation through its finite owner without a push', async accountId => {
        const terminal = createDeferred<unknown>();
        operationRpc.mockReturnValue(terminal.promise);
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId: 'home', accountId },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const snapshot: ActionOperationSnapshotV1 = { version: 1, operationId: 'accepted', revision: 7,
            actionId: 'machines.setup.updates.apply', state: 'succeeded', scope: { accountId, machineId: 'machine' },
            title: 'Install machine updates', createdAt: 1, startedAt: 2, settledAt: 3,
            cancellation: 'supported', result: { operationId: 'accepted' } };
        const hook = await renderHook(() => useActionOperation({ serverId: 'home', operationId: 'accepted' },
            { machineId: 'machine', actionId: snapshot.actionId, lifetime }));
        tree = hook.tree;
        await vi.waitFor(() => expect(operationRpc).toHaveBeenCalledTimes(1));
        expect(operationRpc.mock.calls[0]?.[0]).toMatchObject({ accountId, serverId: 'home', machineId: 'machine',
            payload: { operationId: 'accepted', waitForTerminal: true } });
        await act(async () => { terminal.resolve({ kind: 'found', operation: snapshot }); });
        expect(hook.getCurrent()).toMatchObject({ snapshotComplete: true, snapshot });
        expect(operationRpc).toHaveBeenCalledTimes(1);
    });

    it('retires an accepted owner read with its Account and ignores the late result', async () => {
        const terminal = createDeferred<unknown>();
        operationRpc.mockReturnValue(terminal.promise);
        const retire = new Set<() => void>();
        let current = true;
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId: 'home', accountId: 'requester' },
            isCurrent: () => current, onRetire: callback => { retire.add(callback); return { dispose: () => { retire.delete(callback); } }; } };
        const hook = await renderHook(() => useActionOperation({ serverId: 'home', operationId: 'accepted' },
            { machineId: 'machine', actionId: 'machines.reboot', lifetime }));
        tree = hook.tree;
        await vi.waitFor(() => expect(operationRpc).toHaveBeenCalledTimes(1));
        const request = operationRpc.mock.calls[0]?.[0] as Readonly<{ signal: AbortSignal }>;
        await act(async () => {
            current = false;
            for (const callback of retire) callback();
            terminal.resolve({ kind: 'found', operation: { version: 1, operationId: 'accepted', revision: 7,
                actionId: 'machines.reboot', state: 'succeeded', scope: { accountId: 'requester', machineId: 'machine' },
                title: 'Restart', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'unsupported' } });
        });
        expect(request.signal.aborted).toBe(true);
        expect(hook.getCurrent()).toBeNull();
        expect(retire.size).toBe(0);
        expect(actionOperationStore.getSnapshot().operationsByKey.size).toBe(0);
    });

    it.each(['missing', 'forbidden', 'other-account'])('does not invent a terminal result for an accepted operation when its read is %s', async outcome => {
        operationRpc.mockImplementation(async () => {
            if (outcome === 'forbidden') return { error: 'Forbidden', errorCode: 'FORBIDDEN' };
            if (outcome === 'missing') return { kind: 'not_found' };
            return { kind: 'found', operation: { version: 1, operationId: 'accepted', revision: 7,
                actionId: 'machines.reboot', state: 'succeeded', scope: { accountId: 'other', machineId: 'machine' },
                title: 'Restart', createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'unsupported' } };
        });
        const lifetime: ServerAccountScopeLifetime = { scope: { serverId: 'home', accountId: 'requester' },
            isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const hook = await renderHook(() => useActionOperation({ serverId: 'home', operationId: 'accepted' },
            { machineId: 'machine', actionId: 'machines.reboot', lifetime }));
        tree = hook.tree;
        await vi.waitFor(() => expect(operationRpc).toHaveBeenCalledTimes(1));
        expect(hook.getCurrent()).toBeNull();
        expect(actionOperationStore.getSnapshot().operationsByKey.size).toBe(0);
    });

    it('binds terminal outcome to its target Home, Account and actual worker without rerendering on unrelated operations', async () => {
        const observed: Array<string | null> = [];
        function TerminalObserver() {
            observed.push(useTerminalActionOperationState({ serverId: 'target-home', accountId: 'requester', machineId: 'worker', terminalId: 'pty' }));
            return null;
        }
        tree = (await renderScreen(<TerminalObserver />)).tree;
        const snapshot = { version: 1 as const, operationId: 'original', revision: 1, actionId: 'projects.script.run',
            state: 'running' as const, scope: { accountId: 'requester', machineId: 'source' }, title: 'Script', createdAt: 1,
            cancellation: 'supported' as const, domainRef: { kind: 'projectCommand' as const, purpose: 'script' as const,
                serverId: 'target-home', machineId: 'worker', workspaceRefId: 'worker-copy', cwd: '/repo', terminalId: 'pty' } };
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'source-home', snapshots: [snapshot] }));
        expect(observed.at(-1)).toBe('running');
        const before = observed.length;
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'source-home', snapshots: [
            { ...snapshot, operationId: 'other-account', scope: { ...snapshot.scope, accountId: 'other' } },
            { ...snapshot, operationId: 'other-home', domainRef: { ...snapshot.domainRef, serverId: 'other' } },
            { ...snapshot, operationId: 'other-worker', domainRef: { ...snapshot.domainRef, machineId: 'other' } },
            { ...snapshot, operationId: 'other-pty', domainRef: { ...snapshot.domainRef, terminalId: 'other' } },
        ] }));
        expect(observed.length).toBe(before);
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'source-home', snapshots: [{ ...snapshot, revision: 2,
            state: 'cancelled', settledAt: 3 }] }));
        expect(observed.at(-1)).toBe('cancelled');
    });

    it('binds managed row observations to the original Home, requester Account and controller without following unrelated operations', async () => {
        const observed: Array<string | null> = [];
        function ManagedObserver() {
            const operation = useManagedMachineActionOperation({ serverId: 'saved-home', accountId: 'requester', machineId: 'controller', managedId: 'managed' });
            observed.push(operation?.snapshot.operationId ?? null);
            return React.createElement('View');
        }
        tree = (await renderScreen(<ManagedObserver />)).tree;
        const snapshot = { version: 1 as const, operationId: 'original', revision: 1,
            actionId: 'machines.managed.acquire', state: 'running' as const,
            scope: { accountId: 'requester', machineId: 'controller' }, title: 'Installation', createdAt: 1, startedAt: 2,
            cancellation: 'supported' as const, domainRef: { kind: 'managedMachine' as const, id: 'managed' } };
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'saved-home', snapshots: [snapshot] }));
        expect(observed.at(-1)).toBe('original');
        const beforeUnrelated = observed.length;
        act(() => {
            actionOperationStore.mergeSnapshots({ serverId: 'other-home', snapshots: [{ ...snapshot, operationId: 'wrong-home', createdAt: 20 }] });
            actionOperationStore.mergeSnapshots({ serverId: 'saved-home', snapshots: [
                { ...snapshot, operationId: 'wrong-account', createdAt: 30, scope: { ...snapshot.scope, accountId: 'other' } },
                { ...snapshot, operationId: 'wrong-controller', createdAt: 40, scope: { ...snapshot.scope, machineId: 'other' } },
                { ...snapshot, operationId: 'wrong-resource', createdAt: 50, domainRef: { kind: 'managedMachine', id: 'other' } },
            ] });
        });
        expect(observed.at(-1)).toBe('original');
        expect(observed.length).toBe(beforeUnrelated);
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'saved-home', snapshots: [{ ...snapshot,
            operationId: 'retry', actionId: 'machines.managed.bootstrap.retry', createdAt: 60 }] }));
        expect(observed.at(-1)).toBe('retry');
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'saved-home', snapshots: [{ ...snapshot,
            operationId: 'native-intent', actionId: 'machines.managed.intent.update', createdAt: 70 }] }));
        expect(observed.at(-1)).toBe('native-intent');
    });

    it('recovers link operations for the exact Environment without waking for another Home, Account or controller', async () => {
        const query = { serverId: 'home', accountId: 'requester', machineId: 'controller', environmentId: 'environment' };
        const observed: Array<readonly string[]> = [];
        const completeness: Array<true | undefined> = [];
        function LinkObserver() {
            const operations = useDeploymentTargetLinkOperations(query);
            observed.push(operations.map(operation => operation.snapshot.operationId));
            completeness.push(operations[0]?.snapshotComplete);
            return null;
        }
        tree = (await renderScreen(<LinkObserver />)).tree;
        const snapshot = { version: 1 as const, operationId: 'created-resource', revision: 1,
            actionId: 'deployments.targets.link', state: 'failed' as const,
            scope: { accountId: 'requester', machineId: 'controller' }, title: 'Link platform', createdAt: 1,
            cancellation: 'unsupported' as const, domainRef: { kind: 'deploymentTargetLink' as const,
                serverId: 'home', environmentId: 'environment', purpose: 'create' as const, requestKey: 'created-resource-request' } };
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'home', snapshots: [snapshot] }));
        expect(observed.at(-1)).toEqual(['created-resource']);
        const before = observed.length;
        act(() => {
            actionOperationStore.mergeSnapshots({ serverId: 'another-home', snapshots: [{ ...snapshot, operationId: 'wrong-home' }] });
            actionOperationStore.mergeSnapshots({ serverId: 'home', snapshots: [
                { ...snapshot, operationId: 'wrong-account', scope: { ...snapshot.scope, accountId: 'another' } },
                { ...snapshot, operationId: 'wrong-controller', scope: { ...snapshot.scope, machineId: 'another' } },
                { ...snapshot, operationId: 'wrong-environment', domainRef: { ...snapshot.domainRef, environmentId: 'another' } },
            ] });
        });
        expect(observed.length).toBe(before);
        expect(completeness.at(-1)).toBeUndefined();
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'home', snapshots: [snapshot], snapshotComplete: true }));
        expect(completeness.at(-1)).toBe(true);
        expect(observed.length).toBe(before + 1);
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'home', snapshots: [{ ...snapshot, revision: 2,
            result: { ok: false, error: 'deployment_link_incomplete' } }] }));
        expect(observed.length).toBe(before + 2);
        act(() => {
            expect(actionOperationStore.dismissOperation({ serverId: 'home', operationId: 'created-resource' })).toBe(true);
        });
        expect(observed.at(-1)).toEqual(['created-resource']);
        expect(observed.length).toBe(before + 2);
    });

    it('recovers Environment-wide link operations from their original controllers', async () => {
        const observed: Array<readonly string[]> = [];
        function EnvironmentLinkObserver() {
            observed.push(useDeploymentTargetLinkOperations({ serverId: 'home', accountId: 'requester', machineId: undefined,
                environmentId: 'environment' }).map(operation => operation.snapshot.scope.machineId));
            return null;
        }
        tree = (await renderScreen(<EnvironmentLinkObserver />)).tree;
        const snapshot = { version: 1 as const, operationId: 'created-resource', revision: 1,
            actionId: 'deployments.targets.link', state: 'failed' as const,
            scope: { accountId: 'requester', machineId: 'original-controller' }, title: 'Link platform', createdAt: 1,
            cancellation: 'unsupported' as const, domainRef: { kind: 'deploymentTargetLink' as const,
                serverId: 'home', environmentId: 'environment', purpose: 'create' as const, requestKey: 'created-resource-request' } };
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'home', snapshots: [snapshot] }));
        expect(observed.at(-1)).toEqual(['original-controller']);
        act(() => actionOperationStore.mergeSnapshots({ serverId: 'home', snapshots: [{ ...snapshot,
            operationId: 'second-resource', scope: { ...snapshot.scope, machineId: 'second-controller' } }] }));
        expect(observed.at(-1)).toEqual(['original-controller', 'second-controller']);
    });

    it('imperatively reads the latest canonical operation snapshot at a decision point', () => {
        expect(readAllActionOperations()).toEqual([]);
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [{
            version: 1,
            operationId: 'operation-a',
            revision: 1,
            requestId: 'launch-attempt-a',
            actionId: 'session.spawn_new',
            state: 'accepted',
            scope: { accountId: 'account-a', machineId: 'machine-a' },
            title: 'Create session',
            createdAt: 100,
            cancellation: 'unsupported',
        }] });
        expect(readAllActionOperations()).toHaveLength(1);
        expect(readAllActionOperations()[0]?.snapshot.requestId).toBe('launch-attempt-a');
    });

    it('keeps the shared attention hook bound to terminal seen state', async () => {
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [{
            version: 1,
            operationId: 'operation-a',
            revision: 2,
            actionId: 'session.spawn_new',
            state: 'succeeded',
            scope: { accountId: 'account-a', machineId: 'machine-a' },
            title: 'Create session',
            createdAt: 100,
            settledAt: 150,
            cancellation: 'unsupported',
        }] });
        const observed: boolean[] = [];

        function AttentionObserver() {
            observed.push(useActionOperationsHaveAttention());
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(AttentionObserver))).tree;
        expect(observed.at(-1)).toBe(true);

        act(() => {
            actionOperationStore.markAllTerminalSeen(200);
        });
        expect(observed.at(-1)).toBe(false);
    });

    it('keeps a detail observer bound to the operation as its snapshot changes', async () => {
        const observedTitles: string[] = [];

        function OperationObserver() {
            const operation = useActionOperation({ serverId: 'home-a', operationId: 'operation-a' });
            observedTitles.push(operation?.snapshot.title ?? 'missing');
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(OperationObserver))).tree;
        expect(observedTitles.at(-1)).toBe('missing');

        act(() => actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [{
            version: 1,
            operationId: 'operation-a',
            revision: 1,
            actionId: 'session.spawn_new',
            state: 'running',
            scope: { accountId: 'account-a', machineId: 'machine-a' },
            title: 'Creating session',
            createdAt: 100,
            startedAt: 110,
            cancellation: 'unsupported',
        }] }));

        expect(observedTitles.at(-1)).toBe('Creating session');
    });
});
