import { describe, expect, it } from 'vitest';

import { agent } from './index';

describe('Claude connected-service credential lifecycle descriptor', () => {
  it('advertises shared-group live soft switching without claiming in-turn exact runtime identity', async () => {
    await expect(agent.getConnectedServiceCredentialLifecycleDescriptor()).resolves.toMatchObject({
      providerId: 'claude',
      serviceIds: expect.arrayContaining(['claude-subscription', 'anthropic']),
      spawnPreflightOauthRefresh: { mode: 'expiry_window' },
      refreshedCredentialApplication: {
        mode: 'restart_required',
        noRestartRequiredServiceIds: ['claude-subscription'],
      },
      sameAccountFanoutStrategy: 'shared_group_auth_surface',
      generationApplicationScope: 'shared_group_auth_surface',
      sharedGenerationApplicationServiceIds: ['claude-subscription'],
      applySharedGenerationApplication: expect.any(Function),
      predictiveSoftSwitch: {
        mode: 'supported',
        liveSessionRequirement: {
          kind: 'shared_group_auth_surface',
          serviceIds: ['claude-subscription'],
          authEnvKey: 'CLAUDE_CONFIG_DIR',
          authEnvSubpath: ['claude-config'],
        },
      },
      runtimeAuthApply: {
        directLiveHotAuth: {
          supportsInTurnApply: true,
          requiresExactRuntimeIdentity: false,
          refreshSelectionResync: 'not_applicable',
          authMode: {
            kind: 'provider_owned',
            name: 'claude_shared_group_auth_surface',
          },
        },
      },
    });
  });
});
