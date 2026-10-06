import { describe, expect, it } from 'vitest';

import {
  parseSessionConnectedServicesBindingsJson,
  serializeSessionConnectedServicesBindingsForEnv,
} from './sessionConnectedServicesBindingsEnv';

describe('session connected-services bindings env', () => {
  it('serializes and reloads the current team-resource selection and disclosed member', () => {
    const bindings = {
      v: 2 as const,
      bindingsByServiceId: {
        'plugin.acme/service': {
          source: 'team_resource' as const,
          resourceId: 'resource-1',
          deliveryMode: 'direct' as const,
          disclosedMember: {
            service: { pluginId: 'plugin.acme', localId: 'service' },
            accountId: 'member-1',
          },
        },
      },
    };
    const serialized = serializeSessionConnectedServicesBindingsForEnv(bindings);
    expect(serialized).not.toBeNull();
    expect(parseSessionConnectedServicesBindingsJson(serialized)).toEqual(bindings);
  });

  it('normalizes supported persisted v1 input on reload but never writes it', () => {
    const persisted = JSON.stringify({
      v: 1,
      bindingsByServiceId: {
        'claude-subscription': { source: 'connected', profileId: 'work' },
      },
    });
    expect(parseSessionConnectedServicesBindingsJson(persisted)).toEqual({
      v: 2,
      bindingsByServiceId: {
        'happier.agent.claude/claude-subscription': {
          source: 'connected',
          selection: 'profile',
          profileId: 'work',
        },
      },
    });
    expect(serializeSessionConnectedServicesBindingsForEnv(JSON.parse(persisted))).toBeNull();
  });
});
