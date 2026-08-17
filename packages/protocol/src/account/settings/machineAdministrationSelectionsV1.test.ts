import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MACHINE_ADMINISTRATION_SELECTIONS_V1,
  MachineAdministrationSelectionsV1Schema,
  MachineAdministrationTargetV1Schema,
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

  it('defaults to an empty versioned preference container', () => {
    expect(MachineAdministrationSelectionsV1Schema.parse({})).toEqual(
      DEFAULT_MACHINE_ADMINISTRATION_SELECTIONS_V1,
    );
  });

  it('preserves exact server-qualified machine targets', () => {
    const parsed = MachineAdministrationSelectionsV1Schema.parse({
      v: 1,
      targetsByKey: {
        agents: {
          serverIdentityId: 'srv_account_one',
          machineId: 'machine-shared',
        },
        'plugins.home': {
          serverIdentityId: 'srv_account_two',
          machineId: 'machine-shared',
        },
      },
      pluginExecutionOriginsByPluginId: {
        'acme.plugin': {
          serverIdentityId: 'srv_account_two',
          materializationRef: {
            machineId: 'machine-shared',
            materializationId: 'mat-2',
            pluginId: 'acme.plugin',
          },
        },
      },
    });
    expect(parsed.targetsByKey).toEqual({
      agents: {
        serverIdentityId: 'srv_account_one',
        machineId: 'machine-shared',
      },
      'plugins.home': {
        serverIdentityId: 'srv_account_two',
        machineId: 'machine-shared',
      },
    });
    expect(parsed.pluginExecutionOriginsByPluginId['acme.plugin']).toEqual({
      serverIdentityId: 'srv_account_two',
      materializationRef: {
        machineId: 'machine-shared',
        materializationId: 'mat-2',
        pluginId: 'acme.plugin',
      },
    });
  });

  it('rejects malformed entries instead of silently retaining local routing identity', () => {
    expect(MachineAdministrationSelectionsV1Schema.safeParse({
      v: 1,
      targetsByKey: {
        agents: {
          serverIdentityId: 'profile-local',
          machineId: 'machine-a',
        },
      },
      pluginExecutionOriginsByPluginId: {},
    }).success).toBe(false);
  });
});
