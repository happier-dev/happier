// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { actionOperationSelectors } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { ActionOperationSnapshotV1Schema, type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const rpc = vi.hoisted(() => ({ calls: [] as unknown[], fail: false, operation: null as ActionOperationSnapshotV1 | null }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(async request => {
        rpc.calls.push(request);
        if (rpc.fail) throw new Error('offline');
        return { kind: 'found', operation: rpc.operation };
    }));
const { DeploymentPreparationOperations } = await import('./DeploymentPreparationOperations');
const session = { serverId: 'home', sessionId: 'prepare-session' };
function snapshot(patch: Partial<ActionOperationSnapshotV1> = {}): ActionOperationSnapshotV1 {
    return ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'receipt', revision: 1, actionId: 'deployments.deploy', state: 'running',
        scope: { accountId: 'owner', machineId: 'machine', sessionId: session.sessionId },
        title: 'Validation deployment', createdAt: 1, startedAt: 2, cancellation: 'supported', ...patch });
}
function merge(operation: ActionOperationSnapshotV1, serverId = 'home') {
    act(() => actionOperationStore.mergeSnapshots({ serverId, snapshots: [operation] }));
}
const deploymentResult = DeploymentActionOutputSchemasV1['deployments.deploy'].parse({ ok: true,
    environmentId: 'preview', revision: 1, deploymentId: 'validation-receipt', deploymentRevision: 1, state: 'succeeded' });
afterEach(async () => { await standardCleanup(); actionOperationStore.reset(); rpc.calls = []; rpc.fail = false; rpc.operation = null; });

describe('Prepare Session operation results', () => {
    it('reads each terminal result once, without fetching progress or another Session, Home or Account', async () => {
        merge(snapshot());
        const screen = await renderScreen(<DeploymentPreparationOperations session={session} accountId="owner" />);
        expect(rpc.calls).toHaveLength(0);
        merge(snapshot({ revision: 2, progress: { kind: 'phase', phase: 'build', label: 'Building' } }));
        merge(snapshot({ operationId: 'foreign-session', scope: { accountId: 'owner', machineId: 'machine', sessionId: 'other' } }));
        merge(snapshot({ operationId: 'foreign-account', scope: { accountId: 'other', machineId: 'machine', sessionId: session.sessionId } }));
        merge(snapshot({ operationId: 'foreign-home' }), 'other');
        expect(rpc.calls).toHaveLength(0);
        rpc.operation = snapshot({ revision: 3, state: 'succeeded', settledAt: 4, result: deploymentResult });
        await act(async () => { merge(snapshot({ revision: 3, state: 'succeeded', settledAt: 4 })); });
        expect(rpc.calls).toHaveLength(1);
        expect(rpc.calls[0]).toMatchObject({ serverId: 'home', accountId: 'owner', machineId: 'machine', payload: { operationId: 'receipt' } });
        expect(actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), { serverId: 'home', operationId: 'receipt' }))
            .toMatchObject({ snapshotComplete: true, snapshot: { result: deploymentResult } });
        expect(screen.findByTestId('project-deployments.prepare.operation.receipt')).not.toBeNull();
        expect(screen.findByTestId('project-deployments.prepare.operation.foreign-session')).toBeNull();
        await act(async () => { merge(snapshot({ operationId: 'unrelated' })); });
        expect(rpc.calls).toHaveLength(1);
    });

    it('offers visible retry when the owner result cannot be read, then retains the full result', async () => {
        rpc.fail = true;
        merge(snapshot({ state: 'succeeded', settledAt: 4 }));
        const screen = await renderScreen(<DeploymentPreparationOperations session={session} accountId="owner" />);
        expect(rpc.calls).toHaveLength(1);
        expect(screen.findByTestId('project-deployments.prepare.operation.receipt.retry')).not.toBeNull();
        rpc.fail = false;
        rpc.operation = snapshot({ state: 'succeeded', settledAt: 4, result: deploymentResult });
        await screen.pressByTestIdAsync('project-deployments.prepare.operation.receipt.retry');
        expect(rpc.calls).toHaveLength(2);
        expect(screen.findByTestId('project-deployments.prepare.operation.receipt.retry')).toBeNull();
        expect(actionOperationSelectors.selectById(actionOperationStore.getSnapshot(), { serverId: 'home', operationId: 'receipt' }))
            .toMatchObject({ snapshotComplete: true, snapshot: { result: deploymentResult } });
    });
});
