import {
  TriageGetResultV1Schema,
  TriageScanResultV1Schema,
  type TriageConfiguredSourceInstanceV1,
  type TriageGetResultV1,
  type TriageScanInputV1,
  type TriageSourceEntryLocalRefV1,
  type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import { describe, expect, it, vi } from 'vitest';

import issueList from './__fixtures__/issueList.json' with { type: 'json' };
import mergeRequestList from './__fixtures__/mergeRequestList.json' with { type: 'json' };
import { GITLAB_CONFIGURATION_RECORD_V1, encodeGitlabConfiguration } from './configuration.js';
import { GITLAB_CONNECTED_ACCOUNT_PURPOSE } from './contribution.js';
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
function harness(routes: Readonly<Record<string, RouteResponse>>) {
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
  }>) => ({
    kind: 'httpHeaders' as const,
    headers: { Authorization: 'Bearer test-only-not-a-real-token' },
  }));
  const listAccounts = vi.fn(async () => ({ status: 'complete' as const, accounts: [] }));
  return {
    fetcher,
    requested,
    materializeListedAccount,
    connectedAccounts: { listAccounts, materializeListedAccount } as unknown as
      GitlabConnectedAccounts,
  };
}

type ScanSeam = ReturnType<typeof harness>;

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

  it('stops a non-GitLab.com configured deployment before it authorizes anything', async () => {
    const seam = harness({});
    const result = await scanGitlabTriageSource({
      scan: {
        v: 1,
        instance: configuredInstance({ localInstanceKey: 'https://gitlab.example.test' }),
        page: { kind: 'initial', limit: 32 },
      },
      connectedAccounts: seam.connectedAccounts,
      fetcher: seam.fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });

    expect(result).toMatchObject({
      kind: 'failed',
      failure: { class: 'unsupportedContract', code: 'self-managed-floor-unset' },
    });
    expect(seam.materializeListedAccount).not.toHaveBeenCalled();
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
});

describe('GitLab get', () => {
  const localRef = { kindId: 'merge-request', collisionScope: PROJECT_SCOPE, entryId: '7' } as const;

  async function get(routes: Parameters<typeof harness>[0], overrides: Readonly<{
    instance?: TriageConfiguredSourceInstanceV1;
    localRef?: TriageSourceEntryLocalRefV1;
  }> = {}) {
    const seam = harness(routes);
    const result = await getGitlabTriageEntry({
      get: {
        v: 1,
        instance: overrides.instance ?? configuredInstance(),
        localRef: overrides.localRef ?? localRef,
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
      '/api/v4/projects/3/merge_requests/7': { body: mergeRequestList[0] },
      '/api/v4/user': { body: VIEWER },
    });

    if (result.kind !== 'present') throw new Error(`expected present, got ${result.kind}`);
    expect(result.localRef).toEqual(localRef);
    // The fixture's author is the observed viewer; a `get` is reached by route,
    // so it proves nothing about a query lane.
    expect(result.viewer.involvement).toEqual(['author']);
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
      '/api/v4/projects/3/merge_requests/7': {
        body: { ...mergeRequestList[0], iid: 9 },
      },
      '/api/v4/user': { body: VIEWER },
    });

    expect(result).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'unsupportedContract', code: 'identity-mismatch' },
    });
  });

  it('dispatches on kind before a route, so an issue never reads a merge-request path', async () => {
    const { result, seam } = await get({
      '/api/v4/projects/3/issues/7': { body: issueList[0] },
      '/api/v4/user': { body: VIEWER },
    }, {
      localRef: { kindId: 'issue', collisionScope: PROJECT_SCOPE, entryId: '7' },
    });

    if (result.kind !== 'present') throw new Error(`expected present, got ${result.kind}`);
    expect(result.localRef.kindId).toBe('issue');
    expect(seam.requested.some((url) => url.includes('/merge_requests/'))).toBe(false);
    // Issues carry no merge-request-only content, whatever the two kinds share.
    expect(JSON.stringify(result.snapshot)).not.toContain('detailed_merge_status');
    expect(result.snapshot.facts.some((fact) => fact.id === 'gitlab/merge-status')).toBe(false);
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
      failure: { class: 'unsupportedContract', code: 'undeclared-kind' },
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
