import { describe, expect, it } from 'vitest';

import { resolveRuntimeAccountIdentityFanoutMatch } from './resolveRuntimeAccountIdentityFanoutMatch';

describe('resolveRuntimeAccountIdentityFanoutMatch', () => {
  it('returns expected and actual identity proof when exact provider account mismatches', () => {
    expect(resolveRuntimeAccountIdentityFanoutMatch({
      strategy: 'provider_account_id',
      providerAccountId: 'acct-a',
      candidate: {
        sessionId: 'different-account',
        serviceId: 'openai-codex',
        groupId: 'team',
        profileId: 'primary',
        groupGeneration: 4,
      },
      result: {
        status: 'exact',
        strategy: 'provider_account_id',
        providerAccountId: 'acct-b',
        profileId: 'primary',
        groupId: 'team',
        groupGeneration: 4,
        observedAtMs: 1_000,
      },
      observedAtMs: 1_000,
    })).toEqual({
      status: 'suppressed',
      reason: 'runtime_identity_probe_account_mismatch',
      diagnostic: {
        sessionId: 'different-account',
        expectedProviderAccountId: 'acct-a',
        actualProviderAccountId: 'acct-b',
        expectedProfileId: 'primary',
        actualProfileId: 'primary',
        expectedGroupId: 'team',
        actualGroupId: 'team',
        expectedGroupGeneration: 4,
        actualGroupGeneration: 4,
      },
    });
  });
});
