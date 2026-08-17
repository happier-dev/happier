import { describe, expect, it } from 'vitest';

import { AccountProfileSchema } from './profile';

describe('AccountProfileSchema connectedServicesV2', () => {
  it('defaults connectedServicesV2 to an empty array', () => {
    const parsed = AccountProfileSchema.parse({ id: 'acct' });
    expect(parsed.connectedServicesV2).toEqual([]);
    expect(parsed.connectedServiceCredentialRevisionsV1).toEqual([]);
    expect(parsed.connectedAccountsV4).toEqual([]);
    expect(parsed.connectedAccountGroupsV4).toEqual([]);
  });

  it('projects novel qualified accounts and groups without a legacy service enum', () => {
    const service = {
      pluginId: 'third-party.connected-accounts',
      localId: 'service/with/path',
    };
    const parsed = AccountProfileSchema.parse({
      id: 'acct',
      connectedAccountsV4: [{
        ref: { service, accountId: 'account/with/path' },
        status: 'connected',
        authenticationModeId: 'manual',
        revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
        configurationReady: false,
        configurationRevision: null,
        displayName: 'Novel account',
        scopes: [],
      }],
      connectedAccountGroupsV4: [{
        v: 1,
        ref: { service, groupId: 'fallback' },
        incarnation: 'qualified-group-row-fallback',
        displayName: null,
        policy: {},
        activeConnectedAccountId: 'account/with/path',
        generation: 0,
        runtimeStateRevision: 0,
        state: {},
        createdAt: 1,
        updatedAt: 1,
        members: [],
      }],
    });

    expect(parsed.connectedAccountsV4[0]?.ref.service).toEqual(service);
    expect(parsed.connectedAccountGroupsV4[0]?.ref.service).toEqual(service);
    expect(AccountProfileSchema.safeParse({
      id: 'acct',
      connectedAccountsV4: [{
        ...parsed.connectedAccountsV4[0],
        serviceId: 'openai',
      }],
    }).success).toBe(false);
  });

  it('parses exact opaque credential revisions while older projections may omit them', () => {
    const parsed = AccountProfileSchema.parse({
      id: 'acct',
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'openai-codex',
        profileId: 'work',
        credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
      }],
    });

    expect(parsed.connectedServiceCredentialRevisionsV1).toEqual([{
      serviceId: 'openai-codex',
      profileId: 'work',
      credentialRevision: 'csr_1123456789ABCDEFGHJKMNPQRS',
    }]);
    expect(AccountProfileSchema.safeParse({
      id: 'acct',
      connectedServiceCredentialRevisionsV1: [{
        serviceId: 'openai-codex',
        profileId: 'work',
        credentialRevision: 'not-a-revision',
      }],
    }).success).toBe(false);
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
