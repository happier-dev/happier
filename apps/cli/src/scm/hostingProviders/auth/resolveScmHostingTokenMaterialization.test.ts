import { describe, expect, it } from 'vitest';

import { materializeGithubScmHostingToken } from '@happier-dev/plugins-scm-github';
import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import type { ScmHostingAuthMaterializationRegistry } from './materializationRegistry';
import { resolveScmHostingTokenMaterialization } from './resolveScmHostingTokenMaterialization';
import type {
  ScmHostingTokenMaterializationRequest,
  ScmHostingTokenMaterializationResult,
} from './types';

type TokenMaterializationRegistryFixture = Readonly<{
  scmHostingProvidersById: ReadonlyMap<string, Readonly<{
    registration: Readonly<{
      auth?: Readonly<{
        tokenMaterializer?: Readonly<{
          serviceId: string;
          materialize: (request: ScmHostingTokenMaterializationRequest) => ScmHostingTokenMaterializationResult;
        }>;
      }>;
    }>;
  }>>;
}>;

type TokenMaterializationResolver = (
  request: ScmHostingTokenMaterializationRequest,
  registry: TokenMaterializationRegistryFixture,
) => Promise<ScmHostingTokenMaterializationResult>;

const githubMaterializationRegistry: ScmHostingAuthMaterializationRegistry = {
  scmHostingProvidersById: new Map([[
    'scm.github',
    {
      registration: {
        id: 'scm.github',
        adapter: {},
        auth: {
          tokenMaterializer: {
            serviceId: 'github',
            materialize: materializeGithubScmHostingToken,
          },
        },
      },
    },
  ]]),
};

describe('resolveScmHostingTokenMaterialization', () => {
  it('materializes through a provider runtime materializer', async () => {
    const record = buildConnectedServiceCredentialRecord({
      now: 1700000000000,
      serviceId: 'github',
      profileId: 'work',
      kind: 'token',
      token: {
        token: '  registry-token  ',
        providerAccountId: 'octocat',
        providerEmail: 'octocat@example.com',
      },
    });
    const registry: TokenMaterializationRegistryFixture = {
      scmHostingProvidersById: new Map([[
        'scm.example',
        {
          registration: {
            auth: {
              tokenMaterializer: {
                serviceId: 'github',
                materialize: (request) => {
            const tokenRecord = request.records.find((candidate) => candidate.kind === 'token');
            if (!tokenRecord || tokenRecord.kind !== 'token') {
              return { kind: 'missing', reason: 'credential_unavailable' };
            }
            return {
              kind: 'available',
              token: tokenRecord.token.token.trim(),
              profileId: tokenRecord.profileId,
              serviceId: tokenRecord.serviceId,
              credentialKind: tokenRecord.kind,
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

    const resolveWithRegistry = resolveScmHostingTokenMaterialization as TokenMaterializationResolver;

    await expect(Promise.resolve(resolveWithRegistry({
      kind: 'scm_hosting_token',
      providerId: 'scm.example',
      host: 'example.test',
      profileId: 'work',
      records: [record],
    }, registry))).resolves.toEqual({
      kind: 'available',
      token: 'registry-token',
      profileId: 'work',
      serviceId: 'github',
      credentialKind: 'token',
      providerAccountId: 'octocat',
      providerEmail: 'octocat@example.com',
    });
  });

  it('rejects malformed hook results instead of accepting undefined profile material', async () => {
    const registry: TokenMaterializationRegistryFixture = {
      scmHostingProvidersById: new Map([[
        'scm.example',
        {
          registration: {
            auth: {
              tokenMaterializer: {
                serviceId: 'github',
                materialize: () => ({
                  kind: 'available',
                  token: 'registry-token',
                } as unknown as ScmHostingTokenMaterializationResult),
              },
            },
          },
        },
      ]]),
    };

    const resolveWithRegistry = resolveScmHostingTokenMaterialization as TokenMaterializationResolver;

    await expect(Promise.resolve(resolveWithRegistry({
      kind: 'scm_hosting_token',
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
    const registry: TokenMaterializationRegistryFixture = {
      scmHostingProvidersById: new Map([[
        'scm.example',
        {
          registration: {
            auth: {
              tokenMaterializer: {
                serviceId: 'github',
                materialize: () => ({
                  kind: 'missing',
                  reason: 'not_a_typed_reason',
                } as unknown as ScmHostingTokenMaterializationResult),
              },
            },
          },
        },
      ]]),
    };

    const resolveWithRegistry = resolveScmHostingTokenMaterialization as TokenMaterializationResolver;

    await expect(Promise.resolve(resolveWithRegistry({
      kind: 'scm_hosting_token',
      providerId: 'scm.example',
      host: 'example.test',
      profileId: 'work',
      records: [],
    }, registry))).resolves.toEqual({
      kind: 'missing',
      reason: 'unsupported_provider',
    });
  });

  it('materializes a GitHub connected account token for github.com', async () => {
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

    await expect(resolveScmHostingTokenMaterialization({
      kind: 'scm_hosting_token',
      providerId: 'scm.github',
      host: 'github.com',
      profileId: 'work',
      records: [record],
    }, githubMaterializationRegistry)).resolves.toEqual({
      kind: 'available',
      token: 'redacted-test-token',
      profileId: 'work',
      serviceId: 'github',
      credentialKind: 'token',
      providerAccountId: 'octocat',
      providerEmail: 'octocat@example.com',
    });
  });

  it('does not send github.com connected account tokens to enterprise hosts', async () => {
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

    await expect(resolveScmHostingTokenMaterialization({
      kind: 'scm_hosting_token',
      providerId: 'scm.github',
      host: 'ghe.internal.test',
      profileId: 'work',
      records: [record],
    }, githubMaterializationRegistry)).resolves.toEqual({
      kind: 'missing',
      reason: 'unsupported_host',
    });
  });

  it('returns missing for blank tokens and wrong record kinds', async () => {
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

    await expect(resolveScmHostingTokenMaterialization({
      kind: 'scm_hosting_token',
      providerId: 'scm.github',
      host: 'github.com',
      profileId: 'work',
      records: [blankRecord, oauthRecord],
    }, githubMaterializationRegistry)).resolves.toEqual({
      kind: 'missing',
      reason: 'credential_unavailable',
    });
  });
});
