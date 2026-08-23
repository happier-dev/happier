import { describe, expect, it, vi } from 'vitest';

import type { GitlabAuthorizedInvocation, GitlabHttpFetcher } from '../http/gitlabClient.js';
import { createGitlabResponseHeaders } from '../http/gitlabHeaders.js';
import { buildGitlabScanLanes } from '../mapping/gitlabInvolvement.js';
import { normalizeGitlabConfiguredBaseUrl } from '../origin.js';
import {
  GITLAB_MAX_NATIVE_PAGE_SIZE,
  createGitlabScanFrontier,
  hasOpenGitlabLane,
  runGitlabScan,
} from './gitlabScanFrontier.js';

const NOW_MS = 1_609_844_100_000;

const origin = normalizeGitlabConfiguredBaseUrl('https://gitlab.com');
if (!origin) throw new Error('unusable fixture origin');
const GITLAB_COM = origin;

const AUTHORIZED: GitlabAuthorizedInvocation = {
  origin: GITLAB_COM,
  headers: { Authorization: 'Bearer test-only-not-a-real-token', Accept: 'application/json' },
};

function mergeRequestRow(iid: number) {
  return {
    id: iid * 1000,
    iid,
    project_id: 3,
    title: `Merge request ${iid}`,
    state: 'opened',
    draft: false,
    labels: [],
    assignees: [],
    reviewers: [],
    updated_at: '2026-08-09T08:46:00Z',
    created_at: '2026-08-04T08:46:00Z',
    user_notes_count: 0,
    references: { short: `!${iid}`, relative: `!${iid}`, full: `example-group/app!${iid}` },
    web_url: `https://gitlab.com/example-group/app/-/merge_requests/${iid}`,
  };
}

type PageScript = Readonly<{ rows: readonly unknown[]; nextUrl?: string; totals?: string }>;

/**
 * A fetcher driven by an explicit per-URL script, so a test states exactly what
 * GitLab returned for each request rather than a page counter guessing for it.
 */
function scriptedFetcher(script: Readonly<Record<string, PageScript>>) {
  return vi.fn<GitlabHttpFetcher>(async (url) => {
    const page = script[url];
    if (!page) throw new Error(`unscripted url: ${url}`);
    return {
      status: 200,
      statusText: '',
      headers: createGitlabResponseHeaders({
        ...(page.nextUrl ? { Link: `<${page.nextUrl}>; rel="next"` } : {}),
        ...(page.totals ? { 'X-Total': page.totals } : {}),
      }),
      text: async () => JSON.stringify(page.rows),
    };
  });
}

function mergeRequestLanes() {
  return buildGitlabScanLanes({ kindId: 'merge-request', viewerUserId: 42 });
}

describe('createGitlabScanFrontier', () => {
  it('fixes one native page size for the whole invocation, capped at GitLab’s own limit', () => {
    const { requests } = mergeRequestLanes();
    expect(createGitlabScanFrontier({ scanLimit: 500, origin: GITLAB_COM, lanes: requests })
      .nativePageSize).toBe(GITLAB_MAX_NATIVE_PAGE_SIZE);
    expect(createGitlabScanFrontier({ scanLimit: 25, origin: GITLAB_COM, lanes: requests })
      .nativePageSize).toBe(25);
  });

  it('builds one initial URL per lane, carrying that lane’s own GitLab scope', () => {
    const { requests } = mergeRequestLanes();
    const frontier = createGitlabScanFrontier({ scanLimit: 100, origin: GITLAB_COM, lanes: requests });
    const urls = frontier.lanes.map((lane) => lane.nextUrl);
    expect(urls.some((url) => url.includes('scope=created_by_me'))).toBe(true);
    expect(urls.some((url) => url.includes('scope=reviews_for_me'))).toBe(true);
    expect(urls.some((url) => url.includes('approved_by_ids%5B%5D=42'))).toBe(true);
    expect(urls.every((url) => url.startsWith('https://gitlab.com/api/v4/merge_requests?'))).toBe(true);
    expect(urls.every((url) => url.includes('per_page=100'))).toBe(true);
  });
});

describe('runGitlabScan', () => {
  it('keeps every provider Link frontier private to one bounded invocation', async () => {
    const { requests, unavailable } = mergeRequestLanes();
    // A limit above one native page is what lets more than one lane run inside a
    // single call; below it the continuation carries the rotation instead.
    const frontier = createGitlabScanFrontier({ scanLimit: 250, origin: GITLAB_COM, lanes: requests });
    const [authored, assigned, reviewRequested, approved] = frontier.lanes.map((l) => l.nextUrl);
    if (!authored || !assigned || !reviewRequested || !approved) throw new Error('expected four lanes');

    const authoredPage2 = 'https://gitlab.com/api/v4/merge_requests?scope=created_by_me&per_page=100&page=2';
    const fetcher = scriptedFetcher({
      [authored]: { rows: [mergeRequestRow(1), mergeRequestRow(2), mergeRequestRow(3)], nextUrl: authoredPage2, totals: '9000' },
      [authoredPage2]: { rows: [mergeRequestRow(4)], totals: '20000' },
      // The same merge request is encountered again in another lane. The source
      // emits both encounters; converging them is the target's job, and
      // pre-deduplicating here would silently lose the second involvement fact.
      [assigned]: { rows: [mergeRequestRow(1)] },
      [reviewRequested]: { rows: [] },
      [approved]: { rows: [mergeRequestRow(2)] },
    });

    const result = await runGitlabScan({
      invocation: AUTHORIZED,
      frontier,
      unavailableLanes: unavailable,
      fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });
    if (result.kind !== 'settled') throw new Error('expected a settled scan');

    // Only the provider-issued URLs were requested; none was constructed locally.
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      authored, assigned, reviewRequested, approved, authoredPage2,
    ]);
    expect(result.entries).toHaveLength(6);
    expect(result.entries.map((entry) => entry.identity.entryId)).toEqual(['1', '2', '3', '1', '2', '4']);
    expect(result.entries[0]?.viewer.involvement).toEqual(['author']);
    expect(result.entries[3]?.viewer.involvement).toEqual(['assignee']);
    expect(result.entries[4]?.viewer.involvement).toEqual(['participating']);
    expect(result.entries[4]?.rowFacts.map((fact) => fact.id)).toContain('gitlab/approved');
    // Changing advisory totals mid-walk changed nothing.
    expect(result.consumedItemCount).toBeLessThanOrEqual(frontier.scanLimit);
    expect(result.health).toEqual({ kind: 'partial', reason: 'lane-unavailable' });
  });

  it('hands the rotation to the next lane rather than restarting at the first one', async () => {
    // `nativePageSize = min(scanLimit, 100)`, and a page starts only when a whole
    // native page fits the remaining budget, so at any admissible limit ONE lane page
    // fills the call. That is the page shape, not the walk: the rotation position
    // survives on the frontier, so the following call reads the NEXT lane. Restarting
    // the rotation at zero is what starved every lane after `scope=created_by_me`.
    const { requests, unavailable } = mergeRequestLanes();
    const frontier = createGitlabScanFrontier({ scanLimit: 64, origin: GITLAB_COM, lanes: requests });
    const [authored, assigned] = frontier.lanes.map((lane) => lane.nextUrl);
    if (!authored || !assigned) throw new Error('expected lanes');

    const fetcher = scriptedFetcher({
      [authored]: { rows: [mergeRequestRow(1)] },
      [assigned]: { rows: [mergeRequestRow(2)] },
    });
    const call = async () => runGitlabScan({
      invocation: AUTHORIZED,
      frontier,
      unavailableLanes: unavailable,
      fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });

    const first = await call();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([authored]);
    expect(first).toMatchObject({ kind: 'settled', budgetExhausted: true });
    // The lane that already answered ended with no `Link`, so the rotation moves on.
    expect(hasOpenGitlabLane(frontier)).toBe(true);

    const second = await call();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([authored, assigned]);
    if (second.kind !== 'settled') throw new Error('expected a settled scan');
    expect(second.entries.map((entry) => entry.identity.entryId)).toEqual(['2']);
  });

  it('keeps a reason observed on an earlier page in the walk that settles it', async () => {
    const { requests, unavailable } = mergeRequestLanes();
    const frontier = createGitlabScanFrontier({ scanLimit: 2, origin: GITLAB_COM, lanes: requests });
    const [authored, assigned] = frontier.lanes.map((lane) => lane.nextUrl);
    if (!authored || !assigned) throw new Error('expected lanes');

    const fetcher = scriptedFetcher({
      [authored]: { rows: ['not-an-object', mergeRequestRow(1)] },
      [assigned]: { rows: [mergeRequestRow(2)] },
    });
    const call = async () => runGitlabScan({
      invocation: AUTHORIZED,
      frontier,
      unavailableLanes: unavailable,
      fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });

    const first = await call();
    if (first.kind !== 'settled') throw new Error('expected a settled scan');
    expect(first.undecodableCount).toBe(1);

    const second = await call();
    if (second.kind !== 'settled') throw new Error('expected a settled scan');
    // This call skipped nothing. The reason belongs to the WALK, and a page that
    // reports only what it personally saw settles a truncated walk as a clean one.
    expect(second.undecodableCount).toBe(0);
    expect(second.health).toEqual({ kind: 'partial', reason: 'undecodable-items' });
  });

  it('settles partial rather than fetching a page that cannot fit the remaining budget', async () => {
    const { requests, unavailable } = mergeRequestLanes();
    const frontier = createGitlabScanFrontier({ scanLimit: 6, origin: GITLAB_COM, lanes: requests });
    const [authored, assigned, reviewRequested, approved] = frontier.lanes.map((l) => l.nextUrl);
    if (!authored || !assigned || !reviewRequested || !approved) throw new Error('expected four lanes');

    // The first lane leaves 2 of the 6-item budget, and a whole native page is 6.
    // Starting any sibling page would overrun the submitted limit.
    const fetcher = scriptedFetcher({
      [authored]: { rows: [mergeRequestRow(1), mergeRequestRow(2), mergeRequestRow(3), mergeRequestRow(4)] },
      [assigned]: { rows: [mergeRequestRow(5), mergeRequestRow(6), mergeRequestRow(7)] },
      [reviewRequested]: { rows: [] },
      [approved]: { rows: [] },
    });

    const result = await runGitlabScan({
      invocation: AUTHORIZED,
      frontier,
      unavailableLanes: unavailable,
      fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });
    if (result.kind !== 'settled') throw new Error('expected a settled scan');

    // The first lane spent the whole budget, so no sibling lane page was started.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.entries).toHaveLength(4);
    expect(result.consumedItemCount).toBe(4);
    expect(result.budgetExhausted).toBe(true);
    // `lane-unavailable` outranks this call's own page-shape fact: a lane GitLab offers
    // no query for is something the walk could not inspect, which is the stronger
    // caveat. The budget fact is the page shape, and the continuation resolves it.
    expect(result.health).toEqual({ kind: 'partial', reason: 'lane-unavailable' });
  });

  it('spends the budget on raw response cardinality, not on rows that decoded cleanly', async () => {
    const frontier = createGitlabScanFrontier({
      scanLimit: 2,
      origin: GITLAB_COM,
      lanes: [{
        laneId: 'authored',
        kindId: 'merge-request',
        path: '/merge_requests',
        query: [['scope', 'created_by_me']],
        involvement: 'author',
      }],
    });
    const [authored] = frontier.lanes.map((lane) => lane.nextUrl);
    if (!authored) throw new Error('expected one lane');

    const fetcher = scriptedFetcher({
      [authored]: { rows: [mergeRequestRow(1), { id: 9, project_id: 3 }] },
    });
    const result = await runGitlabScan({
      invocation: AUTHORIZED,
      frontier,
      unavailableLanes: [],
      fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });
    if (result.kind !== 'settled') throw new Error('expected a settled scan');

    expect(result.entries).toHaveLength(1);
    expect(result.undecodableCount).toBe(1);
    // Two raw rows were consumed even though one was skipped: counting decoded rows
    // would let a page of malformed items walk past the submitted limit.
    expect(result.consumedItemCount).toBe(2);
    expect(result.health).toEqual({ kind: 'partial', reason: 'undecodable-items' });
  });

  it('settles a refused next link as an unresolved lane, never as a finished walk', async () => {
    const frontier = createGitlabScanFrontier({
      scanLimit: 100,
      origin: GITLAB_COM,
      lanes: [{
        laneId: 'authored',
        kindId: 'merge-request',
        path: '/merge_requests',
        query: [['scope', 'created_by_me']],
        involvement: 'author',
      }],
    });
    const [authored] = frontier.lanes.map((lane) => lane.nextUrl);
    if (!authored) throw new Error('expected one lane');

    const fetcher = scriptedFetcher({
      [authored]: {
        rows: [mergeRequestRow(1)],
        nextUrl: 'https://gitlab.com.evil.example/api/v4/merge_requests?page=2',
      },
    });
    const result = await runGitlabScan({
      invocation: AUTHORIZED,
      frontier,
      unavailableLanes: [],
      fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    // The lane stops — the credential never leaves the invoked origin — but it stopped
    // UNFINISHED. `walkFinished` here would tell the reader this lane ran out, which is
    // the one claim a refused continuation cannot support.
    expect(result).toMatchObject({
      kind: 'settled',
      health: { kind: 'partial', reason: 'lane-unresolved' },
    });
    expect(hasOpenGitlabLane(frontier)).toBe(false);
  });

  it('keeps a walk whose only lane ran out reporting a finished walk', async () => {
    // The discriminating half of the pair above: absence of a `Link` is the lane's own
    // end and must NOT acquire the refused caveat, or every clean walk reports partial.
    const frontier = createGitlabScanFrontier({
      scanLimit: 100,
      origin: GITLAB_COM,
      lanes: [{
        laneId: 'authored',
        kindId: 'merge-request',
        path: '/merge_requests',
        query: [['scope', 'created_by_me']],
        involvement: 'author',
      }],
    });
    const [authored] = frontier.lanes.map((lane) => lane.nextUrl);
    if (!authored) throw new Error('expected one lane');

    const result = await runGitlabScan({
      invocation: AUTHORIZED,
      frontier,
      unavailableLanes: [],
      fetcher: scriptedFetcher({ [authored]: { rows: [mergeRequestRow(1)] } }),
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });
    expect(result).toMatchObject({ kind: 'settled', health: { kind: 'walkFinished' } });
  });

  it('carries a refused next link into the page that settles the walk', async () => {
    // Stickiness is the whole point: the lane that was cut off may end on page one while
    // a sibling lane settles the walk two pages later, and the settling page is the one
    // the reader sees.
    const { requests, unavailable } = mergeRequestLanes();
    const frontier = createGitlabScanFrontier({ scanLimit: 2, origin: GITLAB_COM, lanes: requests });
    const [authored, assigned] = frontier.lanes.map((lane) => lane.nextUrl);
    if (!authored || !assigned) throw new Error('expected lanes');

    const fetcher = scriptedFetcher({
      [authored]: {
        rows: [mergeRequestRow(1)],
        nextUrl: 'https://attacker.example/api/v4/merge_requests?page=2',
      },
      [assigned]: { rows: [mergeRequestRow(2)] },
    });
    const call = async () => runGitlabScan({
      invocation: AUTHORIZED,
      frontier,
      unavailableLanes: unavailable,
      fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });

    await call();
    const second = await call();
    // `lane-unresolved` outranks `lane-unavailable` in the declared precedence: a lane
    // that was cut off mid-walk is a stronger caveat than one that never had a query.
    expect(second).toMatchObject({
      kind: 'settled',
      health: { kind: 'partial', reason: 'lane-unresolved' },
    });
  });

  it('settles a rate limit as one failed result and discards the frontier', async () => {
    const frontier = createGitlabScanFrontier({
      scanLimit: 100,
      origin: GITLAB_COM,
      lanes: [{
        laneId: 'authored',
        kindId: 'merge-request',
        path: '/merge_requests',
        query: [['scope', 'created_by_me']],
        involvement: 'author',
      }],
    });
    const fetcher = vi.fn<GitlabHttpFetcher>(async () => ({
      status: 429,
      statusText: '',
      headers: createGitlabResponseHeaders({ 'Retry-After': '30' }),
      text: async () => '',
    }));
    const result = await runGitlabScan({
      invocation: AUTHORIZED,
      frontier,
      unavailableLanes: [],
      fetcher,
      signal: new AbortController().signal,
      nowMs: NOW_MS,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      kind: 'failed',
      failure: {
        class: 'rateLimit',
        code: 'too-many-requests',
        retryNotBeforeMs: NOW_MS + 30_000,
      },
    });
  });

  it('restarts from the initial request after a cancelled walk, with no resumable state', async () => {
    const { requests, unavailable } = mergeRequestLanes();
    const frontier = createGitlabScanFrontier({ scanLimit: 100, origin: GITLAB_COM, lanes: requests });
    const initialUrls = frontier.lanes.map((lane) => lane.nextUrl);
    const controller = new AbortController();
    controller.abort();

    const fetcher = vi.fn<GitlabHttpFetcher>(async () => {
      throw new Error('a cancelled walk must not reach the provider');
    });
    const cancelled = await runGitlabScan({
      invocation: AUTHORIZED,
      frontier,
      unavailableLanes: unavailable,
      fetcher,
      signal: controller.signal,
      nowMs: NOW_MS,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(cancelled).toEqual({
      kind: 'failed',
      failure: { class: 'transient', code: 'cancelled' },
    });

    // A later coordinator attempt builds a fresh frontier that starts where the
    // first one did. Nothing carried a cursor across the interruption.
    const restarted = createGitlabScanFrontier({ scanLimit: 100, origin: GITLAB_COM, lanes: requests });
    expect(restarted.lanes.map((lane) => lane.nextUrl)).toEqual(initialUrls);
    expect(JSON.stringify(restarted)).not.toContain('Bearer');
    expect(JSON.stringify(restarted).toLowerCase()).not.toContain('authorization');
  });
});
