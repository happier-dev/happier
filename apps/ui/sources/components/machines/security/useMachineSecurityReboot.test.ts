import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { MachineRebootResultV1 } from '@happier-dev/protocol';

import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { renderHook, standardCleanup } from '@/dev/testkit';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { useMachineSecurityReboot } = await import('./useMachineSecurityReboot');
const { actionOperationStore } =
  await import('@/sync/domains/actionOperations/actionOperationStore');
const { createFrontDoorActionExecute } =
  await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { createDefaultActionExecutor } =
  await import('@/sync/ops/actions/defaultActionExecutor');

let serverId: string;
const machineId = 'reboot-machine';

beforeEach(async () => {
  await homes.reset();
  actionOperationStore.reset();
  serverId = await homes.addHome({
    name: 'Reboot',
    serverUrl: 'https://reboot.test',
    serverIdentityId: 'srv_reboot',
    accountId: 'reboot-owner',
    currentAccount: true,
  });
  homes.answer(serverId, 'GET /v1/deployments/machine-references', {
    select: () => ({
      body: {
        homeId: 'srv_reboot',
        machineId,
        coverage: 'complete',
        references: [],
        nextCursor: null,
      },
    }),
  });
});
afterEach(async () => {
  standardCleanup();
  actionOperationStore.reset();
  await homes.reset();
});

/** The real Action front door and executor; only the Machine RPC and the person's dialog are substituted. */
function frontDoor(answer: MachineRebootResultV1) {
  const dispatched: unknown[] = [];
  const execute = createFrontDoorActionExecute(
    createDefaultActionExecutor({
      machineReboot: async ({ input }) => {
        dispatched.push(input);
        return answer;
      },
      machineServiceAction: async () => ({ kind: 'snapshot', services: [] }),
      presentUserActionConfirmation: async () => true,
    }),
  );
  return { execute, dispatched };
}

function operation(
  state: ActionOperationSnapshotV1['state'],
): ActionOperationSnapshotV1 {
  return {
    version: 1,
    operationId: 'reboot-op',
    revision: state === 'running' ? 1 : 2,
    actionId: 'machines.reboot',
    state,
    scope: { accountId: 'reboot-owner', machineId },
    title: 'Reboot',
    createdAt: 1,
    cancellation: 'unsupported',
    ...(state === 'running' ? {} : { settledAt: 2 }),
    domainRef: {
      kind: 'machineReboot',
      serverId,
      machineId,
      installationId: 'installation-a',
      task: { id: 'reboot-task', taskKind: 'machine.reboot.v1' },
      basis: {
        dispatchStarted: true,
        bootedAt: 1,
        expectedRunningServiceIds: [],
        expectedRunningServicesKnown: true,
      },
    },
  };
}

it('asks the page to read again once when the Machine refuses the restart', async () => {
  const onSettled = vi.fn();
  const { execute, dispatched } = frontDoor({
    kind: 'blocked',
    reasons: ['session', 'terminal'],
  });
  const hook = await renderHook(() =>
    useMachineSecurityReboot({
      serverId,
      machineId,
      installationId: 'installation-a',
      onSettled,
      execute,
    }),
  );
  await act(async () => {
    await hook.getCurrent().start();
  });
  expect(dispatched).toEqual([
    { serverId, machineId, expectedInstallationId: 'installation-a' },
  ]);
  expect(hook.getCurrent().reboot).toEqual({
    kind: 'blocked',
    reasons: ['session', 'terminal'],
  });
  expect(onSettled).toHaveBeenCalledTimes(1);
});

it('asks the page to read again once when the accepted restart settles, never before', async () => {
  const onSettled = vi.fn();
  const { execute } = frontDoor({
    kind: 'accepted',
    operation: { operationId: 'reboot-op' },
    bootedAt: 1,
  });
  const hook = await renderHook(() =>
    useMachineSecurityReboot({
      serverId,
      machineId,
      installationId: 'installation-a',
      onSettled,
      execute,
    }),
  );
  await act(async () => {
    await hook.getCurrent().start();
  });
  expect(hook.getCurrent().reboot).toEqual({
    kind: 'restarting',
    operationId: 'reboot-op',
  });
  await act(async () =>
    actionOperationStore.mergeSnapshots({
      serverId,
      snapshots: [operation('running')],
    }),
  );
  expect(onSettled).not.toHaveBeenCalled();
  await act(async () =>
    actionOperationStore.mergeSnapshots({
      serverId,
      snapshots: [operation('succeeded')],
    }),
  );
  expect(hook.getCurrent().reboot).toEqual({
    kind: 'settled',
    operationId: 'reboot-op',
    state: 'succeeded',
  });
  expect(onSettled).toHaveBeenCalledTimes(1);
  await act(async () =>
    actionOperationStore.mergeSnapshots({
      serverId,
      snapshots: [{ ...operation('succeeded'), revision: 3 }],
    }),
  );
  expect(onSettled).toHaveBeenCalledTimes(1);
});

it('does not dispatch a restart without the exact installation', async () => {
  const onSettled = vi.fn();
  const { execute, dispatched } = frontDoor({
    kind: 'blocked',
    reasons: ['session'],
  });
  const hook = await renderHook(() =>
    useMachineSecurityReboot({
      serverId,
      machineId,
      installationId: null,
      onSettled,
      execute,
    }),
  );
  await act(async () => {
    await hook.getCurrent().start();
  });
  expect(dispatched).toEqual([]);
  expect(hook.getCurrent().reboot).toEqual({ kind: 'idle' });
});
