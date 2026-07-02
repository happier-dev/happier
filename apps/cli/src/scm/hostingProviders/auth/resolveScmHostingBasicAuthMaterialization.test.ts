import { describe, expect, it } from 'vitest';

import { materializeBitbucketScmHostingBasicAuth } from '@happier-dev/plugins-scm-bitbucket/auth/basicAuthMaterializer';
import {
  BITBUCKET_CONNECTED_ACCOUNT_DESCRIPTOR,
  buildConnectedServiceCredentialRecord,
} from '@happier-dev/protocol';

import type { ScmHostingAuthMaterializationRegistry } from './materializationRegistry';
import { resolveScmHostingBasicAuthMaterialization } from './resolveScmHostingBasicAuthMaterialization';
import type {
  ScmHostingBasicAuthMaterializationRequest,
  ScmHostingBasicAuthMaterializationResult,
} from './types';

type BasicAuthMaterializationRegistryFixture = Readonly<{
  scmHostingProvidersById: ReadonlyMap<string, Readonly<{
    registration: Readonly<{
      auth?: Readonly<{
        basicAuthMaterializer?: Readonly<{
          serviceId: string;
          materialize: (
            request: ScmHostingBasicAuthMaterializationRequest
          ) => ScmHostingBasicAuthMaterializationResult;
        }>;
      }>;
    }>;
  }>>;
}>;

type BasicAuthMaterializationResolver = (
  request: ScmHostingBasicAuthMaterializationRequest,
  registry: BasicAuthMaterializationRegistryFixture,
) => Promise<ScmHostingBasicAuthMaterializationResult>;

const bitbucketMaterializationRegistry: ScmHostingAuthMaterializationRegistry = {
  scmHostingProvidersById: new Map([[
    'scm.bitbucket',
    {
      registration: {
        id: 'scm.bitbucket',
        adapter: {},
        auth: {
          basicAuthMaterializer: {
            serviceId: BITBUCKET_CONNECTED_ACCOUNT_DESCRIPTOR.id,
            materialize: materializeBitbucketScmHostingBasicAuth,
          },
        },
      },
    },
  ]]),
};

describe('resolveScmHostingBasicAuthMaterialization', () => {
  it('materializes through a provider runtime materializer', async () => {
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
    const registry: BasicAuthMaterializationRegistryFixture = {
      scmHostingProvidersById: new Map([[
        'scm.example',
        {
          registration: {
            auth: {
              basicAuthMaterializer: {
                serviceId: 'bitbucket',
                materialize: (request) => {
            const tokenRecord = request.records.find((candidate) => candidate.kind === 'token');
            if (!tokenRecord || tokenRecord.kind !== 'token') {
              return { kind: 'missing', reason: 'credential_unavailable' };
            }
            return {
              kind: 'available',
              username: tokenRecord.token.providerEmail ?? '',
              password: tokenRecord.token.token.trim(),
              profileId: tokenRecord.profileId,
              serviceId: 'bitbucket',
              credentialKind: 'bitbucket_basic_auth',
              providerAccountId: tokenRecord.token.providerAccountId,
              providerEmail: tokenRecord.token.providerEmail,
            };
                },
              },
            },
          },
        },
      ]]),
    };

    const resolveWithRegistry = resolveScmHostingBasicAuthMaterialization as BasicAuthMaterializationResolver;

    await expect(Promise.resolve(resolveWithRegistry({
      kind: 'scm_hosting_basic_auth',
      providerId: 'scm.example',
      host: 'example.test',
      profileId: 'work',
      records: [record],
    }, registry))).resolves.toEqual({
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

  it('rejects malformed hook results instead of accepting undefined profile material', async () => {
    const registry: BasicAuthMaterializationRegistryFixture = {
      scmHostingProvidersById: new Map([[
        'scm.example',
        {
          registration: {
            auth: {
              basicAuthMaterializer: {
                serviceId: 'bitbucket',
                materialize: () => ({
                  kind: 'available',
                  username: 'dev@example.com',
                  password: 'bb-api-token',
                } as unknown as ScmHostingBasicAuthMaterializationResult),
              },
            },
          },
        },
      ]]),
    };

    const resolveWithRegistry = resolveScmHostingBasicAuthMaterialization as BasicAuthMaterializationResolver;

    await expect(Promise.resolve(resolveWithRegistry({
      kind: 'scm_hosting_basic_auth',
      providerId: 'scm.example',
      host: 'example.test',
      profileId: 'work',
      records: [],
    }, registry))).resolves.toEqual({
      kind: 'missing',
      reason: 'unsupported_provider',
    });
  });

  it('rejects hook missing results with invalid reasons', async () => {
    const registry: BasicAuthMaterializationRegistryFixture = {
      scmHostingProvidersById: new Map([[
        'scm.example',
        {
          registration: {
            auth: {
              basicAuthMaterializer: {
                serviceId: 'bitbucket',
                materialize: () => ({
                  kind: 'missing',
                  reason: 'not_a_typed_reason',
                } as unknown as ScmHostingBasicAuthMaterializationResult),
              },
            },
          },
        },
      ]]),
    };

    const resolveWithRegistry = resolveScmHostingBasicAuthMaterialization as BasicAuthMaterializationResolver;

    await expect(Promise.resolve(resolveWithRegistry({
      kind: 'scm_hosting_basic_auth',
      providerId: 'scm.example',
      host: 'example.test',
      profileId: 'work',
      records: [],
    }, registry))).resolves.toEqual({
      kind: 'missing',
      reason: 'unsupported_provider',
    });
  });

  it('materializes Bitbucket Cloud email and API token credentials only for bitbucket.org', async () => {
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

    await expect(resolveScmHostingBasicAuthMaterialization({
      kind: 'scm_hosting_basic_auth',
      providerId: 'scm.bitbucket',
      host: 'bitbucket.org',
      profileId: 'work',
      records: [record],
    }, bitbucketMaterializationRegistry)).resolves.toEqual({
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

  it('does not materialize Bitbucket credentials for custom hosts or incomplete records', async () => {
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

    await expect(resolveScmHostingBasicAuthMaterialization({
      kind: 'scm_hosting_basic_auth',
      providerId: 'scm.bitbucket',
      host: 'bitbucket.internal.test',
      profileId: 'work',
      records: [record],
    }, bitbucketMaterializationRegistry)).resolves.toEqual({
      kind: 'missing',
      reason: 'unsupported_host',
    });

    await expect(resolveScmHostingBasicAuthMaterialization({
      kind: 'scm_hosting_basic_auth',
      providerId: 'scm.bitbucket',
      host: 'bitbucket.org',
      profileId: 'work',
      records: [record],
    }, bitbucketMaterializationRegistry)).resolves.toEqual({
      kind: 'missing',
      reason: 'credential_unavailable',
    });
  });
});
