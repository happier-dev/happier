import { describe, expect, it } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { resolveScmHostingBasicAuthMaterialization } from './resolveScmHostingBasicAuthMaterialization';

describe('resolveScmHostingBasicAuthMaterialization', () => {
  it('materializes Bitbucket Cloud email and API token credentials only for bitbucket.org', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1700000000000,
      serviceId: 'bitbucket',
      profileId: 'work',
      kind: 'token',
      token: {
        token: '  bb-api-token  ',
        providerAccountId: 'dev@example.com',
        providerEmail: 'dev@example.com',
      },
    });

    expect(resolveScmHostingBasicAuthMaterialization({
      kind: 'scm_hosting_basic_auth',
      providerId: 'scm.bitbucket',
      host: 'bitbucket.org',
      profileId: 'work',
      records: [record],
    })).toEqual({
      kind: 'available',
      username: 'dev@example.com',
      password: 'bb-api-token',
      profileId: 'work',
      serviceId: 'bitbucket',
      credentialKind: 'bitbucket_basic_auth',
      providerAccountId: 'dev@example.com',
      providerEmail: 'dev@example.com',
    });
  });

  it('does not materialize Bitbucket credentials for custom hosts or incomplete records', () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1700000000000,
      serviceId: 'bitbucket',
      profileId: 'work',
      kind: 'token',
      token: {
        token: 'bb-api-token',
        providerAccountId: null,
        providerEmail: null,
      },
    });

    expect(resolveScmHostingBasicAuthMaterialization({
      kind: 'scm_hosting_basic_auth',
      providerId: 'scm.bitbucket',
      host: 'bitbucket.internal.test',
      profileId: 'work',
      records: [record],
    })).toEqual({
      kind: 'missing',
      reason: 'unsupported_host',
    });

    expect(resolveScmHostingBasicAuthMaterialization({
      kind: 'scm_hosting_basic_auth',
      providerId: 'scm.bitbucket',
      host: 'bitbucket.org',
      profileId: 'work',
      records: [record],
    })).toEqual({
      kind: 'missing',
      reason: 'credential_unavailable',
    });
  });
});
