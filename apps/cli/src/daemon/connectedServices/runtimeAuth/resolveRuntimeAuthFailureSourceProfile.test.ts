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
  sourceProviderOrganizationId: 'org-live',
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
      resolveProviderAccountIdentity: async (profileId) => (
        { providerAccountId: profileId === 'live-profile' ? 'acct-live' : 'acct-old', providerOrganizationId: 'org-live' }
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
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'acct-live', providerOrganizationId: 'org-live' }),
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
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'acct-live', providerOrganizationId: 'org-live' }),
    });

    expect(resolved).toMatchObject({ profileId: null, groupGeneration: null, credentialRevision: null });
  });

  it('resolves the attested organization when group members share a provider user', async () => {
    const resolved = await resolveRuntimeAuthFailureSourceProfile({
      classification: { ...classification, sourceProviderOrganizationId: 'org-live' },
      getGroupMembers: async () => [
        { profileId: 'spawn-profile', enabled: true },
        { profileId: 'live-profile', enabled: true },
      ],
      resolveProviderAccountIdentity: async (profileId) => ({ providerAccountId: 'acct-live',
        providerOrganizationId: profileId === 'live-profile' ? 'org-live' : 'org-old' }),
    });

    expect(resolved.profileId).toBe('live-profile');
    expect(resolved.credentialRevision).toBeNull();
  });

  it('does not substitute a member whose organization cannot attest the observed context', async () => {
    const original = { ...classification, sourceProviderOrganizationId: 'org-live' };
    const resolved = await resolveRuntimeAuthFailureSourceProfile({
      classification: original,
      getGroupMembers: async () => [{ profileId: 'other-profile', enabled: true }],
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'acct-live' }),
    });
    expect(resolved).toMatchObject({ ...original, profileId: null, groupGeneration: null, credentialRevision: null });
  });

  it('does not treat a user-only observation as proof of an organization-bearing member', async () => {
    const resolved = await resolveRuntimeAuthFailureSourceProfile({
      classification: { ...classification, sourceProviderOrganizationId: null },
      getGroupMembers: async () => [{ profileId: 'spawn-profile', enabled: true }],
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'acct-live', providerOrganizationId: 'org-other' }),
    });
    expect(resolved).toMatchObject({ profileId: null, groupGeneration: null, credentialRevision: null });
  });

  it('does not attribute unknown-organization Claude quota evidence even when a legacy credential user matches', async () => {
    const original = { ...classification, sourceProviderOrganizationId: null };
    const resolved = await resolveRuntimeAuthFailureSourceProfile({ classification: original,
      getGroupMembers: async () => [{ profileId: 'spawn-profile', enabled: true }],
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'acct-live' }),
    });
    expect(resolved).toMatchObject({ profileId: null, groupGeneration: null, credentialRevision: null });
  });

  it.each(['auth_expired', 'account-only quota'])('preserves %s source policy without a required quota organization', async (kind) => {
    const original = { ...classification, sourceProviderOrganizationId: null,
      ...(kind === 'auth_expired' ? { kind: 'auth_expired' as const } : { serviceId: 'openai-codex' }),
    };
    const resolved = await resolveRuntimeAuthFailureSourceProfile({ classification: original,
      getGroupMembers: async () => [{ profileId: 'spawn-profile', enabled: true }],
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'acct-live' }),
    });
    expect(resolved).toBe(original);
  });

  it('does not load group state without provider-qualified group evidence', async () => {
    const getGroupMembers = vi.fn(async () => []);

    const resolved = await resolveRuntimeAuthFailureSourceProfile({
      classification: { ...classification, sourceProviderAccountId: null },
      getGroupMembers,
      resolveProviderAccountIdentity: async () => null,
    });

    expect(resolved).not.toHaveProperty('sourceProviderAccountId', 'acct-live');
    expect(getGroupMembers).not.toHaveBeenCalled();
  });
});
