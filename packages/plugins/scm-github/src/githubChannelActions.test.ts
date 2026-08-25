import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { MAX_CONVERSATION_RETRY_AFTER_MS } from '@happier-dev/channels-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import {
  deliverGithubChannelMessage,
  pollGithubChannelObservations,
  resolveGithubChannelEndpoint,
  resolveGithubChannelPrincipal,
  setupGithubChannels,
  testGithubChannelConnection,
} from './githubChannelActions.js';
import { createGithubApiClient } from './observations/githubApiClient.js';

const GITHUB_ACCOUNT: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: 'happier.scm.forge.github', localId: 'github-account' }),
  accountId: '99',
});

const GITHUB_CHANNEL_PROVIDER_CONFIG = Object.freeze({
  v: 1 as const,
  repository: {
    v: 1 as const,
    repositoryId: '77',
    owner: 'acme',
    name: 'widgets',
    nameWithOwner: 'acme/widgets',
  },
  integrationPrincipal: { id: '99', label: 'happier-bot' },
});

const ARBITRARY_PROVIDER_ACTION_ID = 'unrelated-targeted-role';

function githubChannelConnectionInput() {
  return {
    v: 1 as const,
    connectionId: 'connection-1',
    providerConnectionKey: 'github:repository:77',
    providerConfigVersion: 1,
    providerConfig: GITHUB_CHANNEL_PROVIDER_CONFIG,
    credentialRef: GITHUB_ACCOUNT,
  };
}

function githubChannelDeliveryInput(deliveryKey: string) {
  return {
    ...githubChannelConnectionInput(),
    endpoint: {
      kind: 'githubIssue' as const,
      audience: 'shared' as const,
      id: 'github:repository:77:issue:5:number:1',
      label: '#1 Issue title',
      parentId: '77',
      parentLabel: 'acme/widgets',
    },
    content: 'A reply that must not bypass endpoint revalidation',
    deliveryKey,
    mentionPolicy: 'suppress' as const,
    linkPreviewPolicy: 'suppress' as const,
  };
}

/** The exact published request input, so recorded calls keep their real shape. */
type GithubHttpRequestInput =
  Parameters<PluginInvocationContext['services']['http']['request']>[0];

function jsonResponse(
  value: unknown,
  status = 200,
  extraHeaders: Readonly<Record<string, string>> = {},
): Readonly<{
  status: number;
  finalUrl: string;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}> {
  return Object.freeze({
    status,
    finalUrl: 'https://api.github.com/',
    headers: Object.freeze({ 'content-type': 'application/json', ...extraHeaders }),
    body: new TextEncoder().encode(JSON.stringify(value)),
  });
}

function coreContext(
  services: Readonly<{
    connectedAccounts: Partial<PluginInvocationContext['services']['connectedAccounts']>;
    http: Partial<PluginInvocationContext['services']['http']>;
  }>,
  signal: AbortSignal = new AbortController().signal,
): PluginInvocationContext {
  return {
    plugin: { id: 'happier.scm.forge.github', version: '0.0.0' },
    contribution: {
      id: ARBITRARY_PROVIDER_ACTION_ID,
      qualifiedId: `happier.scm.forge.github/actions/${ARBITRARY_PROVIDER_ACTION_ID}`,
    },
    surface: 'plugin',
    caller: {
      kind: 'plugin',
      pluginId: 'happier.channels',
      contribution: {
        id: 'connection-setup-v1',
        qualifiedId: 'happier.channels/actions/connection-setup-v1',
      },
      materialization: {
        machineId: 'github-channel-actions-fixture-machine',
        materializationId: 'github-channel-actions-fixture-materialization',
        pluginId: 'happier.channels',
      },
    },
    signal,
    services: services as PluginInvocationContext['services'],
  };
}

describe('GitHub Channel Actions', () => {
  it('returns typed selected-transport unavailability before materializing a GitHub account', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => {
        throw new Error('The unsupported transport must not make a GitHub request.');
      }),
    };

    await expect(testGithubChannelConnection({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig: {},
      credentialRef: GITHUB_ACCOUNT,
      selectedTransport: 'socket',
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'notReady',
      reason: 'unsupported',
      diagnostic: 'GitHub Channels supports checkpointed polling only.',
    });
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('keeps authorization tied to the host-stamped Channels caller, not a conventional provider Action ID', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => {
        throw new Error('An unauthorized caller must not make a GitHub request.');
      }),
    };
    const context: PluginInvocationContext = {
      ...coreContext({ connectedAccounts, http }),
      caller: {
        kind: 'plugin',
        pluginId: 'happier.other-plugin',
        contribution: {
          id: 'unrelated-caller-role',
          qualifiedId: 'happier.other-plugin/actions/unrelated-caller-role',
        },
        materialization: {
          machineId: 'github-channel-actions-fixture-machine',
          materializationId: 'github-channel-actions-fixture-materialization',
          pluginId: 'happier.other-plugin',
        },
      },
    };

    await expect(setupGithubChannels({
      credentialRef: GITHUB_ACCOUNT,
      repository: 'acme/widgets',
    }, context)).rejects.toMatchObject({ code: 'github_channels_core_caller_required' });
    expect(connectedAccounts.materialize).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });

  it('materializes the exact selected PAT account once for setup and returns only provider facts', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url === 'https://api.github.com/repos/acme/widgets'
          ? jsonResponse({
            id: 77,
            name: 'widgets',
            full_name: 'acme/widgets',
            owner: { login: 'acme' },
          })
          : request.url === 'https://api.github.com/user'
            ? jsonResponse({ id: 99, login: 'happier-bot' })
            : Promise.reject(new Error(`Unexpected GitHub request: ${request.url}`))
      )),
    };

    await expect(setupGithubChannels({
      credentialRef: GITHUB_ACCOUNT,
      repository: 'acme/widgets',
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      v: 1,
      credentialRef: GITHUB_ACCOUNT,
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig: {
        v: 1,
        repository: {
          v: 1,
          repositoryId: '77',
          owner: 'acme',
          name: 'widgets',
          nameWithOwner: 'acme/widgets',
        },
        integrationPrincipal: { id: '99', label: 'happier-bot' },
      },
      integrationPrincipal: { id: '99', label: 'happier-bot' },
      supportedTransports: ['checkpointedPull'],
      recommendedTransport: 'checkpointedPull',
      overlapSafety: 'safe',
      replayContinuity: 'checkpointed',
      outboundTextLimit: { maximum: 65_536, unit: 'utf8Bytes' },
    });

    expect(connectedAccounts.materialize).toHaveBeenCalledOnce();
    expect(connectedAccounts.materialize).toHaveBeenCalledWith(
      'github-connected-account',
      {
        kind: 'httpHeaders',
        origin: 'https://api.github.com',
        headerNames: ['authorization'],
      },
      expect.objectContaining({
        expectedAccount: GITHUB_ACCOUNT,
        signal: expect.anything(),
      }),
    );
  });

  it('uses setup\'s repository key for one cursor across mixed issue endpoints without observation cursor identity', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url === 'https://api.github.com/repos/acme/widgets'
          ? jsonResponse({
            id: 77,
            name: 'widgets',
            full_name: 'acme/widgets',
            owner: { login: 'acme' },
          })
          : request.url === 'https://api.github.com/user'
            ? jsonResponse({ id: 99, login: 'happier-bot' })
            : request.url.includes('/issues/comments')
              ? jsonResponse([
                {
                  id: 9,
                  body: 'first issue comment',
                  created_at: '2026-08-10T12:00:01Z',
                  updated_at: '2026-08-10T12:00:01Z',
                  issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
                  user: { id: 123, login: 'octocat', type: 'User' },
                },
                {
                  id: 10,
                  body: 'second issue comment',
                  created_at: '2026-08-10T12:00:02Z',
                  updated_at: '2026-08-10T12:00:02Z',
                  issue_url: 'https://api.github.com/repos/acme/widgets/issues/2',
                  user: { id: 124, login: 'hubot', type: 'Bot' },
                },
              ])
              : request.url === 'https://api.github.com/repos/acme/widgets/issues/1'
                ? jsonResponse({ id: 5, number: 1, title: 'First issue' })
                : request.url === 'https://api.github.com/repos/acme/widgets/issues/2'
                  ? jsonResponse({ id: 6, number: 2, title: 'Second issue' })
                  : Promise.reject(new Error(`Unexpected GitHub request: ${request.url}`))
      )),
    };

    const setup = await setupGithubChannels({
      credentialRef: GITHUB_ACCOUNT,
      repository: 'acme/widgets',
    }, coreContext({ connectedAccounts, http }));

    const result = await pollGithubChannelObservations({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: setup.providerConnectionKey,
      providerConfigVersion: setup.providerConfigVersion,
      providerConfig: setup.providerConfig,
      credentialRef: setup.credentialRef,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '8',
        etag: null,
      },
      limit: 10,
      waitMs: 0,
    }, coreContext({ connectedAccounts, http }));

    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') throw new Error(`Expected a GitHub poll batch, received ${result.kind}`);
    const observations = result.observations.flatMap(({ observation }) => (
      observation.kind === 'fullText' ? [observation.observation] : []
    ));
    expect(observations).toHaveLength(2);
    expect(observations.map((observation) => observation.occurrenceId)).toEqual([
      'github:repository:77:issue-comment:9',
      'github:repository:77:issue-comment:10',
    ]);
    expect(observations.map((observation) => observation.endpoint.id)).toEqual([
      'github:repository:77:issue:5:number:1',
      'github:repository:77:issue:6:number:2',
    ]);
    for (const observation of observations) {
      expect(observation).not.toHaveProperty('streamKey');
    }
    expect(result.checkpointAfterBatch).toEqual({
      v: 1,
      updatedAtIso: '2026-08-10T12:00:02.000Z',
      commentIdAtUpdatedAt: '10',
      etag: null,
    });
  });

  it('does not let request headers replace the exact-account authorization', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => jsonResponse({ ok: true })),
    };
    const client = await createGithubApiClient(coreContext({ connectedAccounts, http }), GITHUB_ACCOUNT);

    await client.request({
      url: 'https://api.github.com/repos/acme/widgets',
      headers: {
        authorization: 'Bearer forged-token',
        'If-None-Match': 'cached-response',
      },
    });

    const requestHeaders = http.request.mock.calls[0]?.[0]?.headers ?? {};
    expect(Object.entries(requestHeaders).filter(([name]) => name.toLowerCase() === 'authorization')).toEqual([
      ['Authorization', 'Bearer exact-account-token'],
    ]);
    expect(requestHeaders['If-None-Match']).toBe('cached-response');
    expect(connectedAccounts.materialize).toHaveBeenCalledWith(
      'github-connected-account',
      {
        kind: 'httpHeaders',
        origin: 'https://api.github.com',
        headerNames: ['authorization'],
      },
      expect.objectContaining({
        expectedAccount: GITHUB_ACCOUNT,
        signal: expect.anything(),
      }),
    );
  });

  it('reports a malformed persisted GitHub checkpoint as a provider-history gap without request or checkpoint advance', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = { request: vi.fn() };
    const providerConfig = {
      v: 1,
      repository: {
        v: 1,
        repositoryId: '77',
        owner: 'acme',
        name: 'widgets',
        nameWithOwner: 'acme/widgets',
      },
      integrationPrincipal: { id: '99', label: 'happier-bot' },
    };

    const result = await pollGithubChannelObservations({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig,
      credentialRef: GITHUB_ACCOUNT,
      checkpoint: {
        v: 1,
        updatedAtIso: 'not an ISO timestamp',
        commentIdAtUpdatedAt: '1',
        etag: null,
      },
      limit: 10,
      waitMs: 0,
    }, coreContext({ connectedAccounts, http }));
    expect(result).toEqual({
      kind: 'historyGap',
      reason: 'providerHistoryUnavailable',
    });
    expect(http.request).not.toHaveBeenCalled();
  });

  it('returns a structured provider-history gap when GitHub pagination cannot establish a no-history baseline', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => jsonResponse([], 200, {
        link: '<https://api.github.com/repos/acme/widgets/issues/comments?sort=updated&direction=asc&per_page=100&page=2>; rel="next"',
      })),
    };
    const providerConfig = {
      v: 1,
      repository: {
        v: 1,
        repositoryId: '77',
        owner: 'acme',
        name: 'widgets',
        nameWithOwner: 'acme/widgets',
      },
      integrationPrincipal: { id: '99', label: 'happier-bot' },
    };

    await expect(pollGithubChannelObservations({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig,
      credentialRef: GITHUB_ACCOUNT,
      checkpoint: null,
      limit: 10,
      waitMs: 0,
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'historyGap',
      reason: 'providerHistoryUnavailable',
    });
  });

  it('returns an edited comment as bodyless routable non-admission at the poll Action boundary', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url.includes('/issues/comments')
          ? jsonResponse([{
            id: 9,
            body: 'this body must not reach normalized ingress',
            created_at: '2026-08-10T12:00:00Z',
            updated_at: '2026-08-10T12:00:01Z',
            issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
            user: { id: 123, login: 'octocat', type: 'User' },
          }])
          : request.url === 'https://api.github.com/repos/acme/widgets/issues/1'
            ? jsonResponse({ id: 5, number: 1, title: 'Issue title' })
            : Promise.reject(new Error(`Unexpected GitHub request: ${request.url}`))
      )),
    };
    const providerConfig = {
      v: 1,
      repository: {
        v: 1,
        repositoryId: '77',
        owner: 'acme',
        name: 'widgets',
        nameWithOwner: 'acme/widgets',
      },
      integrationPrincipal: { id: '99', label: 'happier-bot' },
    };

    const result = await pollGithubChannelObservations({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig,
      credentialRef: GITHUB_ACCOUNT,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '8',
        etag: null,
      },
      limit: 10,
      waitMs: 0,
    }, coreContext({ connectedAccounts, http }));

    expect(result).toMatchObject({
      kind: 'batch',
      observations: [{
        eventCandidate: null,
        observation: {
          kind: 'routableNonAdmission',
          reason: 'unsupportedEdit',
          shell: {
            occurrenceId: 'github:repository:77:issue-comment:9',
            transport: { kind: 'poll' },
            endpoint: {
              kind: 'githubIssue',
              audience: 'shared',
              id: 'github:repository:77:issue:5:number:1',
            },
            actor: {
              principalId: '123',
              label: 'octocat',
              kind: 'human',
              isIntegrationSelf: false,
            },
            message: {
              id: '9',
              revision: '2026-08-10T12:00:01.000Z',
              addressingEvidence: 'none',
              contentProvenance: 'original',
              providerTimestamp: Date.parse('2026-08-10T12:00:01.000Z'),
            },
          },
        },
      }],
      checkpointAfterBatch: {
        updatedAtIso: '2026-08-10T12:00:01.000Z',
        commentIdAtUpdatedAt: '9',
      },
    });
    expect(result.kind === 'batch' ? result.observations[0]?.observation : undefined)
      .not.toHaveProperty('shell.message.text');
    expect(result.kind === 'batch' ? result.observations[0]?.observation : undefined)
      .not.toHaveProperty('shell.streamKey');
  });

  it.each([
    {
      label: 'an over-limit comment',
      body: 'x'.repeat(64 * 1024 + 1),
      reason: 'messageTooLarge' as const,
      createdAt: '2026-08-10T12:00:02Z',
      updatedAt: '2026-08-10T12:00:02Z',
    },
    {
      label: 'a comment with unsupported content',
      body: null,
      reason: 'unsupportedContent' as const,
      createdAt: '2026-08-10T12:00:02Z',
      updatedAt: '2026-08-10T12:00:02Z',
    },
    {
      label: 'an edited comment with unsupported content',
      body: null,
      reason: 'unsupportedEdit' as const,
      createdAt: '2026-08-10T12:00:02Z',
      updatedAt: '2026-08-10T12:00:03Z',
    },
  ])('returns $label as bodyless routable non-admission at the poll Action boundary', async ({
    body,
    reason,
    createdAt,
    updatedAt,
  }) => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url.includes('/issues/comments')
          ? jsonResponse([{
            id: 10,
            body,
            created_at: createdAt,
            updated_at: updatedAt,
            issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
            user: { id: 123, login: 'octocat', type: 'User' },
          }])
          : request.url === 'https://api.github.com/repos/acme/widgets/issues/1'
            ? jsonResponse({ id: 5, number: 1, title: 'Issue title' })
            : Promise.reject(new Error(`Unexpected GitHub request: ${request.url}`))
      )),
    };
    const result = await pollGithubChannelObservations({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig: {
        v: 1,
        repository: {
          v: 1,
          repositoryId: '77',
          owner: 'acme',
          name: 'widgets',
          nameWithOwner: 'acme/widgets',
        },
        integrationPrincipal: { id: '99', label: 'happier-bot' },
      },
      credentialRef: GITHUB_ACCOUNT,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '8',
        etag: null,
      },
      limit: 10,
      waitMs: 0,
    }, coreContext({ connectedAccounts, http }));

    expect(result).toMatchObject({
      kind: 'batch',
      observations: [{
        eventCandidate: null,
        observation: {
          kind: 'routableNonAdmission',
          reason,
          shell: {
            occurrenceId: 'github:repository:77:issue-comment:10',
            message: {
              id: '10',
              revision: new Date(updatedAt).toISOString(),
            },
          },
        },
      }],
    });
    expect(result.kind === 'batch' ? result.observations[0]?.observation : undefined)
      .not.toHaveProperty('shell.message.text');
  });

  it('maps a rate-limited GitHub poll to an explicit backoff result', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => jsonResponse([], 429, { 'retry-after': '60' })),
    };
    const providerConfig = {
      v: 1,
      repository: {
        v: 1,
        repositoryId: '77',
        owner: 'acme',
        name: 'widgets',
        nameWithOwner: 'acme/widgets',
      },
      integrationPrincipal: { id: '99', label: 'happier-bot' },
    };

    await expect(pollGithubChannelObservations({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig,
      credentialRef: GITHUB_ACCOUNT,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '1',
        etag: null,
      },
      limit: 10,
      waitMs: 0,
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'notReady',
      reason: 'rateLimited',
      retryAfterMs: 60_000,
    });
  });

  it('clamps an over-24-hour Retry-After before projecting a connection result', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => jsonResponse([], 429, { 'retry-after': '86401' })),
    };

    await expect(testGithubChannelConnection({
      ...githubChannelConnectionInput(),
      selectedTransport: 'checkpointedPull',
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'notReady',
      reason: 'rateLimited',
      retryAfterMs: MAX_CONVERSATION_RETRY_AFTER_MS,
    });
  });

  it('clamps an over-24-hour reset hint before projecting a poll result', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => jsonResponse([], 429, {
        'x-ratelimit-reset': String(Math.ceil((Date.now() + MAX_CONVERSATION_RETRY_AFTER_MS + 3_600_000) / 1_000)),
      })),
    };

    await expect(pollGithubChannelObservations({
      ...githubChannelConnectionInput(),
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '1',
        etag: null,
      },
      limit: 10,
      waitMs: 0,
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'notReady',
      reason: 'rateLimited',
      retryAfterMs: MAX_CONVERSATION_RETRY_AFTER_MS,
    });
  });

  it('maps a GitHub secondary rate-limit poll response without rate headers to a bounded backoff', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => jsonResponse({
        message: 'You have exceeded a secondary rate limit.',
      }, 403)),
    };
    const providerConfig = {
      v: 1,
      repository: {
        v: 1,
        repositoryId: '77',
        owner: 'acme',
        name: 'widgets',
        nameWithOwner: 'acme/widgets',
      },
      integrationPrincipal: { id: '99', label: 'happier-bot' },
    };

    await expect(pollGithubChannelObservations({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig,
      credentialRef: GITHUB_ACCOUNT,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '1',
        etag: null,
      },
      limit: 10,
      waitMs: 0,
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'notReady',
      reason: 'rateLimited',
      retryAfterMs: 60_000,
    });
  });

  it('keeps an ordinary positive-remaining GitHub 403 with reset metadata as a permission failure', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => jsonResponse({
        message: 'Resource not accessible by integration',
      }, 403, {
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': '61',
      })),
    };
    const providerConfig = {
      v: 1,
      repository: {
        v: 1,
        repositoryId: '77',
        owner: 'acme',
        name: 'widgets',
        nameWithOwner: 'acme/widgets',
      },
      integrationPrincipal: { id: '99', label: 'happier-bot' },
    };

    await expect(testGithubChannelConnection({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig,
      credentialRef: GITHUB_ACCOUNT,
      selectedTransport: 'checkpointedPull',
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'notReady',
      reason: 'permissionMissing',
    });
  });

  it('resolves a GitHub pull request as a shared endpoint', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url === 'https://api.github.com/repos/acme/widgets/issues/12'
          ? jsonResponse({
            id: 300,
            number: 12,
            title: 'Pull request title',
            pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/12' },
          })
          : Promise.reject(new Error(`Unexpected GitHub request: ${request.url}`))
      )),
    };
    const connection = {
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig: {
        v: 1,
        repository: {
          v: 1,
          repositoryId: '77',
          owner: 'acme',
          name: 'widgets',
          nameWithOwner: 'acme/widgets',
        },
        integrationPrincipal: { id: '99', label: 'happier-bot' },
      },
      credentialRef: GITHUB_ACCOUNT,
    } as const;

    await expect(resolveGithubChannelEndpoint({ ...connection, query: '#12' }, coreContext({ connectedAccounts, http })))
      .resolves.toEqual({
        kind: 'resolved',
        candidates: [{
          kind: 'githubPullRequest',
          audience: 'shared',
          id: 'github:repository:77:issue:300:number:12',
          parentId: '77',
          parentLabel: 'acme/widgets',
          label: '#12 Pull request title',
        }],
      });
  });

  it('normalizes GitHub principal candidates for the Channels reader', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => {
        if (!request.url.startsWith('https://api.github.com/search/users?')) {
          throw new Error(`Unexpected GitHub request: ${request.url}`);
        }
        return jsonResponse({
          total_count: 3,
          items: [
            { id: 2, login: 'zoe', type: 'User' },
            { id: 2, login: 'zoe', type: 'User' },
            { id: 1, login: 'ada', type: 'User' },
          ],
        });
      }),
    };
    const endpoint = {
      kind: 'githubIssue' as const,
      audience: 'shared' as const,
      id: 'github:repository:77:issue:5:number:1',
      parentId: '77',
      parentLabel: 'acme/widgets',
      label: '#1 Issue title',
    };

    await expect(resolveGithubChannelPrincipal({
      ...githubChannelConnectionInput(),
      endpoint,
      query: 'a',
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'resolved',
      candidates: [
        { id: '1', label: 'ada', kind: 'human' },
        { id: '2', label: 'zoe', kind: 'human' },
      ],
    });
  });

  it('classifies endpoint and principal lookup response failures through the shared GitHub response error', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url === 'https://api.github.com/repos/acme/widgets/issues/1'
          ? jsonResponse({ message: 'Not Found' }, 404)
          : request.url.startsWith('https://api.github.com/search/users?')
            ? jsonResponse({ message: 'API rate limit exceeded' }, 403, {
              'retry-after': '1',
              'x-ratelimit-remaining': '0',
            })
            : Promise.reject(new Error(`Unexpected GitHub request: ${request.url}`))
      )),
    };
    const connection = {
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig: {
        v: 1,
        repository: {
          v: 1,
          repositoryId: '77',
          owner: 'acme',
          name: 'widgets',
          nameWithOwner: 'acme/widgets',
        },
        integrationPrincipal: { id: '99', label: 'happier-bot' },
      },
      credentialRef: GITHUB_ACCOUNT,
    } as const;
    const endpoint = {
      kind: 'githubIssue',
      audience: 'shared',
      id: 'github:repository:77:issue:5:number:1',
      label: '#1 Issue title',
      parentId: '77',
      parentLabel: 'acme/widgets',
    } as const;

    await expect(resolveGithubChannelEndpoint({ ...connection, query: '#1' }, coreContext({ connectedAccounts, http })))
      .resolves.toEqual({ kind: 'notReady', reason: 'invalidConfiguration' });
    await expect(resolveGithubChannelPrincipal({ ...connection, endpoint, query: 'octocat' }, coreContext({ connectedAccounts, http })))
      .resolves.toEqual({ kind: 'notReady', reason: 'rateLimited', retryAfterMs: 1_000 });
  });

  it('propagates an aborted action instead of classifying it as a retryable provider failure', async () => {
    const providerConfig = {
      v: 1,
      repository: {
        v: 1,
        repositoryId: '77',
        owner: 'acme',
        name: 'widgets',
        nameWithOwner: 'acme/widgets',
      },
      integrationPrincipal: { id: '99', label: 'happier-bot' },
    } as const;
    const connection = {
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig,
      credentialRef: GITHUB_ACCOUNT,
    } as const;
    const endpoint = {
      kind: 'githubIssue',
      audience: 'shared',
      id: 'github:repository:77:issue:5:number:1',
      label: '#1 Issue title',
      parentId: '77',
      parentLabel: 'acme/widgets',
    } as const;

    const expectAbortToPropagate = async (
      invoke: (context: PluginInvocationContext) => Promise<unknown>,
    ): Promise<void> => {
      const controller = new AbortController();
      const cancellation = new Error('GitHub action was cancelled');
      const connectedAccounts = {
        materialize: vi.fn(async () => ({
          kind: 'httpHeaders' as const,
          headers: { Authorization: 'Bearer exact-account-token' },
        })),
      };
      const http = {
        request: vi.fn(async (_request: GithubHttpRequestInput) => {
          controller.abort();
          throw cancellation;
        }),
      };

      await expect(invoke(coreContext({ connectedAccounts, http }, controller.signal))).rejects.toBe(cancellation);
      expect(http.request).toHaveBeenCalledOnce();
    };

    await expectAbortToPropagate((context) => testGithubChannelConnection({
      ...connection,
      selectedTransport: 'checkpointedPull',
    }, context));
    await expectAbortToPropagate((context) => resolveGithubChannelEndpoint({ ...connection, query: '#1' }, context));
    await expectAbortToPropagate((context) => resolveGithubChannelPrincipal({
      ...connection,
      endpoint,
      query: 'octocat',
    }, context));
    await expectAbortToPropagate((context) => pollGithubChannelObservations({
      ...connection,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '1',
        etag: null,
      },
      limit: 10,
      waitMs: 0,
    }, context));
  });

  it('propagates final-generation retirement before GitHub provider I/O', async () => {
    const retirement = new PluginError({
      code: 'plugin_final_generation_retired',
      message: 'The GitHub plugin generation is no longer current.',
    });
    const connectedAccounts = {
      materialize: vi.fn(async () => {
        throw retirement;
      }),
    };
    const http = { request: vi.fn() };
    const endpoint = githubChannelDeliveryInput('delivery-currentness-fixture').endpoint;
    const connection = githubChannelConnectionInput();
    const invocations = [
      (context: PluginInvocationContext) => testGithubChannelConnection({
        ...connection,
        selectedTransport: 'checkpointedPull',
      }, context),
      (context: PluginInvocationContext) => resolveGithubChannelEndpoint({
        ...connection,
        query: '#1',
      }, context),
      (context: PluginInvocationContext) => resolveGithubChannelPrincipal({
        ...connection,
        endpoint,
        query: 'octocat',
      }, context),
      (context: PluginInvocationContext) => pollGithubChannelObservations({
        ...connection,
        checkpoint: null,
        limit: 10,
        waitMs: 0,
      }, context),
    ];

    for (const invoke of invocations) {
      await expect(invoke(coreContext({ connectedAccounts, http }))).rejects.toBe(retirement);
    }
    expect(connectedAccounts.materialize).toHaveBeenCalledTimes(invocations.length);
    expect(http.request).not.toHaveBeenCalled();
  });

  it('propagates cancellation from the pre-send endpoint GET instead of returning a safe retry', async () => {
    const controller = new AbortController();
    const cancellation = new Error('GitHub pre-send endpoint revalidation was cancelled');
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => {
        controller.abort();
        throw cancellation;
      }),
    };

    await expect(deliverGithubChannelMessage(
      githubChannelDeliveryInput('delivery-get-cancelled'),
      coreContext({ connectedAccounts, http }, controller.signal),
    )).rejects.toBe(cancellation);
    expect(http.request).toHaveBeenCalledOnce();
    expect(http.request.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/widgets/issues/1',
    });
  });

  it('propagates final-generation retirement from the pre-send endpoint GET', async () => {
    const retirement = new PluginError({
      code: 'plugin_final_generation_retired',
      message: 'The GitHub plugin generation is no longer current.',
    });
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => {
        throw retirement;
      }),
    };

    await expect(deliverGithubChannelMessage(
      githubChannelDeliveryInput('delivery-get-currentness'),
      coreContext({ connectedAccounts, http }),
    )).rejects.toBe(retirement);
    expect(http.request).toHaveBeenCalledOnce();
    expect(http.request.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/widgets/issues/1',
    });
  });

  it('revalidates the frozen issue endpoint before one mention-neutralized delivery request', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url === 'https://api.github.com/repos/acme/widgets/issues/1'
          ? jsonResponse({ id: 5, number: 1, title: 'Issue title' })
          : request.url === 'https://api.github.com/repos/acme/widgets/issues/1/comments'
            ? jsonResponse({ id: 700 }, 201)
            : Promise.reject(new Error(`Unexpected GitHub request: ${request.url}`))
      )),
    };
    const providerConfig = {
      v: 1,
      repository: {
        v: 1,
        repositoryId: '77',
        owner: 'acme',
        name: 'widgets',
        nameWithOwner: 'acme/widgets',
      },
      integrationPrincipal: { id: '99', label: 'happier-bot' },
    };

    await expect(deliverGithubChannelMessage({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig,
      credentialRef: GITHUB_ACCOUNT,
      endpoint: {
        kind: 'githubIssue',
        audience: 'shared',
        id: 'github:repository:77:issue:5:number:1',
        label: '#1 Issue title',
        parentId: '77',
        parentLabel: 'acme/widgets',
      },
      content: 'Thanks @octocat and @acme/team',
      deliveryKey: 'delivery-1',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'delivered',
      providerMessageIds: ['700'],
    });

    expect(http.request.mock.calls.map(([request]) => request.url)).toEqual([
      'https://api.github.com/repos/acme/widgets/issues/1',
      'https://api.github.com/repos/acme/widgets/issues/1/comments',
    ]);
    const body = http.request.mock.calls[1]?.[0]?.body;
    expect(JSON.parse(new TextDecoder().decode(body))).toEqual({
      body: 'Thanks @\u200Boctocat and @\u200Bacme/team',
    });
  });

  it('posts to the frozen issue endpoint when a source comment supplies reply context GitHub cannot represent', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url === 'https://api.github.com/repos/acme/widgets/issues/1'
          ? jsonResponse({ id: 5, number: 1, title: 'Issue title' })
          : request.url === 'https://api.github.com/repos/acme/widgets/issues/1/comments'
            ? jsonResponse({ id: 701 }, 201)
            : Promise.reject(new Error(`Unexpected GitHub request: ${request.url}`))
      )),
    };
    const providerConfig = {
      v: 1,
      repository: {
        v: 1,
        repositoryId: '77',
        owner: 'acme',
        name: 'widgets',
        nameWithOwner: 'acme/widgets',
      },
      integrationPrincipal: { id: '99', label: 'happier-bot' },
    };

    await expect(deliverGithubChannelMessage({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig,
      credentialRef: GITHUB_ACCOUNT,
      endpoint: {
        kind: 'githubIssue',
        audience: 'shared',
        id: 'github:repository:77:issue:5:number:1',
        label: '#1 Issue title',
        parentId: '77',
        parentLabel: 'acme/widgets',
      },
      content: 'The endpoint, not the comment ID, is GitHub’s reply target.',
      deliveryKey: 'delivery-unrepresentable-reply-context',
      replyContext: { replyToMessageId: '123' },
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'delivered',
      providerMessageIds: ['701'],
    });
    expect(http.request.mock.calls.map(([request]) => request.url)).toEqual([
      'https://api.github.com/repos/acme/widgets/issues/1',
      'https://api.github.com/repos/acme/widgets/issues/1/comments',
    ]);
  });

  it('returns the bounded secondary-rate-limit retry for a pre-send endpoint revalidation', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url === 'https://api.github.com/repos/acme/widgets/issues/1'
          ? jsonResponse({ message: 'You have exceeded a secondary rate limit.' }, 403)
          : Promise.reject(new Error(`Unexpected GitHub request: ${request.url}`))
      )),
    };
    const providerConfig = {
      v: 1,
      repository: {
        v: 1,
        repositoryId: '77',
        owner: 'acme',
        name: 'widgets',
        nameWithOwner: 'acme/widgets',
      },
      integrationPrincipal: { id: '99', label: 'happier-bot' },
    };

    await expect(deliverGithubChannelMessage({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig,
      credentialRef: GITHUB_ACCOUNT,
      endpoint: {
        kind: 'githubIssue',
        audience: 'shared',
        id: 'github:repository:77:issue:5:number:1',
        label: '#1 Issue title',
        parentId: '77',
        parentLabel: 'acme/widgets',
      },
      content: 'A reply that must not bypass endpoint revalidation',
      deliveryKey: 'delivery-secondary-rate-limit',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'notDelivered',
      retry: 'after',
      retryAfterMs: 60_000,
    });
    expect(http.request).toHaveBeenCalledOnce();
  });

  it('clamps an over-24-hour Retry-After before returning a pre-send delivery retry', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => jsonResponse([], 429, { 'retry-after': '86401' })),
    };

    await expect(deliverGithubChannelMessage(
      githubChannelDeliveryInput('delivery-over-24-hours'),
      coreContext({ connectedAccounts, http }),
    )).resolves.toEqual({
      kind: 'notDelivered',
      retry: 'after',
      retryAfterMs: MAX_CONVERSATION_RETRY_AFTER_MS,
    });
    expect(http.request).toHaveBeenCalledOnce();
  });

  it('classifies GitHub Connected Account materialization before any comment delivery effect', async () => {
    for (const scenario of [
      {
        name: 'retryable materialization failure',
        error: new PluginError({
          code: 'plugin_connected_account_runtime_unavailable',
          message: 'The Connected Account runtime is temporarily unavailable.',
          retryable: true,
        }),
        expected: { kind: 'notDelivered' as const, retry: 'safe' as const },
      },
      {
        name: 'unavailable Connected Account service',
        error: new PluginError({
          code: 'plugin_service_unavailable',
          message: 'The Connected Accounts service is unavailable for this invocation.',
        }),
        expected: { kind: 'notDelivered' as const, retry: 'safe' as const },
      },
      {
        name: 'permanent Connected Account authorization refusal',
        error: new PluginError({
          code: 'plugin_host_access_operation_denied',
          message: 'The selected Connected Account is not authorized for this use.',
        }),
        expected: { kind: 'notDelivered' as const, retry: 'never' as const },
      },
      {
        name: 'permanent Connected Account configuration refusal',
        error: new PluginError({
          code: 'plugin_connected_account_configuration_invalid',
          message: 'The selected Connected Account configuration is invalid.',
        }),
        expected: { kind: 'notDelivered' as const, retry: 'never' as const },
      },
      {
        name: 'unclassified materialization failure',
        error: new Error('GitHub account materialization was unavailable'),
        expected: { kind: 'notDelivered' as const, retry: 'safe' as const },
      },
    ]) {
      const connectedAccounts = {
        materialize: vi.fn(async () => {
          throw scenario.error;
        }),
      };
      const http = { request: vi.fn() };

      await expect(deliverGithubChannelMessage(
        githubChannelDeliveryInput(`delivery-materialization-${scenario.name}`),
        coreContext({ connectedAccounts, http }),
      )).resolves.toEqual(scenario.expected);

      expect(connectedAccounts.materialize).toHaveBeenCalledOnce();
      expect(http.request).not.toHaveBeenCalled();
    }
  });

  it('propagates cancellation and currentness from GitHub Connected Account materialization before delivery', async () => {
    const cancellationController = new AbortController();
    const cancellation = new Error('The GitHub delivery invocation was cancelled.');
    for (const scenario of [
      {
        name: 'cancellation',
        error: cancellation,
        signal: cancellationController.signal,
        beforeFailure: () => cancellationController.abort(cancellation),
      },
      {
        name: 'currentness',
        error: new PluginError({
          code: 'plugin_final_generation_retired',
          message: 'The GitHub plugin generation is no longer current.',
        }),
        signal: new AbortController().signal,
        beforeFailure: undefined,
      },
    ]) {
      const connectedAccounts = {
        materialize: vi.fn(async () => {
          scenario.beforeFailure?.();
          throw scenario.error;
        }),
      };
      const http = { request: vi.fn() };

      await expect(deliverGithubChannelMessage(
        githubChannelDeliveryInput(`delivery-materialization-${scenario.name}`),
        coreContext({ connectedAccounts, http }, scenario.signal),
      )).rejects.toBe(scenario.error);

      expect(connectedAccounts.materialize).toHaveBeenCalledOnce();
      expect(http.request).not.toHaveBeenCalled();
    }
  });

  it('returns a safe retry when the pre-send endpoint GET fails without a comment POST', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => {
        throw new Error('GitHub endpoint revalidation network failure');
      }),
    };

    await expect(deliverGithubChannelMessage(
      githubChannelDeliveryInput('delivery-get-network-failure'),
      coreContext({ connectedAccounts, http }),
    )).resolves.toEqual({ kind: 'notDelivered', retry: 'safe' });
    expect(http.request).toHaveBeenCalledOnce();
    expect(http.request.mock.calls[0]?.[0]).toMatchObject({
      url: 'https://api.github.com/repos/acme/widgets/issues/1',
    });
  });

  it('returns a safe retry for a pre-send endpoint 5xx without a comment POST', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => jsonResponse({ message: 'Service Unavailable' }, 503)),
    };

    await expect(deliverGithubChannelMessage(
      githubChannelDeliveryInput('delivery-get-5xx'),
      coreContext({ connectedAccounts, http }),
    )).resolves.toEqual({ kind: 'notDelivered', retry: 'safe' });
    expect(http.request).toHaveBeenCalledOnce();
  });

  it('returns a safe retry when the pre-send endpoint payload is unusable without a comment POST', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => jsonResponse({ id: 'not-a-decimal', number: 1 }, 200)),
    };

    await expect(deliverGithubChannelMessage(
      githubChannelDeliveryInput('delivery-get-invalid-payload'),
      coreContext({ connectedAccounts, http }),
    )).resolves.toEqual({ kind: 'notDelivered', retry: 'safe' });
    expect(http.request).toHaveBeenCalledOnce();
  });

  it('retains outcome-unknown only when the comment POST itself is transport-ambiguous', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url === 'https://api.github.com/repos/acme/widgets/issues/1'
          ? jsonResponse({ id: 5, number: 1, title: 'Issue title' })
          : Promise.reject(new Error('GitHub comment POST transport ambiguity'))
      )),
    };

    await expect(deliverGithubChannelMessage(
      githubChannelDeliveryInput('delivery-post-ambiguity'),
      coreContext({ connectedAccounts, http }),
    )).resolves.toEqual({ kind: 'outcomeUnknown' });
    expect(http.request.mock.calls.map(([request]) => request.url)).toEqual([
      'https://api.github.com/repos/acme/widgets/issues/1',
      'https://api.github.com/repos/acme/widgets/issues/1/comments',
    ]);
  });

  it('returns the bounded secondary-rate-limit retry for a known no-effect comment rejection', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url === 'https://api.github.com/repos/acme/widgets/issues/1'
          ? jsonResponse({ id: 5, number: 1, title: 'Issue title' })
          : request.url === 'https://api.github.com/repos/acme/widgets/issues/1/comments'
            ? jsonResponse({ message: 'You have exceeded a secondary rate limit.' }, 403)
            : Promise.reject(new Error(`Unexpected GitHub request: ${request.url}`))
      )),
    };
    const providerConfig = {
      v: 1,
      repository: {
        v: 1,
        repositoryId: '77',
        owner: 'acme',
        name: 'widgets',
        nameWithOwner: 'acme/widgets',
      },
      integrationPrincipal: { id: '99', label: 'happier-bot' },
    };

    await expect(deliverGithubChannelMessage({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig,
      credentialRef: GITHUB_ACCOUNT,
      endpoint: {
        kind: 'githubIssue',
        audience: 'shared',
        id: 'github:repository:77:issue:5:number:1',
        label: '#1 Issue title',
        parentId: '77',
        parentLabel: 'acme/widgets',
      },
      content: 'A reply that GitHub rejects before creating a comment',
      deliveryKey: 'delivery-secondary-rate-limit-after-revalidation',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'notDelivered',
      retry: 'after',
      retryAfterMs: 60_000,
    });
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it('splits mention-neutralized GitHub output at the native byte ceiling without splitting the suppression pair', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    let deliveredCommentCount = 0;
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url === 'https://api.github.com/repos/acme/widgets/issues/1'
          ? jsonResponse({ id: 5, number: 1, title: 'Issue title' })
          : request.url === 'https://api.github.com/repos/acme/widgets/issues/1/comments'
            ? jsonResponse({ id: String(++deliveredCommentCount) }, 201)
            : Promise.reject(new Error(`Unexpected GitHub request: ${request.url}`))
      )),
    };
    const providerConfig = {
      v: 1,
      repository: {
        v: 1,
        repositoryId: '77',
        owner: 'acme',
        name: 'widgets',
        nameWithOwner: 'acme/widgets',
      },
      integrationPrincipal: { id: '99', label: 'happier-bot' },
    };

    // The raw content satisfies the generic 192 KiB action schema. Formatting
    // the final mention expands it beyond one native GitHub comment, so the
    // provider must make two ordered comments rather than reject after custody.
    const content = `${'x'.repeat(65_535)}@octocat`;
    await expect(deliverGithubChannelMessage({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig,
      credentialRef: GITHUB_ACCOUNT,
      endpoint: {
        kind: 'githubIssue',
        audience: 'shared',
        id: 'github:repository:77:issue:5:number:1',
        label: '#1 Issue title',
        parentId: '77',
        parentLabel: 'acme/widgets',
      },
      content,
      deliveryKey: 'delivery-chunk-after-formatting',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'delivered',
      providerMessageIds: ['1', '2'],
    });

    expect(http.request.mock.calls.map(([request]) => request.url)).toEqual([
      'https://api.github.com/repos/acme/widgets/issues/1',
      'https://api.github.com/repos/acme/widgets/issues/1/comments',
      'https://api.github.com/repos/acme/widgets/issues/1/comments',
    ]);
    expect(http.request.mock.calls.slice(1).map(([request]) => (
      JSON.parse(new TextDecoder().decode(request.body))
    ))).toEqual([
      { body: 'x'.repeat(65_535) },
      { body: '@\u200Boctocat' },
    ]);
  });

  it('retains accepted GitHub comment IDs when a later output chunk has a known no-effect failure', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    let deliveredCommentCount = 0;
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url === 'https://api.github.com/repos/acme/widgets/issues/1'
          ? jsonResponse({ id: 5, number: 1, title: 'Issue title' })
          : request.url === 'https://api.github.com/repos/acme/widgets/issues/1/comments'
            ? ++deliveredCommentCount === 1
              ? jsonResponse({ id: '700' }, 201)
              : jsonResponse({ message: 'Validation Failed' }, 422)
            : Promise.reject(new Error(`Unexpected GitHub request: ${request.url}`))
      )),
    };
    const providerConfig = {
      v: 1,
      repository: {
        v: 1,
        repositoryId: '77',
        owner: 'acme',
        name: 'widgets',
        nameWithOwner: 'acme/widgets',
      },
      integrationPrincipal: { id: '99', label: 'happier-bot' },
    };

    await expect(deliverGithubChannelMessage({
      v: 1,
      connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77',
      providerConfigVersion: 1,
      providerConfig,
      credentialRef: GITHUB_ACCOUNT,
      endpoint: {
        kind: 'githubIssue',
        audience: 'shared',
        id: 'github:repository:77:issue:5:number:1',
        label: '#1 Issue title',
        parentId: '77',
        parentLabel: 'acme/widgets',
      },
      content: `${'x'.repeat(65_535)}@octocat`,
      deliveryKey: 'delivery-partial-after-formatting',
      mentionPolicy: 'suppress',
      linkPreviewPolicy: 'suppress',
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'partial',
      providerMessageIds: ['700'],
      failedChunk: 1,
      retrySafe: false,
    });
  });
});

describe('GitHub content-creation 422 classification', () => {
  const materializeGithubAccount = () => ({
    materialize: vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer exact-account-token' },
    })),
  });

  function commentPostHttp(commentResponse: ReturnType<typeof jsonResponse>) {
    return {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url === 'https://api.github.com/repos/acme/widgets/issues/1'
          ? jsonResponse({ id: 5, number: 1, title: 'Issue title' })
          : request.url === 'https://api.github.com/repos/acme/widgets/issues/1/comments'
            ? commentResponse
            : Promise.reject(new Error(`Unexpected GitHub request: ${request.url}`))
      )),
    };
  }

  // GitHub documents this endpoint's 422 as "Validation failed, or the endpoint
  // has been spammed", and warns that creating content too quickly results in
  // secondary rate limiting. A throttle must not be settled as permanent.
  it('retries a comment POST that GitHub throttled with a 422', async () => {
    for (const throttled of [
      { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
      {
        message: 'Validation Failed',
        errors: [{ resource: 'IssueComment', code: 'unprocessable', field: 'data', message: 'was submitted too quickly' }],
      },
      { message: 'This comment was flagged as spam and was not created.' },
    ]) {
      const http = commentPostHttp(jsonResponse(throttled, 422));
      await expect(deliverGithubChannelMessage(
        githubChannelDeliveryInput(`delivery-throttled-422-${JSON.stringify(throttled).length}`),
        coreContext({ connectedAccounts: materializeGithubAccount(), http }),
      )).resolves.toEqual({
        kind: 'notDelivered',
        retry: 'after',
        retryAfterMs: 60_000,
      });
    }
  });

  it('keeps a documented GitHub validation 422 permanent', async () => {
    const http = commentPostHttp(jsonResponse({
      message: 'Validation Failed',
      errors: [{ resource: 'IssueComment', code: 'invalid', field: 'body' }],
    }, 422));
    await expect(deliverGithubChannelMessage(
      githubChannelDeliveryInput('delivery-validation-422'),
      coreContext({ connectedAccounts: materializeGithubAccount(), http }),
    )).resolves.toEqual({ kind: 'notDelivered', retry: 'never' });
  });

  it('reports a throttled endpoint read as rate limited rather than misconfigured', async () => {
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => jsonResponse(
        { message: 'You have exceeded a secondary rate limit.' },
        422,
      )),
    };
    await expect(resolveGithubChannelEndpoint({
      ...githubChannelConnectionInput(),
      query: '#1',
    }, coreContext({ connectedAccounts: materializeGithubAccount(), http }))).resolves.toEqual({
      kind: 'notReady',
      reason: 'rateLimited',
      retryAfterMs: 60_000,
    });
  });
});

describe('GitHub Channel readiness probe', () => {
  const materializeGithubAccount = () => ({
    materialize: vi.fn(async () => ({
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer exact-account-token' },
    })),
  });

  const ISSUE_COMMENTS_PROBE_URL =
    'https://api.github.com/repos/acme/widgets/issues/comments?per_page=1';

  // A PAT that authenticates is not a PAT that can read this repository's issue
  // comments. READY is the gate the Channels core creates a connection behind,
  // so it must exercise the endpoint the Channel actually polls.
  it('reports ready only after the configured account can read repository issue comments', async () => {
    const http = {
      request: vi.fn(async (request: GithubHttpRequestInput) => (
        request.url === 'https://api.github.com/user'
          ? jsonResponse({ id: 99, login: 'happier-bot' })
          : request.url === ISSUE_COMMENTS_PROBE_URL
            ? jsonResponse([])
            : Promise.reject(new Error(`Unexpected GitHub request: ${request.url}`))
      )),
    };

    await expect(testGithubChannelConnection({
      ...githubChannelConnectionInput(),
      selectedTransport: 'checkpointedPull',
    }, coreContext({ connectedAccounts: materializeGithubAccount(), http }))).resolves.toEqual({
      kind: 'ready',
      integrationPrincipal: { id: '99', label: 'happier-bot' },
      providerConnectionKey: 'github:repository:77',
    });
    expect(http.request.mock.calls.map(([request]) => request.url)).toEqual([
      'https://api.github.com/user',
      ISSUE_COMMENTS_PROBE_URL,
    ]);
  });

  it('refuses readiness when the configured account cannot read repository issue comments', async () => {
    for (const probe of [
      {
        response: jsonResponse({ message: 'Resource not accessible by personal access token' }, 403, {
          'x-ratelimit-remaining': '4999',
        }),
        expected: { kind: 'notReady', reason: 'permissionMissing' },
      },
      {
        response: jsonResponse({ message: 'Not Found' }, 404),
        expected: { kind: 'notReady', reason: 'invalidConfiguration' },
      },
    ]) {
      const http = {
        request: vi.fn(async (request: GithubHttpRequestInput) => (
          request.url === 'https://api.github.com/user'
            ? jsonResponse({ id: 99, login: 'happier-bot' })
            : probe.response
        )),
      };

      await expect(testGithubChannelConnection({
        ...githubChannelConnectionInput(),
        selectedTransport: 'checkpointedPull',
      }, coreContext({ connectedAccounts: materializeGithubAccount(), http })))
        .resolves.toEqual(probe.expected);
    }
  });
});
