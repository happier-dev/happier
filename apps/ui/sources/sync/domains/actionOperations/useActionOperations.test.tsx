import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { actionOperationStore } from './actionOperationStore';
import { readAllActionOperations, useActionOperation, useActionOperationsHaveAttention, useManagedMachineActionOperation } from './useActionOperations';

describe('useActionOperations', () => {
    let tree: renderer.ReactTestRenderer | null = null;

    afterEach(() => {
        if (tree) act(() => tree?.unmount());
        tree = null;
        actionOperationStore.reset();
        vi.restoreAllMocks();
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
