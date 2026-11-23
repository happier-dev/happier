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

  it('tells the owner that people they add work as them only while isolation is off', () => {
    const ownerLead = t('machines.sharing.fallback.ownerLead', { machine: 'Lima' });
    for (const [platform, isolationPolicy, told] of [
      ['linux', undefined, true],
      ['linux', { version: 1, enabled: false }, true],
      ['darwin', { version: 1, enabled: false }, true],
      ['linux', { version: 1, enabled: true }, false],
      ['darwin', { version: 1, enabled: true }, false],
      ['linux', member, false],
    ] as const) {
      const presented = presentMachineAuthorityV1({ platform, isolationPolicy });
      const owner = describeMachineShareTrust(presented.separateUsers.placement, false, 'Lima', presented.isolation);
      expect.soft(owner.lead === ownerLead, `${platform} ${JSON.stringify(isolationPolicy)}`).toBe(told);
      // The person it is shared with is never addressed as the one who adds people.
      const recipient = describeMachineShareTrust(presented.separateUsers.placement, true, 'Lima', presented.isolation);
      expect.soft(`${recipient.lead} ${recipient.detail}`).not.toContain(ownerLead);
    }
  });
});
