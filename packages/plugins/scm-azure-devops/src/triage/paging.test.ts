import { describe, expect, it } from 'vitest';

import { createAzureDevOpsApiClient } from './client.js';
import { normalizeAzureDevOpsBaseUrl } from './origin.js';
import {
  advanceAzureLane,
  azurePageFitsBudget,
  createAzureScanFrontier,
  readAzureProjectPage,
  readAzurePullRequestLanePage,
  readAzureRepositoriesAfter,
} from './paging.js';
import type {
  AzureDevOpsApiClient,
  AzureDevOpsHttpRequest,
  AzureDevOpsHttpResponse,
  AzureDevOpsOrigin,
} from './types.js';
import authoredPage from './fixtures/pullRequests.authored.page1.json';
import projectsPage1 from './fixtures/projects.page1.json';
import projectsPage2 from './fixtures/projects.page2.json';
import repositoriesFixture from './fixtures/repositories.json';

const PROJECT_ID = '3f1e2c74-9a51-4a1b-8f2a-6c1d0b7e5a42';
const VIEWER_ID = 'd6245f20-2af8-44f4-9451-8107cb2767db';
const REPO_GATEWAY = '5febef5a-833d-4e14-b9c0-14cb638f91e6';
const REPO_SETTLEMENT = 'a0d3f2b1-6c88-4d2e-b3f9-1e5c7a904b6d';
const REPO_CHECKOUT = 'f4b7c210-55ae-4d31-8a6c-2b90d5e1c773';

function origin(): AzureDevOpsOrigin {
  const result = normalizeAzureDevOpsBaseUrl('https://dev.azure.com/AcmeOrg');
  if (!result.ok) throw new Error('fixture origin must normalize');
  return result.origin;
}

function scriptedClient(
  responses: readonly AzureDevOpsHttpResponse[],
): Readonly<{ client: AzureDevOpsApiClient; calls: AzureDevOpsHttpRequest[] }> {
  const calls: AzureDevOpsHttpRequest[] = [];
  let index = 0;
  return {
    calls,
    client: createAzureDevOpsApiClient({
      origin: origin(),
      authorization: { headers: { authorization: 'Basic REDACTED' } },
      transport: async (request) => {
        calls.push(request);
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        if (!response) throw new Error('no scripted response');
        return response;
      },
      now: () => 1_700_000_000_000,
    }),
  };
}

function json(body: unknown, headers: Readonly<Record<string, string>> = {}): AzureDevOpsHttpResponse {
  return {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
    bodyText: JSON.stringify(body),
  };
}

describe('createAzureScanFrontier', () => {
  it('starts both lanes at offset zero with the caller-owned scan budget', () => {
    const frontier = createAzureScanFrontier({ scanLimit: 50 });
    expect(frontier.scanLimit).toBe(50);
    expect(frontier.lanes.map((lane) => lane.laneId)).toEqual(['authored', 'reviewer']);
    expect(frontier.lanes.every((lane) => lane.skip === 0 && !lane.ended)).toBe(true);
    expect(frontier.projectNextToken).toBeNull();
    expect(frontier.lastCompletedRepositoryId).toBeNull();
  });

  it('carries no credential and no delivered ids beyond its offsets and provider token', () => {
    const frontier = createAzureScanFrontier({ scanLimit: 10 });
    frontier.projectNextToken = 'opaque-project-token';
    frontier.lastCompletedRepositoryId = REPO_GATEWAY;

    const serialized = JSON.stringify(frontier).toLowerCase();
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('basic ');
    expect(serialized).not.toContain('bearer');
    // Delivered entry ids never accumulate in the frontier; only offsets and the provider token.
    expect(serialized).not.toContain('pullrequest');
    expect(Object.keys(frontier).sort()).toEqual([
      'currentRepositoryId',
      'lanes',
      'lastCompletedRepositoryId',
      'nextLaneIndex',
      'observed',
      'projectId',
      'projectNextToken',
      'scanLimit',
      'walkHealth',
    ]);
  });

  it('stops when the caller-owned scan budget is exhausted', () => {
    const frontier = createAzureScanFrontier({ scanLimit: 30 });
    expect(azurePageFitsBudget(frontier)).toBe(true);
    frontier.observed = 29;
    expect(azurePageFitsBudget(frontier)).toBe(true);
    frontier.observed = 30;
    expect(azurePageFitsBudget(frontier)).toBe(false);
  });

  it('advances a lane by the raw provider cardinality, not the decoded row count', () => {
    const frontier = createAzureScanFrontier({ scanLimit: 100 });
    advanceAzureLane(frontier, 'authored', 25, false);
    expect(frontier.lanes[0]).toEqual({ laneId: 'authored', skip: 25, ended: false });
    expect(frontier.lanes[1]).toEqual({ laneId: 'reviewer', skip: 0, ended: false });
  });
});

describe('readAzureProjectPage', () => {
  it('requests one project at a time and returns only the response-issued continuation token', async () => {
    const harness = scriptedClient([json(projectsPage1, { 'X-MS-ContinuationToken': 'opaque-project-token' })]);

    const page = await readAzureProjectPage({
      client: harness.client,
      continuationToken: null,
      signal: new AbortController().signal,
    });

    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.projects.map((row) => row.name)).toEqual(['Payments']);
      expect(page.continuationToken).toBe('opaque-project-token');
    }
    expect(harness.calls[0]?.url).toContain('stateFilter=wellFormed');
    expect(harness.calls[0]?.url).toContain('$top=1');
    expect(harness.calls[0]?.url).not.toContain('continuationToken');
  });

  it('sends back the exact provider token and never a locally derived one', async () => {
    const harness = scriptedClient([json(projectsPage2)]);

    const page = await readAzureProjectPage({
      client: harness.client,
      continuationToken: 'opaque-project-token',
      signal: new AbortController().signal,
    });

    expect(harness.calls[0]?.url).toContain('continuationToken=opaque-project-token');
    if (page.ok) expect(page.continuationToken).toBeNull();
  });

  it('reports a project frontier failure instead of an empty project list', async () => {
    const harness = scriptedClient([{ status: 500, headers: {}, bodyText: '{"message":"boom"}' }]);

    const page = await readAzureProjectPage({
      client: harness.client,
      continuationToken: null,
      signal: new AbortController().signal,
    });

    expect(page.ok).toBe(false);
    if (!page.ok) expect(page.failure.class).toBe('server');
  });
});

describe('readAzureRepositoriesAfter', () => {
  it('orders the scan-local frontier by immutable GUID, not provider presentation order', async () => {
    const harness = scriptedClient([json(repositoriesFixture)]);

    const result = await readAzureRepositoriesAfter({
      client: harness.client,
      projectId: PROJECT_ID,
      lastCompletedRepositoryId: null,
      signal: new AbortController().signal,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Provider order in the fixture is checkout, gateway, settlement; GUID order is not.
      expect(result.repositories.map((row) => row.id)).toEqual([
        REPO_GATEWAY,
        REPO_SETTLEMENT,
        REPO_CHECKOUT,
      ]);
    }
    expect(harness.calls[0]?.url).not.toContain('continuationToken');
    expect(harness.calls[0]?.url).not.toContain('$skip');
  });

  it('continues strictly after the frontier GUID so a reordered list still converges', async () => {
    const harness = scriptedClient([json(repositoriesFixture)]);

    const result = await readAzureRepositoriesAfter({
      client: harness.client,
      projectId: PROJECT_ID,
      lastCompletedRepositoryId: REPO_GATEWAY,
      signal: new AbortController().signal,
    });

    if (result.ok) {
      expect(result.repositories.map((row) => row.id)).toEqual([REPO_SETTLEMENT, REPO_CHECKOUT]);
    }
  });

  it('keeps a disabled repository visible as an attributable row rather than silently dropping it', async () => {
    const harness = scriptedClient([json(repositoriesFixture)]);

    const result = await readAzureRepositoriesAfter({
      client: harness.client,
      projectId: PROJECT_ID,
      lastCompletedRepositoryId: null,
      signal: new AbortController().signal,
    });

    if (result.ok) {
      expect(result.repositories.find((row) => row.id === REPO_SETTLEMENT)?.isDisabled).toBe(true);
    }
  });
});

describe('readAzurePullRequestLanePage', () => {
  it('sends the authored lane as a creatorId query with explicit status, top and skip', async () => {
    const harness = scriptedClient([json(authoredPage)]);

    await readAzurePullRequestLanePage({
      client: harness.client,
      projectId: PROJECT_ID,
      repositoryId: REPO_GATEWAY,
      lane: 'authored',
      viewerId: VIEWER_ID,
      top: 25,
      skip: 0,
      signal: new AbortController().signal,
    });

    const url = harness.calls[0]?.url ?? '';
    expect(url).toContain(`searchCriteria.creatorId=${VIEWER_ID}`);
    expect(url).toContain('searchCriteria.status=active');
    expect(url).toContain('$top=25');
    expect(url).toContain('$skip=0');
    expect(url).not.toContain('reviewerId');
  });

  it('sends the reviewer lane as a separate reviewerId query and never a third reviewed query', async () => {
    const harness = scriptedClient([json(authoredPage)]);

    await readAzurePullRequestLanePage({
      client: harness.client,
      projectId: PROJECT_ID,
      repositoryId: REPO_GATEWAY,
      lane: 'reviewer',
      viewerId: VIEWER_ID,
      top: 25,
      skip: 0,
      signal: new AbortController().signal,
    });

    expect(harness.calls).toHaveLength(1);
    const url = harness.calls[0]?.url ?? '';
    expect(url).toContain(`searchCriteria.reviewerId=${VIEWER_ID}`);
    expect(url).not.toContain('creatorId');
  });

  it('ends the lane on a short page and reports the raw cardinality for the next offset', async () => {
    const harness = scriptedClient([json(authoredPage)]);

    const page = await readAzurePullRequestLanePage({
      client: harness.client,
      projectId: PROJECT_ID,
      repositoryId: REPO_GATEWAY,
      lane: 'authored',
      viewerId: VIEWER_ID,
      top: 25,
      skip: 0,
      signal: new AbortController().signal,
    });

    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.rawCardinality).toBe(2);
      expect(page.ended).toBe(true);
      expect(page.rows).toHaveLength(2);
    }
  });

  it('keeps a full page open and advances the offset by the raw cardinality including undecodable rows', async () => {
    const harness = scriptedClient([json({
      count: 2,
      value: [authoredPage.value[0], { pullRequestId: 'not-a-number' }],
    })]);

    const page = await readAzurePullRequestLanePage({
      client: harness.client,
      projectId: PROJECT_ID,
      repositoryId: REPO_GATEWAY,
      lane: 'authored',
      viewerId: VIEWER_ID,
      top: 2,
      skip: 0,
      signal: new AbortController().signal,
    });

    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.ended).toBe(false);
      expect(page.rawCardinality).toBe(2);
      expect(page.undecodable).toBe(1);
      expect(page.rows).toHaveLength(1);
    }
  });

  it('attributes a failed lane rather than presenting it as an empty result', async () => {
    const harness = scriptedClient([{
      status: 429,
      headers: { 'retry-after': '60' },
      bodyText: '',
    }]);

    const page = await readAzurePullRequestLanePage({
      client: harness.client,
      projectId: PROJECT_ID,
      repositoryId: REPO_GATEWAY,
      lane: 'authored',
      viewerId: VIEWER_ID,
      top: 25,
      skip: 0,
      signal: new AbortController().signal,
    });

    expect(page.ok).toBe(false);
    if (!page.ok) {
      expect(page.failure.class).toBe('rateLimit');
      expect(page.failure.retryNotBeforeMs).toBe(1_700_000_000_000 + 60_000);
    }
    expect(harness.calls).toHaveLength(1);
  });
});
