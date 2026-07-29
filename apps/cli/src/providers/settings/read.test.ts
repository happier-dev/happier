import { describe, expect, it } from 'vitest';

import { readProviderSettingsForCli } from './read';

describe('readProviderSettingsForCli', () => {
  it('uses the protocol owner and preserves valid siblings when one connection is malformed', () => {
    const result = readProviderSettingsForCli({
      providerSettingsV1: {
        v: 1,
        connections: [
          {
            v: 1,
            id: 'pc_valid',
            source: { kind: 'contribution', contributionKey: 'plugin/p' },
            role: 'default',
            displayName: 'Provider',
            displayNameMode: 'automatic',
            revision: 0,
            createdAt: 1,
            updatedAt: 1,
          },
          { v: 1, id: '', source: null },
        ],
        connectionTombstones: [],
        accountGrants: [],
        machineGrants: [],
        secretBindingsByConnectionId: {},
        manualModelsByConnectionId: {},
        modelVisibilityByRef: {},
        experimentalBindingConfirmations: [],
        defaultsByAgentTargetKey: {},
      },
    });

    expect(result.settings.connections.map((connection) => connection.id)).toEqual(['pc_valid']);
    expect(result.diagnostics).toContainEqual({ path: 'connections[1]', reason: 'invalid_record' });
  });
});
