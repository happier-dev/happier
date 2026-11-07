import { afterEach, describe, expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { storage } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { useProjectSetupMachine } from './useProjectSetupMachine';

const serverId = 'home';

function seedMachines(...machines: ReturnType<typeof createMachineFixture>[]) {
  storage.setState({
    machines: Object.fromEntries(machines.map((machine) => [machine.id, machine])),
    machineListByServerId: { [serverId]: machines },
    machineListStatusByServerId: { [serverId]: 'idle' },
  });
}

describe('useProjectSetupMachine', () => {
  afterEach(() => seedMachines());

  it('names a readable machine for the Project setup sentences', async () => {
    seedMachines(createMachineFixture({ id: 'devbox', metadata: { displayName: 'Dev box', host: 'devbox.local' } as never }));
    const hook = await renderHook(() => useProjectSetupMachine(serverId, 'devbox'));
    expect(hook.getCurrent().machineName).toBe('Dev box');
    await hook.unmount();
  });

  it('says "this machine" for a machine this device cannot read, never the locked placeholder', async () => {
    seedMachines(createMachineFixture({
      id: 'devbox', metadata: null, availability: { kind: 'locked', reason: 'encryption_material_unavailable' },
    }));
    const hook = await renderHook(() => useProjectSetupMachine(serverId, 'devbox'));
    expect(hook.getCurrent().machineName).toBe(t('machine.thisMachineInSentence'));
    await hook.unmount();
  });

  it.each([
    [{ enabled: false }, 'machines.sharing.fallback.lead', 'owner'],
    [{ enabled: true }, 'machines.sharing.trustedOsDetail', 'happier-agent'],
    [{ enabled: true, memberProvisioning: 'linuxUsersV1' }, 'machines.sharing.memberUsersDetail', null],
  ] as const)('projects the shared Machine policy into the setup disclosure: %s', async (agentIsolation, detailKey, sharedRunAs) => {
    const base = createMachineFixture({ id: 'devbox', isShared: true });
    seedMachines({ ...base, metadata: { ...base.metadata!, username: 'owner', platform: 'linux', agentIsolation },
      daemonState: { ...base.daemonState!, agentIsolation: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' } } });
    const hook = await renderHook(() => useProjectSetupMachine(serverId, 'devbox'));
    expect(hook.getCurrent()).toMatchObject({ sharedRunAs,
      sharedTrustDetail: expect.stringContaining(t(detailKey, { machine: hook.getCurrent().machineName })) });
    await hook.unmount();
  });
});
