import 'fake-indexeddb/auto';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
vi.mock('socket.io-client', async (importOriginal) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(importOriginal),
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock().module;
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
// The authenticated Machine RPC is the genuine boundary; the hook, Account capture, store and modal are real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({ machineRpcWithServerScope: rpc.machine }),
);
const harness = createHomeGovernanceHarness();
installDisconnectedServerSocketBoundary();
installHomeGovernanceBoundaries(harness);
await loadSyncSingletonForTests();
const { ActionOperationDetailModal } =
  await import('./ActionOperationDetailModal');

// A fixture-only password; the live-only Action must omit it from retained observations.
const DUMMY = 'fixture-only-value';

function heldSetup(
  serverId: string,
  taskId = 'setup-task',
): ActionOperationSnapshotV1 {
  return {
    version: 1,
    operationId: 'setup-operation',
    revision: 1,
    actionId: 'machines.setup.adminAccess.set',
    state: 'running',
    scope: { accountId: 'alice', machineId: 'machine-1' },
    title: 'Set administrator access',
    createdAt: 1_000,
    startedAt: 1_100,
    cancellation: 'supported',
    domainRef: {
      kind: 'machineSetup',
      serverId,
      machineId: 'machine-1',
      setupTask: {
        id: taskId,
        taskKind: 'machine.setup.apply.v1',
        prompt: { kind: 'sudo.password', adminUsername: 'ops.admin' },
      },
    },
  };
}

function fieldValue(screen: Awaited<ReturnType<typeof renderScreen>>): unknown {
  return screen.findHostByTestId('action-operation-sudo-password')?.props.value;
}

describe('ActionOperationDetailModal sudo answer', () => {
  beforeEach(async () => {
    await harness.reset();
    await loadSyncSingletonForTests();
    actionOperationStore.reset();
    rpc.machine.mockReset();
  });
  afterEach(() => {
    standardCleanup();
    actionOperationStore.reset();
    installHomeGovernanceBoundaries(harness);
  });

  it('asks for the password in the operation detail, clears it on reply and leaves with the question', async () => {
    const serverId = await harness.addHome({
      name: 'Origin',
      serverUrl: 'https://origin.test',
      accountId: 'alice',
      currentAccount: true,
      serverIdentityId: 'srv_origin_test',
    });
    const snapshot = heldSetup(serverId);
    actionOperationStore.mergeSnapshots({ serverId, snapshots: [snapshot] });
    const screen = await renderScreen(
      <ActionOperationDetailModal
        serverId={serverId}
        operationId="setup-operation"
        onClose={vi.fn()}
      />,
    );

    // Needs password: the secure field names the administrator; Send waits for a value; Stop stays the canceller.
    const field = screen.findHostByTestId('action-operation-sudo-password');
    expect(field?.props.secureTextEntry).toBe(true);
    expect(screen.getTextContent()).toContain('ops.admin');
    expect(
      screen.findByTestId('action-operation-sudo-send')?.props.disabled,
    ).toBe(true);
    expect(screen.findByTestId('action-operation-cancel')).not.toBeNull();
    // Setup with no attached output does not repeat the status or Machine in an empty Output section.
    expect(
      screen.findByTestId('action-operation-project-command.target'),
    ).toBeNull();

    // Submitting: the value leaves the field at once; the field and Send hold while the machine answers.
    const reply = createDeferred<unknown>();
    rpc.machine.mockImplementation(async ({ method }) => method === 'actionOperation.get.v2'
      ? { kind: 'found', operation: snapshot } : await reply.promise);
    screen.changeTextByTestId('action-operation-sudo-password', DUMMY);
    await flushHookEffects();
    expect(
      screen.findByTestId('action-operation-sudo-send')?.props.disabled,
    ).toBe(false);
    await screen.pressByTestIdAsync('action-operation-sudo-send');
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(rpc.machine.mock.calls.filter(([request]) => request.method === 'capabilities.invoke')).toHaveLength(1);
    });
    expect(rpc.machine.mock.calls.find(([request]) => request.method === 'capabilities.invoke')?.[0].payload.params).toMatchObject({
      taskId: 'setup-task',
      answer: { password: DUMMY },
    });
    expect(fieldValue(screen)).toBe('');
    expect(
      screen.findHostByTestId('action-operation-sudo-password')?.props.editable,
    ).toBe(false);
    expect(
      screen.findByTestId('action-operation-sudo-send')?.props.accessibilityState?.busy,
    ).toBe(true);

    // Refused (the daemon's capability reply shape): one cause under the field, empty and answerable again.
    reply.resolve({
      ok: false,
      error: { code: 'permission_denied', message: 'denied' },
    });
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(
        screen.findByTestId('action-operation-sudo-password.error'),
      ).not.toBeNull();
    });
    expect(fieldValue(screen)).toBe('');
    expect(screen.getTextContent()).not.toContain(DUMMY);

    // Sent: a successful reply replaces the field until the operation moves on.
    rpc.machine.mockImplementation(async ({ method }) => method === 'actionOperation.get.v2'
      ? { kind: 'found', operation: snapshot } : { ok: true, result: { ok: true } });
    screen.changeTextByTestId('action-operation-sudo-password', DUMMY);
    await flushHookEffects();
    await screen.pressByTestIdAsync('action-operation-sudo-send');
    await waitForHomeGovernance(async () => {
      await flushHookEffects();
      expect(screen.findByTestId('action-operation-sudo-sent')).not.toBeNull();
    });
    expect(
      screen.findHostByTestId('action-operation-sudo-password'),
    ).toBeNull();

    // Replaced: a new question on the same operation starts empty, with no earlier error or receipt.
    actionOperationStore.mergeSnapshots({
      serverId,
      snapshots: [{ ...heldSetup(serverId, 'setup-task-2'), revision: 2 }],
    });
    await flushHookEffects();
    expect(fieldValue(screen)).toBe('');
    expect(screen.findByTestId('action-operation-sudo-sent')).toBeNull();
    expect(
      screen.findByTestId('action-operation-sudo-password.error'),
    ).toBeNull();

    // Cleared, then settled: the question leaves the detail and the field goes with it.
    screen.changeTextByTestId('action-operation-sudo-password', DUMMY);
    await flushHookEffects();
    expect(fieldValue(screen)).toBe(DUMMY);
    actionOperationStore.mergeSnapshots({
      serverId,
      snapshots: [
        {
          ...snapshot,
          revision: 3,
          domainRef: {
            kind: 'machineSetup',
            serverId,
            machineId: 'machine-1',
            setupTask: {
              id: 'setup-task-2',
              taskKind: 'machine.setup.apply.v1',
            },
          },
        },
      ],
    });
    await flushHookEffects();
    expect(screen.findByTestId('action-operation-sudo')).toBeNull();
    actionOperationStore.mergeSnapshots({
      serverId,
      snapshots: [{ ...heldSetup(serverId, 'setup-task-3'), revision: 4 }],
    });
    await flushHookEffects();
    expect(fieldValue(screen)).toBe('');
    actionOperationStore.mergeSnapshots({
      serverId,
      snapshots: [
        {
          ...heldSetup(serverId, 'setup-task-3'),
          revision: 5,
          state: 'succeeded',
          settledAt: 2_000,
        },
      ],
    });
    await flushHookEffects();
    expect(screen.findByTestId('action-operation-sudo')).toBeNull();
    expect(rpc.machine.mock.calls.filter(([request]) => request.method === 'capabilities.invoke')).toHaveLength(2);
    await screen.unmount();
  });
});
