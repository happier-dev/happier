import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  TriageGetResultV1Schema,
  TriageListScopeUnitsResultV1Schema,
  TriagePrepareReviewWorkspaceResultV1Schema,
  TriageScanResultV1Schema,
  TriageVerifyReviewWorkspaceResultV1Schema,
  type TriageConfiguredSourceInstanceV1,
  type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';
import { activate } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { GITHUB_TRIAGE_ACTION_IDS_V1 } from './contribution.js';

import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../observations/githubProviderContracts.js';

import {
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
  GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_PULL_REQUEST_RESPONSE,
  GITHUB_ISSUE_RESPONSE,
  GITHUB_SEARCH_PULL_REQUEST_ITEM,
  githubSearchResponse,
  githubChangedFile,
  githubCheckRun,
  githubCheckRunsResponse,
  githubCombinedStatusResponse,
} from './__fixtures__/githubResponses.js';
import { listGithubChangedFiles } from './detailOperations.js';
import { encodeGithubTriageConfiguration } from './configuration.js';
import {
  getGithubTriageEntry,
  openGithubTriageClient,
  prepareGithubTriageReviewWorkspace,
  scanGithubTriageSource,
  verifyGithubTriageReviewWorkspace,
} from './operations.js';
import {
  createStubGithubTransport,
  fixedClock,
  type StubHttpResponse,
} from './testkit/githubTriage.test-support.js';

const REPOSITORY_KEY = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();

describe('registered GitHub REST → Triage source contract', () => {
  it('reads open work and recently closed task kinds through registered HTTP paging while ordinary scans stay open-only', async () => {
    const sinceMs = Date.parse('2026-10-19T00:00:00Z');
    const transport = createStubGithubTransport({ respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname !== '/search/issues') return undefined;
      const query = url.searchParams.get('q') ?? '';
      return { status: 200, body: githubSearchResponse({ items: query.includes('closed:>=2026-10-19') && query.includes('assignee:@me')
        ? [{ ...GITHUB_ISSUE_RESPONSE, state: 'closed', state_reason: 'completed', closed_at: '2026-10-20T09:00:00Z',
          repository_url: `https://api.github.com/repos/${REPOSITORY_KEY}` }] : [] }) };
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    const instance = configuredInstance({ scope: 'repository' });
    try {
      const ordinary = TriageScanResultV1Schema.parse(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.scan,
        { v: 1, instance, page: { kind: 'initial', limit: 64 } }, { surface: 'agent', sessionId: 'fx70' }));
      expect(ordinary).toMatchObject({ kind: 'complete', observations: [] });
      const completed = { kindIds: ['issue'], sinceMs };
      const first = TriageScanResultV1Schema.parse(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.scan,
        { v: 1, instance, completed, page: { kind: 'initial', limit: 1 } }, { surface: 'agent', sessionId: 'fx70' }));
      expect(first.kind).toBe('page');
      if (first.kind !== 'page') throw new Error('Expected the existing scan continuation');
      expect(first.observations).toMatchObject([{ kind: 'present', localRef: { kindId: 'issue' }, snapshot: {
        state: { completionReason: 'completed' }, completedAtMs: Date.parse('2026-10-20T09:00:00Z'),
      } }]);
      expect(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.scan,
        { v: 1, instance, completed: { ...completed, sinceMs: sinceMs + 1 }, page: { kind: 'continuation', continuation: first.continuation } },
        { surface: 'agent', sessionId: 'fx70' })).toMatchObject({ kind: 'failed' });
      const next = await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.scan,
        { v: 1, instance, completed, page: { kind: 'continuation', continuation: first.continuation } }, { surface: 'agent', sessionId: 'fx70' });
      expect(TriageScanResultV1Schema.safeParse(next).success).toBe(true);
      const queries = transport.requests.filter(request => new URL(request.url).pathname === '/search/issues')
        .map(request => new URL(request.url).searchParams.get('q') ?? '');
      expect(queries.filter(query => query.includes('closed:>=')).every(query => query.includes('is:issue is:closed'))).toBe(true);
      expect(queries.slice(0, 5).every(query => query.startsWith('is:open '))).toBe(true);
    } finally { await plugin.dispose(); }
  });
  it('keeps a retained repository selection and the current directory on one native unit id', async () => {
    const transport = createStubGithubTransport({ respond: (request) => new URL(request.url).pathname === '/user/repos'
      ? { status: 200, body: [{ id: 11, full_name: 'org/app' }] } : undefined });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    const instance = configuredInstance({ scope: 'account' });
    try {
      const result = TriageListScopeUnitsResultV1Schema.parse(await plugin.invokeAction('triage/list-github-scope-units', {
        v: 1, draft: { v: 1, binding: instance.binding, localInstanceKey: instance.localInstanceKey,
          configuration: { v: 1, token: JSON.stringify({ v: 1, scope: { kind: 'repository', repositoryKey: 'org/app' } }) } },
      }, { surface: 'agent', sessionId: 'retained-selection' }));
      if (result.kind !== 'page' || result.selection.kind !== 'selected') throw new Error('Expected a retained selection');
      expect(result.units[0]?.id).toBe(result.selection.unitIds[0]);
    } finally { await plugin.dispose(); }
  });
  it('searches and pages selectable repositories under the exact account and refuses a foreign directory continuation', async () => {
    const transport = createStubGithubTransport({ respond: (request): StubHttpResponse | undefined => {
      const url = new URL(request.url);
      if (url.pathname !== '/search/repositories') return undefined;
      expect(url.searchParams.get('q')).toBe('org:octo-org app');
      const second = url.searchParams.get('page') === '2';
      const next = new URL(url); next.searchParams.set('page', '2');
      return { status: 200, headers: second ? {} : { link: `<${next}>; rel="next"` }, body: {
        total_count: 2, incomplete_results: false, items: [{ id: second ? 22 : 11, full_name: second ? 'octo-org/api' : 'octo-org/app' }],
      } };
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    const configured = configuredInstance({ scope: 'account' });
    const draft = { v: 1, binding: configured.binding, localInstanceKey: configured.localInstanceKey,
      keyStability: 'locatorDerived', configuration: configured.configuration, locator: { v: 1, displayLabel: 'Account' } };
    try {
      const first = TriageListScopeUnitsResultV1Schema.parse(await plugin.invokeAction('triage/list-github-scope-units', {
        v: 1, draft, query: 'org:octo-org app',
      }, { surface: 'agent', sessionId: 'directory-session' }));
      expect(first).toMatchObject({ kind: 'page', status: 'partial', units: [{ id: 'octo-org/app', label: 'octo-org/app', collisionScope: 'github:11' }] });
      if (first.kind !== 'page' || first.status !== 'partial' || first.nextCursor === undefined) throw new Error('Expected a directory continuation');
      const second = await plugin.invokeAction('triage/list-github-scope-units', {
        v: 1, draft, query: 'org:octo-org app', cursor: first.nextCursor,
      }, { surface: 'agent', sessionId: 'directory-session' });
      expect(second).toMatchObject({ kind: 'page', status: 'complete', units: [{ id: 'octo-org/api', label: 'octo-org/api' }] });
      const requested = transport.requests.length;
      const foreign = await plugin.invokeAction('triage/list-github-scope-units', {
        v: 1, draft: { ...draft, localInstanceKey: 'another-boundary' }, query: 'org:octo-org app', cursor: first.nextCursor,
      }, { surface: 'agent', sessionId: 'directory-session' });
      expect(foreign).toMatchObject({ kind: 'failed', failure: { class: 'unsupportedContract' } });
      expect(transport.requests).toHaveLength(requested);
    } finally { await plugin.dispose(); }
  });
  it('projects configured repository selection for filters through a registered safe Action without provider reads', async () => {
    const transport = createStubGithubTransport({ respond: () => { throw new Error('Configured projection must not read GitHub'); } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    const instance = configuredInstance({ scope: 'account' });
    const selection = { kind: 'selected', unitIds: ['org/app', 'org/api'] };
    const units = [{ id: 'org/app', label: 'org/app', collisionScope: 'github:11' }, { id: 'org/api', label: 'org/api', collisionScope: 'github:22' }];
    try {
      const result = await plugin.invokeAction('triage/list-github-scope-units', { v: 1, mode: 'configured', draft: {
        v: 1, binding: instance.binding, localInstanceKey: instance.localInstanceKey, keyStability: 'locatorDerived',
        configuration: { v: 1, token: JSON.stringify({ v: 1, selection, units }) }, locator: { v: 1, displayLabel: 'Account' },
      } }, { surface: 'agent', sessionId: 'source-selection-session' });
      expect(result).toEqual({ kind: 'page', status: 'complete', selection, units });
      expect(transport.materializeCount()).toBe(0);
      expect(transport.requests).toEqual([]);
    } finally { await plugin.dispose(); }
  });
  it('scans both selected repositories through the registered Action without an account-wide query', async () => {
    const transport = createStubGithubTransport({ respond: (request) => new URL(request.url).pathname === '/search/issues'
      ? { status: 200, body: githubSearchResponse({ items: [] }) } : undefined });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    const instance = { ...configuredInstance({ scope: 'account' }), configuration: {
      v: 1, token: JSON.stringify({ v: 1, selection: { kind: 'selected', unitIds: ['octo-org/app', 'octo-org/api'] } }),
    } };
    try {
      let page: import('@happier-dev/triage-protocol/v1').TriageScanInputV1['page'] = { kind: 'initial', limit: 64 };
      for (let step = 0; step < 4; step += 1) {
        const result: TriageScanResultV1 = TriageScanResultV1Schema.parse(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.scan,
          { v: 1, instance, page }, { surface: 'plugin' }));
        expect(result.kind).not.toBe('failed');
        if (result.kind !== 'page') break;
        page = { kind: 'continuation', continuation: result.continuation };
      }
      const queries = transport.requests.filter((request) => new URL(request.url).pathname === '/search/issues')
        .map((request) => new URL(request.url).searchParams.get('q') ?? '');
      expect(queries.length).toBeGreaterThan(0);
      expect(queries.every((query) => /repo:octo-org\/(app|api)/u.test(query))).toBe(true);
      expect(queries.some((query) => query.includes('repo:octo-org/app'))).toBe(true);
      expect(queries.some((query) => query.includes('repo:octo-org/api'))).toBe(true);
    } finally { await plugin.dispose(); }
  });
  it('loads exact task fields despite honest row-fact truncation through the registered get Action', async () => {
    const body = 'Full task body\n\nKeep the Markdown whitespace.  \n';
    const issue = { ...GITHUB_ISSUE_RESPONSE, number: 7, title: '界'.repeat(1000), body,
      labels: [{ name: ' preserve label whitespace ' }], assignees: [{ login: 'octocat' }],
      url: `https://api.github.com/repos/${REPOSITORY_KEY}/issues/7`,
      repository_url: `https://api.github.com/repos/${REPOSITORY_KEY}`,
      html_url: `https://github.com/${REPOSITORY_KEY}/issues/7` };
    const transport = createStubGithubTransport({ respond: (request) => request.url.endsWith('/issues/7')
      ? { status: 200, body: issue } : undefined });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    try {
      const result = await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.get, { v: 1,
        instance: configuredInstance({ scope: 'repository' }),
        localRef: { kindId: 'issue', collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`, entryId: '7' },
        lastKnownLocator: { v: 1, routingToken: REPOSITORY_KEY },
      }, { surface: 'agent', sessionId: 'task-edit-session' });
      expect(result).toMatchObject({ kind: 'present', snapshot: { projectionTruncated: true }, taskFields: {
        title: issue.title, body, labelIds: [' preserve label whitespace '], assigneeIds: ['octocat'],
      } });
      expect(TriageGetResultV1Schema.safeParse(result).success).toBe(true);
    } finally { await plugin.dispose(); }
  });
  it.each([
    { name: 'readable failing', checkStatus: 200, empty: false, headStatus: 200, failureCode: null },
    { name: 'readable empty', checkStatus: 200, empty: true, headStatus: 200, failureCode: null },
    { name: 'checks denied', checkStatus: 403, empty: false, headStatus: 200, failureCode: 'github_forbidden' },
    { name: 'head denied', checkStatus: 200, empty: false, headStatus: 403, failureCode: 'github_forbidden' },
    { name: 'checks throttled', checkStatus: 429, empty: false, headStatus: 200, failureCode: 'github_rate_limited' },
  ])('preserves the PR and distinguishes $name Checks through the registered strict consumer', async ({ checkStatus, empty, headStatus, failureCode }) => {
    const transport = createStubGithubTransport({ respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/search/issues') return { status: 200, body: githubSearchResponse({
        items: /review-requested:|mentions:/u.test(url.searchParams.get('q') ?? '') ? [GITHUB_SEARCH_PULL_REQUEST_ITEM] : [],
      }) };
      if (url.pathname.endsWith('/pulls/1284')) return { status: headStatus, body: GITHUB_PULL_REQUEST_RESPONSE };
      if (url.pathname.endsWith('/check-runs')) return { status: checkStatus,
        ...(checkStatus === 429 ? { headers: { 'retry-after': '60' } } : {}), body: githubCheckRunsResponse({
        runs: empty ? [] : [githubCheckRun({ id: 1, name: 'unit', status: 'completed', conclusion: 'failure' })],
      }) };
      if (url.pathname.endsWith('/status')) return { status: 200, body: githubCombinedStatusResponse({ state: 'success', statuses: [] }) };
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    try {
      const result = TriageScanResultV1Schema.parse(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.scan, {
        v: 1, instance: configuredInstance({ scope: 'repository' }), page: { kind: 'initial', limit: 200 },
      }, { surface: 'agent', sessionId: 'triage-audit-session' }));
      if (result.kind === 'failed') throw new Error('The search row must survive an optional checks failure');
      expect(result.observations).toHaveLength(2);
      const row = result.observations[0];
      if (row?.kind !== 'present') throw new Error('Expected the real search row');
      expect(row.viewer.involvement).toEqual(['reviewRequested']);
      expect(result.observations[1]).toMatchObject({ kind: 'present', viewer: { involvement: ['mentioned'] } });
      expect(row.snapshot.facts.find((fact) => fact.id === 'github/checks')?.value).toEqual(
        failureCode !== null ? { kind: 'status', value: 'Checks unavailable', tone: 'warning' }
          : empty ? undefined : { kind: 'status', value: '1 failing', tone: 'danger' },
      );
      expect(result.evidence).toEqual(failureCode === null
        ? { kind: 'walkFinished' } : { kind: 'partial', reason: failureCode });
      expect(transport.requests.filter((request) => new URL(request.url).pathname.endsWith('/pulls/1284'))).toHaveLength(1);
    } finally {
      await plugin.dispose();
    }
  });

  it('projects provider responses through the real registered get Action into the strict target schema', async () => {
    let response: Readonly<Record<string, unknown>> = { ...GITHUB_PULL_REQUEST_RESPONSE, title: 'Fix café 🧪'.repeat(500) };
    const transport = createStubGithubTransport({ respond: (request) => (
      request.url.endsWith('/pulls/1284') ? { status: 200, body: response } : undefined
    ) });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    const input = {
      v: 1,
      instance: configuredInstance({ scope: 'repository' }),
      localRef: { kindId: 'pull-request', collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`, entryId: '1284' },
      lastKnownLocator: { v: 1, routingToken: REPOSITORY_KEY },
    };
    try {
      const result = TriageGetResultV1Schema.parse(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.get, input,
        { surface: 'agent', sessionId: 'triage-audit-session' }));
      expect(result.kind).toBe('present');
      if (result.kind !== 'present') throw new Error('Matching REST entity must be present');
      expect(result.localRef).toEqual(input.localRef);
      expect(result.snapshot.title).toContain('café 🧪');
      expect(result.comparisonSource).toMatchObject({ kind: 'pullRequest', locator: { number: 1284,
        repository: REPOSITORY_KEY, sourceAction: { input: { instance: input.instance, localRef: input.localRef } } } });
      expect(TriageGetResultV1Schema.safeParse({ ...result, providerPayload: response }).success).toBe(false);

      // A 200 at the right URL is insufficient: the body must prove the same
      // entry. The public result retains that failure instead of leaking it as
      // a present row or treating it as absence.
      response = { ...response, number: 1285 };
      const mismatch = TriageGetResultV1Schema.parse(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.get, input,
        { surface: 'agent', sessionId: 'triage-audit-session' }));
      expect(mismatch).toMatchObject({ kind: 'unresolved', localRef: input.localRef,
        failure: { code: 'route-body-mismatch' } });
    } finally {
      await plugin.dispose();
    }
  });
});
const CONFIGURED_ACCOUNT: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }),
  accountId: 'configured-account',
});
const OTHER_ACCOUNT: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }),
  accountId: 'other-account',
});

const GITHUB_FORK_PULL_REQUEST_RESPONSE = Object.freeze({
  ...GITHUB_PULL_REQUEST_RESPONSE,
  head: Object.freeze({
    label: 'fork-user:review-from-fork',
    ref: 'review-from-fork',
    sha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
    repo: Object.freeze({
      id: 8128,
      owner: Object.freeze({ login: 'fork-user' }),
      name: 'fork-app',
      full_name: 'fork-user/fork-app',
      clone_url: 'https://github.com/fork-user/fork-app.git',
    }),
  }),
  base: Object.freeze({
    ...(GITHUB_PULL_REQUEST_RESPONSE.base as Readonly<Record<string, unknown>>),
    repo: Object.freeze({
      id: Number(GITHUB_FIXTURE_REPOSITORY_ID),
      owner: Object.freeze({ login: GITHUB_FIXTURE_OWNER }),
      name: GITHUB_FIXTURE_REPOSITORY,
      full_name: `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`,
      clone_url: `https://github.com/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}.git`,
    }),
  }),
});

function prepareWorkspaceInput(input: Readonly<{
  scope?: 'repository' | 'account';
  observed?: Partial<Readonly<{
    baseSha: string;
    headSha: string;
    nativeRevision: string;
  }>>;
  workspace?: Readonly<{ serverId: string; machineId: string; rootPath: string }> | null;
}>) {
  return {
    v: 1 as const,
    // Account-wide discovery owns no repository configuration. Its newest
    // source locator is the only route preparation may use for this entry.
    instance: configuredInstance({ scope: input.scope ?? 'account' }),
    entryRef: {
      source: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }),
      kindId: 'pull-request',
      collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
      entryId: '1284',
    },
    lastKnownLocator: { v: 1 as const, routingToken: REPOSITORY_KEY },
    observed: {
      baseSha: '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e',
      headSha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
      nativeRevision: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
      observedAtMs: 1_700_000_000_000,
      ...input.observed,
    },
    workspace: input.workspace === undefined
      ? { serverId: 'server-selected', machineId: 'machine-selected', rootPath: '/selected/repository' }
      : input.workspace,
  };
}

function withReviewWorkspaceMaterializer(
  context: PluginInvocationContext,
  result: unknown = Object.freeze({
    success: true as const,
    targetPath: '/selected/repository/.happier/review/review-from-fork',
    branchName: 'review-from-fork',
    created: true,
    currentness: Object.freeze({ kind: 'currentAtObservedHead' as const }),
  }),
): Readonly<{
  context: PluginInvocationContext;
  execute: ReturnType<typeof vi.fn>;
}> {
  // The generic SCM Action is a process boundary. The GitHub source operation,
  // its exact-account reauthorization and its provider reread remain real.
  const execute = vi.fn(async () => result);
  return Object.freeze({
    execute,
    context: {
      ...context,
      services: { ...context.services, actions: { execute } },
    } as unknown as PluginInvocationContext,
  });
}

function verifyWorkspaceInput(input: Readonly<{
  observed?: Partial<Readonly<{
    baseSha: string;
    headSha: string;
    nativeRevision: string;
  }>>;
  repositoryPath?: string;
  pullRequest?: unknown;
  acceptedCheckout?: boolean;
}> = {}) {
  const prepared = prepareWorkspaceInput({ observed: input.observed });
  return {
    ...prepared,
    prepared: input.acceptedCheckout ? {
      kind: 'acceptedCheckout' as const,
      repositoryPath: input.repositoryPath ?? '/selected/repository',
    } : {
      repositoryPath: input.repositoryPath
        ?? '/selected/repository/.happier/review/review-from-fork',
      pullRequest: input.pullRequest ?? { number: 1284 },
    },
  };
}

function configuredInstance(input: Readonly<{
  scope: 'repository' | 'account';
  purpose?: string;
  account?: ConnectedAccountRef;
}>): TriageConfiguredSourceInstanceV1 {
  const token = encodeGithubTriageConfiguration(
    input.scope === 'repository'
      ? { v: 1, scope: { kind: 'repository', repositoryKey: REPOSITORY_KEY } }
      : { v: 1, scope: { kind: 'account' } },
  );
  if (token === null) throw new Error('the fixture configuration must encode');
  const fixture = createTriageSourceV1Fixture();
  return Object.freeze({
    ...fixture.configuredInstance,
    instance: Object.freeze({
      source: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }),
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
    }),
    binding: Object.freeze({
      purpose: input.purpose ?? GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      account: input.account ?? CONFIGURED_ACCOUNT,
    }),
    localInstanceKey: 'github.com',
    configuration: Object.freeze({ v: 1 as const, token }),
  });
}

function searchTransport() {
  return createStubGithubTransport({
    respond: (request): StubHttpResponse | undefined => {
      if (!request.url.startsWith('https://api.github.com/search/issues')) return undefined;
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: githubSearchResponse({ items: [GITHUB_SEARCH_PULL_REQUEST_ITEM] }),
      };
    },
  });
}

describe('GitHub Triage source operations', () => {
  it('reports a lost machine login with its typed authentication repair without contacting GitHub', async () => {
    const stub = createStubGithubTransport({ respond: () => undefined });
    const instance = {
      ...configuredInstance({ scope: 'repository' }),
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native' as const, service: CONFIGURED_ACCOUNT.service },
    };
    expect(await openGithubTriageClient(instance, stub.context)).toEqual({
      ok: false,
      failure: { class: 'authentication', code: 'plugin_connected_account_native_unavailable' },
    });
    expect(stub.requests).toEqual([]);
  });

  it('uses the machine login for a native configured source without returning credential material', async () => {
    const nativeToken = 'native-source-token-must-not-be-returned';
    const stub = createStubGithubTransport({
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: `Bearer ${nativeToken}` } },
      respond: (request) => request.url.startsWith('https://api.github.com/search/issues')
        ? { status: 200, body: githubSearchResponse({ items: [GITHUB_SEARCH_PULL_REQUEST_ITEM] }) }
        : undefined,
    });
    const instance = {
      ...configuredInstance({ scope: 'repository' }),
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native' as const, service: CONFIGURED_ACCOUNT.service },
    };

    const result = await scanGithubTriageSource({ v: 1, instance, page: { kind: 'initial', limit: 64 } }, stub.context);

    expect(result.kind).toBe('page');
    expect(stub.requests[0]?.headers.Authorization).toBe(`Bearer ${nativeToken}`);
    expect(stub.materializations).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(nativeToken);
    expect(JSON.stringify(instance)).not.toContain(nativeToken);
  });

  it('projects a GitHub scan onto the strict source ABI as one settled result with no continuation', async () => {
    const stub = searchTransport();

    const result = await scanGithubTriageSource({
      v: 1,
      instance: configuredInstance({ scope: 'repository' }),
      page: { kind: 'initial', limit: 64 },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(() => TriageScanResultV1Schema.parse(result)).not.toThrow();
    // One whole native page spends the ABI-capped budget, so this call settles the
    // PAGE arm with the source's own continuation and the rotation resumes at the
    // second involvement lane — every lane is reached inside the one refresh.
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') throw new Error('unreachable');
    expect(result.continuation.v).toBe(1);
    expect(typeof result.continuation.token).toBe('string');
    expect(result.observations).toHaveLength(1);
    const observation = result.observations[0];
    if (observation?.kind !== 'present') throw new Error('expected a present observation');
    expect(observation.localRef).toEqual({
      kindId: 'pull-request',
      collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
      entryId: '1284',
    });
    expect(observation.locator.routingToken).toBe(REPOSITORY_KEY);
    expect(observation.viewer.involvement).toEqual(['reviewRequested']);
    // The public row-fact arms name their payload `value`; the plugin's own arms do
    // not, and this projection is the only place that rename happens.
    const numberFact = observation.snapshot.facts.find((fact) => fact.id === 'github/number');
    expect(numberFact?.value).toEqual({ kind: 'text', value: '#1284' });
    // `projection-budget` describes this PAGE's shape — it is not a claim that the
    // walk stopped early, because the continuation carries it forward.
    expect(result.evidence).toEqual({ kind: 'partial', reason: 'projection-budget' });
    expect(stub.requests.filter((request) => new URL(request.url).pathname === '/search/issues')).toHaveLength(1);
  });

  it('materializes only the exact configured account and never a caller-supplied one', async () => {
    const stub = searchTransport();

    const result = await scanGithubTriageSource({
      v: 1,
      instance: configuredInstance({ scope: 'repository', account: OTHER_ACCOUNT }),
      page: { kind: 'initial', limit: 64 },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(stub.materializations).toEqual([{
      purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      account: OTHER_ACCOUNT,
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://api.github.com',
        headerNames: ['authorization'],
      },
    }]);
    // The credential belongs on the outbound request and NOWHERE else: it never
    // reaches the source result, and the result carries no account ref either.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('test-only-placeholder');
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain(OTHER_ACCOUNT.accountId);
  });

  it('reauthorizes a GitHub fork source tip before materializing only at the selected workspace root', async () => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => {
        if (!request.url.endsWith(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`)) {
          return undefined;
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_FORK_PULL_REQUEST_RESPONSE,
        };
      },
    });
    const materializer = withReviewWorkspaceMaterializer(stub.context);

    const result = await prepareGithubTriageReviewWorkspace(
      prepareWorkspaceInput({}),
      materializer.context,
      { now: fixedClock(1_700_000_000_000) },
    );

    expect(() => TriagePrepareReviewWorkspaceResultV1Schema.parse(result)).not.toThrow();
    expect(result).toEqual({
      kind: 'prepared',
      repositoryPath: '/selected/repository/.happier/review/review-from-fork',
      branch: 'review-from-fork',
      created: true,
      currentness: { kind: 'currentAtObservedHead' },
      // The source transports a bounded reference after the canonical reread;
      // the generic SCM/Reviews producer remains its only grammar validator.
      pullRequest: { number: 1284 },
    });
    // The source's exact configured account is still the sole credential that
    // reaches GitHub. The generic materializer receives no account authority.
    expect(stub.materializations).toEqual([{
      purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      account: CONFIGURED_ACCOUNT,
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://api.github.com',
        headerNames: ['authorization'],
      },
    }]);
    // The source repo is a fork. Base/target facts remain the route/read
    // authority and must never become the editable checkout target.
    expect(materializer.execute).toHaveBeenCalledWith(
      'scm.reviewWorkspace.materializePrepared',
      {
        cwd: '/selected/repository',
        displayName: 'review-from-fork',
        sourceTip: {
          repository: {
            kind: 'github',
            deployment: 'https://github.com',
            repository: 'fork-user/fork-app',
          },
          cloneUrl: 'https://github.com/fork-user/fork-app.git',
          branch: 'review-from-fork',
          sourceHeadSha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
          fetchRef: 'refs/heads/review-from-fork',
        },
      },
      { signal: materializer.context.signal },
    );
  });

  it('keeps a PR present without comparison routing when the source cannot pin its endpoints', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => new URL(request.url).pathname.endsWith('/pulls/1284')
        ? { status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE, head: null } }
        : undefined,
    });
    const result = TriageGetResultV1Schema.parse(await getGithubTriageEntry({
      v: 1,
      instance: configuredInstance({ scope: 'account' }),
      localRef: { kindId: 'pull-request', collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`, entryId: '1284' },
      lastKnownLocator: { v: 1, routingToken: REPOSITORY_KEY },
    }, stub.context));

    expect(result.kind).toBe('present');
    expect(result).not.toHaveProperty('comparisonSource');
    expect(result).not.toHaveProperty('snapshot.reviewRevision');
  });

  it.each([
    ['missing', undefined, { kind: 'unsupported' as const }],
    [
      'malformed',
      { v: 1 as const, routingToken: 'https://api.github.com/repos/octo-org/example-app' },
      { kind: 'refused' as const, reason: 'pullRequestMoved' as const },
    ],
  ] as const)('does not prepare a workspace from repository configuration when the locator is %s', async (
    _case,
    lastKnownLocator,
    expected,
  ) => {
    const stub = searchTransport();
    const materializer = withReviewWorkspaceMaterializer(stub.context);
    const input = prepareWorkspaceInput({ scope: 'repository' });
    const request = lastKnownLocator === undefined
      ? (({ lastKnownLocator: _locator, ...withoutLocator }) => withoutLocator)(input)
      : { ...input, lastKnownLocator };

    await expect(prepareGithubTriageReviewWorkspace(
      request,
      materializer.context,
      { now: fixedClock(1_700_000_000_000) },
    )).resolves.toEqual(expected);

    expect(stub.materializations).toHaveLength(0);
    expect(stub.requests).toHaveLength(0);
    expect(materializer.execute).not.toHaveBeenCalled();
  });

  it('rereads the exact pull request and asks canonical SCM to verify the prepared local HEAD', async () => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => {
        if (!request.url.endsWith(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`)) {
          return undefined;
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_FORK_PULL_REQUEST_RESPONSE,
        };
      },
    });
    const verifier = withReviewWorkspaceMaterializer(stub.context, Object.freeze({
      success: true as const,
      verification: Object.freeze({
        targetPath: '/selected/repository/.happier/review/review-from-fork',
        sourceHeadSha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
      }),
    }));

    const result = await verifyGithubTriageReviewWorkspace(
      verifyWorkspaceInput(),
      verifier.context,
      { now: fixedClock(1_700_000_000_000) },
    );

    expect(() => TriageVerifyReviewWorkspaceResultV1Schema.parse(result)).not.toThrow();
    expect(result).toEqual({ kind: 'verified', pullRequest: { number: 1284 } });
    expect(verifier.execute).toHaveBeenCalledWith(
      'scm.reviewWorkspace.materializePrepared',
      {
        cwd: '/selected/repository',
        displayName: 'review-from-fork',
        sourceTip: {
          repository: {
            kind: 'github',
            deployment: 'https://github.com',
            repository: 'fork-user/fork-app',
          },
          cloneUrl: 'https://github.com/fork-user/fork-app.git',
          branch: 'review-from-fork',
          sourceHeadSha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
          fetchRef: 'refs/heads/review-from-fork',
        },
        verification: {
          targetPath: '/selected/repository/.happier/review/review-from-fork',
        },
      },
      { signal: verifier.context.signal },
    );
  });

  it('refuses changed provider or prepared pull-request facts before local verification', async () => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => {
        if (!request.url.endsWith(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`)) {
          return undefined;
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_FORK_PULL_REQUEST_RESPONSE,
        };
      },
    });
    const verifier = withReviewWorkspaceMaterializer(stub.context);

    await expect(verifyGithubTriageReviewWorkspace(
      verifyWorkspaceInput({ observed: { headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }),
      verifier.context,
      { now: fixedClock(1_700_000_000_000) },
    )).resolves.toEqual({ kind: 'refused', reason: 'observedHeadMoved' });
    await expect(verifyGithubTriageReviewWorkspace(
      verifyWorkspaceInput({ pullRequest: { number: 999 } }),
      verifier.context,
      { now: fixedClock(1_700_000_000_000) },
    )).resolves.toEqual({ kind: 'refused', reason: 'pullRequestMoved' });
    expect(verifier.execute).not.toHaveBeenCalled();
  });

  it('verifies an accepted checkout against the reread source tip without preparing or creating a workspace', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => new URL(request.url).pathname.endsWith('/pulls/1284')
        ? { status: 200, body: GITHUB_FORK_PULL_REQUEST_RESPONSE }
        : undefined,
    });
    const verifier = withReviewWorkspaceMaterializer(stub.context, {
      success: true,
      verification: {
        targetPath: '/selected/repository',
        sourceHeadSha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
      },
    });

    const result = TriageVerifyReviewWorkspaceResultV1Schema.parse(await verifyGithubTriageReviewWorkspace(
      verifyWorkspaceInput({ acceptedCheckout: true }),
      verifier.context,
      { now: fixedClock(1_700_000_000_000) },
    ));

    expect(result).toEqual({ kind: 'verified', pullRequest: { number: 1284 } });
    expect(stub.requests.filter(request => new URL(request.url).pathname.endsWith('/pulls/1284'))).toHaveLength(1);
    expect(stub.requests.every(request => request.method === 'GET')).toBe(true);
    expect(verifier.execute.mock.calls).toEqual([[
      'scm.reviewWorkspace.materializePrepared',
      {
        cwd: '/selected/repository',
        displayName: 'review-from-fork',
        sourceTip: {
          repository: { kind: 'github', deployment: 'https://github.com', repository: 'fork-user/fork-app' },
          cloneUrl: 'https://github.com/fork-user/fork-app.git',
          branch: 'review-from-fork',
          sourceHeadSha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
          fetchRef: 'refs/heads/review-from-fork',
        },
        verification: { targetPath: '/selected/repository' },
      },
      { signal: verifier.context.signal },
    ]]);
  });

  it.each(['source', 'pullRequest', 'head'] as const)(
    'refuses an accepted checkout when the selected %s authorization no longer matches', async (changed) => {
      const stub = createStubGithubTransport({
        respond: (request) => new URL(request.url).pathname.endsWith('/pulls/1284')
          ? { status: 200, body: changed === 'pullRequest'
            ? { ...GITHUB_FORK_PULL_REQUEST_RESPONSE, number: 999 }
            : GITHUB_FORK_PULL_REQUEST_RESPONSE }
          : undefined,
      });
      const verifier = withReviewWorkspaceMaterializer(stub.context);
      const input = verifyWorkspaceInput({ acceptedCheckout: true,
        ...(changed === 'head' ? { observed: { headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } } : {}),
      });

      await expect(verifyGithubTriageReviewWorkspace(
        changed === 'source' ? { ...input, entryRef: { ...input.entryRef,
          source: { ...input.entryRef.source, pluginId: 'another.source' } } } : input,
        verifier.context,
        { now: fixedClock(1_700_000_000_000) },
      )).resolves.toEqual({ kind: 'refused', reason: changed === 'head' ? 'observedHeadMoved' : 'pullRequestMoved' });
      expect(verifier.execute).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ targetPath: '/another/checkout', sourceHeadSha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29' },
      { kind: 'workspaceMismatch' }],
    [{ targetPath: '/selected/repository', sourceHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      { kind: 'refused', reason: 'observedHeadMoved' }],
  ] as const)('refuses an accepted checkout whose native path or HEAD differs', async (verification, expected) => {
    const stub = createStubGithubTransport({
      respond: (request) => new URL(request.url).pathname.endsWith('/pulls/1284')
        ? { status: 200, body: GITHUB_FORK_PULL_REQUEST_RESPONSE }
        : undefined,
    });
    const verifier = withReviewWorkspaceMaterializer(stub.context, { success: true, verification });

    await expect(verifyGithubTriageReviewWorkspace(
      verifyWorkspaceInput({ acceptedCheckout: true }),
      verifier.context,
      { now: fixedClock(1_700_000_000_000) },
    )).resolves.toEqual(expected);
    expect(verifier.execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{
      success: true,
      verification: {
        targetPath: '/another/worktree',
        sourceHeadSha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
      },
    }, { kind: 'workspaceMismatch' }],
    [{
      success: true,
      verification: {
        targetPath: '/selected/repository/.happier/review/review-from-fork',
        sourceHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    }, { kind: 'refused', reason: 'observedHeadMoved' }],
  ] as const)('fails closed when canonical SCM reports changed final workspace facts', async (
    scmResult,
    expected,
  ) => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => request.url.endsWith(
        `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`,
      ) ? {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_FORK_PULL_REQUEST_RESPONSE,
        } : undefined,
    });
    const verifier = withReviewWorkspaceMaterializer(stub.context, Object.freeze(scmResult));

    await expect(verifyGithubTriageReviewWorkspace(
      verifyWorkspaceInput(),
      verifier.context,
      { now: fixedClock(1_700_000_000_000) },
    )).resolves.toEqual(expected);
    expect(verifier.execute).toHaveBeenCalledTimes(1);
  });

  it('requires an already-selected workspace without reading GitHub or probing local SCM', async () => {
    const stub = searchTransport();
    const materializer = withReviewWorkspaceMaterializer(stub.context);
    const { workspace: _workspace, ...withoutWorkspace } = prepareWorkspaceInput({});

    await expect(prepareGithubTriageReviewWorkspace(
      withoutWorkspace,
      materializer.context,
      { now: fixedClock(1_700_000_000_000) },
    )).resolves.toEqual({ kind: 'workspaceRequired' });

    expect(stub.materializations).toHaveLength(0);
    expect(stub.requests).toHaveLength(0);
    expect(materializer.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['baseSha', '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2f'],
    ['headSha', '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e20'],
    ['nativeRevision', '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e20'],
  ] as const)('refuses a reread whose observed %s moved before local materialization', async (field, value) => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => {
        if (!request.url.endsWith(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`)) {
          return undefined;
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_FORK_PULL_REQUEST_RESPONSE,
        };
      },
    });
    const materializer = withReviewWorkspaceMaterializer(stub.context);

    const result = await prepareGithubTriageReviewWorkspace(
      prepareWorkspaceInput({ observed: { [field]: value } }),
      materializer.context,
      { now: fixedClock(1_700_000_000_000) },
    );

    expect(result).toEqual({ kind: 'refused', reason: 'observedHeadMoved' });
    expect(materializer.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['NOT_REPOSITORY', { kind: 'workspaceMismatch' }],
    ['INVALID_PATH', { kind: 'workspaceMismatch' }],
    ['REMOTE_NOT_FOUND', { kind: 'workspaceMismatch' }],
    ['COMMAND_FAILED', { kind: 'unavailable', reason: 'scmResolver' }],
  ] as const)('projects generic local materialization %s without granting a fallback path', async (
    errorCode,
    expected,
  ) => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => {
        if (!request.url.endsWith(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`)) {
          return undefined;
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_FORK_PULL_REQUEST_RESPONSE,
        };
      },
    });
    const materializer = withReviewWorkspaceMaterializer(stub.context, Object.freeze({
      success: false as const,
      error: 'synthetic local materialization failure',
      errorCode,
    }));

    await expect(prepareGithubTriageReviewWorkspace(
      prepareWorkspaceInput({}),
      materializer.context,
      { now: fixedClock(1_700_000_000_000) },
    )).resolves.toEqual(expected);
    expect(materializer.execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed when preparation receives the read-only verification success arm', async () => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => request.url.endsWith(
        `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`,
      ) ? {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_FORK_PULL_REQUEST_RESPONSE,
        } : undefined,
    });
    const materializer = withReviewWorkspaceMaterializer(stub.context, Object.freeze({
      success: true as const,
      verification: Object.freeze({
        targetPath: '/selected/repository/.happier/review/review-from-fork',
        sourceHeadSha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
      }),
    }));

    await expect(prepareGithubTriageReviewWorkspace(
      prepareWorkspaceInput({}),
      materializer.context,
      { now: fixedClock(1_700_000_000_000) },
    )).resolves.toEqual({ kind: 'unavailable', reason: 'scmResolver' });
  });

  it('propagates SCM AbortError from both preparation and final verification', async () => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => request.url.endsWith(
        `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`,
      ) ? {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_FORK_PULL_REQUEST_RESPONSE,
        } : undefined,
    });
    const cancellation = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const execute = vi.fn(async () => {
      throw cancellation;
    });
    const context = {
      ...stub.context,
      services: { ...stub.context.services, actions: { execute } },
    } as unknown as PluginInvocationContext;

    await expect(prepareGithubTriageReviewWorkspace(
      prepareWorkspaceInput({}),
      context,
      { now: fixedClock(1_700_000_000_000) },
    )).rejects.toBe(cancellation);
    await expect(verifyGithubTriageReviewWorkspace(
      verifyWorkspaceInput(),
      context,
      { now: fixedClock(1_700_000_000_000) },
    )).rejects.toBe(cancellation);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('refuses a continuation this process did not mint rather than guessing a frontier', async () => {
    const stub = searchTransport();

    const result = await scanGithubTriageSource({
      v: 1,
      instance: configuredInstance({ scope: 'repository' }),
      page: { kind: 'continuation', continuation: { v: 1, token: 'lane-frontier' } },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    // The continuation is refresh-local. A token from another process, another
    // version, or another configured instance restarts the walk at `initial`; it is
    // never a resume point this source will honour.
    expect(result).toEqual({
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'triage_scope_continuation_invalid' },
    });
    expect(stub.requests).toHaveLength(0);
  });

  it('walks every involvement lane to exhaustion across continuation pages inside one refresh', async () => {
    const stub = searchTransport();
    const instance = configuredInstance({ scope: 'repository' });
    const lanes: string[] = [];
    let request: Parameters<typeof scanGithubTriageSource>[0] = {
      v: 1,
      instance,
      page: { kind: 'initial', limit: 64 },
    };

    for (let page = 0; page < 8; page += 1) {
      const result = await scanGithubTriageSource(
        request,
        stub.context,
        { now: fixedClock(1_700_000_000_000) },
      );
      expect(() => TriageScanResultV1Schema.parse(result)).not.toThrow();
      lanes.push(new URL(stub.requests.filter((request) => new URL(request.url).pathname === '/search/issues').at(-1)?.url ?? '').searchParams.get('q') ?? '');
      if (result.kind === 'complete') break;
      if (result.kind !== 'page') throw new Error('expected a page arm');
      request = { v: 1, instance, page: { kind: 'continuation', continuation: result.continuation } };
    }

    // Without the continuation the first lane consumed the whole budget on every
    // refresh and `assigned`, `mentioned`, `reviewed` and `authored` were never read.
    expect(lanes.map((query) => query.split(' ').at(-1))).toEqual([
      'review-requested:@me',
      'assignee:@me',
      'mentions:@me',
      'reviewed-by:@me',
      'author:@me',
    ]);
  });

  it('refuses a configured instance bound to another declared purpose', async () => {
    const stub = searchTransport();

    const result = await scanGithubTriageSource({
      v: 1,
      instance: configuredInstance({ scope: 'repository', purpose: 'gitlab-connected-account' }),
      page: { kind: 'initial', limit: 64 },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(result).toEqual({
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'github_instance_binding_foreign' },
    });
    expect(stub.materializations).toHaveLength(0);
  });

  it('returns the exact input local ref from an authoritative get', async () => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => {
        if (new URL(request.url).pathname.endsWith('/pulls/1284/files')) {
          return { status: 200, headers: { 'content-type': 'application/json' }, body: [githubChangedFile({ filename: 'current.ts' })] };
        }
        if (!request.url.endsWith(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`)) {
          return undefined;
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_PULL_REQUEST_RESPONSE,
        };
      },
    });
    const localRef = {
      kindId: 'pull-request',
      collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
      entryId: '1284',
    } as const;

    const result = await getGithubTriageEntry({
      v: 1,
      instance: configuredInstance({ scope: 'repository' }),
      localRef,
      lastKnownLocator: {
        v: 1,
        webUrl: `https://github.com/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pull/1284`,
        displayPath: `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}#1284`,
        routingToken: `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`,
      },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(() => TriageGetResultV1Schema.parse(result)).not.toThrow();
    expect(result.kind).toBe('present');
    expect(result.localRef).toEqual(localRef);
    if (result.kind !== 'present') throw new Error('expected present GitHub pull request');
    expect(result.snapshot.reviewRevision).toEqual({
      baseSha: '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e',
      headSha: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
      nativeRevision: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
    });
    expect(result).toMatchObject({
      comparisonSource: {
        kind: 'pullRequest',
        locator: {
          providerId: 'github',
          repository: REPOSITORY_KEY,
          number: 1284,
          baseOid: '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e',
          headOid: '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29',
          sourceAction: {
            action: { pluginId: GITHUB_PLUGIN_ID, localId: 'triage/list-github-changed-files' },
            input: {
              v: 1,
              instance: configuredInstance({ scope: 'repository' }),
              localRef,
              routingToken: REPOSITORY_KEY,
              limit: 100,
              comparison: true,
            },
          },
        },
      },
    });
    if (result.comparisonSource?.kind !== 'pullRequest') throw new Error('expected source-owned PR comparison');
    const evidence = await listGithubChangedFiles(result.comparisonSource.locator.sourceAction?.input, stub.context);
    expect(evidence).toMatchObject({
      kind: 'changedFiles',
      rows: [{ path: 'current.ts' }],
      comparison: {
        baseOid: result.comparisonSource.locator.baseOid,
        headOid: result.comparisonSource.locator.headOid,
        locator: { providerId: 'github', repository: REPOSITORY_KEY, number: 1284 },
      },
    });
    expect(stub.materializations.every((read) => read.account.accountId === CONFIGURED_ACCOUNT.accountId)).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['malformed', { v: 1 as const, routingToken: 'https://api.github.com/repos/octo-org/example-app' }],
  ] as const)('does not guess an exact route from repository configuration when the locator is %s', async (
    _case,
    lastKnownLocator,
  ) => {
    const stub = searchTransport();
    const localRef = {
      kindId: 'pull-request',
      collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
      entryId: '1284',
    } as const;

    const result = await getGithubTriageEntry({
      v: 1,
      instance: configuredInstance({ scope: 'repository' }),
      localRef,
      ...(lastKnownLocator === undefined ? {} : { lastKnownLocator }),
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(result).toEqual({
      kind: 'unresolved',
      localRef,
      failure: { class: 'unknown', code: 'github_locator_unusable' },
    });
    expect(stub.requests).toHaveLength(0);
    expect(stub.materializations).toHaveLength(0);
  });

  it('answers unresolved without an outbound call when the configured instance carries no route', async () => {
    const stub = searchTransport();
    const localRef = {
      kindId: 'pull-request',
      collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
      entryId: '1284',
    } as const;

    const result = await getGithubTriageEntry({
      v: 1,
      instance: configuredInstance({ scope: 'account' }),
      localRef,
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    // An account-scoped instance names no repository and the target has never
    // observed this entry, so there is no route. The answer is the contract's
    // `unresolved`, and no path is guessed from identity or display text.
    expect(result).toEqual({
      kind: 'unresolved',
      localRef,
      failure: { class: 'unknown', code: 'github_locator_unusable' },
    });
    expect(stub.requests).toHaveLength(0);
  });

  it('routes an account-wide get through the last-known locator the target observed', async () => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => {
        if (!request.url.endsWith(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`)) {
          return undefined;
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_PULL_REQUEST_RESPONSE,
        };
      },
    });
    const localRef = {
      kindId: 'pull-request',
      collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
      entryId: '1284',
    } as const;

    const result = await getGithubTriageEntry({
      v: 1,
      // Account-wide: the configured instance names no repository at all.
      instance: configuredInstance({ scope: 'account' }),
      localRef,
      lastKnownLocator: { v: 1, routingToken: REPOSITORY_KEY },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    // An account-wide scan discovers entries across many repositories, so the
    // locator is the only evidence that can name this entry's one. It grants no
    // authority: the response is still validated against the requested ref.
    expect(() => TriageGetResultV1Schema.parse(result)).not.toThrow();
    expect(result.kind).toBe('present');
    expect(result.localRef).toEqual(localRef);
    expect(stub.requests).toHaveLength(1);
  });

  it('answers unresolved without an outbound call when the last-known locator carries no usable route', async () => {
    const stub = searchTransport();
    const localRef = {
      kindId: 'pull-request',
      collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
      entryId: '1284',
    } as const;

    const result = await getGithubTriageEntry({
      v: 1,
      instance: configuredInstance({ scope: 'account' }),
      localRef,
      // Display facts are never API-route fallbacks, and an origin-bearing token is
      // not a route this source minted.
      lastKnownLocator: {
        v: 1,
        displayPath: `${REPOSITORY_KEY}#1284`,
        webUrl: `https://github.com/${REPOSITORY_KEY}/pull/1284`,
      },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(result).toEqual({
      kind: 'unresolved',
      localRef,
      failure: { class: 'unknown', code: 'github_locator_unusable' },
    });
    expect(stub.requests).toHaveLength(0);
  });

  it('refuses an undeclared kind rather than reading a route for it', async () => {
    const stub = searchTransport();

    const result = await getGithubTriageEntry({
      v: 1,
      instance: configuredInstance({ scope: 'repository' }),
      localRef: {
        kindId: 'merge-request',
        collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
        entryId: '1284',
      },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(result).toEqual({
      kind: 'unresolved',
      localRef: {
        kindId: 'merge-request',
        collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
        entryId: '1284',
      },
      failure: { class: 'unsupportedContract', code: 'github_kind_undeclared' },
    });
    expect(stub.requests).toHaveLength(0);
  });
});
