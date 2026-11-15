import { describe, expect, it } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { ScmComparisonSourceSchema, ScmFileViewedReadResultV1Schema } from '@happier-dev/plugin-sdk/scm';
import { createPluginActionPresentUserGate, PluginActionContributionV2Schema } from '@happier-dev/protocol';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageGetResultV1Schema, TriageScanResultV1Schema } from '@happier-dev/triage-protocol/v1';
import { activate, activateAccount } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { GITHUB_CONNECTED_ACCOUNT_PURPOSE, GITHUB_PLUGIN_ID } from '../observations/githubProviderContracts.js';
import { encodeGithubTriageConfiguration } from './configuration.js';
import { buildGithubCollisionScope } from './identity.js';
import { createStubGithubTransport, githubChecksBatchResponse, readRecordedJsonBody } from './testkit/githubTriage.test-support.js';
import { GITHUB_FIXTURE_OWNER, GITHUB_FIXTURE_REPOSITORY, GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_PULL_REQUEST_RESPONSE, GITHUB_SEARCH_PULL_REQUEST_ITEM, githubSearchResponse } from './__fixtures__/githubResponses.js';
import { readGithubFileViewed, setGithubFileViewed } from './fileViewed.js';
import { getGithubTriageEntry, scanGithubTriageSource } from './operations.js';

const readId = 'triage/read-github-file-viewed';
const setId = 'github/pull-request/file-viewed-set';
const headOid = 'a'.repeat(40);
const repository = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();
function input() {
  const fixture = createTriageSourceV1Fixture();
  return { v: 1, instance: { ...fixture.configuredInstance,
    instance: { ...fixture.configuredInstance.instance, source: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' } },
    binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      account: { service: { pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }, accountId: 'account-under-test' } },
    localInstanceKey: 'github.com', configuration: { v: 1, token: encodeGithubTriageConfiguration({ v: 1,
      scope: { kind: 'repository', repositoryKey: repository } })! } },
    localRef: { kindId: 'pull-request', entryId: '1284', collisionScope: buildGithubCollisionScope(GITHUB_FIXTURE_REPOSITORY_ID) },
    routingToken: repository };
}

describe('GitHub Viewed Actions through production registration and admission', () => {
  it('publishes executable Viewed references only from an authoritative PR get, never from scan rows', async () => {
    const request = input();
    const stub = createStubGithubTransport({ respond(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/pulls/1284')) return { status: 200, body: GITHUB_PULL_REQUEST_RESPONSE };
      if (path.endsWith('/search/issues')) return { status: 200, body: githubSearchResponse({ items: [GITHUB_SEARCH_PULL_REQUEST_ITEM] }) };
      if (path === '/graphql') return githubChecksBatchResponse(request);
      return undefined;
    } });
    const result = TriageGetResultV1Schema.parse(await getGithubTriageEntry({ v: 1, instance: request.instance,
      localRef: request.localRef, lastKnownLocator: { v: 1, routingToken: repository } }, stub.context));
    expect(result.kind).toBe('present');
    if (result.kind !== 'present' || result.comparisonSource?.kind !== 'pullRequest') throw new Error('Expected a source-owned PR comparison');
    expect(result.comparisonSource.locator.fileViewedActions).toEqual({
      read: { action: { pluginId: GITHUB_PLUGIN_ID, localId: readId }, input: request },
      set: { action: { pluginId: GITHUB_PLUGIN_ID, localId: setId }, input: request },
    });
    const scan = TriageScanResultV1Schema.parse(await scanGithubTriageSource({ v: 1, instance: request.instance,
      page: { kind: 'initial', limit: 64 } }, stub.context));
    expect(scan.kind).toBe('complete');
    if (scan.kind !== 'complete') throw new Error('Expected the fixture scan to finish');
    expect(scan.observations.length).toBeGreaterThan(0);
    for (const row of scan.observations) expect(row).not.toHaveProperty('comparisonSource');
    expect(stub.requests.filter(row => new TextDecoder().decode(row.body).includes('viewerViewedState'))).toHaveLength(0);
  });

  it('keeps the shared locator and nested results closed while accepting sources without Viewed support', () => {
    const source = { kind: 'pullRequest', locator: { providerId: 'github', repository, number: 1284 } };
    expect(ScmComparisonSourceSchema.safeParse(source).success).toBe(true);
    const actions = { read: { action: { pluginId: GITHUB_PLUGIN_ID, localId: readId } },
      set: { action: { pluginId: GITHUB_PLUGIN_ID, localId: setId } } };
    expect(ScmComparisonSourceSchema.safeParse({ ...source, locator: { ...source.locator, fileViewedActions: actions } }).success).toBe(true);
    expect(ScmComparisonSourceSchema.safeParse({ ...source, locator: { ...source.locator, fileViewedActions: { ...actions, bypass: true } } }).success).toBe(false);
    expect(ScmFileViewedReadResultV1Schema.safeParse({ kind: 'ready', headOid, files: [{ path: 'a', state: 'dismissed', bypass: true }] }).success).toBe(false);
  });

  it.each([0, 101, 201, 601])('reads all %i files with one GraphQL request per 100 files and one credential admission', async (count) => {
    const states = ['VIEWED', 'UNVIEWED', 'DISMISSED'];
    const stub = createStubGithubTransport({ respond(request) {
      if (!new URL(request.url).pathname.endsWith('/graphql')) return undefined;
      const body = readRecordedJsonBody(request) as { query: string; variables: { cursor?: string | null } };
      expect(body.query).toContain('files(first: 100');
      const offset = Number(body.variables.cursor ?? 0);
      const end = Math.min(count, offset + 100);
      return { status: 200, body: { data: { repository: { pullRequest: { headRefOid: headOid,
        files: { nodes: Array.from({ length: end - offset }, (_, index) => ({ path: `file-${offset + index}.ts`,
          viewerViewedState: states[(offset + index) % 3] })), pageInfo: { hasNextPage: end < count, endCursor: end < count ? String(end) : null } },
      } } } } };
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts,
    } });
    try {
      const result = await plugin.invokeAction(readId, input());
      expect(result).toEqual({ kind: 'ready', headOid, files: Array.from({ length: count }, (_, index) => ({
        path: `file-${index}.ts`, state: states[index % 3]?.toLowerCase(),
      })) });
      expect(stub.requests.filter(request => new URL(request.url).pathname.endsWith('/graphql'))).toHaveLength(Math.max(1, Math.ceil(count / 100)));
      expect(stub.materializeCount()).toBe(1);
    } finally { await plugin.dispose(); }
  });

  it.each([true, false])('sets viewed=%s once and acknowledges without a confirmation read', async (viewed) => {
    const mutations: string[] = [];
    const stub = createStubGithubTransport({ respond(request) {
      if (!new URL(request.url).pathname.endsWith('/graphql')) return undefined;
      const body = readRecordedJsonBody(request) as { query: string; variables: Record<string, unknown> };
      if (body.query.startsWith('query')) return { status: 200, body: { data: { repository: { pullRequest: { id: 'PR_test' } } } } };
      mutations.push(body.query);
      expect(body.variables).toEqual({ pullRequestId: 'PR_test', path: 'src/a.ts' });
      return { status: 200, body: { data: { [viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed']: { pullRequest: { id: 'PR_test' } } } } };
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts,
    } });
    try {
      expect(await plugin.invokeAction(setId, { ...input(), path: 'src/a.ts', viewed })).toEqual({ kind: 'ready', path: 'src/a.ts', state: viewed ? 'viewed' : 'unviewed' });
      expect(mutations).toHaveLength(1);
      expect(mutations[0]).toContain(viewed ? 'markFileAsViewed(input:' : 'unmarkFileAsViewed(input:');
      expect(stub.requests.filter(request => new URL(request.url).pathname.endsWith('/graphql'))).toHaveLength(2);
      expect(stub.materializeCount()).toBe(1);
    } finally { await plugin.dispose(); }
  });

  it.each([readId, setId])('returns existing typed scope failures for %s with no retry', async (action) => {
    let graphqlCalls = 0;
    const stub = createStubGithubTransport({ respond(request) {
      if (!new URL(request.url).pathname.endsWith('/graphql')) return undefined;
      graphqlCalls++;
      const body = readRecordedJsonBody(request) as { query: string };
      if (action === setId && body.query.startsWith('query')) return { status: 200, body: { data: { repository: { pullRequest: { id: 'PR_test' } } } } };
      return { status: 200, body: { data: null, errors: [{ type: 'INSUFFICIENT_SCOPES' }] } };
    } });
    const result = action === readId ? await readGithubFileViewed(input(), stub.context)
      : await setGithubFileViewed({ ...input(), path: 'a.ts', viewed: true }, stub.context);
    expect(result).toEqual({ kind: 'unavailable', failure: { class: 'permission', code: 'insufficient_scope' } });
    expect(graphqlCalls).toBe(action === readId ? 1 : 2);
    expect(ScmFileViewedReadResultV1Schema.safeParse(result).success).toBe(true);
  });

  it.each([readId, setId])('settles a rate-limited %s through its closed SCM result contract', async (action) => {
    let graphqlCalls = 0;
    const stub = createStubGithubTransport({ respond(request) {
      if (!new URL(request.url).pathname.endsWith('/graphql')) return undefined;
      graphqlCalls++;
      const body = readRecordedJsonBody(request) as { query: string };
      if (action === setId && body.query.startsWith('query')) return { status: 200, body: { data: { repository: { pullRequest: { id: 'PR_test' } } } } };
      return { status: 403, headers: { 'retry-after': '60', 'x-github-request-id': 'github-viewed-limited' },
        body: { message: 'You have exceeded a secondary rate limit.' } };
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts,
    } });
    try {
      const result = await plugin.invokeAction(action, action === readId ? input() : { ...input(), path: 'a.ts', viewed: true },
        { surface: 'plugin', requestId: 'viewed-rate-limited' });
      expect(result).toEqual({ kind: 'unavailable', failure: { class: 'rateLimit', code: 'github_secondary_rate_limited',
        detail: 'GitHub request ID: github-viewed-limited', retryNotBeforeMs: expect.any(Number) } });
      expect(graphqlCalls).toBe(action === readId ? 1 : 2);
    } finally { await plugin.dispose(); }
  });

  it('refuses a foreign credential purpose before materialization or requests', async () => {
    const stub = createStubGithubTransport({ respond: () => undefined });
    const request = input();
    const result = await readGithubFileViewed({ ...request, instance: { ...request.instance,
      binding: { ...request.instance.binding, purpose: 'some-other-purpose' } } }, stub.context);
    expect(result).toMatchObject({ kind: 'unavailable' });
    expect(stub.materializeCount()).toBe(0);
    expect(stub.requests).toHaveLength(0);
  });

  it.each([readId, setId])('settles a cancelled %s body read as unavailable without a later effect', async (action) => {
    const caller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const stub = createStubGithubTransport({ signal: caller.signal, respond(request) {
      if (!new URL(request.url).pathname.endsWith('/graphql')) return undefined;
      started();
      return new Promise(() => {});
    } });
    const pending = action === readId ? readGithubFileViewed(input(), stub.context)
      : setGithubFileViewed({ ...input(), path: 'a.ts', viewed: true }, stub.context);
    await ready;
    caller.abort();
    expect(await pending).toMatchObject({ kind: 'unavailable', failure: { class: 'transient' } });
    expect(stub.requests.filter(request => new URL(request.url).pathname.endsWith('/graphql'))).toHaveLength(1);
  });

  it('keeps a failed second page unavailable rather than publishing the first page as a complete map', async () => {
    let calls = 0;
    const stub = createStubGithubTransport({ respond(request) {
      if (!new URL(request.url).pathname.endsWith('/graphql')) return undefined;
      calls++;
      return calls === 1 ? { status: 200, body: { data: { repository: { pullRequest: { headRefOid: headOid,
        files: { nodes: [{ path: 'first.ts', viewerViewedState: 'VIEWED' }], pageInfo: { hasNextPage: true, endCursor: 'next' } },
      } } } } } : { status: 503, body: {} };
    } });
    const result = await readGithubFileViewed(input(), stub.context);
    expect(result).toMatchObject({ kind: 'unavailable', failure: { class: 'transient' } });
    expect(result).not.toHaveProperty('files');
    expect(calls).toBe(2);
  });

  it('rejects malformed provider rows instead of silently treating them as unviewed', async () => {
    const stub = createStubGithubTransport({ respond(request) {
      return new URL(request.url).pathname.endsWith('/graphql') ? { status: 200, body: { data: { repository: { pullRequest: {
        headRefOid: headOid, files: { nodes: [{ path: 'a.ts', viewerViewedState: 'NEW_STATE' }], pageInfo: { hasNextPage: false } },
      } } } } } : undefined;
    } });
    expect(await readGithubFileViewed(input(), stub.context)).toEqual({ kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'github_graphql_response_invalid' } });
  });

  it('declares Direct on every surface while preserving a deliberate Ask setting', async () => {
    const action = PluginActionContributionV2Schema.parse(PLUGIN_MANIFEST.contributes.actions?.find(row => row.id === setId));
    expect(action.dangerLevel).toBe('writesRemote');
    expect(action.surfaces).toEqual(['ui', 'plugin', 'agent', 'mcp', 'cli']);
    const gate = (ask: boolean) => createPluginActionPresentUserGate({ resolve: () => ({ status: 'resolved' as const, action,
      policy: { qualifiedId: `${GITHUB_PLUGIN_ID}/${setId}`, occurrenceId: 'source-occurrence', dangerLevel: action.dangerLevel,
        scopes: action.scopes, surfaces: action.surfaces, confirmation: action.confirmation, confirmationWhen: action.confirmationWhen,
        approvalRequiredByActionSettings: ask,
        authorization: { generation: { targetGeneration: '1', desiredGeneration: '1', appliedGeneration: '1' },
          resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] } },
    }) });
    for (const surface of ['ui', 'plugin', 'agent', 'mcp', 'cli'] as const) {
      for (const viewed of [true, false]) {
        expect(await gate(false).admit({ surface, invocationSurface: surface, input: { ...input(), path: 'a', viewed } })).toMatchObject({ status: 'admitted' });
        expect(await gate(true).admit({ surface, invocationSurface: surface, input: { ...input(), path: 'a', viewed } })).toMatchObject({ status: 'unavailable', code: 'plugin_action_current_intent_unavailable' });
      }
    }
  });
});
