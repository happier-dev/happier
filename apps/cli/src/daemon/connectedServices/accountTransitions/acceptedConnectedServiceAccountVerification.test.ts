import { describe, expect, it } from 'vitest';

import { toAcceptedConnectedServiceAccountVerification } from './acceptedConnectedServiceAccountVerification';

describe('toAcceptedConnectedServiceAccountVerification', () => {
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
