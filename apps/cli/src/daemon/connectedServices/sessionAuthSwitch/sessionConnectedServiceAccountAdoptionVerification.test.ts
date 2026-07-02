import { describe, expect, it } from 'vitest';

import { createSessionConnectedServiceAccountAdoptionVerifier } from './sessionConnectedServiceAccountAdoptionVerification';

describe('createSessionConnectedServiceAccountAdoptionVerifier', () => {
  it('fails closed when a provider has no active-account verifier', async () => {
    const verify = createSessionConnectedServiceAccountAdoptionVerifier({
      resolveRuntimeAuthAdapter: async () => null,
    });

    await expect(verify({
      tracked: {
        startedBy: 'daemon',
        happySessionId: 'sess_1',
        pid: 123,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' },
        },
      },
      sessionId: 'sess_1',
      agentId: 'codex',
      serviceId: 'openai-codex',
      target: {
        serviceId: 'openai-codex',
        profileId: 'work',
      },
      normalizedBindings: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      action: 'hot_applied',
    })).resolves.toEqual({
      status: 'unavailable',
      retryable: false,
      reason: 'active_account_verifier_unavailable',
    });
  });
});
