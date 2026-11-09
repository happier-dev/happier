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
  it('maps only a unique provider-reported organization without borrowing a current provider account', async () => {
    await expect(resolveRuntimeAuthFailureSourceProfile({
      classification: { ...classification, sourceProviderAccountId: null, sourceProviderOrganizationId: null,
        providerReportedOrganizationId: 'org-live' },
      getGroupMembers: async () => [{ profileId: 'live-profile' }],
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'another-user', providerOrganizationId: 'org-live' }),
    })).resolves.toMatchObject({ profileId: 'live-profile', groupGeneration: null, expectedCredentialRevision: null });
  });

  it.each([
    { reported: 'org-other', captured: 'org-live', organizations: ['org-live', 'org-other'] },
    { reported: 'org-live', captured: null, organizations: ['org-live', 'org-live'] },
    { reported: null, captured: 'org-live', organizations: ['org-live'] },
  ])('leaves contradictory, ambiguous or unknown provider evidence unattributed: $reported/$captured', async ({ reported, captured, organizations }) => {
    await expect(resolveRuntimeAuthFailureSourceProfile({
      classification: { ...classification, sourceProviderOrganizationId: captured, providerReportedOrganizationId: reported },
      getGroupMembers: async () => organizations.map((_, i) => ({ profileId: `member-${i}` })),
      resolveProviderAccountIdentity: async (profileId) => ({ providerAccountId: 'acct-live',
        providerOrganizationId: organizations[Number(profileId.split('-')[1])] }),
    })).resolves.toMatchObject({ profileId: null, groupGeneration: null, expectedCredentialRevision: null });
  });

  it.each(['missing', 'unreadable'])('requires every sibling identity to prove organization uniqueness: %s', async (state) => {
    await expect(resolveRuntimeAuthFailureSourceProfile({
      classification: { ...classification, sourceProviderAccountId: null, providerReportedOrganizationId: 'org-live' },
      getGroupMembers: async () => [{ profileId: 'launch-profile' }, { profileId: 'unknown' }],
      resolveProviderAccountIdentity: async (profileId) => {
        if (profileId === 'unknown') {
          if (state === 'unreadable') throw new Error('identity unavailable');
          return null;
        }
        return { providerAccountId: 'acct-live', providerOrganizationId: 'org-live' };
      },
    })).resolves.toMatchObject({ profileId: null, groupGeneration: null, expectedCredentialRevision: null });
  });

  it('keeps account-only service attribution independent of incidental organization metadata', async () => {
    await expect(resolveRuntimeAuthFailureSourceProfile({
      classification: { ...classification, serviceId: 'happier.agent.codex/openai-codex' },
      getGroupMembers: async () => [{ profileId: 'live-profile' }],
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'acct-live', providerOrganizationId: 'metadata-org' }),
    })).resolves.toMatchObject({ profileId: 'live-profile' });
  });

  it('does not use user-only quota evidence when the service requires organization context', async () => {
    await expect(resolveRuntimeAuthFailureSourceProfile({ classification, requiresProviderOrganizationId: true,
      getGroupMembers: async () => [{ profileId: 'launch-profile' }],
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'acct-live' }),
    })).resolves.toMatchObject({ profileId: null, groupGeneration: null, expectedCredentialRevision: null });
  });

  it('attributes the observed organization rather than the stale launch member for the same provider user', async () => {
    await expect(resolveRuntimeAuthFailureSourceProfile({
      classification: { ...classification, sourceProviderOrganizationId: 'org-live' },
      getGroupMembers: async () => [{ profileId: 'launch-profile' }, { profileId: 'live-profile' }],
      resolveProviderAccountIdentity: async (profileId) => ({
        providerAccountId: 'acct-live', providerOrganizationId: profileId === 'live-profile' ? 'org-live' : 'org-old',
      }),
    })).resolves.toMatchObject({ profileId: 'live-profile', groupGeneration: null, expectedCredentialRevision: null });
  });

  it('maps exact provider account evidence to the unique group member and drops stale tuple fields', async () => {
    await expect(resolveRuntimeAuthFailureSourceProfile({
      classification,
      getGroupMembers: async () => [{ profileId: 'launch-profile' }, { profileId: 'live-profile' }],
      resolveProviderAccountIdentity: async (profileId) => ({ providerAccountId: profileId === 'live-profile' ? 'acct-live' : 'acct-old' }),
    })).resolves.toMatchObject({
      profileId: 'live-profile',
      groupGeneration: null,
      expectedCredentialRevision: null,
    });
  });

  it('clears an ambiguous stale source tuple', async () => {
    const result = await resolveRuntimeAuthFailureSourceProfile({
      classification,
      getGroupMembers: async () => [{ profileId: 'a' }, { profileId: 'b' }],
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'acct-live' }),
    });
    expect(result).toMatchObject({ profileId: null, groupGeneration: null, expectedCredentialRevision: null });
  });

  it('does not load the group without provider account evidence', async () => {
    const getGroupMembers = vi.fn(async () => [{ profileId: 'a' }]);
    const input = { ...classification, sourceProviderAccountId: null };
    expect(await resolveRuntimeAuthFailureSourceProfile({
      classification: input,
      getGroupMembers,
      resolveProviderAccountIdentity: async () => ({ providerAccountId: 'acct-live' }),
    })).toBe(input);
    expect(getGroupMembers).not.toHaveBeenCalled();
  });
});
