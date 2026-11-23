import { describe, expect, it } from 'vitest';

import {
  MachineAdministrationTargetV1Schema,
  MachineAdministrationTargetsV1Schema,
} from './machineAdministrationSelectionsV1.js';

describe('machineAdministrationSelectionsV1', () => {
  it('accepts only portable canonical server identities', () => {
    expect(MachineAdministrationTargetV1Schema.parse({
      serverIdentityId: 'srv_account_one',
      machineId: 'machine-a',
    })).toEqual({
      serverIdentityId: 'srv_account_one',
      machineId: 'machine-a',
    });

    expect(MachineAdministrationTargetV1Schema.safeParse({
      serverIdentityId: 'local-profile-id',
      machineId: 'machine-a',
    }).success).toBe(false);
  });

  it('preserves exact server-qualified machine targets', () => {
    const targets = MachineAdministrationTargetsV1Schema.parse({
        agents: {
          serverIdentityId: 'srv_account_one',
          machineId: 'machine-shared',
        },
        'plugins.home': {
          serverIdentityId: 'srv_account_two',
          machineId: 'machine-shared',
        },
    });
    expect(targets).toEqual({
      agents: {
        serverIdentityId: 'srv_account_one',
        machineId: 'machine-shared',
      },
      'plugins.home': {
        serverIdentityId: 'srv_account_two',
        machineId: 'machine-shared',
      },
    });
  });

  it('rejects malformed entries instead of silently retaining local routing identity', () => {
    expect(MachineAdministrationTargetsV1Schema.safeParse({
        agents: {
          serverIdentityId: 'profile-local',
          machineId: 'machine-a',
        },
    }).success).toBe(false);
  });
});
