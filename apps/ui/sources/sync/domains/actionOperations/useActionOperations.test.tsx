import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { actionOperationStore } from './actionOperationStore';
import { useActionOperation, useActionOperationsHaveAttention } from './useActionOperations';

describe('useActionOperations', () => {
    let tree: renderer.ReactTestRenderer | null = null;

    afterEach(() => {
        if (tree) act(() => tree?.unmount());
        tree = null;
        actionOperationStore.reset();
        vi.restoreAllMocks();
    });

    it('keeps the shared attention hook bound to terminal seen state', async () => {
        actionOperationStore.mergeSnapshots([{
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
        }]);
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
            const operation = useActionOperation('operation-a');
            observedTitles.push(operation?.snapshot.title ?? 'missing');
            return React.createElement('View');
        }

        tree = (await renderScreen(React.createElement(OperationObserver))).tree;
        expect(observedTitles.at(-1)).toBe('missing');

        act(() => actionOperationStore.mergeSnapshots([{
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
        }]));

        expect(observedTitles.at(-1)).toBe('Creating session');
    });
});
