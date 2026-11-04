import { afterEach, expect, it } from 'vitest';
import {
  createMachineFixture,
  renderHook,
  standardCleanup,
} from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useMachineAuthority } from '@/components/machines/security/useMachineAuthority';

import { useMachineGuestExecution } from './useMachineGuestExecution';

const baseline = storage.getState();
afterEach(() => {
  standardCleanup();
  storage.setState(baseline, true);
});

async function offerFor(agentIsolation: unknown) {
  const serverId = getActiveServerSnapshot().serverId;
  const base = createMachineFixture({ id: 'guest-machine' });
  const machine = {
    ...base,
    metadata: { ...base.metadata!, platform: 'linux' },
    daemonState: {
      status: 'running',
      ...(agentIsolation === undefined ? {} : { agentIsolation }),
    },
  };
  storage
    .getState()
    .applyMachines([machine as typeof base], true, {
      sourceServerId: serverId,
    });
  const hook = await renderHook(() => ({
    guest: useMachineGuestExecution({
      machineId: machine.id,
      scope: { serverId, accountId: 'guest-owner' },
      canManage: true,
      execute: createFrontDoorActionExecute(),
    }),
    authority: useMachineAuthority({ machineId: machine.id, serverId }),
  }),
  );
  return hook.getCurrent();
}

it('does not offer separate users when the Machine reports isolation unavailable', async () => {
  const result = await offerFor({ kind: 'unavailable', code: 'sudo_unavailable' });
  expect(result.authority.isolation).toMatchObject({ kind: 'unavailable' });
  expect(result.guest.canEnableSeparateUsers).toBe(false);
});

it('keeps offering separate users on a Linux Machine whose isolation is off or not reported', async () => {
  expect((await offerFor({ kind: 'disabled' })).guest.canEnableSeparateUsers).toBe(true);
  expect((await offerFor(undefined)).guest.canEnableSeparateUsers).toBe(true);
});
