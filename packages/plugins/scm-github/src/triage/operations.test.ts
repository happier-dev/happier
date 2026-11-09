import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk';
import {
  MAX_TRIAGE_TEXT_UTF8_BYTES_V1,
  TriageGetResultV1Schema,
  TriageListScopeUnitsResultV1Schema,
  TriagePrepareReviewWorkspaceResultV1Schema,
  TriageScanResultV1Schema,
  TriageVerifyReviewWorkspaceResultV1Schema,
  type TriageConfiguredSourceInstanceV1,
  type TriageScanInputV1,
  type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';
import { activate, activateAccount } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { GITHUB_TRIAGE_ACTION_IDS_V1 } from './contribution.js';
import { runTriageScanPass } from '../../../triage/src/projection/scanPass.js';

import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../observations/githubProviderContracts.js';

import {
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
  GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_PULL_REQUEST_RESPONSE,
  GITHUB_REPOSITORY_RESPONSE,
  GITHUB_ISSUE_RESPONSE,
  GITHUB_SEARCH_PULL_REQUEST_ITEM,
  GITHUB_SEARCH_ISSUE_ITEM,
  githubSearchResponse,
  githubChangedFile,
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
  githubChecksBatchResponse,
  fixedClock,
  type StubHttpResponse,
} from './testkit/githubTriage.test-support.js';

const REPOSITORY_KEY = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();

describe('registered GitHub REST → Triage source contract', () => {
  it('returns the preserved host refusal from the registered public scan Action', async () => {
    const stub = createStubGithubTransport({ respond: () => undefined });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: await import('../activate.js'), services: {
      http: stub.context.services.http,
      connectedAccounts: { ...stub.context.services.connectedAccounts, materializeListedAccount: async () => {
        throw Object.assign(new Error('private material'), {
          code: 'connected_service_credential_reconnect_required', details: { requestId: 'host-request-1' },
        });
      } },
    } });
    try {
      const result = TriageScanResultV1Schema.parse(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.scan,
        { v: 1, instance: configuredInstance({ scope: 'repository' }), page: { kind: 'initial', limit: 64 } },
        { surface: 'plugin' }));
      expect(result).toMatchObject({ kind: 'failed', failure: {
        class: 'authentication', code: 'connected_service_credential_reconnect_required',
        detail: 'Happier Request ID: host-request-1',
      } });
      expect(stub.requests).toEqual([]);
      expect(JSON.stringify(result)).not.toContain('private');
    } finally { await plugin.dispose(); }
  });

  it('keeps a typed host authorization refusal and Happier Request ID in the public scan result', async () => {
    const stub = createStubGithubTransport({ respond: () => undefined });
    const materializeListedAccount = vi.fn(async () => {
      throw Object.assign(new Error('private credential material'), {
        code: 'connected_service_credential_reconnect_required', retryable: false,
      });
    });
    const context = { ...stub.context, invocationId: 'happier-request-1', services: {
      ...stub.context.services,
      connectedAccounts: { ...stub.context.services.connectedAccounts, materializeListedAccount },
    } };
    const result = TriageScanResultV1Schema.parse(await scanGithubTriageSource({
      v: 1, instance: configuredInstance({ scope: 'repository' }), page: { kind: 'initial', limit: 64 },
    }, context));
    expect(result).toMatchObject({ kind: 'failed', failure: {
      class: 'authentication', code: 'connected_service_credential_reconnect_required',
      detail: 'Happier Request ID: happier-request-1',
    } });
    expect(materializeListedAccount).toHaveBeenCalledTimes(1);
    expect(stub.requests).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it('forwards text search from the strict scan Action to GitHub for selected repositories', async () => {
    const instance = configuredInstance({ scope: 'repository' });
    const transport = createStubGithubTransport({ respond: request => {
      if (new URL(request.url).pathname === '/graphql') return githubChecksBatchResponse(request);
      const query = new URL(request.url).searchParams.get('q') ?? '';
      return { status: 200, body: githubSearchResponse({ items: query.includes('"crash"')
        ? [{ ...GITHUB_SEARCH_ISSUE_ITEM, title: 'Older crash fix' }] : [] }) };
    } });
    const result = TriageScanResultV1Schema.parse(await scanGithubTriageSource({ v: 1, instance,
      query: 'crash', page: { kind: 'initial', limit: 64 } }, transport.context));
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') throw new Error(result.failure.code);
    expect(result.observations.some(row => row.kind === 'present' && row.snapshot.title === 'Older crash fix')).toBe(true);
    const searches = transport.requests.filter(request => new URL(request.url).pathname === '/search/issues');
    expect(searches).toHaveLength(5);
    expect(searches.every(request => new URL(request.url).searchParams.get('q')?.includes(`repo:${REPOSITORY_KEY}`))).toBe(true);
  });

  it.each(['healthy', 'rejected', 'ceiling'] as const)('groups selected repository searches with isolated %s frontiers', async (mode) => {
    const unitIds = ['org/first', 'org/second', 'org/third'];
    const configured = configuredInstance({ scope: 'repository' });
    const instance = { ...configured, configuration: { v: 1 as const, token: JSON.stringify({ v: 1,
      selection: { kind: 'selected', unitIds } }) } };
    const transport = createStubGithubTransport({ respond: request => {
      const url = new URL(request.url);
      if (url.pathname !== '/search/issues') return undefined;
      const repositories = [...(url.searchParams.get('q') ?? '').matchAll(/repo:([^\s)]+)/gu)].map(match => match[1]!);
      if (mode === 'rejected' && repositories.includes('org/second')) return { status: 422, body: { message: 'Validation Failed' } };
      const items = repositories.map(repository => ({ ...GITHUB_SEARCH_ISSUE_ITEM,
        repository_url: `https://api.github.com/repos/${repository}`, url: `https://api.github.com/repos/${repository}/issues/7`,
        html_url: `https://github.com/${repository}/issues/7`, repository: { id: 9000 + unitIds.indexOf(repository),
          full_name: repository, name: repository.split('/')[1], owner: { login: 'org' } },
      }));
      return { status: 200, body: githubSearchResponse({ items,
        ...(mode === 'ceiling' && repositories.length > 1 ? { totalCount: 1001 } : {}) }) };
    } });
    let page: TriageScanInputV1['page'] = { kind: 'initial', limit: 64 };
    const observations: unknown[] = [];
    let result: TriageScanResultV1;
    do {
      result = TriageScanResultV1Schema.parse(await scanGithubTriageSource({ v: 1, instance, page }, transport.context));
      if (result.kind === 'failed') throw new Error(`Selected walk failed: ${result.failure.code}`);
      observations.push(...result.observations);
      if (result.kind === 'page') page = { kind: 'continuation', continuation: result.continuation };
    } while (result.kind === 'page');
    const searches = transport.requests.filter(request => new URL(request.url).pathname === '/search/issues');
    expect(searches).toHaveLength(mode === 'healthy' ? 5 : 20);
    expect(observations).toHaveLength(mode === 'rejected' ? 10 : 15);
    expect(result.evidence).toMatchObject({ kind: mode === 'rejected' ? 'partial' : 'walkFinished' });
    const queries = searches.map(request => new URL(request.url).searchParams.get('q')!);
    expect(queries.slice(0, 5).every(query => unitIds.every(id => query.includes(`repo:${id}`)))).toBe(true);
  });

  it.each([false, true])('resumes grouped repository paging fairly, including isolated rejection=%s', async (rejected) => {
    const unitIds = ['org/first', 'org/second', 'org/third'];
    const configured = configuredInstance({ scope: 'repository' });
    const instance = { ...configured, configuration: { v: 1 as const, token: JSON.stringify({ v: 1,
      selection: { kind: 'selected', unitIds } }) } };
    const transport = createStubGithubTransport({ respond: request => {
      const url = new URL(request.url);
      if (url.pathname !== '/search/issues') return undefined;
      const repositories = [...(url.searchParams.get('q') ?? '').matchAll(/repo:([^\s)]+)/gu)].map(match => match[1]!);
      if (rejected && repositories.includes('org/second')) return { status: 422, body: { message: 'Validation Failed' } };
      const perPage = Number(url.searchParams.get('per_page'));
      const offset = (Number(url.searchParams.get('page')) - 1) * perPage;
      const items = repositories.slice(offset, offset + perPage).map(repository => ({ ...GITHUB_SEARCH_ISSUE_ITEM,
        repository_url: `https://api.github.com/repos/${repository}`, html_url: `https://github.com/${repository}/issues/7`,
        repository: { id: 9000 + unitIds.indexOf(repository), name: repository.split('/')[1], owner: { login: 'org' } },
      }));
      const next = new URL(url); next.searchParams.set('page', String(Number(url.searchParams.get('page')) + 1));
      return { status: 200, body: githubSearchResponse({ items, totalCount: repositories.length }),
        ...(offset + perPage < repositories.length ? { headers: { link: `<${next}>; rel="next"` } } : {}) };
    } });
    let page: TriageScanInputV1['page'] = { kind: 'initial', limit: 2 };
    const rows: unknown[] = [];
    let result: TriageScanResultV1;
    do {
      result = TriageScanResultV1Schema.parse(await scanGithubTriageSource({ v: 1, instance, page }, transport.context));
      if (result.kind === 'failed') throw new Error(result.failure.code);
      expect(result.observations.length).toBeLessThanOrEqual(2);
      rows.push(...result.observations);
      if (result.kind === 'page') {
        const count = transport.requests.length;
        const changed = { ...instance, configuration: { v: 1, token: JSON.stringify({ v: 1,
          selection: { kind: 'selected', unitIds: ['org/other'] } }) } };
        expect(await scanGithubTriageSource({ v: 1, instance: changed,
          page: { kind: 'continuation', continuation: result.continuation } }, transport.context)).toMatchObject({ kind: 'failed' });
        expect(transport.requests).toHaveLength(count);
        page = { kind: 'continuation', continuation: result.continuation };
      }
    } while (result.kind === 'page');
    expect(rows).toHaveLength(rejected ? 10 : 15);
    expect(transport.requests).toHaveLength(rejected ? 20 : 10);
    const queries = transport.requests.slice(0, 5).map(request => new URL(request.url).searchParams.get('q')!);
    for (const qualifier of ['review-requested:@me', 'assignee:@me', 'mentions:@me', 'reviewed-by:@me', 'author:@me']) {
      expect(queries.some(query => query.includes(qualifier))).toBe(true);
    }
  });

  it.each([undefined, Date.UTC(2026, 9, 30)])('sizes repository groups from GitHub Boolean limits with completedSince=%s', async (sinceMs) => {
    const configured = configuredInstance({ scope: 'repository' });
    const unitIds = Array.from({ length: 7 }, (_, index) => `org/repository-${index}`);
    const instance = { ...configured, configuration: { v: 1, token: JSON.stringify({ v: 1,
      selection: { kind: 'selected', unitIds } }) } };
    const transport = createStubGithubTransport({ respond: () => ({ status: 200, body: githubSearchResponse({ items: [] }) }) });
    const result = TriageScanResultV1Schema.parse(await scanGithubTriageSource({ v: 1, instance,
      page: { kind: 'initial', limit: 64 }, ...(sinceMs === undefined ? {} : { completed: { kindIds: ['issue'], sinceMs } }),
    }, transport.context));
    expect(result).toMatchObject({ kind: 'complete', evidence: { kind: 'walkFinished' } });
    expect(transport.requests).toHaveLength(10);
    const queries = transport.requests.map(request => new URL(request.url).searchParams.get('q')!);
    expect(queries.every(query => [...query.matchAll(/\b(?:AND|OR|NOT)\b/gu)].length <= 5)).toBe(true);
    for (const id of unitIds) expect(queries.some(query => query.includes(`repo:${id}`))).toBe(true);
  });

  it('keeps continuation work proportional to the current repository group', async () => {
    const configured = configuredInstance({ scope: 'repository' });
    // Two vs five provider-sized groups fit the configured-source envelope;
    // selection must not multiply the retained native frontier by every group.
    const unitIds = Array.from({ length: 30 }, (_, index) => `org/repository-${index}`);
    const transport = createStubGithubTransport({ respond: () => ({ status: 200,
      body: githubSearchResponse({ items: [GITHUB_SEARCH_ISSUE_ITEM] }),
    }) });
    const read = async (selected: readonly string[]) => {
      const instance = { ...configured, configuration: { v: 1, token: JSON.stringify({ v: 1,
        selection: { kind: 'selected', unitIds: selected } }) } };
      const result = TriageScanResultV1Schema.parse(await scanGithubTriageSource({ v: 1, instance,
        page: { kind: 'initial', limit: 1 } }, transport.context));
      if (result.kind !== 'page') throw new Error(JSON.stringify(result.kind === 'failed' ? result.failure : result.evidence));
      expect(result.observations).toHaveLength(1);
      return result.continuation.token.length;
    };
    const small = await read(unitIds.slice(0, 7));
    const large = await read(unitIds);
    expect(large).toBe(small);
    expect(transport.requests).toHaveLength(2);
  });

  it('fills a single aggregate Refresh from short review-requested and later authored lanes', async () => {
    const transport = createStubGithubTransport({ respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname !== '/search/issues') return undefined;
      const query = url.searchParams.get('q') ?? '';
      const authored = query.includes('author:@me');
      const count = query.includes('review-requested:@me') ? 2 : authored ? 54 : 0;
      return { status: 200, body: githubSearchResponse({ items: Array.from({ length: count }, (_, index) => ({
        ...GITHUB_SEARCH_ISSUE_ITEM, id: 5000 + index, number: (authored ? 100 : 1) + index,
      })) }) };
    } });
    const instance = configuredInstance({ scope: 'repository' });
    const result = await runTriageScanPass({ lanes: [{
      source: instance.instance.source,
      sourceInstanceId: instance.instance.sourceInstanceId,
      configured: instance,
      declaredKindIds: ['pull-request', 'issue'],
      scan: (input) => scanGithubTriageSource(input, transport.context, { now: fixedClock(1000) }),
    }], pageLimit: 56, observationBudget: 56, nowMs: fixedClock(1000) });
    expect(result.observations).toHaveLength(56);
    expect(result.stopped).toEqual([]);
    expect(result.observations.filter((row) => row.outcome.kind === 'present'
      && row.outcome.viewer.involvement.includes('author'))).toHaveLength(54);
  });
  it.each(['present', 'denied', 'mismatch'] as const)('resolves a locator-free pin through the registered exact get: %s', async (outcome) => {
    const transport = createStubGithubTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      if (path === `/repositories/${GITHUB_FIXTURE_REPOSITORY_ID}`) return outcome === 'denied'
        ? { status: 404, body: {} }
        : { status: 200, body: { ...GITHUB_REPOSITORY_RESPONSE,
            ...(outcome === 'mismatch' ? { id: 999 } : {}) } };
      if (path === `/repos/${REPOSITORY_KEY}/pulls/1284`) return { status: 200, body: GITHUB_PULL_REQUEST_RESPONSE };
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    const localRef = { kindId: 'pull-request', collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`, entryId: '1284' };
    try {
      const result = TriageGetResultV1Schema.parse(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.get,
        { v: 1, instance: configuredInstance({ scope: 'account' }), localRef }, { surface: 'plugin' }));
      expect(result).toMatchObject({ kind: outcome === 'present' ? 'present' : 'unresolved', localRef });
      if (outcome === 'present') expect(result).toMatchObject({ locator: { routingToken: REPOSITORY_KEY } });
      expect(transport.requests.map(request => new URL(request.url).pathname)).toEqual([
        `/repositories/${GITHUB_FIXTURE_REPOSITORY_ID}`,
        ...(outcome === 'present' ? [`/repos/${REPOSITORY_KEY}/pulls/1284`] : []),
      ]);
      expect(transport.materializeCount()).toBe(1);
    } finally { await plugin.dispose(); }
  });
  it('cancels a hidden native scope before issuing its alert request', async () => {
    const controller = new AbortController();
    const instance = configuredInstance({ scope: 'repository' });
    const enabled = { ...instance, configuration: { v: 1 as const, token: JSON.stringify({ v: 1,
      selection: { kind: 'selected', unitIds: [REPOSITORY_KEY] }, alerts: { dependabot: true, codeScanning: false } }) } };
    const transport = createStubGithubTransport({ signal: controller.signal, respond: request => {
      const path = new URL(request.url).pathname;
      if (path === '/search/issues') return { status: 200, body: githubSearchResponse({ items: [] }) };
      if (path === `/repos/${REPOSITORY_KEY}`) controller.abort(new DOMException('Scope hidden', 'AbortError'));
      return undefined;
    } });
    const first = await scanGithubTriageSource({ v: 1, instance: enabled, page: { kind: 'initial', limit: 64 } }, transport.context);
    if (first.kind !== 'page') throw new Error('Native demand remains');
    await expect(scanGithubTriageSource({ v: 1, instance: enabled,
      page: { kind: 'continuation', continuation: first.continuation } }, transport.context)).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.requests.some(request => new URL(request.url).pathname.endsWith('/alerts'))).toBe(false);
  });
  it('names both denied native families without claiming a complete empty scope', async () => {
    const instance = configuredInstance({ scope: 'repository' });
    const enabled = { ...instance, configuration: { v: 1 as const, token: JSON.stringify({ v: 1,
      selection: { kind: 'selected', unitIds: [REPOSITORY_KEY] }, alerts: { dependabot: true, codeScanning: true } }) } };
    const transport = createStubGithubTransport({ respond: request => {
      const path = new URL(request.url).pathname;
      return path === '/search/issues' ? { status: 200, body: githubSearchResponse({ items: [] }) }
        : path.endsWith('/alerts') ? { status: 403, headers: { 'x-accepted-github-permissions': 'vulnerability_alerts=read',
          'X-GitHub-Request-Id': 'A89C:E6813:2EE25D2:4481C49:6AEB94CC' }, body: { message: 'Resource not accessible' } } : undefined;
    } });
    let current = TriageScanResultV1Schema.parse(await scanGithubTriageSource({ v: 1, instance: enabled,
      page: { kind: 'initial', limit: 64 } }, transport.context));
    while (current.kind === 'page') current = TriageScanResultV1Schema.parse(await scanGithubTriageSource({ v: 1, instance: enabled,
      page: { kind: 'continuation', continuation: current.continuation } }, transport.context));
    expect(current).toMatchObject({ kind: 'complete', observations: [], evidence: { kind: 'partial' } });
    if (current.kind !== 'complete' || current.evidence.kind !== 'partial') throw new Error('Partial coverage');
    expect(current.evidence.reason).toContain('dependabot-permission');
    expect(current.evidence.reason).toContain('code-scanning-permission');
    expect(current.evidence).toMatchObject({ failure: { class: 'permission', code: 'insufficient_scope',
      requiredPermissions: 'vulnerability_alerts=read', detail: expect.stringContaining('Dependabot') } });
    expect(current.evidence).toMatchObject({ failure: { detail: expect.stringContaining('security_events') } });
    expect(current.evidence).toMatchObject({ failure: { detail: expect.stringContaining('A89C:E6813:2EE25D2:4481C49:6AEB94CC') } });
  });
  it('walks explicit All repository pages with a compact cursor and refuses family reconfiguration', async () => {
    const instance = configuredInstance({ scope: 'account' });
    const enabled = { ...instance, configuration: { v: 1 as const, token: JSON.stringify({ v: 1,
      selection: { kind: 'all' }, alerts: { dependabot: true, codeScanning: false } }) } };
    const transport = createStubGithubTransport({ respond: request => {
      const url = new URL(request.url);
      if (url.pathname === '/search/issues') return { status: 200, body: githubSearchResponse({ items: [] }) };
      if (url.pathname === '/user/repos') {
        const page = Number(url.searchParams.get('page') ?? '1');
        const next = new URL(url); next.searchParams.set('page', '2');
        return { status: 200, body: [{ id: page, full_name: `org/repo-${page}` }],
          ...(page === 1 ? { headers: { link: `<${next}>; rel="next"` } } : {}) };
      }
      const repository = /^\/repos\/org\/repo-([12])$/u.exec(url.pathname);
      if (repository !== null) return { status: 200, body: { id: Number(repository[1]), full_name: `org/repo-${repository[1]}` } };
      if (url.pathname.endsWith('/dependabot/alerts')) return { status: 200, body: [{ number: 1, state: 'fixed',
        created_at: '2026-10-01T00:00:00Z', security_advisory: { summary: 'Retained history', severity: 'low' } }] };
      return undefined;
    } });
    const first = TriageScanResultV1Schema.parse(await scanGithubTriageSource({ v: 1, instance: enabled,
      page: { kind: 'initial', limit: 64 } }, transport.context));
    if (first.kind !== 'page') throw new Error('All alert traversal remains open');
    const before = transport.requests.length;
    expect(await scanGithubTriageSource({ v: 1, instance: { ...enabled, configuration: { v: 1,
      token: enabled.configuration.token.replace('"codeScanning":false', '"codeScanning":true') } },
      page: { kind: 'continuation', continuation: first.continuation } }, transport.context)).toMatchObject({ kind: 'failed' });
    expect(transport.requests).toHaveLength(before);
    let current: TriageScanResultV1 = first;
    const identities: string[] = [];
    while (current.kind === 'page') {
      current = TriageScanResultV1Schema.parse(await scanGithubTriageSource({ v: 1, instance: enabled,
        page: { kind: 'continuation', continuation: current.continuation } }, transport.context));
      if (current.kind === 'failed') throw new Error('Readable repository walk');
      identities.push(...current.observations.filter(observation => observation.kind === 'present')
        .map(observation => observation.localRef.collisionScope));
    }
    expect(identities).toEqual(['github:1', 'github:2']);
    expect(current.evidence).toEqual({ kind: 'walkFinished' });
    expect(transport.requests.filter(request => new URL(request.url).pathname === '/user/repos')).toHaveLength(2);
    // The directory row this same invocation just read with this credential is the
    // repository's identity proof; a second repository read would re-prove it.
    expect(transport.requests.filter(request => /^\/repos\/org\/repo-[12]$/u.test(new URL(request.url).pathname))).toHaveLength(0);
    expect(transport.requests.some(request => new URL(request.url).pathname.endsWith('/code-scanning/alerts'))).toBe(false);
  });

  it('pages ten thousand all-state native findings without issue-search ceilings or per-row detail reads', async () => {
    const nativeTotal = 10_000;
    const perRepositoryTotal = nativeTotal / 2;
    const secondRepositoryKey = `${GITHUB_FIXTURE_OWNER}/second-repository`.toLowerCase();
    const instance = configuredInstance({ scope: 'repository' });
    const enabled = { ...instance, configuration: { v: 1 as const, token: JSON.stringify({ v: 1,
      selection: { kind: 'selected', unitIds: [REPOSITORY_KEY, secondRepositoryKey] }, alerts: { dependabot: true, codeScanning: true } }) } };
    const transport = createStubGithubTransport({ respond: request => {
      const url = new URL(request.url);
      if (url.pathname === '/search/issues') return { status: 200, body: githubSearchResponse({ items: [] }) };
      if (url.pathname === `/repos/${secondRepositoryKey}`) return { status: 200, body: { id: 100, full_name: secondRepositoryKey } };
      if (url.pathname.endsWith('/code-scanning/alerts')) return { status: 403, body: { message: 'Resource not accessible' } };
      if (!url.pathname.endsWith('/dependabot/alerts')) return undefined;
      expect(url.searchParams.get('state')).toBe('open,dismissed,fixed,auto_dismissed');
      expect(url.searchParams.has('severity')).toBe(false);
      const perPage = Number(url.searchParams.get('per_page'));
      expect(perPage).toBeGreaterThan(0);
      expect(perPage).toBeLessThanOrEqual(64);
      const offset = Number(url.searchParams.get('after') ?? '0');
      const count = Math.min(perPage, perRepositoryTotal - offset);
      const next = new URL(url);
      next.searchParams.set('after', String(offset + count));
      return { status: 200,
        ...(offset + count < perRepositoryTotal ? { headers: { link: `<${next}>; rel="next"` } } : {}),
        body: Array.from({ length: count }, (_, index) => ({ number: offset + index + 1,
          state: ['open', 'dismissed', 'fixed', 'auto_dismissed'][(offset + index) % 4],
          created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
          security_advisory: { summary: `Finding ${offset + index + 1}`, severity: 'high' },
          dependency: { package: { name: 'package', ecosystem: 'npm' }, manifest_path: 'package.json' },
        })) };
    } });
    let page: Parameters<typeof scanGithubTriageSource>[0] = { v: 1, instance: enabled, page: { kind: 'initial', limit: 64 } };
    const seen: string[] = [];
    const nativeStates = new Set<string>();
    let result: TriageScanResultV1;
    do {
      result = TriageScanResultV1Schema.parse(await scanGithubTriageSource(page, transport.context));
      expect(result.kind).not.toBe('failed');
      if (result.kind === 'failed') throw new Error('Native scan must retain readable family');
      expect(result.observations.length).toBeLessThanOrEqual(64);
      for (const observation of result.observations) {
        if (observation.kind !== 'present') continue;
        seen.push(`${observation.localRef.collisionScope}/${observation.localRef.entryId}`);
        nativeStates.add(observation.snapshot.state.presentation);
      }
      if (result.kind === 'page') {
        page = { v: 1, instance: enabled, page: { kind: 'continuation', continuation: result.continuation } };
      }
    } while (result.kind === 'page');
    expect(new Set(transport.requests.filter(request => new URL(request.url).pathname.endsWith('/dependabot/alerts'))
      .map(request => new URL(request.url).searchParams.get('state')))).toEqual(new Set(['open,dismissed,fixed,auto_dismissed']));
    expect(transport.requests.filter(request => new URL(request.url).pathname.endsWith('/code-scanning/alerts'))
      .every(request => !new URL(request.url).searchParams.has('state'))).toBe(true);
    expect(seen).toHaveLength(nativeTotal);
    expect(new Set(seen).size).toBe(nativeTotal);
    expect(nativeStates).toEqual(new Set(['active', 'resolved', 'suppressed']));
    expect(result.evidence).toMatchObject({ kind: 'partial' });
    const paths = transport.requests.map(request => new URL(request.url).pathname);
    expect(paths.filter(path => path === '/user/repos')).toHaveLength(0);
    expect(paths.filter(path => path.endsWith('/code-scanning/alerts'))).toHaveLength(2);
    expect(paths.every(path => path === '/search/issues' || path === `/repos/${REPOSITORY_KEY}`
      || path === `/repos/${secondRepositoryKey}` || path.endsWith('/dependabot/alerts') || path.endsWith('/code-scanning/alerts'))).toBe(true);
  });

  it('does zero native discovery for legacy tokens', async () => {
    const transport = createStubGithubTransport({ respond: request => new URL(request.url).pathname === '/search/issues'
      ? { status: 200, body: githubSearchResponse({ items: [] }) } : undefined });
    const instance = configuredInstance({ scope: 'account' });
    let current = await scanGithubTriageSource({ v: 1, instance, page: { kind: 'initial', limit: 64 } }, transport.context);
    while (current.kind === 'page') current = await scanGithubTriageSource({ v: 1, instance,
      page: { kind: 'continuation', continuation: current.continuation } }, transport.context);
    expect(current).toMatchObject({ kind: 'complete', observations: [] });
    expect(transport.requests.every(request => new URL(request.url).pathname === '/search/issues')).toBe(true);
  });

  it('reads open work and recently closed task kinds through registered HTTP paging while ordinary scans stay open-only', async () => {
    const sinceMs = Date.parse('2026-10-19T00:00:00Z');
    const transport = createStubGithubTransport({ respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/graphql') return githubChecksBatchResponse(request);
      if (url.pathname !== '/search/issues') return undefined;
      const query = url.searchParams.get('q') ?? '';
      return { status: 200, body: githubSearchResponse({ items: query.includes('closed:>=2026-10-19') && query.includes('assignee:@me')
        ? [{ ...GITHUB_ISSUE_RESPONSE, state: 'closed', state_reason: 'completed', closed_at: '2026-10-20T09:00:00Z',
          repository_url: `https://api.github.com/repos/${REPOSITORY_KEY}` }] : [] }) };
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
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
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
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
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
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
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
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
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
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
    // One three-byte character past the display bound, so the row title must truncate.
    const issue = { ...GITHUB_ISSUE_RESPONSE, number: 7, title: '界'.repeat(Math.floor(MAX_TRIAGE_TEXT_UTF8_BYTES_V1 / 3) + 1), body,
      labels: [{ name: ' preserve label whitespace ' }], assignees: [{ login: 'octocat' }],
      url: `https://api.github.com/repos/${REPOSITORY_KEY}/issues/7`,
      repository_url: `https://api.github.com/repos/${REPOSITORY_KEY}`,
      html_url: `https://github.com/${REPOSITORY_KEY}/issues/7` };
    const transport = createStubGithubTransport({ respond: (request) => request.url.endsWith('/issues/7')
      ? { status: 200, body: issue } : undefined });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
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
  ])('preserves the PR and distinguishes $name Checks through the registered strict consumer', async ({ checkStatus, empty, headStatus, failureCode }) => {
    const transport = createStubGithubTransport({ respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/search/issues') return { status: 200, body: githubSearchResponse({
        items: /review-requested:|mentions:/u.test(url.searchParams.get('q') ?? '') ? [GITHUB_SEARCH_PULL_REQUEST_ITEM] : [],
      }) };
      if (url.pathname === '/graphql') return githubChecksBatchResponse(request, {
        reviewDecision: 'APPROVED',
        nodes: empty ? [] : [{ __typename: 'CheckRun', id: 'check-1', name: 'unit', status: 'COMPLETED',
          conclusion: 'FAILURE', isRequired: true, detailsUrl: null, startedAt: null, completedAt: null,
          checkSuite: { createdAt: '2026-08-10T11:59:59Z' } }],
        ...(headStatus === 403 ? { pullRequest: null, errors: [{ type: 'FORBIDDEN', path: ['row0', 'pullRequest'] }] }
          : checkStatus === 403 ? { pullRequest: { headRefOid: 'a'.repeat(40), reviewDecision: 'APPROVED', commits: null },
            errors: [{ type: 'FORBIDDEN', path: ['row0', 'pullRequest', 'commits'] }] } : {}),
      });
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
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
      expect(row.snapshot.facts.find(fact => fact.id === 'github/review-decision')?.value).toEqual(
        headStatus === 403 ? undefined : { kind: 'status', value: 'Approved', tone: 'success' },
      );
      expect(result.evidence).toEqual(failureCode === null
        ? { kind: 'walkFinished' } : { kind: 'partial', reason: failureCode });
      expect(transport.requests.filter((request) => new URL(request.url).pathname === '/graphql')).toHaveLength(1);
      expect(transport.materializeCount()).toBe(1);
    } finally {
      await plugin.dispose();
    }
  });

  it('keeps every searched lane when the page batch of optional Checks parks the account', async () => {
    const startedAtMs = 1_800_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAtMs);
    let batchReads = 0;
    const transport = createStubGithubTransport({ respond: (request): StubHttpResponse | undefined => {
      const url = new URL(request.url);
      if (url.pathname === '/search/issues') {
        const query = url.searchParams.get('q') ?? '';
        const review = query.includes('review-requested:');
        const first = url.searchParams.get('page') === '1';
        const next = new URL(url); next.searchParams.set('page', '2');
        return { status: 200, ...(review && first ? { headers: { link: `<${next}>; rel="next"` } } : {}),
          body: githubSearchResponse({ items: first && (review || query.includes('mentions:')) ? [GITHUB_SEARCH_PULL_REQUEST_ITEM] : [] }) };
      }
      if (url.pathname === '/graphql') return ++batchReads === 1
        ? { status: 429, headers: { 'retry-after': '60' }, body: { message: 'Too many requests' } }
        : githubChecksBatchResponse(request);
      return undefined;
    } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: transport.context.services.http, connectedAccounts: transport.context.services.connectedAccounts,
    } });
    try {
      const instance = configuredInstance({ scope: 'repository' });
      const invoke = async (page: TriageScanInputV1['page']) =>
        TriageScanResultV1Schema.parse(await plugin.invokeAction(GITHUB_TRIAGE_ACTION_IDS_V1.scan, { v: 1, instance, page },
          { surface: 'agent', sessionId: 'triage-audit-session' }));
      const first = await invoke({ kind: 'initial', limit: 200 });
      // The page's one Checks batch follows its last search, so the park refuses no
      // search: the walk finishes and every lane's rows survive as partial evidence.
      expect(first).toMatchObject({ kind: 'complete', evidence: { kind: 'partial', reason: 'github_rate_limited' },
        observations: [{ kind: 'present', localRef: { entryId: '1284' }, viewer: { involvement: ['reviewRequested'] } },
          { kind: 'present', localRef: { entryId: '1284' }, viewer: { involvement: ['mentioned'] } }] });
      if (first.kind === 'failed') throw new Error('Optional Checks must retain the searched rows');
      expect(first.observations[0]?.kind === 'present' && first.observations[0].snapshot.facts.find(fact => fact.id === 'github/checks')?.value)
        .toEqual({ kind: 'status', value: 'Checks unavailable', tone: 'warning' });
      const searches = transport.requests.filter(request => new URL(request.url).pathname === '/search/issues').map(request => new URL(request.url));
      expect(searches.map(url => [url.searchParams.get('q')?.split(' ').at(-1), url.searchParams.get('page')])).toEqual([
        ['review-requested:@me', '1'], ['assignee:@me', '1'], ['mentions:@me', '1'],
        ['reviewed-by:@me', '1'], ['author:@me', '1'], ['review-requested:@me', '2'],
      ]);
      expect(transport.requests.at(-1)?.url).toContain('/graphql');
      expect(batchReads).toBe(1);
      expect(transport.materializations.every(materialization => materialization.account.accountId === CONFIGURED_ACCOUNT.accountId)).toBe(true);
    } finally {
      await plugin.dispose();
      clock.mockRestore();
    }
  });

  it('projects provider responses through the real registered get Action into the strict target schema', async () => {
    let response: Readonly<Record<string, unknown>> = { ...GITHUB_PULL_REQUEST_RESPONSE, title: 'Fix café 🧪'.repeat(500) };
    const transport = createStubGithubTransport({ respond: (request) => (
      request.url.endsWith('/pulls/1284') ? { status: 200, body: response } : undefined
    ) });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
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
      if (new URL(request.url).pathname === '/graphql') return githubChecksBatchResponse(request);
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
    const stub = createStubGithubTransport({ binding: null, respond: () => undefined });
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
      binding: null,
      nativeMaterialization: { kind: 'httpHeaders', headers: { Authorization: `Bearer ${nativeToken}` } },
      respond: (request) => new URL(request.url).pathname === '/graphql' ? githubChecksBatchResponse(request)
        : request.url.startsWith('https://api.github.com/search/issues')
        ? { status: 200, body: githubSearchResponse({ items: [GITHUB_SEARCH_PULL_REQUEST_ITEM] }) }
        : undefined,
    });
    const instance = {
      ...configuredInstance({ scope: 'repository' }),
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native' as const, service: CONFIGURED_ACCOUNT.service },
    };

    const result = await scanGithubTriageSource({ v: 1, instance, page: { kind: 'initial', limit: 64 } }, stub.context);

    expect(result.kind).toBe('complete');
    expect(stub.requests[0]?.headers.Authorization).toBe(`Bearer ${nativeToken}`);
    expect(stub.materializations).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(nativeToken);
    expect(JSON.stringify(instance)).not.toContain(nativeToken);
  });

  it('refuses explicit machine login while the host purpose still selects an Account', async () => {
    const nativeMaterialization = vi.fn((): never => { throw new Error('A selected Account cannot grant native materialization'); });
    const stub = createStubGithubTransport({ nativeMaterialization, respond: () => undefined });
    const instance = {
      ...configuredInstance({ scope: 'repository' }),
      binding: { purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE, source: 'native' as const, service: CONFIGURED_ACCOUNT.service },
    };
    expect(await openGithubTriageClient(instance, stub.context)).toEqual({ ok: false,
      failure: { class: 'authentication', code: 'github_credential_mismatch' } });
    expect(nativeMaterialization).not.toHaveBeenCalled();
    expect(stub.requests).toEqual([]);
  });

  it('projects a GitHub scan onto the strict source ABI as one settled result with no continuation', async () => {
    const stub = searchTransport();

    const result = await scanGithubTriageSource({
      v: 1,
      instance: configuredInstance({ scope: 'repository' }),
      page: { kind: 'initial', limit: 64 },
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(() => TriageScanResultV1Schema.parse(result)).not.toThrow();
    // All five short initial lane pages fit; the source preserves each involvement encounter.
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') throw new Error('expected the completed source walk');
    expect(result.observations).toHaveLength(5);
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
    expect(result.evidence).toEqual({ kind: 'walkFinished' });
    expect(stub.requests.filter((request) => new URL(request.url).pathname === '/search/issues')).toHaveLength(5);
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

  it.each([
    ['AbortError', Object.assign(new Error('cancelled'), { name: 'AbortError' })],
    ['typed host refusal', new PluginError({
      code: 'credential_scope_denied',
      details: { requestId: 'review-workspace-host-request', scope: 'scm' },
      remediation: { kind: 'openSettings', path: 'connected-accounts' },
    })],
  ])('propagates SCM %s from both preparation and final verification', async (_kind, failure) => {
    const stub = createStubGithubTransport({
      respond: (request): StubHttpResponse | undefined => request.url.endsWith(
        `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`,
      ) ? {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: GITHUB_FORK_PULL_REQUEST_RESPONSE,
        } : undefined,
    });
    const execute = vi.fn(async () => {
      throw failure;
    });
    const context = {
      ...stub.context,
      services: { ...stub.context.services, actions: { execute } },
    } as unknown as PluginInvocationContext;

    await expect(prepareGithubTriageReviewWorkspace(
      prepareWorkspaceInput({}),
      context,
      { now: fixedClock(1_700_000_000_000) },
    )).rejects.toBe(failure);
    await expect(verifyGithubTriageReviewWorkspace(
      verifyWorkspaceInput(),
      context,
      { now: fixedClock(1_700_000_000_000) },
    )).rejects.toBe(failure);
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
      failure: { class: 'unsupportedContract', code: 'github_scan_continuation_unrecognized' },
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
      page: { kind: 'initial', limit: 1 },
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
      lastKnownLocator,
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    expect(result).toEqual({
      kind: 'unresolved',
      localRef,
      failure: { class: 'unknown', code: 'github_locator_unusable' },
    });
    expect(stub.requests).toHaveLength(0);
    expect(stub.materializations).toHaveLength(0);
  });

  it('answers unresolved without an outbound call when the locator-free ref has no GitHub repository identity', async () => {
    const stub = searchTransport();
    const localRef = {
      kindId: 'pull-request',
      collisionScope: 'unknown-repository',
      entryId: '1284',
    } as const;

    const result = await getGithubTriageEntry({
      v: 1,
      instance: configuredInstance({ scope: 'account' }),
      localRef,
    }, stub.context, { now: fixedClock(1_700_000_000_000) });

    // Neither configuration nor display text supplies a missing repository identity.
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
