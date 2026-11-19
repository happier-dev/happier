import {
  decodeTriagePagingTokenV1,
  encodeTriagePagingTokenV1,
  TriageGetResultV1Schema,
  TriageListScopeUnitsResultV1Schema,
  TriageScanResultV1Schema,
  type TriageConfiguredSourceInstanceV1,
  type TriageEntryLocatorV1,
  type TriageGetResultV1,
  type TriageScanInputV1,
  type TriageSourceEntryLocalRefV1,
  type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { activate } from '../activate.js';
import { activate as activateAccount } from '../accountRuntime.js';
import { PLUGIN_MANIFEST } from '../manifest.js';

import issueList from './__fixtures__/issueList.json' with { type: 'json' };
import mergeRequestList from './__fixtures__/mergeRequestList.json' with { type: 'json' };
import { GITLAB_CONFIGURATION_RECORD_V1, encodeGitlabConfiguration } from './configuration.js';
import { GITLAB_CONNECTED_ACCOUNT_PURPOSE, GITLAB_TRIAGE_ACTION_IDS } from './contribution.js';
import type { GitlabConnectedAccounts, GitlabHttpResponse } from './http/gitlabClient.js';
import { createGitlabResponseHeaders } from './http/gitlabHeaders.js';
import { getGitlabTriageEntry } from './sourceGet.js';
import { scanGitlabTriageSource } from './sourceScan.js';

const NOW_MS = 1_764_000_000_000;
const SERVICE = Object.freeze({
  pluginId: 'happier.scm.forge.gitlab',
  localId: 'gitlab-account',
});
const ACCOUNT = Object.freeze({ service: SERVICE, accountId: 'account-1' });
const OTHER_ACCOUNT = Object.freeze({ service: SERVICE, accountId: 'account-2' });
const VIEWER = { id: 41, username: 'example-user' };
/** `gitlab:base64url('https://gitlab.com'):3` — the fixture's project. */
const PROJECT_SCOPE = `gitlab:${Buffer.from('https://gitlab.com', 'utf8').toString('base64url')}:3`;
const REPOSITORY_KEY = 'example-group/example-subgroup/example-project';
const ENCODED_REPOSITORY_KEY = encodeURIComponent(REPOSITORY_KEY);

function configuredInstance(overrides: Partial<TriageConfiguredSourceInstanceV1> = {}) {
  return {
    v: 1,
    instance: {
      source: { pluginId: 'happier.scm.forge.gitlab', localId: 'gitlab-forge' },
      sourceInstanceId: '9d6f0b2a-3c41-4d7e-9a52-8c1f4b7d2e03',
    },
    binding: { purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
    localInstanceKey: 'https://gitlab.com',
    configuration: encodeGitlabConfiguration(GITLAB_CONFIGURATION_RECORD_V1),
    ...overrides,
  } as TriageConfiguredSourceInstanceV1;
}

type RouteResponse = Readonly<{ status?: number; body?: unknown; headers?: Readonly<Record<string, string>> }>;

/**
 * The provider transport is the one genuine system boundary here. Every mapper,
 * lane builder, frontier, identity builder and result projection below it runs
 * for real.
 */
const SELF_MANAGED_BASE = 'https://gitlab.example.test/Corp/GitLab';
const PUBLISHED_BASES = [
  'https://gitlab.com',
  SELF_MANAGED_BASE,
] as const;

function harness(
  routes: Readonly<Record<string, RouteResponse>>,
  options: Readonly<{
    publishedBases?: readonly string[] | (() => readonly string[]);
    onMaterialize?: () => void;
  }> = {},
) {
  const requested: string[] = [];
  const fetcher = vi.fn(async (url: string): Promise<GitlabHttpResponse> => {
    requested.push(url);
    const path = new URL(url).pathname;
    const match = routes[`${path}${new URL(url).search}`] ?? routes[path];
    if (match === undefined) {
      return {
        status: 404,
        statusText: '',
        headers: createGitlabResponseHeaders({}),
        text: async () => '{"message":"404 Not found"}',
      };
    }
    return {
      status: match.status ?? 200,
      statusText: '',
      headers: createGitlabResponseHeaders(match.headers ?? {}),
      text: async () => JSON.stringify(match.body ?? null),
    };
  });
  const materializeListedAccount = vi.fn(async (_request: Readonly<{
    purpose: string;
    account: Readonly<{ service: Readonly<{ pluginId: string; localId: string }>; accountId: string }>;
    materialization: Readonly<{ kind: string; origin?: string; headerNames?: readonly string[] }>;
  }>) => {
    options.onMaterialize?.();
    return {
      kind: 'httpHeaders' as const,
      headers: { Authorization: 'Bearer test-only-not-a-real-token' },
    };
  });
  const listAccounts = vi.fn(async () => ({
    status: 'complete' as const,
    accounts: [ACCOUNT, OTHER_ACCOUNT].map((account) => ({
      account,
      displayName: `@${account.accountId}`,
      state: 'connected' as const,
      connectedAccountOrigins: ['https://gitlab.com', 'https://gitlab.example.test'],
      connectedAccountBases: typeof options.publishedBases === 'function'
        ? options.publishedBases()
        : options.publishedBases ?? PUBLISHED_BASES,
    })),
  }));
  return {
    fetcher,
    requested,
    materializeListedAccount,
    connectedAccounts: { listAccounts, materializeListedAccount } as unknown as
      GitlabConnectedAccounts,
  };
}

type ScanSeam = ReturnType<typeof harness>;
it('refuses unsupported scan sorting before acquiring credentials', async () => {
  const seam = harness({ '/api/v4/user': { body: VIEWER } });
  const result = await scanGitlabTriageSource({ connectedAccounts: seam.connectedAccounts,
    fetcher: seam.fetcher, signal: new AbortController().signal, nowMs: NOW_MS,
    scan: { instance: configuredInstance(), sort: { field: 'due', direction: 'asc' }, page: { kind: 'initial', limit: 2 } } });
  expect(result).toMatchObject({ kind: 'failed', failure: { class: 'unsupportedContract', code: 'unsupported-sort' } });
  expect(seam.materializeListedAccount).not.toHaveBeenCalled();
});


it.each([{ field: 'updated', direction: 'asc' }, { field: 'updated', direction: 'desc' },
  { field: 'created', direction: 'asc' }, { field: 'created', direction: 'desc' }] as const)('orders $field $direction across native involvement lanes before returning source pages', async ({ field, direction }) => {
  const seam = harness({});
  seam.fetcher.mockImplementation(async (rawUrl: string) => {
    seam.requested.push(rawUrl);
    const url = new URL(rawUrl);
    if (url.pathname.endsWith('/user')) return { status: 200, statusText: '', headers: createGitlabResponseHeaders({}), text: async () => JSON.stringify(VIEWER) };
    expect(url.searchParams.get('per_page')).toBe('2');
    expect(url.searchParams.get('order_by')).toBe(field === 'updated' ? 'updated_at' : 'created_at');
    expect(url.searchParams.get('sort')).toBe(direction);
    const values = url.pathname.endsWith('/merge_requests')
      ? url.searchParams.get('scope') === 'created_by_me' ? [1, 4, 5, 8]
        : url.searchParams.get('scope') === 'assigned_to_me' ? [2, 3, 6, 7] : []
      : [];
    const sorted = direction === 'asc' ? values : values.slice().reverse();
    const page = Number(url.searchParams.get('page') ?? '1');
    const next = new URL(url); next.searchParams.set('page', String(page + 1));
    return { status: 200, statusText: '', headers: createGitlabResponseHeaders(page === 1 && values.length > 0 ? { Link: `<${next}>; rel="next"` } : {}),
      text: async () => JSON.stringify(sorted.slice((page - 1) * 2, page * 2).map(value => ({
        ...mergeRequestList[0], iid: 100 - value,
        [field === 'updated' ? 'updated_at' : 'created_at']: new Date(value * 1000).toISOString(),
      }))) };
  });
  const input = { connectedAccounts: seam.connectedAccounts, fetcher: seam.fetcher,
    signal: new AbortController().signal, nowMs: NOW_MS };
  const scan = { instance: configuredInstance(), sort: { field, direction } };
  const first = await scanGitlabTriageSource({ ...input, scan: { ...scan, page: { kind: 'initial', limit: 12 } } });
  expect(first.kind).toBe('page');
  if (first.kind !== 'page') throw new Error('expected retained lane heads');
  expect(first.observations.map(row => row.kind === 'present' && row.localRef.entryId))
    .toEqual(direction === 'asc' ? ['99', '98', '97'] : ['92', '93', '94']);
  expect(seam.requested.filter(url => !url.endsWith('/user'))).toHaveLength(6);
  const second = await scanGitlabTriageSource({ ...input, scan: { ...scan,
    page: { kind: 'continuation', continuation: first.continuation } } });
  expect(second.kind).toBe('complete');
  if (second.kind === 'failed') throw new Error(second.failure.code);
  expect(second.observations.map(row => row.kind === 'present' && row.localRef.entryId))
    .toEqual(direction === 'asc' ? ['96', '95', '94', '93', '92'] : ['95', '96', '97', '98', '99']);
  expect(seam.requested.filter(url => !url.endsWith('/user'))).toHaveLength(8);
});

it('merges all selected project heads in the same sorted GitLab source frontier', async () => {
  const seam = harness({});
  seam.fetcher.mockImplementation(async (rawUrl: string) => {
    seam.requested.push(rawUrl);
    const url = new URL(rawUrl);
    const page = Number(url.searchParams.get('page') ?? '1');
    const value = url.pathname.endsWith('/merge_requests') && url.searchParams.get('scope') === 'created_by_me'
      ? (url.pathname.includes('/projects/3/') ? 3 : 0) + page : null;
    const next = new URL(url); next.searchParams.set('page', String(page + 1));
    return { status: 200, statusText: '', headers: createGitlabResponseHeaders(value !== null && page === 1 ? { Link: `<${next}>; rel="next"` } : {}),
      text: async () => JSON.stringify(url.pathname.endsWith('/user') ? VIEWER : value === null ? [] : [{
        ...mergeRequestList[0], project_id: url.pathname.includes('/projects/3/') ? 3 : 4,
        iid: 100 - value, updated_at: new Date(value * 1000).toISOString(),
      }]) };
  });
  const scan = { instance: configuredInstance({ configuration: encodeGitlabConfiguration({ v: 1,
    selection: { kind: 'selected', unitIds: ['3', '4'] } })! }), sort: { field: 'updated' as const, direction: 'asc' as const } };
  const input = { connectedAccounts: seam.connectedAccounts, fetcher: seam.fetcher,
    signal: new AbortController().signal, nowMs: NOW_MS };
  const first = await scanGitlabTriageSource({ ...input, scan: { ...scan, page: { kind: 'initial', limit: 12 } } });
  expect(first.kind).toBe('page');
  if (first.kind !== 'page') throw new Error('expected project frontier continuation');
  expect(first.observations.map(row => row.kind === 'present' && row.localRef.entryId)).toEqual(['99']);
  expect(seam.requested.filter(url => !url.endsWith('/user'))).toHaveLength(12);
  const replay = await scanGitlabTriageSource({ ...input, scan: { ...scan, sort: { field: 'updated', direction: 'desc' },
    page: { kind: 'continuation', continuation: first.continuation } } });
  expect(replay).toMatchObject({ kind: 'failed', failure: { code: 'unknown-continuation' } });
  expect(seam.requested.filter(url => !url.endsWith('/user'))).toHaveLength(12);
  const record = decodeTriagePagingTokenV1(first.continuation.token);
  if (!record || !Array.isArray(record.lanes)) throw new Error('expected native lane frontier');
  const lane = record.lanes[0] as { nextUrl: string };
  lane.nextUrl = lane.nextUrl.replace('sort=asc', 'sort=desc');
  const tampered = encodeTriagePagingTokenV1(record);
  if (tampered === null) throw new Error('expected fitting frontier');
  const changedNativeOrder = await scanGitlabTriageSource({ ...input, scan: { ...scan,
    page: { kind: 'continuation', continuation: { v: 1, token: tampered } } } });
  expect(changedNativeOrder).toMatchObject({ kind: 'failed', failure: { code: 'unknown-continuation' } });
  expect(seam.requested.filter(url => !url.endsWith('/user'))).toHaveLength(12);
  const second = await scanGitlabTriageSource({ ...input, scan: { ...scan,
    page: { kind: 'continuation', continuation: first.continuation } } });
  expect(second.kind).toBe('complete');
  if (second.kind === 'failed') throw new Error(second.failure.code);
  expect(second.observations.map(row => row.kind === 'present' && row.localRef.entryId)).toEqual(['98', '96', '95']);
  expect(seam.requested.filter(url => !url.endsWith('/user'))).toHaveLength(14);
});

it('searches the exact self-managed base through Account activation without a Machine and keeps pagination bound to that directory', async () => {
  const seam = harness({});
  const requested: string[] = [];
  const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
    connectedAccounts: seam.connectedAccounts,
    http: { request: async ({ url }) => {
      requested.push(url);
      const parsed = new URL(url);
      expect(parsed.pathname).toBe('/Corp/GitLab/api/v4/projects');
      expect(parsed.searchParams.get('search')).toBe('platform');
      const second = parsed.searchParams.get('page') === '2';
      const next = new URL(parsed); next.searchParams.set('page', '2');
      const headers: Readonly<Record<string, string>> = second ? {} : { link: `<${next}>; rel="next"` };
      return { status: 200, headers, body: new TextEncoder().encode(JSON.stringify([
        { id: second ? 22 : 11, path_with_namespace: second ? 'platform/api' : 'platform/app', name: second ? 'API' : 'App' },
      ])) };
    } },
  } });
  const draft = { v: 1, binding: { purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT },
    localInstanceKey: SELF_MANAGED_BASE, keyStability: 'locatorDerived',
    configuration: { v: 1, token: '{"v":1}' }, locator: { v: 1, displayLabel: 'Self-managed account' } };
  try {
    const first = TriageListScopeUnitsResultV1Schema.parse(await plugin.invokeAction('triage/list-gitlab-scope-units', {
      v: 1, draft, query: 'platform',
    }, { surface: 'agent', sessionId: 'directory-session' }));
    expect(first).toMatchObject({ kind: 'page', status: 'partial', units: [{ id: '11', label: 'platform/app' }] });
    if (first.kind !== 'page' || first.status !== 'partial' || first.nextCursor === undefined) throw new Error('Expected directory continuation');
    expect(await plugin.invokeAction('triage/list-gitlab-scope-units', {
      v: 1, draft, query: 'platform', cursor: first.nextCursor,
    }, { surface: 'agent', sessionId: 'directory-session' })).toMatchObject({ kind: 'page', status: 'complete', units: [{ id: '22' }] });
    const count = requested.length;
    expect(count).toBe(2);
    expect(await plugin.invokeAction('triage/list-gitlab-scope-units', {
      v: 1, draft, query: 'different query', cursor: first.nextCursor,
    }, { surface: 'agent', sessionId: 'directory-session' })).toMatchObject({ kind: 'failed', failure: { class: 'unsupportedContract' } });
    expect(requested).toHaveLength(count);
  } finally { await plugin.dispose(); }
});

it('projects configured GitLab projects through its admitted Action without credential or provider reads', async () => {
  const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount } });
  const selection = { kind: 'selected', unitIds: ['11', '22'] };
  const units = [{ id: '11', label: 'group/app' }, { id: '22', label: 'group/api' }];
  try {
    const result = await plugin.invokeAction('triage/list-gitlab-scope-units', { v: 1, mode: 'configured', draft: {
      v: 1, binding: { purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE, account: ACCOUNT }, localInstanceKey: 'https://gitlab.com',
      keyStability: 'locatorDerived', configuration: { v: 1, token: JSON.stringify({ v: 1, selection, units }) },
      locator: { v: 1, displayLabel: 'GitLab account' },
    } }, { surface: 'agent', sessionId: 'source-selection-session' });
    expect(result).toMatchObject({ kind: 'page', status: 'complete', selection, units: units.map((unit) => ({ ...unit,
      collisionScope: `gitlab:${Buffer.from('https://gitlab.com', 'utf8').toString('base64url')}:${unit.id}`,
    })) });
  } finally { await plugin.dispose(); }
});

it('scans every selected GitLab project through project-scoped provider lanes', async () => {
  const seam = harness({ '/api/v4/user': { body: VIEWER },
    '/api/v4/projects/11/issues': { body: [] }, '/api/v4/projects/11/merge_requests': { body: [] },
    '/api/v4/projects/22/issues': { body: [] }, '/api/v4/projects/22/merge_requests': { body: [] },
  });
  const instance = configuredInstance({ configuration: { v: 1,
    token: JSON.stringify({ v: 1, selection: { kind: 'selected', unitIds: ['11', '22'] } }),
  } });
  let page: TriageScanInputV1['page'] = { kind: 'initial', limit: 64 };
  for (let step = 0; step < 4; step += 1) {
    const result: TriageScanResultV1 = TriageScanResultV1Schema.parse(await scanGitlabTriageSource({
      scan: { v: 1, instance, page }, connectedAccounts: seam.connectedAccounts,
      fetcher: seam.fetcher, signal: new AbortController().signal, nowMs: NOW_MS,
    }));
    expect(result.kind).not.toBe('failed');
    if (result.kind !== 'page') break;
    page = { kind: 'continuation', continuation: result.continuation };
  }
  const paths = seam.requested.map((url) => new URL(url).pathname).filter((path) => path !== '/api/v4/user');
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every((path) => /^\/api\/v4\/projects\/(11|22)\/(issues|merge_requests)$/u.test(path))).toBe(true);
  expect(paths.some((path) => path.includes('/11/'))).toBe(true);
  expect(paths.some((path) => path.includes('/22/'))).toBe(true);
});

async function scanPage(
  seam: ScanSeam,
  page: TriageScanInputV1['page'],
): Promise<TriageScanResultV1> {
  // The published input is a two-arm union, so each arm is built in its own branch
  // rather than widened into one object literal.
  const scan: TriageScanInputV1 = page.kind === 'initial'
    ? { v: 1, instance: configuredInstance(), page }
    : { v: 1, instance: configuredInstance(), page };
  return TriageScanResultV1Schema.parse(await scanGitlabTriageSource({
    scan,
    connectedAccounts: seam.connectedAccounts,
    fetcher: seam.fetcher,
    signal: new AbortController().signal,
    nowMs: NOW_MS,
  })) as TriageScanResultV1;
}

/**
 * Drives one refresh the way the aggregate does: serially, from `initial` through
 * every continuation the source hands back, until the walk completes. The bound is a
 * test guard against a source that pages forever, not a contract limit.
 */
async function walkScan(
  seam: ScanSeam,
  limit: number,
): Promise<readonly TriageScanResultV1[]> {
  const pages: TriageScanResultV1[] = [];
  let next: TriageScanInputV1['page'] = { kind: 'initial', limit };
  for (let call = 0; call < 24; call += 1) {
    const result = await scanPage(seam, next);
    pages.push(result);
    if (result.kind !== 'page') return pages;
    next = { kind: 'continuation', continuation: result.continuation };
  }
  throw new Error('the walk never settled');
}

describe('GitLab scan', () => {
  it('refuses a native credential binding before account or provider access', async () => {
    const seam = harness({});
    const result = await scanGitlabTriageSource({
      scan: {
        v: 1,
        instance: configuredInstance({ binding: {
          purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
          source: 'native',
          service: SERVICE,
        } }),
        page: { kind: 'initial', limit: 32 },
      },
      connectedAccounts: seam.connectedAccounts,
      fetcher: seam.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({ kind: 'failed', failure: { class: 'unsupportedContract' } });
    expect(seam.materializeListedAccount).not.toHaveBeenCalled();
    expect(seam.fetcher).not.toHaveBeenCalled();
  });

  it('reauthorizes and materializes only the configured instance binding', async () => {
    const seam = harness({
      '/api/v4/user': { body: VIEWER },
      '/api/v4/merge_requests': { body: mergeRequestList },
    });

    const result = TriageScanResultV1Schema.parse(await scanGitlabTriageSource({
      scan: {
        v: 1,
        instance: configuredInstance({
          binding: { purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE, account: OTHER_ACCOUNT },
        }),
        page: { kind: 'initial', limit: 32 },
      },
      connectedAccounts: seam.connectedAccounts,
      fetcher: seam.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    })) as TriageScanResultV1;

    // `limit` is one page, and the lanes this call did not reach are still open.
    expect(result.kind).toBe('page');
    expect(seam.materializeListedAccount).toHaveBeenCalledTimes(1);
    expect(seam.materializeListedAccount.mock.calls[0]?.[0]).toEqual({
      purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
      // The exact account the configured instance names, never a selected or
      // default binding for the purpose.
      account: OTHER_ACCOUNT,
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://gitlab.com',
        headerNames: ['authorization'],
      },
    });
  });

  it('maps GitLab merge requests into GitLab-vocabulary observations with lane involvement', async () => {
    const seam = harness({
      '/api/v4/user': { body: VIEWER },
      '/api/v4/merge_requests': { body: mergeRequestList },
    });

    const result = TriageScanResultV1Schema.parse(await scanGitlabTriageSource({
      scan: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 32 } },
      connectedAccounts: seam.connectedAccounts,
      fetcher: seam.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    })) as TriageScanResultV1;

    if (result.kind !== 'page') throw new Error(`expected page, got ${result.kind}`);
    const first = result.observations[0];
    if (first?.kind !== 'present') throw new Error('expected a present observation');
    expect(first.localRef).toEqual({
      kindId: 'merge-request',
      collisionScope: PROJECT_SCOPE,
      // The per-project internal id, which is what `!7` means — never the
      // instance-global id, which addresses nothing project-scoped.
      entryId: '7',
    });
    // The first lane is `scope=created_by_me`, whose canonical fact is `author`.
    // A native lane id never crosses the boundary.
    expect(first.viewer.involvement).toEqual(['author']);
    // A native lane id never reaches an observation. The source's own opaque
    // continuation token is a different thing: the aggregate copies it back without
    // parsing it, and the validated provider URLs inside it are the frontier itself.
    const published = JSON.stringify(result.observations);
    expect(published).not.toContain('created_by_me');
    expect(published).not.toContain('authored');
    expect(first.snapshot.scopeLabel).toContain('/');
    expect(first.snapshot).toMatchObject({
      scopeLabel: REPOSITORY_KEY,
      scopeDisplayName: 'example-project',
    });
    expect(first.locator.routingToken).toBe(first.snapshot.scopeLabel);
  });

  it('never claims more than a finished walk and never concludes absence', async () => {
    const seam = harness({
      '/api/v4/user': { body: VIEWER },
      '/api/v4/merge_requests': { body: mergeRequestList, headers: { 'X-Total': '9999999' } },
      '/api/v4/issues': { body: issueList },
    });

    const pages = await walkScan(seam, 32);
    const settled = pages[pages.length - 1];
    if (settled?.kind !== 'complete') throw new Error('expected the walk to settle complete');
    expect(['walkFinished', 'partial']).toContain(settled.evidence.kind);
    // `walkFinished` is a claim that the walk ended, so no page arm may carry it.
    for (const page of pages.slice(0, -1)) {
      if (page.kind !== 'page') throw new Error('expected page arms before the settlement');
      expect(page.evidence.kind).not.toBe('walkFinished');
    }
    expect(JSON.stringify(pages)).not.toContain('absent');
    // Advisory totals are absent above 10,000 records by GitLab's own
    // statement, so no completeness claim may read them. The check is scoped to
    // the two places a completeness claim can live — the evidence arm and the
    // continuation the walk resumes from — rather than to the whole encoded
    // result: an observation legitimately carries provider commit ids, and a
    // whole-output substring match would pass or fail on a fixture's `sha`.
    const claims = JSON.stringify(pages.map((page) => ({
      evidence: page.evidence,
      continuation: page.kind === 'page' ? page.continuation : undefined,
    })));
    expect(claims).not.toContain('9999999');
  });

  it('still reports a row it skipped on the first page when the last page settles', async () => {
    // The sticky rule of `sources/SCM.md` §2.8b. The walk observed one undecodable row
    // on its FIRST lane; every later lane is clean. A per-call-only health arm reports
    // `walkFinished` at the settlement and tells the user the inbox is whole.
    const seam = harness({
      '/api/v4/user': { body: VIEWER },
      '/api/v4/merge_requests': { body: [{ nope: true }, ...mergeRequestList] },
      '/api/v4/issues': { body: issueList },
    });

    const pages = await walkScan(seam, 4);
    const settled = pages[pages.length - 1];
    if (settled?.kind !== 'complete') throw new Error('expected the walk to settle complete');
    expect(settled.evidence).toMatchObject({ kind: 'partial', reason: 'undecodable-items' });
    // Names travel across pages; counts do not. The settling page returned no
    // undecodable row of its own, so it reports no count for one.
    expect(settled.evidence.kind === 'partial' ? settled.evidence.omittedItemCount : 0)
      .toBeUndefined();
  });

  it('refuses a continuation whose sticky health it does not recognize', async () => {
    const seam = harness({
      '/api/v4/user': { body: VIEWER },
      '/api/v4/merge_requests': { body: mergeRequestList },
      '/api/v4/issues': { body: issueList },
    });
    const first = await scanPage(seam, { kind: 'initial', limit: 4 });
    if (first.kind !== 'page') throw new Error('expected a page');
    const tampered = JSON.parse(first.continuation.token) as Record<string, unknown>;
    tampered.walkHealth = ['invented-reason'];

    const resumed = await scanPage(seam, {
      kind: 'continuation',
      continuation: { v: 1, token: JSON.stringify(tampered) },
    });

    // A dropped caveat is how a truncated walk comes back looking finished, so an
    // unrecognized reason restarts the walk rather than being silently ignored.
    expect(resumed).toMatchObject({
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'unknown-continuation' },
    });
  });

  it('refuses a continuation it did not mint rather than resuming a foreign walk', async () => {
    const seam = harness({ '/api/v4/user': { body: VIEWER } });
    const result = await scanGitlabTriageSource({
      scan: {
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'continuation', continuation: { v: 1, token: 'not-ours' } },
      },
      connectedAccounts: seam.connectedAccounts,
      fetcher: seam.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });

    expect(result).toEqual({
      kind: 'failed',
      failure: {
        class: 'unsupportedContract',
        code: 'unknown-continuation',
        detail: expect.any(String),
      },
    });
    // The invocation reads its own account identity, which the lane set depends on, and
    // then refuses. No lane page of a walk it cannot own is ever requested.
    expect(seam.requested.filter((url) => !url.endsWith('/api/v4/user'))).toEqual([]);
  });

  it('routes a self-managed configured base path through the normal scan owner', async () => {
    const seam = harness({
      '/Corp/GitLab/api/v4/user': { body: VIEWER },
      '/Corp/GitLab/api/v4/merge_requests': { body: mergeRequestList },
    });
    const result = await scanGitlabTriageSource({
      scan: {
        v: 1,
        instance: configuredInstance({
          localInstanceKey: 'https://gitlab.example.test/Corp/GitLab',
        }),
        page: { kind: 'initial', limit: 32 },
      },
      connectedAccounts: seam.connectedAccounts,
      fetcher: seam.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({ kind: 'page' });
    expect(seam.materializeListedAccount).toHaveBeenCalledWith(expect.objectContaining({
      materialization: {
        kind: 'httpHeaders',
        origin: 'https://gitlab.example.test',
        headerNames: ['authorization'],
      },
    }), expect.anything());
    expect(seam.requested).toEqual([
      'https://gitlab.example.test/Corp/GitLab/api/v4/user',
      expect.stringContaining('https://gitlab.example.test/Corp/GitLab/api/v4/merge_requests?'),
    ]);
    expect(seam.requested.every((url) => (
      url.startsWith('https://gitlab.example.test/Corp/GitLab/api/v4/')
    ))).toBe(true);
  });

  it('refuses a configured path the credential-bearing account does not publish', async () => {
    const seam = harness({}, {
      publishedBases: ['https://gitlab.example.test/Other/GitLab'],
    });
    const result = await scanGitlabTriageSource({
      scan: {
        v: 1,
        instance: configuredInstance({ localInstanceKey: SELF_MANAGED_BASE }),
        page: { kind: 'initial', limit: 32 },
      },
      connectedAccounts: seam.connectedAccounts,
      fetcher: seam.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'configured-base-stale' },
    });
    expect(seam.materializeListedAccount).not.toHaveBeenCalled();
    expect(seam.fetcher).not.toHaveBeenCalled();
  });

  it('reconfirms the exact configured path after credential materialization', async () => {
    let publishedBases: readonly string[] = [SELF_MANAGED_BASE];
    const seam = harness({}, {
      publishedBases: () => publishedBases,
      onMaterialize: () => {
        publishedBases = ['https://gitlab.example.test/Other/GitLab'];
      },
    });
    const result = await scanGitlabTriageSource({
      scan: {
        v: 1,
        instance: configuredInstance({ localInstanceKey: SELF_MANAGED_BASE }),
        page: { kind: 'initial', limit: 32 },
      },
      connectedAccounts: seam.connectedAccounts,
      fetcher: seam.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'configured-base-stale' },
    });
    expect(seam.materializeListedAccount).toHaveBeenCalledTimes(1);
    expect(seam.fetcher).not.toHaveBeenCalled();
  });

  it('walks GitLab merge-request and issue lanes to exhaustion across continuation pages', async () => {
    const seam = harness({
      '/api/v4/user': { body: VIEWER },
      '/api/v4/merge_requests': { body: mergeRequestList },
      '/api/v4/issues': { body: issueList },
    });

    // One refresh, driven serially exactly as the aggregate drives it. A source that
    // declares the whole account finished in one call spends the budget on
    // `scope=created_by_me` and never reaches another lane, in this refresh or any
    // later one — the frontier it discarded restarts at that same first lane.
    const pages = await walkScan(seam, 32);

    const settled = pages[pages.length - 1];
    if (settled?.kind !== 'complete') throw new Error('expected the walk to settle complete');
    for (const page of pages.slice(0, -1)) {
      expect(page.kind).toBe('page');
    }

    const lanePages = seam.requested.filter((url) => !url.endsWith('/api/v4/user'));
    // Every declared lane of BOTH kinds ran inside this one refresh.
    expect(lanePages.filter((url) => url.includes('scope=created_by_me'))).toHaveLength(2);
    expect(lanePages.filter((url) => url.includes('scope=assigned_to_me'))).toHaveLength(2);
    expect(lanePages.filter((url) => url.includes('scope=reviews_for_me'))).toHaveLength(1);
    expect(lanePages.filter((url) => url.includes('approved_by_ids'))).toHaveLength(1);
    // Round-robin, not lane-at-a-time: the second call moved on rather than deep-paging
    // the lane the first call started.
    expect(lanePages[0]).toContain('scope=created_by_me');
    expect(lanePages[1]).not.toContain('scope=created_by_me');

    const involvements = new Set(pages.flatMap((page) =>
      page.kind === 'failed'
        ? []
        : page.observations.flatMap((observation) =>
          observation.kind === 'present' ? observation.viewer.involvement : [])));
    // `subscribed` is the item-level fact GitLab returned on a row, not a lane: GitLab
    // publishes no subscribed list filter, and none is simulated here.
    expect(involvements).toEqual(
      new Set(['author', 'assignee', 'reviewRequested', 'participating', 'subscribed']));

    // Every page stayed inside the submitted limit on its own, and the geometry never
    // shrank to fit a remainder.
    for (const page of pages) {
      if (page.kind === 'failed') throw new Error('unexpected failed page');
      const omitted = page.evidence.kind === 'partial' ? page.evidence.omittedItemCount ?? 0 : 0;
      expect(page.observations.length + omitted).toBeLessThanOrEqual(32);
      if (page.kind !== 'page') continue;
      expect(JSON.parse(page.continuation.token)).toMatchObject({ nativePageSize: 32 });
    }
  });

  it('hands back its own continuation at the page boundary and resumes the next lane', async () => {
    const routes = {
      '/api/v4/user': { body: VIEWER },
      '/api/v4/merge_requests': { body: mergeRequestList },
      '/api/v4/issues': { body: issueList },
    } as const;
    // `limit` is ONE page: the first lane fills it exactly, and the lanes that have
    // not run yet are still open, so the walk is handed back rather than starved.
    const first = harness(routes);
    const firstResult = TriageScanResultV1Schema.parse(await scanGitlabTriageSource({
      scan: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 2 } },
      connectedAccounts: first.connectedAccounts,
      fetcher: first.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    })) as TriageScanResultV1;

    if (firstResult.kind !== 'page') throw new Error(`expected page, got ${firstResult.kind}`);
    expect(firstResult.observations).toHaveLength(2);
    const firstLanes = first.requested.filter((url) => !url.endsWith('/api/v4/user'));
    expect(firstLanes).toHaveLength(1);
    expect(firstLanes[0]).toContain('scope=created_by_me');

    const second = harness(routes);
    const secondResult = TriageScanResultV1Schema.parse(await scanGitlabTriageSource({
      scan: {
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'continuation', continuation: firstResult.continuation },
      },
      connectedAccounts: second.connectedAccounts,
      fetcher: second.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    })) as TriageScanResultV1;

    const secondLanes = second.requested.filter((url) => !url.endsWith('/api/v4/user'));
    // The lane already spent is not repeated, and the next one in the rotation runs.
    expect(secondLanes).toHaveLength(1);
    expect(secondLanes[0]).toContain('scope=assigned_to_me');
    expect(secondLanes[0]).not.toContain('scope=created_by_me');
    expect(secondResult.kind === 'page' || secondResult.kind === 'complete').toBe(true);
  });

  it('keeps a valid continuation usable when the viewer lookup transiently fails', async () => {
    const routes = {
      '/api/v4/user': { body: VIEWER },
      '/api/v4/merge_requests': { body: mergeRequestList },
      '/api/v4/issues': { body: issueList },
    } as const;
    const first = harness(routes);
    const firstResult = await scanGitlabTriageSource({
      scan: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 2 } },
      connectedAccounts: first.connectedAccounts,
      fetcher: first.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });
    if (firstResult.kind !== 'page') throw new Error('expected a continuation page');

    const resumed = harness({
      ...routes,
      '/api/v4/user': { status: 500, body: { message: 'temporary failure' } },
    });
    const resumedResult = await scanGitlabTriageSource({
      scan: {
        v: 1,
        instance: configuredInstance(),
        page: { kind: 'continuation', continuation: firstResult.continuation },
      },
      connectedAccounts: resumed.connectedAccounts,
      fetcher: resumed.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });

    expect(resumedResult).not.toMatchObject({
      kind: 'failed',
      failure: { code: 'unknown-continuation' },
    });
    expect(resumed.requested.some((url) => !url.endsWith('/api/v4/user'))).toBe(true);
  });

  it('refuses a continuation replayed through another configured source instance', async () => {
    const routes = {
      '/api/v4/user': { body: VIEWER },
      '/api/v4/merge_requests': { body: mergeRequestList },
      '/api/v4/issues': { body: issueList },
    } as const;
    const first = harness(routes);
    const firstResult = await scanGitlabTriageSource({
      scan: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 2 } },
      connectedAccounts: first.connectedAccounts,
      fetcher: first.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });
    if (firstResult.kind !== 'page') throw new Error('expected a continuation page');

    const replay = harness(routes);
    const result = await scanGitlabTriageSource({
      scan: {
        v: 1,
        instance: configuredInstance({
          instance: {
            source: { pluginId: 'happier.scm.forge.gitlab', localId: 'gitlab-forge' },
            sourceInstanceId: '50ee54a4-b4a9-40a7-9490-b95afdd6981d',
          },
        }),
        page: { kind: 'continuation', continuation: firstResult.continuation },
      },
      connectedAccounts: replay.connectedAccounts,
      fetcher: replay.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'unknown-continuation' },
    });
    expect(replay.fetcher).not.toHaveBeenCalled();
    expect(replay.materializeListedAccount).not.toHaveBeenCalled();
  });

  it('keeps observations plus omitted rows inside the caller’s one-page limit', async () => {
    const malformed = [{ iid: 7, project_id: 3 }, ...mergeRequestList, { nope: true }];
    const seam = harness({
      '/api/v4/user': { body: VIEWER },
      '/api/v4/merge_requests': { body: malformed },
      '/api/v4/issues': { body: issueList },
    });

    const result = TriageScanResultV1Schema.parse(await scanGitlabTriageSource({
      scan: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 4 } },
      connectedAccounts: seam.connectedAccounts,
      fetcher: seam.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    })) as TriageScanResultV1;

    if (result.kind === 'failed') throw new Error('expected a settled page');
    // A malformed provider row spends budget exactly like a mapped one. Counting
    // only what mapped cleanly is how a source returns more rows than it was asked
    // for and the strict aggregate rejects the whole page.
    const omitted = result.evidence.kind === 'partial' ? result.evidence.omittedItemCount ?? 0 : 0;
    expect(result.observations.length + omitted).toBeLessThanOrEqual(4);
    expect(omitted).toBeGreaterThan(0);
  });

  it('refuses provider overdelivery before publishing an over-limit atomic envelope', async () => {
    const seam = harness({
      '/api/v4/user': { body: VIEWER },
      '/api/v4/merge_requests': {
        body: Array.from({ length: 5 }, (_unused, index) => ({
          ...mergeRequestList[0],
          id: index + 1,
          iid: index + 1,
          references: {
            short: `!${index + 1}`,
            relative: `!${index + 1}`,
            full: `${REPOSITORY_KEY}!${index + 1}`,
          },
        })),
      },
    });

    const result = await scanGitlabTriageSource({
      scan: { v: 1, instance: configuredInstance(), page: { kind: 'initial', limit: 4 } },
      connectedAccounts: seam.connectedAccounts,
      fetcher: seam.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'provider-overdelivery' },
    });
    expect(seam.requested.some((url) => url.includes('/api/v4/issues'))).toBe(false);
  });
});

describe('GitLab get', () => {
  const localRef = { kindId: 'merge-request', collisionScope: PROJECT_SCOPE, entryId: '7' } as const;

  it('retains the issued get identity after a registered malformed provider body', async () => {
    const requestId = '8778a4ad-822b-4a1f-b2c7-12b2be8201db';
    const seam = harness({});
    const kit = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      connectedAccounts: seam.connectedAccounts,
      http: { request: async () => ({ status: 200, headers: {}, body: new TextEncoder().encode('{}') }) },
    } });
    try {
      const result = TriageGetResultV1Schema.parse(await kit.invokeAction(GITLAB_TRIAGE_ACTION_IDS.get, {
        v: 1, instance: configuredInstance(), localRef, lastKnownLocator: { v: 1, routingToken: REPOSITORY_KEY },
      }, { surface: 'ui', requestId }));
      expect(result).toMatchObject({ kind: 'unresolved', failure: { code: 'undecodable-item', requestId } });
    } finally { await kit.dispose(); }
  });

  async function get(routes: Parameters<typeof harness>[0], overrides: Readonly<{
    instance?: TriageConfiguredSourceInstanceV1;
    localRef?: TriageSourceEntryLocalRefV1;
    lastKnownLocator?: TriageEntryLocatorV1 | null;
  }> = {}) {
    const seam = harness(routes);
    const result = await getGitlabTriageEntry({
      get: {
        v: 1,
        instance: overrides.instance ?? configuredInstance(),
        localRef: overrides.localRef ?? localRef,
        ...(overrides.lastKnownLocator === null ? {} : {
          lastKnownLocator: overrides.lastKnownLocator ?? { v: 1, routingToken: REPOSITORY_KEY },
        }),
      },
      connectedAccounts: seam.connectedAccounts,
      fetcher: seam.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });
    return { result: TriageGetResultV1Schema.parse(result) as TriageGetResultV1, seam };
  }

  it('returns the addressed entry with involvement derived from the item itself', async () => {
    const { result } = await get({
      [`/api/v4/projects/${ENCODED_REPOSITORY_KEY}/merge_requests/7`]: {
        body: mergeRequestList[0],
      },
      '/api/v4/user': { body: VIEWER },
    });

    if (result.kind !== 'present') throw new Error(`expected present, got ${result.kind}`);
    expect(result.localRef).toEqual(localRef);
    // The fixture's author is the observed viewer; a `get` is reached by route,
    // so it proves nothing about a query lane.
    expect(result.viewer.involvement).toEqual(['author']);
  });

  it.each([
    { name: 'passing', body: [{ id: 91, status: 'success', sha: mergeRequestList[0]!.sha }], value: 'All passing', tone: 'success' },
    { name: 'failing', body: [{ id: 91, status: 'failed', sha: mergeRequestList[0]!.sha }], value: 'Failing', tone: 'danger' },
    { name: 'running', body: [{ id: 91, status: 'running', sha: mergeRequestList[0]!.sha }], value: 'Running', tone: 'info' },
    { name: 'pending', body: [{ id: 91, status: 'pending', sha: mergeRequestList[0]!.sha }], value: 'Running', tone: 'info' },
    { name: 'empty', body: [], value: 'No pipelines', tone: 'neutral' },
    { name: 'unreadable', status: 403, body: null, value: 'Checks unavailable', tone: 'warning' },
    { name: 'malformed', body: [{ id: 91, sha: mergeRequestList[0]!.sha }], value: 'Checks unavailable', tone: 'warning' },
    { name: 'unknown', body: [{ id: 91, status: 'future-status', sha: mergeRequestList[0]!.sha }], value: 'Checks unavailable', tone: 'warning' },
    { name: 'canceled', body: [{ id: 91, status: 'canceled', sha: mergeRequestList[0]!.sha }], value: 'Checks unavailable', tone: 'warning' },
    { name: 'stale head', body: [{ id: 91, status: 'success', sha: '7777777777777777777777777777777777777777' }], value: 'Checks unavailable', tone: 'warning' },
    { name: 'missing pipeline head', body: [{ id: 91, status: 'success' }], value: 'Checks unavailable', tone: 'warning' },
    { name: 'missing merge request head', missingHead: true, body: [{ id: 91, status: 'success', sha: mergeRequestList[0]!.sha }], value: 'Checks unavailable', tone: 'warning' },
  ])('projects opening pipeline summary: $name, without reading job pages', async ({ body, status, value, tone, missingHead }) => {
    const pipelinesPath = `/api/v4/projects/${ENCODED_REPOSITORY_KEY}/merge_requests/7/pipelines`;
    const { result, seam } = await get({
      [`/api/v4/projects/${ENCODED_REPOSITORY_KEY}/merge_requests/7`]: {
        body: missingHead ? { ...mergeRequestList[0], sha: null, diff_refs: null } : mergeRequestList[0],
      },
      '/api/v4/user': { body: VIEWER },
      [`${pipelinesPath}?per_page=1`]: { body, status },
    });
    const fact = { id: 'gitlab/checks', importance: 'primary', value: { kind: 'status', value, tone } };
    expect(result).toMatchObject({
      kind: 'present',
      snapshot: { facts: expect.arrayContaining([fact]) },
      detailData: { overview: { observation: { snapshot: { facts: expect.arrayContaining([fact]) } } } },
    });
    expect(seam.requested.filter((url) => new URL(url).pathname === pipelinesPath)
      .map((url) => new URL(url).search)).toEqual(['?per_page=1']);
    expect(seam.requested.some((url) => url.includes('/jobs'))).toBe(false);
  });

  it('does not search older pipelines when the opening summary is stale or incomplete', async () => {
    const pipelinesPath = `/api/v4/projects/${ENCODED_REPOSITORY_KEY}/merge_requests/7/pipelines`;
    for (const body of [[], [{ id: 91, status: 'success', sha: '7777777777777777777777777777777777777777' }]]) {
      const { result, seam } = await get({
        [`/api/v4/projects/${ENCODED_REPOSITORY_KEY}/merge_requests/7`]: { body: mergeRequestList[0] },
        '/api/v4/user': { body: VIEWER },
        [`${pipelinesPath}?per_page=1`]: {
          body, headers: { Link: `<https://gitlab.com${pipelinesPath}?per_page=1&page=2>; rel="next"` },
        },
      });
      expect(result).toMatchObject({ kind: 'present', snapshot: { facts: expect.arrayContaining([
        { id: 'gitlab/checks', importance: 'primary', value: { kind: 'status', value: 'Checks unavailable', tone: 'warning' } },
      ]) } });
      expect(seam.requested.filter((url) => url.includes('/pipelines'))).toHaveLength(1);
    }
  });

  it.each([false, true])('keeps a viewer rate limit unresolved for a review-requested item (subscribed=%s)', async (subscribed) => {
    const itemPath = `/api/v4/projects/${ENCODED_REPOSITORY_KEY}/merge_requests/7`;
    const item = { ...mergeRequestList[0], subscribed };
    const viewer = { id: 2, username: 'example-reviewer' };
    const current = await get({
      [itemPath]: { body: item },
      '/api/v4/user': { body: viewer },
    });
    expect(current.result).toMatchObject({
      kind: 'present',
      viewer: { involvement: subscribed ? ['reviewRequested', 'subscribed'] : ['reviewRequested'] },
    });

    const throttled = await get({
      [itemPath]: { body: item },
      '/api/v4/user': { status: 429, headers: { 'Retry-After': '30' } },
    });

    expect(throttled.seam.requested.map((url) => new URL(url).pathname)).toEqual([
      itemPath,
      '/api/v4/user',
    ]);
    expect(throttled.result).toEqual({
      kind: 'unresolved',
      localRef,
      failure: {
        class: 'rateLimit',
        code: 'too-many-requests',
        retryNotBeforeMs: NOW_MS + 30_000,
      },
    });
  });

  it('never concludes absence from a 404, even when the owning project reads', async () => {
    // `sources/SCM.md` §4.6: **GitLab V1 never emits `absent`.** GitLab documents the
    // item `404` as project-or-item-not-found and authorization hides resources behind
    // the same status, so a readable parent project proves nothing about the item. An
    // authoritative `absent` here claims the entry is gone and deletes a row the user
    // can still open on GitLab.
    const readableProject = await get({
      '/api/v4/projects/3': { body: { id: 3 } },
      '/api/v4/user': { body: VIEWER },
    });
    expect(readableProject.result).toMatchObject({
      kind: 'unresolved',
      localRef,
      failure: { class: 'permission', code: 'item-unreadable' },
    });

    const unreadableProject = await get({ '/api/v4/user': { body: VIEWER } });
    expect(unreadableProject.result).toMatchObject({
      kind: 'unresolved',
      localRef,
      failure: { class: 'permission', code: 'item-unreadable' },
    });
    // No parent reread is attempted at all: it can never change the conclusion, and
    // spending the user's quota to learn nothing is its own defect.
    expect(unreadableProject.seam.requested.some((url) => url.endsWith('/api/v4/projects/3')))
      .toBe(false);
    expect(readableProject.seam.requested.some((url) => url.endsWith('/api/v4/projects/3')))
      .toBe(false);
  });

  it('refuses a reference keyed against another deployment without calling the provider', async () => {
    const { result, seam } = await get({}, {
      localRef: {
        kindId: 'merge-request',
        collisionScope: `gitlab:${Buffer.from('https://gitlab.example.test', 'utf8').toString('base64url')}:3`,
        entryId: '7',
      },
    });

    expect(result).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'unsupportedContract', code: 'scope-outside-binding' },
    });
    expect(seam.fetcher).not.toHaveBeenCalled();
  });

  it('treats a differently identified answer as invalid rather than as a redirect', async () => {
    const { result } = await get({
      [`/api/v4/projects/${ENCODED_REPOSITORY_KEY}/merge_requests/7`]: {
        body: { ...mergeRequestList[0], iid: 9 },
      },
      '/api/v4/user': { body: VIEWER },
    });

    expect(result).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'unsupportedContract', code: 'identity-mismatch' },
    });
  });

  it('reads an issue and merge request with the same project and IID through their own routes', async () => {
    const issueRef = { kindId: 'issue', collisionScope: PROJECT_SCOPE, entryId: '7' } as const;
    const issuePath = `/api/v4/projects/${ENCODED_REPOSITORY_KEY}/issues/7`;
    const mergeRequestPath = `/api/v4/projects/${ENCODED_REPOSITORY_KEY}/merge_requests/7`;
    const routes: Record<string, RouteResponse> = {
      [issuePath]: { body: issueList[0] },
      [mergeRequestPath]: { body: mergeRequestList[0] },
      '/api/v4/user': { body: VIEWER },
    };
    const seam = harness(routes);
    const instance = configuredInstance();
    const read = async (ref: TriageSourceEntryLocalRefV1) => TriageGetResultV1Schema.parse(await getGitlabTriageEntry({
      get: { v: 1, instance, localRef: ref, lastKnownLocator: { v: 1, routingToken: REPOSITORY_KEY } },
      connectedAccounts: seam.connectedAccounts,
      fetcher: seam.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    }));

    const issue = await read(issueRef);
    expect(issue).toMatchObject({ kind: 'present', localRef: issueRef, snapshot: { title: issueList[0]!.title } });
    if (issue.kind !== 'present') throw new Error(`expected present, got ${issue.kind}`);
    expect(issue.snapshot.facts.some((fact) => fact.id === 'gitlab/merge-status')).toBe(false);
    expect(seam.requested.map((url) => new URL(url).pathname)).toEqual([issuePath, '/api/v4/user']);

    expect(await read(localRef)).toMatchObject({
      kind: 'present', localRef, snapshot: { title: mergeRequestList[0]!.title },
    });
    routes[issuePath] = { body: { message: '404 Not found' }, status: 404 };
    expect(await read(issueRef)).toMatchObject({ kind: 'unresolved', localRef: issueRef, failure: { code: 'item-unreadable' } });
    const itemRequests = seam.requested.map((url) => new URL(url).pathname)
      .filter(path => path === issuePath || path === mergeRequestPath);
    expect(itemRequests).toEqual([issuePath, mergeRequestPath, issuePath]);
  });

  it('requires the newest locator and never reconstructs a route from collision scope', async () => {
    const { result, seam } = await get({}, { lastKnownLocator: null });

    expect(result).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'unsupportedContract', code: 'locator-routing-token-invalid' },
    });
    expect(seam.fetcher).not.toHaveBeenCalled();
  });

  it('routes from the locator but refuses a fresh row whose repository key moved', async () => {
    const renamed = {
      ...mergeRequestList[0],
      web_url: 'https://gitlab.com/renamed/group/project/-/merge_requests/7',
      references: { short: '!7', relative: '!7', full: 'renamed/group/project!7' },
    };
    const { result, seam } = await get({
      [`/api/v4/projects/${ENCODED_REPOSITORY_KEY}/merge_requests/7`]: { body: renamed },
    });

    expect(result).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'unsupportedContract', code: 'locator-mismatch' },
    });
    expect(seam.requested).toContain(
      `https://gitlab.com/api/v4/projects/${ENCODED_REPOSITORY_KEY}/merge_requests/7`,
    );
    expect(seam.requested.some((url) => url.includes('/projects/3/'))).toBe(false);
  });

  it('refuses a kind this source never declared', async () => {
    const { result, seam } = await get({}, {
      localRef: {
        kindId: 'pull-request',
        collisionScope: PROJECT_SCOPE,
        entryId: '7',
      } as unknown as typeof localRef,
    });

    expect(result).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'unsupportedContract', code: 'gitlab-kind-unsupported' },
    });
    expect(seam.fetcher).not.toHaveBeenCalled();
  });

  it('rejects a configuration token this source did not mint', async () => {
    const { result, seam } = await get({}, {
      instance: configuredInstance({ configuration: { v: 1, token: '{"v":2}' } }),
    });

    expect(result).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'unsupportedContract', code: 'unsupported-configuration' },
    });
    expect(seam.materializeListedAccount).not.toHaveBeenCalled();
  });
});
