import { describe, expect, it } from 'vitest';

import { AccountProfileSchema } from './profile';

describe('AccountProfileSchema connectedServicesV2', () => {
  it('defaults connectedServicesV2 to an empty array', () => {
    const parsed = AccountProfileSchema.parse({ id: 'acct' });
    expect(parsed.connectedServicesV2).toEqual([]);
  });

  it('limits legacy connectedServices to cloud-vendor keys', () => {
    const parsed = AccountProfileSchema.parse({
      id: 'acct',
      connectedServices: ['openai', 'anthropic', 'gemini'],
    });

    expect(parsed.connectedServices).toEqual(['openai', 'anthropic', 'gemini']);

    expect(() =>
      AccountProfileSchema.parse({
        id: 'acct',
        connectedServices: ['openai-codex'],
      }),
    ).toThrow();
  });

  it('accepts connectedServicesV2 service + profile projections', () => {
    const parsed = AccountProfileSchema.parse({
      id: 'acct',
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [
            {
              profileId: 'work',
              status: 'needs_reauth',
              kind: 'oauth',
              providerEmail: 'a@b.com',
              expiresAt: 1,
              health: {
                v: 1,
                status: 'needs_reauth',
                reconnectRequired: true,
                lastRefreshFailureKind: 'invalid_grant',
                lastRefreshFailureAt: 2,
              },
            },
          ],
        },
      ],
    });
    expect(parsed.connectedServicesV2[0]?.serviceId).toBe('openai-codex');
    expect(parsed.connectedServicesV2[0]?.profiles[0]?.profileId).toBe('work');
    expect(parsed.connectedServicesV2[0]?.profiles[0]?.health?.reconnectRequired).toBe(true);
    expect(JSON.stringify(parsed.connectedServicesV2)).not.toContain('secret');
  });

  it('accepts connectedServicesV2 account-group projections from account profile responses', () => {
    const parsed = AccountProfileSchema.parse({
      id: 'acct',
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [
            { profileId: 'work', status: 'connected', kind: 'oauth' },
            { profileId: 'backup', status: 'connected', kind: 'oauth' },
          ],
          groups: [
            {
              groupId: 'codex-main',
              displayName: 'Codex main',
              activeProfileId: 'work',
              generation: 2,
              memberProfileIds: ['work', 'backup'],
            },
          ],
        },
      ],
    });

    expect(parsed.connectedServicesV2[0]?.groups).toEqual([
      {
        groupId: 'codex-main',
        displayName: 'Codex main',
        activeProfileId: 'work',
        generation: 2,
        memberProfileIds: ['work', 'backup'],
      },
    ]);
  });
});
