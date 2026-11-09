import { describe, expect, it } from 'vitest';

import { readConnectedServiceApplicationTargetCredentialRevision, toAcceptedConnectedServiceAccountVerification } from './acceptedConnectedServiceAccountVerification';

describe('toAcceptedConnectedServiceAccountVerification', () => {
  it('does not use a materialized target from a different recipient epoch', () => {
    const serviceId = 'happier.agent.codex/openai-codex';
    const target = { serviceId, groupId: 'pool', profileId: 'B', generation: 2 };
    expect(readConnectedServiceApplicationTargetCredentialRevision({ ...target,
      materializedTargetByServiceId: { [serviceId]: { ...target, generation: 3, credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb' } },
    })).toBeNull();
  });
  it('preserves exact verified provider account ids without upgrading weak proof', () => {
    expect(toAcceptedConnectedServiceAccountVerification({
      status: 'verified',
      providerAccountId: 'acct-exact',
      proofStrength: 'exact',
      reason: 'runtime_verified',
    })).toEqual({
      status: 'verified',
      providerAccountId: 'acct-exact',
      proofStrength: 'exact',
      reason: 'runtime_verified',
    });

    expect(toAcceptedConnectedServiceAccountVerification({
      status: 'weakly_verified',
      providerAccountId: 'acct-weak',
      proofStrength: 'weak',
      reason: 'auth_surface_rewritten',
    })).toEqual({
      status: 'weakly_verified',
      reason: 'auth_surface_rewritten',
    });
  });
});
