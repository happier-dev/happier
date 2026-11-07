import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import { PluginError, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import { ConversationProviderSetupOutcomeV1Schema } from '@happier-dev/channels-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

// Exercise the canonical retained-fact consumer, not a reconstruction of its reader.
import { loadConversationAccountLocalBindingPolicyModule, readConnectionFacts } from '../../channels/src/outwardDelivery.js';
import { createCurrentConversationConnectionFixture } from '../../channels/src/testkit/currentConnectionFixture.js';

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

describe('headerless GitHub Channel cadence', () => {
  it.each(['budget', 'malformed', 'denied'] as const)('settles the real provider Action using the account overview: %s', async scenario => {
    const nowMs = Date.parse('2026-08-10T12:00:00Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const reads: string[] = [];
    const http = createPluginHttpFixture({ request: async request => {
      const path = new URL(request.url).pathname;
      reads.push(path);
      return {
        status: path === '/rate_limit' && scenario === 'denied' ? 403 : 200,
        finalUrl: request.url, headers: {},
        body: new TextEncoder().encode(JSON.stringify(path !== '/rate_limit' ? []
          : scenario === 'budget' ? { resources: { core: { remaining: 10, reset: nowMs / 1_000 + 600 } } } : {})),
      };
    } });
    try {
      const result = await pollGithubChannelObservations({ ...githubChannelConnectionInput(), checkpoint: null, limit: 10, waitMs: 0 },
        coreContext({ connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders', headers: { Authorization: 'Bearer fixture' } }) }, http }));
      expect(result).toMatchObject(scenario === 'budget'
        ? { kind: 'checkpointOnly', retryHint: { retryAfterMs: 60_000 } }
        : { kind: 'notReady', reason: scenario === 'denied' ? 'permissionMissing' : 'invalidConfiguration' });
      expect(reads).toEqual(['/repos/acme/widgets/issues/comments', '/rate_limit']);
    } finally { clock.mockRestore(); }
  });
});

describe('explicit native GitHub Channel credential', () => {
  it.each(['explicit', 'repository shortcut'] as const)('materializes only the declared machine-native service and performs read-only setup (%s)', async mode => {
    const materialize = vi.fn(async (_purpose: string, _request: unknown, _options?: unknown) => ({ kind: 'httpHeaders' as const, headers: { authorization: 'Bearer fixture-native' } }));
    const reads: string[] = [];
    const http = createPluginHttpFixture({ request: async request => {
      expect(request.method).toBe('GET');
      const path = new URL(request.url).pathname;
      reads.push(path);
      if (path === '/user') return jsonResponse({ id: 99, login: 'native-user' });
      if (path === '/repos/acme/widgets') return jsonResponse({ id: 77, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } });
      throw new Error(`Unexpected native setup read ${path}`);
    } });
    expect(await setupGithubChannels(mode === 'explicit' ? { repository: 'acme/widgets', credentialRef: null } : { repository: 'acme/widgets' }, coreContext({
      connectedAccounts: { getBinding: async () => null, materialize }, http,
    }))).toMatchObject({ credentialRef: null, providerConnectionKey: 'github:repository:77' });
    expect(materialize.mock.calls[0]?.[2]).toMatchObject({ nativeService: GITHUB_ACCOUNT.service });
    expect(reads.sort()).toEqual(['/repos/acme/widgets', '/user']);
  });
  it('never substitutes a default Connected Account for an explicit native service', async () => {
    const materialize = vi.fn();
    const http = { request: vi.fn() };
    await expect(setupGithubChannels({ repository: 'acme/widgets', credentialRef: null }, coreContext({
      connectedAccounts: { getBinding: async (purpose) => ({ purpose, account: GITHUB_ACCOUNT,
        service: GITHUB_ACCOUNT.service, target: { kind: 'account', displayName: 'Selected GitHub' } }), materialize }, http,
    }))).rejects.toMatchObject({ code: 'github_credential_mismatch' });
    expect(materialize).not.toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });
});

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
    content: { text: 'A reply that must not bypass endpoint revalidation' },
    deliveryKey,

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
    headers: Object.freeze({ 'content-type': 'application/json',
      'x-ratelimit-remaining': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1_000) + 3_600), ...extraHeaders }),
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
    invokedAtMs: 1_760_000_700_000,
    caller: {
      kind: 'plugin',
      pluginId: 'happier.channels',
      contribution: {
        id: 'connection-setup-v1',
        qualifiedId: 'happier.channels/actions/connection-setup-v1',
      },
      occurrenceId: 'github-channel-actions-fixture-generation',
      sourceCustody: { kind: 'managed', immutableGenerationId: 'github-channel-actions-fixture-generation', installSource: 'npm' },
      materialization: {
        machineId: 'github-channel-actions-fixture-machine',
        materializationId: 'github-channel-actions-fixture-materialization',
        pluginId: 'happier.channels',
      },
    },
    signal,
    services: {
      ...services,
      http: services.http.request ? { ...services.http, ...createPluginHttpFixture({ request: services.http.request }) } : services.http,
    } as PluginInvocationContext['services'],
  };
}

describe('GitHub Channel Actions', () => {
  it('refuses unsupported new threads before any GitHub request', async () => {
    const request = vi.fn(async () => { throw new Error('Unsupported starts must not call GitHub'); });
    await expect(deliverGithubChannelMessage({
      ...githubChannelDeliveryInput('start-1'), content: { text: 'Brief', html: '<p>Brief</p>' },
      newThread: { recipients: ['principal-1'], subject: 'Brief' },
    }, coreContext({ connectedAccounts: {}, http: { request } })))
      .resolves.toEqual({ kind: 'notReady', reason: 'unsupported' });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    ['unavailable service', 'plugin_service_unavailable', false, 'network'],
    ['retryable materialization', 'plugin_connected_account_runtime_unavailable', true, 'network'],
    ['credential denial', 'plugin_host_access_operation_denied', false, 'credentialInvalid'],
  ] as const)('classifies pre-effect %s consistently for polling and connection tests', async (_label, code, retryable, reason) => {
    const connectedAccounts = {
      materialize: vi.fn(async () => {
        throw new PluginError({ code, retryable, message: 'Materialization refused before provider I/O.' });
      }),
    };
    const http = { request: vi.fn() };
    const context = coreContext({ connectedAccounts, http });

    await expect(testGithubChannelConnection({
      ...githubChannelConnectionInput(), selectedTransport: 'checkpointedPull',
    }, context)).resolves.toMatchObject({ kind: 'notReady', reason });
    await expect(pollGithubChannelObservations({
      ...githubChannelConnectionInput(), checkpoint: null, limit: 10, waitMs: 0,
    }, context)).resolves.toMatchObject({ kind: 'notReady', reason });
    await expect(resolveGithubChannelEndpoint({
      ...githubChannelConnectionInput(), query: '#1',
    }, context)).resolves.toMatchObject({ kind: 'notReady', reason });
    await expect(resolveGithubChannelPrincipal({
      ...githubChannelConnectionInput(), endpoint: githubChannelDeliveryInput('unused').endpoint, query: 'octocat',
    }, context)).resolves.toMatchObject({ kind: 'notReady', reason });
    expect(http.request).not.toHaveBeenCalled();
  });

  it('keeps pre-effect HTTP service unavailability retryable for polling and connection tests', async () => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer fixture' } })),
    };
    const http = {
      request: vi.fn(async () => { throw new PluginError({ code: 'plugin_service_unavailable', message: 'HTTP service unavailable before request dispatch.' }); }),
    };
    const context = coreContext({ connectedAccounts, http });
    await expect(testGithubChannelConnection({
      ...githubChannelConnectionInput(), selectedTransport: 'checkpointedPull',
    }, context)).resolves.toMatchObject({ kind: 'notReady', reason: 'network' });
    await expect(pollGithubChannelObservations({
      ...githubChannelConnectionInput(), checkpoint: null, limit: 10, waitMs: 0,
    }, context)).resolves.toMatchObject({ kind: 'notReady', reason: 'network' });
  });

  it('polls selected CI bindings through the authenticated Channel operation', async () => {
    const credentialRequests: GithubHttpRequestInput[] = [];
    const connectedAccounts = { materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer exact-account-token' } })) };
    const endpoint = { ...githubChannelDeliveryInput('unused').endpoint, kind: 'githubPullRequest' as const };
    const http = { request: async (request: GithubHttpRequestInput) => {
      credentialRequests.push(request);
      const path = new URL(request.url).pathname;
      if (path.endsWith('/issues/comments')) return jsonResponse([]);
      if (path === '/repositories/77/pulls/1') return jsonResponse({ number: 1, base: { repo: { id: 77 } }, head: { sha: 'abc123', ref: 'feature' } });
      if (path.endsWith('/permission')) return jsonResponse({ permission: 'write', user: { id: 99, login: 'happier-bot' } });
      if (path === '/graphql') return jsonResponse({ data: { row0: { databaseId: 77, pullRequest: {
        headRefOid: 'abc123', commits: { nodes: [{ commit: { oid: 'abc123', statusCheckRollup: {
          contexts: { nodes: [{ __typename: 'CheckRun', id: 'check-1', name: 'Tests', status: 'COMPLETED',
            conclusion: 'FAILURE', detailsUrl: null, startedAt: null, completedAt: '2026-08-10T12:00:01Z',
            checkSuite: { createdAt: '2026-08-10T11:59:59Z' },
            isRequired: false }], pageInfo: { hasNextPage: false } },
        } } }] },
      } } } });
      throw new Error(`Unexpected request ${request.url}`);
    } };
    const result = await pollGithubChannelObservations({ ...githubChannelConnectionInput(), limit: 10, waitMs: 0,
      checkpoint: { v: 1, updatedAtIso: '2026-08-10T12:00:00Z', commentIdAtUpdatedAt: '0', etag: null },
      bindings: [{ endpoint, scopedTriggerKind: 'ciFailed' }],
    }, coreContext({ connectedAccounts, http }));
    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') throw new Error('Expected authenticated CI observation');
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ observation: { kind: 'fullText', observation: {
      endpoint, scopedTriggerKind: 'ciFailed', actor: { principalId: '99', repositoryWriteAccess: true },
    } } });
    expect(credentialRequests.every((request) => request.headers?.Authorization === 'Bearer exact-account-token')).toBe(true);
  });

  it('routes active direct PR demand through the real feedback and check readers', async () => {
    const requests: string[] = [];
    let inline: unknown[] = [];
    const endpoint = { ...githubChannelDeliveryInput('unused').endpoint, kind: 'githubPullRequest' as const };
    const sha = 'a'.repeat(40);
    const context = coreContext({ connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer fixture' } }) },
      http: { request: async (request: GithubHttpRequestInput) => {
        requests.push(request.url);
        const path = new URL(request.url).pathname;
        if (path.endsWith('/issues/comments')) return jsonResponse([]);
        if (path.endsWith('/pulls/comments')) return jsonResponse(inline);
        if (path.endsWith('/pulls/1/reviews')) return jsonResponse([]);
        if (path === '/repositories/77/pulls/1') return jsonResponse({ number: 1, base: { repo: { id: 77 } }, state: 'open', head: { sha, ref: 'feature', repo: { id: 77 } }, mergeable: true });
        if (path.endsWith('/permission')) return jsonResponse({ permission: 'write', user: { id: 99, login: 'happier-bot' } });
        if (path === '/graphql') return jsonResponse({
          data: {
            row0: {
              databaseId: 77,
              pullRequest: {
                headRefOid: sha,
                commits: { nodes: [{ commit: { oid: sha, statusCheckRollup: null } }] },
              },
            },
          },
        });
        throw new Error(`Unexpected request ${request.url}`);
      } } });
    const input = { ...githubChannelConnectionInput(), limit: 10, waitMs: 0, checkpoint: null as unknown, bindings: [{ endpoint, pullRequestUpdates: true }] };
    const baseline = await pollGithubChannelObservations(input, context);
    if (baseline.kind !== 'checkpointOnly') throw new Error('Expected the exact PR baseline');
    input.checkpoint = baseline.checkpointAfterBatch;
    inline = [{ id: 21, body: 'Please keep the full inline body', created_at: '2026-08-10T12:01:00Z', updated_at: '2026-08-10T12:01:00Z', pull_request_url: 'https://api.github.com/repos/acme/widgets/pulls/1', path: 'src/file.ts', line: 4, diff_hunk: '@@ -1 +1 @@', user: { id: 99, login: 'happier-bot', type: 'User' } }];
    const updated = await pollGithubChannelObservations(input, context);
    expect(updated).toMatchObject({ kind: 'batch', observations: [{ observation: { kind: 'fullText', observation: { scopedTriggerKind: 'prComment', pullRequestUpdate: { event: { kind: 'inlineComment', id: '21', body: 'Please keep the full inline body', line: 4 } } } } }] });
    expect(requests.some(url => new URL(url).pathname === '/graphql')).toBe(true);
  });

  it('keeps a retained Off PR state read free of feedback and CI acquisition', async () => {
    const requests: string[] = [];
    const endpoint = { ...githubChannelDeliveryInput('unused').endpoint, kind: 'githubPullRequest' as const };
    const context = coreContext({ connectedAccounts: { materialize: async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer fixture' } }) },
      http: { request: async (request: GithubHttpRequestInput) => {
        requests.push(request.url);
        const path = new URL(request.url).pathname;
        if (path === '/repositories/77/pulls/1') return jsonResponse({ number: 1, base: { repo: { id: 77 } }, state: 'closed', merged: true });
        throw new Error(`Off state refresh requested feedback: ${request.url}`);
      } } });
    const result = await pollGithubChannelObservations({ ...githubChannelConnectionInput(), limit: 10, waitMs: 0, checkpoint: null, bindings: [{ endpoint }] }, context);
    expect(result).toMatchObject({ kind: 'checkpointOnly', pullRequestEndpoints: [{ pullRequestState: { state: 'merged' } }] });
    expect(requests).toHaveLength(1);
  });

  it('sets up a native SCM PR link with the selected credential when no Channel connection exists', async () => {
    const connectedAccounts = {
      getBinding: vi.fn(async () => ({ purpose: 'github-connected-account', service: GITHUB_ACCOUNT.service, account: GITHUB_ACCOUNT, target: { kind: 'account' as const, displayName: 'GitHub' } })),
      materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const, headers: { Authorization: 'Bearer selected-native-token' } })),
    };
    const http = { request: vi.fn(async (request: GithubHttpRequestInput) => request.url.endsWith('/user')
      ? jsonResponse({ id: 99, login: 'happier-bot' })
      : jsonResponse({ id: 77, name: 'widgets', full_name: 'acme/widgets', owner: { login: 'acme' } })) };
    await expect(setupGithubChannels({ repository: 'acme/widgets' }, coreContext({ connectedAccounts, http })))
      .resolves.toMatchObject({ credentialRef: GITHUB_ACCOUNT, providerConnectionKey: 'github:repository:77',
        outboundTextLimit: { maximum: 65_536, unit: 'unicodeCodePoints', formatting: 'preservesNativeUnits' },
      });
    expect(connectedAccounts.materialize).toHaveBeenCalledWith('github-connected-account', expect.any(Object), expect.objectContaining({ expectedAccount: GITHUB_ACCOUNT }));
  });
  it.each([
    ['write', 200, 'write', 123, true],
    ['admin', 200, 'admin', 123, true],
    ['reader', 200, 'read', 123, false],
    ['no access', 200, 'none', 123, false],
    ['unavailable', 403, 'write', 123, null],
    ['unknown role', 200, 'unexpected', 123, null],
    ['reused login', 200, 'write', 456, null],
  ] as const)('carries authenticated PR commenter write access: %s', async (_label, status, permission, userId, expected) => {
    const connectedAccounts = {
      materialize: vi.fn(async () => ({ kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' } })),
    };
    const permissionRequests: GithubHttpRequestInput[] = [];
    const http = { request: vi.fn(async (request: GithubHttpRequestInput) => {
      const path = new URL(request.url).pathname;
      if (path === '/repos/acme/widgets/issues/comments') return jsonResponse([1, 2].map((id) => ({
        id, body: `Comment ${id}`, created_at: '2026-08-10T12:00:01Z', updated_at: '2026-08-10T12:00:01Z',
        issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
        user: { id: 123, login: 'octocat', type: 'User' },
      })));
      if (path === '/repos/acme/widgets/issues/1') return jsonResponse({ id: 5, number: 1, pull_request: {} });
      if (path === '/repos/acme/widgets/collaborators/octocat/permission') {
        permissionRequests.push(request);
        return jsonResponse({ permission, user: { id: userId, login: 'octocat' } }, status);
      }
      throw new Error(`Unexpected GitHub request ${request.url}`);
    }) };
    const result = await pollGithubChannelObservations({
      ...githubChannelConnectionInput(), limit: 10, waitMs: 0,
      checkpoint: { v: 1, updatedAtIso: '2026-08-10T12:00:00Z', commentIdAtUpdatedAt: '0', etag: null },
    }, coreContext({ connectedAccounts, http }));
    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') throw new Error('Expected authenticated observations');
    expect(result.observations.map(({ observation }) => observation.kind === 'fullText'
      ? observation.observation.actor : null)).toEqual([
      expect.objectContaining({ principalId: '123', repositoryWriteAccess: expected }),
      expect.objectContaining({ principalId: '123', repositoryWriteAccess: expected }),
    ]);
    // Two comments from the same identity share a single read within this poll.
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0]?.headers).toMatchObject({ Authorization: 'Bearer exact-account-token' });
  });

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
        occurrenceId: 'github-channel-actions-unrelated-fixture-generation',
        sourceCustody: { kind: 'managed', immutableGenerationId: 'github-channel-actions-unrelated-fixture-generation', installSource: 'npm' },
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

    const setupInput = {
      credentialRef: GITHUB_ACCOUNT,
      repository: 'acme/widgets',
    };
    const setup = ConversationProviderSetupOutcomeV1Schema.parse(await setupGithubChannels(
      setupInput, coreContext({ connectedAccounts, http }),
    ));
    if ('kind' in setup) throw new Error('Expected a completed GitHub channel setup');
    expect(setup).toEqual({
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
      recommendedMaximumObservationAgeMs: 30 * 86_400_000,
      outboundTextLimit: { maximum: 65_536, unit: 'unicodeCodePoints', formatting: 'preservesNativeUnits' },
    });

    const connection = createCurrentConversationConnectionFixture({
      connectionId: 'github-setup-consumer',
      authority: {
        providerPluginId: 'happier.scm.forge.github',
        providerContributionSelection: { contributionId: 'github-channels-provider' },
        providerSetupInput: setupInput,
        credentialRef: setup.credentialRef,
        transportOrigin: {
          serverIdentityId: 'srv_plugin_testkit',
          materializationRef: {
            pluginId: 'happier.scm.forge.github', machineId: 'github-setup-machine',
            materializationId: 'github-setup-materialization',
          },
        },
        providerConnectionKey: setup.providerConnectionKey,
        providerConfig: setup.providerConfig,
        routingIdentityKey: 'f'.repeat(43),
        integrationPrincipal: setup.integrationPrincipal,
        authorityEpoch: 1,
      },
      outboundTextLimit: setup.outboundTextLimit,
      overlapSafety: setup.overlapSafety,
      replayContinuity: setup.replayContinuity,
    });
    const accountLocalBindingPolicy = await loadConversationAccountLocalBindingPolicyModule();
    const facts = readConnectionFacts({
      accountLocalBindingPolicy,
      row: { rowId: connection.id, revision: 1, value: connection },
      connectionId: connection.id,
    });
    expect(facts?.outboundTextLimit).toEqual({ maximum: 65_536, unit: 'unicodeCodePoints', formatting: 'preservesNativeUnits' });
    expect(facts?.providerAction).toMatchObject({
      providerConnectionKey: setup.providerConnectionKey, providerConfig: setup.providerConfig,
    });
    // Negative wiring control: keep the producer-derived canonical row intact
    // except for failing to forward its native limit into retained setup facts.
    const { outboundTextLimit: _unforwardedNativeBound, ...payloadWithoutBound } = connection.payload;
    const factsWithoutBound = readConnectionFacts({
      accountLocalBindingPolicy,
      row: { rowId: connection.id, revision: 1, value: { ...connection, payload: payloadWithoutBound } },
      connectionId: connection.id,
    });
    expect(factsWithoutBound).not.toBeNull();
    expect(factsWithoutBound?.outboundTextLimit).toBeUndefined();
    expect(factsWithoutBound?.providerAction).toEqual(facts?.providerAction);

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

  it('preserves an over-24-hour Retry-After in a connection result', async () => {
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
      retryAfterMs: 86_401_000,
    });
  });

  it('preserves an over-24-hour reset hint in a poll result', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const connectedAccounts = {
      materialize: vi.fn(async () => ({
        kind: 'httpHeaders' as const,
        headers: { Authorization: 'Bearer exact-account-token' },
      })),
    };
    const http = {
      request: vi.fn(async (_request: GithubHttpRequestInput) => jsonResponse([], 429, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.ceil((Date.now() + 90_000_000) / 1_000)),
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
      retryAfterMs: 90_000_000,
    });
    now.mockRestore();
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

  it.each(['#12', 'https://github.com/acme/widgets/pull/12'])('resolves a GitHub pull request reference %s as a shared endpoint', async (query) => {
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

    await expect(resolveGithubChannelEndpoint({ ...connection, query }, coreContext({ connectedAccounts, http })))
      .resolves.toEqual({
        kind: 'resolved',
        candidates: [{
          kind: 'githubPullRequest',
          pullRequest: { repository: 'acme/widgets', number: 12 },
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
          controller.abort(cancellation);
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
        controller.abort(cancellation);
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
      content: { text: 'Thanks @octocat and @acme/team' },
      deliveryKey: 'delivery-1',

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
      body: 'Thanks ＠octocat and ＠acme/team',
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
      content: { text: 'The endpoint, not the comment ID, is GitHub’s reply target.' },
      deliveryKey: 'delivery-unrepresentable-reply-context',
      replyContext: { replyToMessageId: '123' },

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
      content: { text: 'A reply that must not bypass endpoint revalidation' },
      deliveryKey: 'delivery-secondary-rate-limit',

      linkPreviewPolicy: 'suppress',
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'notDelivered',
      retry: 'after',
      retryAfterMs: 60_000,
    });
    expect(http.request).toHaveBeenCalledOnce();
  });

  it('preserves an over-24-hour Retry-After in a pre-send delivery retry', async () => {
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
      retryAfterMs: 86_401_000,
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
      content: { text: 'A reply that GitHub rejects before creating a comment' },
      deliveryKey: 'delivery-secondary-rate-limit-after-revalidation',

      linkPreviewPolicy: 'suppress',
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'notDelivered',
      retry: 'after',
      retryAfterMs: 60_000,
    });
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['astral text', `${'😀'.repeat(65_528)}@octocat`],
    ['all mentions', '@'.repeat(65_536)],
  ])('keeps mention suppression within the native code-point limit without splitting or truncation (%s)', async (_label, content) => {
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

    // Both bodies reach the exact native code-point limit, beyond 64 KiB UTF-8.
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
      content: { text: content },
      deliveryKey: 'delivery-chunk-after-formatting',

      linkPreviewPolicy: 'suppress',
    }, coreContext({ connectedAccounts, http }))).resolves.toEqual({
      kind: 'delivered',
      providerMessageIds: ['1'],
    });

    expect(http.request.mock.calls.map(([request]) => request.url)).toEqual([
      'https://api.github.com/repos/acme/widgets/issues/1',
      'https://api.github.com/repos/acme/widgets/issues/1/comments',
    ]);
    const postedBody = JSON.parse(new TextDecoder().decode(http.request.mock.calls[1]![0].body)).body;
    expect([...postedBody].length).toBe(65_536);
    expect(postedBody).not.toContain('@');
    expect(http.request.mock.calls.slice(1).map(([request]) => (
      JSON.parse(new TextDecoder().decode(request.body))
    ))).toEqual([
      { body: content.replaceAll('@', '＠') },
    ]);
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
