import { describe, expect, it } from 'vitest';
import { presentMachineAuthorityV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import { t } from '@/text';

import { describeMachineShareTrust } from './machineShareTrust';

describe('describeMachineShareTrust', () => {
  const member = {
    version: 1,
    enabled: true,
    memberProvisioning: 'linuxUsersV1',
  };

  it('says separate users are on only while the Machine runs them, from the same fact Security reads', () => {
    const running = presentMachineAuthorityV1({
      platform: 'linux',
      isolationPolicy: member,
      isolation: {
        kind: 'effective',
        platform: 'linux',
        agentUser: 'happier-agent',
      },
    });
    expect(
      describeMachineShareTrust(
        running.separateUsers.placement,
        false,
        'Lima',
        running.isolation,
      ).lead,
    ).toBe(t('machines.sharing.memberUsersLead', { machine: 'Lima' }));
    // Set to on, but the Machine reports them not running (after a restart): the same pending state Security shows.
    const restarted = presentMachineAuthorityV1({
      platform: 'linux',
      isolationPolicy: member,
      isolation: {
        kind: 'unavailable',
        code: 'provisioning_unavailable',
      },
    });
    expect(
      describeMachineShareTrust(
        restarted.separateUsers.placement,
        false,
        'Lima',
        restarted.isolation,
      ).lead,
    ).toBe(t('machines.sharing.memberUsersPendingLead', { machine: 'Lima' }));
  });
});
