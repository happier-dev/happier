import { describe, expect, it } from 'vitest';

import { PI_BROKER_SELECTION_IDENTITY_ENV } from '@/backends/pi/brokerExtension';
import { materializePiConnectedServiceRuntimeAuthSelection } from './materializePiConnectedServiceRuntimeAuthSelection';

describe('materializePiConnectedServiceRuntimeAuthSelection', () => {
  it('carries the frozen broker selection identity so hot apply can update daemon-side selection indirection', async () => {
    const result = await materializePiConnectedServiceRuntimeAuthSelection({
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
      },
      api: {} as any,
      input: {
        mode: 'apply',
        tracked: {
          startedBy: 'daemon',
          happySessionId: 'sess_1',
          pid: 999,
          spawnOptions: {
            directory: '/tmp/workspace',
            backendTarget: { kind: 'builtInAgent', agentId: 'pi' },
            environmentVariables: {
              [PI_BROKER_SELECTION_IDENTITY_ENV]: 'pi|connected|broker:1|claude-subscription:acct-old:',
            },
          },
        },
        sessionId: 'sess_1',
        agentId: 'pi',
        serviceId: 'claude-subscription',
        previous: null,
        next: {
          source: 'connected',
          selection: 'group',
          serviceId: 'claude-subscription',
          profileId: 'profile-new',
          groupId: 'main',
        },
        previousBindings: { v: 1, bindingsByServiceId: {} },
        normalizedBindings: { v: 1, bindingsByServiceId: {} },
      },
      baseSelection: {
        serviceId: 'claude-subscription',
        binding: { source: 'connected', selection: 'group', groupId: 'main', profileId: 'profile-new' },
        profileId: 'profile-new',
        groupId: 'main',
        activeProfileId: 'profile-new',
        fallbackProfileId: 'profile-old',
        generation: 12,
        credentialRevision: null,
        record: { profileId: 'profile-new' },
      },
    });

    expect(result).toMatchObject({
      brokerSelectionIdentity: 'pi|connected|broker:1|claude-subscription:acct-old:',
      serviceId: 'claude-subscription',
      activeProfileId: 'profile-new',
      generation: 12,
    });
  });
});
