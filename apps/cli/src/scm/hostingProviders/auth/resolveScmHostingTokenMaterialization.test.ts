import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { resolveScmHostingTokenMaterialization } from './resolveScmHostingTokenMaterialization';

describe('resolveScmHostingTokenMaterialization', () => {
  it('materializes a GitHub connected account token for github.com', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1700000000000,
      serviceId: 'github',
      profileId: 'work',
      kind: 'token',
      token: {
        token: '  redacted-test-token  ',
        providerAccountId: 'octocat',
        providerEmail: 'octocat@example.com',
      },
    });

    expect(resolveScmHostingTokenMaterialization({
      kind: 'scm_hosting_token',
      providerId: 'scm.github',
      host: 'github.com',
      profileId: 'work',
      records: [record],
    })).toEqual({
      kind: 'available',
      token: 'redacted-test-token',
      profileId: 'work',
      serviceId: 'github',
      credentialKind: 'token',
      providerAccountId: 'octocat',
      providerEmail: 'octocat@example.com',
    });
  });

  it('does not send github.com connected account tokens to enterprise hosts', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1700000000000,
      serviceId: 'github',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'redacted-test-token',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(resolveScmHostingTokenMaterialization({
      kind: 'scm_hosting_token',
      providerId: 'scm.github',
      host: 'ghe.internal.test',
      profileId: 'work',
      records: [record],
    })).toEqual({
      kind: 'missing',
      reason: 'unsupported_host',
    });
  });

  it('returns missing for blank tokens and wrong record kinds', () => {
    const blankGithub = buildConnectedServiceCredentialRecord({
      now: 1700000000000,
      serviceId: 'github',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'token',
        providerAccountId: null,
        providerEmail: null,
      },
    });
    if (blankGithub.kind !== 'token') {
      throw new Error('Expected token fixture');
    }
    const blankRecord = {
      ...blankGithub,
      token: {
        ...blankGithub.token,
        token: '   ',
      },
    };
    const oauthRecord = buildConnectedServiceCredentialRecord({
      now: 1700000000000,
      serviceId: 'openai-codex',
      profileId: 'work',
      kind: 'oauth',
      oauth: {
        accessToken: 'server-identity-token-must-not-be-used',
        refreshToken: 'refresh',
        idToken: null,
        scope: null,
        tokenType: null,
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(resolveScmHostingTokenMaterialization({
      kind: 'scm_hosting_token',
      providerId: 'scm.github',
      host: 'github.com',
      profileId: 'work',
      records: [blankRecord, oauthRecord],
    })).toEqual({
      kind: 'missing',
      reason: 'credential_unavailable',
    });
  });
});
