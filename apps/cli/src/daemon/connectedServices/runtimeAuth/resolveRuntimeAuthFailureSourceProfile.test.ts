import { describe, expect, it, vi } from 'vitest';

import { resolveRuntimeAuthFailureSourceProfile } from './resolveRuntimeAuthFailureSourceProfile';

const classification = {
  kind: 'usage_limit',
  limitCategory: 'usage_limit',
  serviceId: 'claude-subscription',
  profileId: 'launch-profile',
  groupId: 'claude',
  groupGeneration: 4,
  expectedCredentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
  sourceProviderAccountId: 'acct-live',
  resetsAtMs: null,
  planType: null,
  rateLimits: null,
  source: 'structured_provider_error',
} as const;

describe('resolveRuntimeAuthFailureSourceProfile', () => {
  it('maps exact provider account evidence to the unique group member and drops stale tuple fields', async () => {
    await expect(resolveRuntimeAuthFailureSourceProfile({
      classification,
      getGroupMembers: async () => [{ profileId: 'launch-profile' }, { profileId: 'live-profile' }],
      resolveProviderAccountId: async (profileId) => profileId === 'live-profile' ? 'acct-live' : 'acct-old',
    })).resolves.toMatchObject({
      profileId: 'live-profile',
      groupGeneration: null,
      expectedCredentialRevision: null,
    });
  });

  it('leaves ambiguous provider identity unchanged', async () => {
    const result = await resolveRuntimeAuthFailureSourceProfile({
      classification,
      getGroupMembers: async () => [{ profileId: 'a' }, { profileId: 'b' }],
      resolveProviderAccountId: async () => 'acct-live',
    });
    expect(result).toBe(classification);
  });

  it('does not load the group without provider account evidence', async () => {
    const getGroupMembers = vi.fn(async () => [{ profileId: 'a' }]);
    const input = { ...classification, sourceProviderAccountId: null };
    expect(await resolveRuntimeAuthFailureSourceProfile({
      classification: input,
      getGroupMembers,
      resolveProviderAccountId: async () => 'acct-live',
    })).toBe(input);
    expect(getGroupMembers).not.toHaveBeenCalled();
  });
});
