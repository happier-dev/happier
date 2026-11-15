import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { motionTokens } from '@/components/ui/motion/motionTokens';

vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// The Radix DOM leaf is the system boundary; modal custody and detail rendering stay real.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());

// The Machine RPC transport is external; operation admission, store merge and Details stay real.
const operationRpc = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: operationRpc,
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { ModalProvider, useModal } = await import('@/modal/ModalProvider');
const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');
type ModalEntries = ReturnType<typeof useModal>['state']['modals'];
let entries: ModalEntries = [];
function ObserveModals() {
    entries = useModal().state.modals;
    return null;
}

describe('openActionOperationDetail', () => {
    beforeEach(() => {
        actionOperationStore.reset();
        entries = [];
        operationRpc.mockReset();
        operationRpc.mockImplementation(() => new Promise(() => {}));
    });
    afterEach(async () => {
        await standardCleanup();
        await homes.reset();
        vi.useRealTimers();
        actionOperationStore.reset();
    });

    it('opens the shared live detail by exact Home-qualified operation address', async () => {
        const { openActionOperationDetail } = await import('./openActionOperationDetail');
        for (const serverId of ['home-a', 'home-b']) actionOperationStore.mergeSnapshots({ serverId, snapshots: [{
            version: 1, operationId: 'operation-1', revision: 1, actionId: 'acme.preview/deploy', state: 'succeeded',
            scope: { accountId: 'account', machineId: 'machine' }, title: 'Deploy', createdAt: 1, settledAt: 2,
            cancellation: 'unsupported', result: { destination: serverId === 'home-a' ? 'Alpha destination' : 'Beta destination' },
        }] });
        const screen = await renderScreen(React.createElement(ModalProvider, null, React.createElement(ObserveModals)));
        await act(async () => {
            expect(openActionOperationDetail({ serverId: 'home-a', operationId: 'operation-1' })).toBeUndefined();
            expect(actionOperationStore.getSnapshot().seenAtByOperationKey.has(JSON.stringify(['home-a', 'operation-1']))).toBe(true);
            await vi.dynamicImportSettled();
        });

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            type: 'custom',
            visible: true,
            props: { serverId: 'home-a', operationId: 'operation-1' },
            closeOnBackdrop: true,
            accessibilityLabel: 'inbox.actionOperations.detailAccessibilityLabel',
        });
        expect(actionOperationStore.getSnapshot().seenAtByOperationKey.has(JSON.stringify(['home-a', 'operation-1']))).toBe(true);
        expect(actionOperationStore.getSnapshot().seenAtByOperationKey.has(JSON.stringify(['home-b', 'operation-1']))).toBe(false);
        expect(screen.getTextContent()).toContain('Alpha destination');
        expect(screen.getTextContent()).not.toContain('Beta destination');
        vi.useFakeTimers();
        await screen.pressByTestIdAsync('action-operation-done');
        expect(entries.filter(entry => 'visible' in entry && entry.visible === true)).toHaveLength(0);
        await act(async () => { await vi.advanceTimersByTimeAsync(motionTokens.overlay.modal.exitMs); });
        expect(screen.findAllByType(ActionOperationDetailModal)).toHaveLength(0);
    });

    it('loads the retained refusal when cold Activity only has its summary', async () => {
        const { openActionOperationDetail } = await import('./openActionOperationDetail');
        const { ActionOperationSnapshotV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
        const full = ActionOperationSnapshotV1Schema.parse({
            version: 1, operationId: 'cold-failure', revision: 2, actionId: 'acme.preview/deploy', state: 'failed',
            requestId: 'cold-request', scope: { accountId: 'account', machineId: 'machine' }, title: 'Deploy',
            createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'unsupported',
            error: { errorCode: 'credential_unavailable', error: 'credential_unavailable' },
            result: { ok: false, code: 'credential_unavailable', message: 'Sign in to Docker: run sbx login', retryable: true },
        });
        const { result: _result, ...summary } = full;
        actionOperationStore.mergeSnapshots({ serverId: 'home-a', snapshots: [summary] });
        operationRpc.mockResolvedValue({ kind: 'found', operation: full });
        const screen = await renderScreen(React.createElement(ModalProvider, null, React.createElement(ObserveModals)));
        await act(async () => {
            openActionOperationDetail({ serverId: 'home-a', operationId: 'cold-failure' });
            await vi.dynamicImportSettled();
        });
        expect(screen.getTextContent()).toContain('Sign in to Docker: run sbx login');
        expect(actionOperationStore.getSnapshot().operationsByKey.get(JSON.stringify(['home-a', 'cold-failure']))?.snapshot.result).toEqual(full.result);
    });

    it('does not open detail for an unqualified legacy operation', async () => {
        const { openActionOperationDetail } = await import('./openActionOperationDetail');
        await renderScreen(React.createElement(ModalProvider, null, React.createElement(ObserveModals)));
        await act(async () => openActionOperationDetail({ serverId: null, operationId: 'operation-1' }));

        expect(entries).toEqual([]);
    });

    it('opens the native terminal result from cold Activity without a prior operation projection', async () => {
        const { readDeploymentActivityPage } = await import('@/components/projects/deployments/deploymentActivityRead');
        const { openActionOperationDetail } = await import('./openActionOperationDetail');
        const { ActionOperationSnapshotV1Schema, ACTION_OPERATION_RPC_METHODS_V2,
            projectActionOperationListSnapshotV1 } = await import('@happier-dev/protocol/actions/operations/v1');
        const serverId = await homes.addHome({ name: 'Cold Activity', serverUrl: 'https://cold-activity.test', accountId: 'requester' });
        homes.answer(serverId, '/v1/deployments/environments', { body: { ok: true, items: [], nextCursor: null } });
        const full = ActionOperationSnapshotV1Schema.parse({
            version: 1, operationId: 'native-updates', revision: 7, actionId: 'machines.setup.updates.apply', state: 'succeeded',
            scope: { accountId: 'requester', machineId: 'shared-machine' }, title: 'Install machine updates',
            createdAt: 1, startedAt: 2, settledAt: 3, cancellation: 'supported', result: { operationId: 'native-updates' },
            domainRef: { kind: 'machineSetup', serverId, machineId: 'shared-machine', steps: [{
                planIndex: 0, stepId: 'os-updates', label: { key: 'os-updates', fallback: 'Native package recovery' }, state: 'succeeded',
            }] },
        });
        operationRpc.mockImplementation(async (...args) => {
            const request = args[0] as Readonly<{ method: string }>;
            return request.method === ACTION_OPERATION_RPC_METHODS_V2.list
                ? { items: [projectActionOperationListSnapshotV1(full)], nextCursor: null }
                : { kind: 'found', operation: full };
        });
        const screen = await renderScreen(React.createElement(ModalProvider, null, React.createElement(ObserveModals)));
        const lifetime = { scope: { serverId, accountId: 'requester' }, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        await act(async () => {
            const page = await readDeploymentActivityPage(lifetime, { limit: 10 }, ['shared-machine'],
                { signal: new AbortController().signal });
            expect(page.items).toMatchObject([{ kind: 'operation', operation: { operationId: full.operationId } }]);
            openActionOperationDetail({ serverId, operationId: full.operationId });
            await vi.dynamicImportSettled();
        });
        expect(screen.getTextContent()).toContain('Native package recovery');
        expect(actionOperationStore.getSnapshot().operationsByKey.get(JSON.stringify([serverId, full.operationId])))
            .toMatchObject({ snapshotComplete: true, snapshot: { state: 'succeeded', result: full.result } });
    });
});
