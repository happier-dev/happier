import { describe, expect, it, vi } from 'vitest';

import { resolveRuntimeAuthFailureSourceProfile } from './resolveRuntimeAuthFailureSourceProfile';

const classification = {
  kind: 'usage_limit' as const,
  limitCategory: 'usage_limit' as const,
  serviceId: 'claude-subscription',
  profileId: 'spawn-profile',
  groupId: 'claude',
  groupGeneration: 370,
  credentialRevision: 'csr_7123456789ABCDEFGHJKMNPQRS' as const,
  sourceProviderAccountId: 'acct-live',
  resetsAtMs: null,
  planType: null,
  rateLimits: null,
  source: 'structured_provider_error' as const,
};

describe('resolveRuntimeAuthFailureSourceProfile', () => {
  it('replaces stale spawn profile identity with the unique provider-qualified group member', async () => {
    const resolved = await resolveRuntimeAuthFailureSourceProfile({
      classification,
      getGroupMembers: async () => [
        { profileId: 'spawn-profile', enabled: true },
        { profileId: 'live-profile', enabled: true },
      ],
      resolveProviderAccountId: async (profileId) => (
        profileId === 'live-profile' ? 'acct-live' : 'acct-old'
      ),
    });

    expect(resolved).toEqual({
      ...classification,
      profileId: 'live-profile',
      groupGeneration: null,
      credentialRevision: null,
    });
  });

  it('preserves an already matching exact source tuple', async () => {
    const resolved = await resolveRuntimeAuthFailureSourceProfile({
      classification,
      getGroupMembers: async () => [{ profileId: 'spawn-profile', enabled: true }],
      resolveProviderAccountId: async () => 'acct-live',
    });

    expect(resolved).toBe(classification);
  });

  it('does not guess when provider account identity is ambiguous', async () => {
    const resolved = await resolveRuntimeAuthFailureSourceProfile({
      classification,
      getGroupMembers: async () => [
        { profileId: 'one', enabled: true },
        { profileId: 'two', enabled: true },
      ],
      resolveProviderAccountId: async () => 'acct-live',
    });

    expect(resolved).toBe(classification);
  });

  it('does not load group state without provider-qualified group evidence', async () => {
    const getGroupMembers = vi.fn(async () => []);

    const resolved = await resolveRuntimeAuthFailureSourceProfile({
      classification: { ...classification, sourceProviderAccountId: null },
      getGroupMembers,
      resolveProviderAccountId: async () => null,
    });

    expect(resolved).not.toHaveProperty('sourceProviderAccountId', 'acct-live');
    expect(getGroupMembers).not.toHaveBeenCalled();
  });
});
