import 'fake-indexeddb/auto';
import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

const boundary = vi.hoisted(() => ({ machine: vi.fn(), sheets: [] as Array<{ props?: { onResolve?(trusted: boolean): void } }> }));
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Authenticated RPC and the platform modal portal are boundaries; question and trust-sheet owners stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: boundary.machine }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: {
    show: ((sheet: typeof boundary.sheets[number]) => { boundary.sheets.push(sheet); return 'trust-sheet'; }) as never,
} }).module);
const homes = createHomeGovernanceHarness();
installDisconnectedServerSocketBoundary();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { ActionOperationDetailModal } = await import('./ActionOperationDetailModal');
beforeEach(async () => {
    await homes.reset(); await loadSyncSingletonForTests(); actionOperationStore.reset();
    boundary.machine.mockReset(); boundary.sheets.length = 0;
});
afterEach(() => { standardCleanup(); actionOperationStore.reset(); installHomeGovernanceBoundaries(homes); });

it.each([true, false])('asks the real trust sheet and sends the explicit Prepare decision (trusted=%s)', async trusted => {
    const serverId = await homes.addHome({ name: 'Origin', serverUrl: 'https://prepare-origin.test', accountId: 'alice',
        currentAccount: true, serverIdentityId: 'srv_prepare_origin' });
    const snapshot: ActionOperationSnapshotV1 = { version: 1, operationId: 'prepare-operation', revision: 1,
        actionId: 'machines.presets.prepare', state: 'running', scope: { accountId: 'alice', machineId: 'controller' },
        title: 'Prepare guest', createdAt: 1000, startedAt: 1100, cancellation: 'supported',
        domainRef: { kind: 'systemTask', id: 'trust-task', taskKind: 'remote.ssh.bootstrapMachine.v1',
            prompt: { kind: 'ssh.trustHost', message: 'Trust this guest?', host: '192.168.64.7', keyType: 'ssh-ed25519',
                fingerprint: 'SHA256:guest', existingFingerprint: null } } };
    actionOperationStore.mergeSnapshots({ serverId, snapshots: [snapshot] });
    boundary.machine.mockImplementation(async ({ method }) => method === 'actionOperation.get.v2'
        ? { kind: 'found', operation: snapshot } : { ok: true, result: { ok: true } });
    const screen = await renderScreen(<ActionOperationDetailModal serverId={serverId} operationId="prepare-operation" onClose={vi.fn()} />);
    expect(boundary.machine).not.toHaveBeenCalled();
    expect(screen.findByTestId('action-operation-ssh-review')).not.toBeNull();
    await screen.pressByTestIdAsync('action-operation-ssh-review');
    expect(boundary.sheets).toHaveLength(1);
    expect(boundary.machine).not.toHaveBeenCalled();
    boundary.sheets[0]!.props?.onResolve?.(trusted);
    await waitForHomeGovernance(async () => {
        await flushHookEffects();
        expect(boundary.machine.mock.calls.filter(([request]) => request.method === 'capabilities.invoke')).toHaveLength(1);
    });
    expect(boundary.machine.mock.calls.find(([request]) => request.method === 'capabilities.invoke')?.[0].payload).toMatchObject({ id: 'tool.systemTasks', method: 'respond', params: {
        taskId: 'trust-task', expectedPromptKind: 'ssh.trustHost', answer: { trusted },
    } });
});
