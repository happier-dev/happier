import { describe, expect, it } from 'vitest';
import { readGithubPullRequestChecks } from './checks.js';
import { createStubGithubTransport, createTestGithubApiClient, fixedClock } from './testkit/githubTriage.test-support.js';
import { projectGithubCheckRows, GITHUB_DETAIL_BOUNDS_V1 } from './detail/projection.js';
import { GithubProjectedCheckRowV1Schema } from './detail/contracts.js';
import { readGithubChecksConditionBatch } from './checksCondition.js';
import { readRecordedJsonBody } from './testkit/githubTriage.test-support.js';

const sha = 'a'.repeat(40);
// Synthetic response shapes from GitHub GraphQL Checks/Commits documentation,
// consulted 2026-10-02. Only HTTP/Connected Account boundaries are faked.
function page(nodes: readonly unknown[], head = sha, next: string | null = null) {
  return { data: { repository: { pullRequest: { headRefOid: head, commits: { nodes: [{ commit: {
    oid: head, statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } },
  } }] } } } } };
}
function check(conclusion: string | null, required = true) {
  return { __typename: 'CheckRun', id: 'check-1', name: 'build', isRequired: required,
    status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED', conclusion,
    detailsUrl: null, startedAt: null, completedAt: null, checkSuite: { createdAt: '2026-08-10T11:59:59Z' } };
}
async function observe(nodes: readonly unknown[], selection: 'all' | 'required' = 'all', head = sha) {
  const transport = createStubGithubTransport({ respond: (request) => request.url.endsWith('/graphql')
    ? { status: 200, body: page(nodes, head) }
    : { status: 200, body: request.url.includes('/check-runs') ? { total_count: 0, check_runs: [] } : { statuses: [] } } });
  const client = await createTestGithubApiClient(transport);
  const input = { route: { owner: 'octo-org', name: 'example-app' }, headSha: sha,
    observation: { pullRequestNumber: 7, selection } };
  const surface = await readGithubPullRequestChecks(input, { client, now: fixedClock(1000), signal: transport.context.signal });
  return { snapshot: surface.observation, transport };
}

describe('PR checks conditions at the GitHub checks reader', () => {
  it.each(['failure', 'head-change', 'repeated-cursor'] as const)('batches only unfinished connections and keeps %s on a later page', async (later) => {
    const requests: Array<{ query: string; variables: Record<string, unknown> }> = [];
    const repository = (nodes: readonly unknown[], head = sha, next: string | null = null) => ({
      ...page(nodes, head, next).data.repository, databaseId: 4210,
    });
    const transport = createStubGithubTransport({ respond: request => {
      requests.push(readRecordedJsonBody(request) as typeof requests[number]);
      return { status: 200, body: { data: requests.length === 1 ? {
        row0: repository([check('SUCCESS')], sha, 'next'), row1: repository([check('SUCCESS')]),
        row2: { databaseId: 8815 },
      } : { row0: repository([{ ...check('FAILURE'), id: 'check-2' }], later === 'head-change' ? 'b'.repeat(40) : sha,
        later === 'repeated-cursor' ? 'next' : null) } } };
    } });
    const client = await createTestGithubApiClient(transport);
    const reads = await readGithubChecksConditionBatch([
      { route: { owner: 'octo-org', name: 'example-app' }, pullRequestNumber: 7 },
      { route: { owner: 'octo-org', name: 'example-app' }, pullRequestNumber: 8 },
      { route: { owner: 'octo-org', name: 'example-tools' } },
    ], { client, now: fixedClock(1000), signal: transport.context.signal });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.variables).toEqual({ owner0: 'octo-org', name0: 'example-app', number0: 7,
      cursor0: 'next', includeSummary0: false, includeOutput0: false });
    expect(reads[0]?.surface?.observation).toMatchObject({
      state: later === 'failure' ? 'failed' : later === 'head-change' ? 'superseded' : 'unknown', passed: false,
    });
    expect(reads[1]?.surface?.rowState).toEqual({ kind: 'allPassing' });
    expect(reads[2]).toEqual({ repositoryId: '8815', surface: null });
  });

  it.each([{ path: ['row0', 'pullRequest'] }, { path: [] }])('applies GraphQL errors only to their declared path $path', async ({ path }) => {
    const transport = createStubGithubTransport({ respond: () => ({ status: 200, body: {
      data: { row0: { databaseId: 4210, pullRequest: null }, row1: { databaseId: 4210,
        ...page([check('SUCCESS')]).data.repository } },
      errors: [{ type: 'FORBIDDEN', path, message: 'Resource not accessible' }],
    } }) });
    const client = await createTestGithubApiClient(transport);
    const reads = await readGithubChecksConditionBatch([7, 8].map(pullRequestNumber => ({
      route: { owner: 'octo-org', name: 'example-app' }, pullRequestNumber,
    })), { client, now: fixedClock(1000), signal: transport.context.signal });
    expect(reads[0]?.surface).toMatchObject({ state: 'unknown', checkRunsFailure: { code: 'github_forbidden' } });
    expect(reads[1]?.surface?.rowState).toEqual(path.length === 0 ? null : { kind: 'allPassing' });
    if (path.length === 0) expect(reads[1]?.surface?.checkRunsFailure?.code).toBe('github_forbidden');
    expect(transport.requests).toHaveLength(1);
  });

  it.each(['permission', 'transport', 'malformed'] as const)('settles a %s batch with unknown facts and no invented head', async (failure) => {
    const transport = createStubGithubTransport({ respond: () => {
      if (failure === 'transport') throw new Error('offline');
      return failure === 'permission' ? { status: 403, body: { message: 'Forbidden' } } : { status: 200, body: null };
    } });
    const client = await createTestGithubApiClient(transport);
    const reads = await readGithubChecksConditionBatch([7, 8].map(pullRequestNumber => ({
      route: { owner: 'octo-org', name: 'example-app' }, pullRequestNumber,
    })), { client, now: fixedClock(1000), signal: transport.context.signal });
    for (const read of reads) {
      expect(read.repositoryId).toBeNull();
      expect(read.surface).toMatchObject({ state: 'unknown', rowState: null, checkRunsFailure: {
        class: failure === 'permission' ? 'permission' : failure === 'transport' ? 'transient' : 'unsupportedContract',
      } });
      expect(read.surface?.observation).toBeUndefined();
    }
    expect(transport.requests).toHaveLength(1);
  });

  it('cancels an unfinished connection without starting another read', async () => {
    const controller = new AbortController();
    let count = 0;
    const transport = createStubGithubTransport({ signal: controller.signal, respond: () => {
      if (++count === 2) controller.abort();
      return { status: 200, body: { data: { row0: { ...page([check('SUCCESS')], sha, 'next').data.repository,
        databaseId: 4210 } } } };
    } });
    const client = await createTestGithubApiClient(transport);
    await expect(readGithubChecksConditionBatch([{ route: { owner: 'octo-org', name: 'example-app' }, pullRequestNumber: 7 }],
      { client, now: fixedClock(1000), signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(transport.requests).toHaveLength(2);
  });

  it('carries exact Actions provenance and annotation total from already-demanded CheckSuite facts', async () => {
    const native = { ...check('FAILURE'), databaseId: 701, annotations: { totalCount: 12 }, checkSuite: {
      createdAt: '2026-08-10T11:59:59Z', app: { slug: 'github-actions' },
      commit: { oid: sha }, repository: { nameWithOwner: 'octo-org/example-app' },
      workflowRun: { databaseId: 81, runAttempt: 2 },
    } };
    const transport = createStubGithubTransport({ respond: () => ({ status: 200, body: page([native]) }) });
    const client = await createTestGithubApiClient(transport);
    const surface = await readGithubPullRequestChecks({ route: { owner: 'octo-org', name: 'example-app' }, headSha: sha, observation: { pullRequestNumber: 7, selection: 'all' } }, { client, now: fixedClock(1000), signal: transport.context.signal });
    const rows = projectGithubCheckRows(surface.observations, GITHUB_DETAIL_BOUNDS_V1).rows;
    expect(GithubProjectedCheckRowV1Schema.parse(rows[0])).toMatchObject({ annotationsCount: 12, actions: {
      checkRunId: '701', headSha: sha, selection: { kind: 'attempt', attempt: { run: { runId: '81' }, attemptId: '2' } },
    } });
    expect(transport.requests).toHaveLength(1);
    const external = await observe([{ ...native, checkSuite: { ...native.checkSuite, app: { slug: 'external-checks' } } }]);
    expect(external.snapshot?.state).toBe('failed');
  });
  it.each([
    ['SUCCESS', 'passed', true, true], ['FAILURE', 'failed', true, false],
    [null, 'pending', false, false], ['CANCELLED', 'neutral', true, false],
  ] as const)('observes %s without confusing completed with passed', async (conclusion, state, complete, passed) => {
    expect((await observe([check(conclusion)])).snapshot).toMatchObject({ headSha: sha, currentHeadSha: sha, selection: 'all', state, complete, passed });
  });
  it('returns explicit none, never vacuous success', async () => {
    expect((await observe([])).snapshot).toMatchObject({ state: 'none', complete: false, passed: false });
  });
  it('uses provider-required evidence for both check runs and legacy statuses', async () => {
    const nodes = [check('FAILURE', false), { __typename: 'StatusContext', id: 'status-1',
      context: 'legacy', state: 'SUCCESS', isRequired: true, targetUrl: null, createdAt: null, updatedAt: null }];
    expect((await observe(nodes, 'required')).snapshot).toMatchObject({ state: 'passed', complete: true, passed: true });
    expect((await observe(nodes, 'all')).snapshot).toMatchObject({ state: 'failed', passed: false });
    expect((await observe([check('SUCCESS', false)], 'required')).snapshot).toMatchObject({ state: 'none', passed: false });
  });
  it('supersedes the chosen head when the PR moves instead of accepting its green checks', async () => {
    expect((await observe([check('SUCCESS')], 'all', 'b'.repeat(40))).snapshot).toMatchObject({
      state: 'superseded', headSha: sha, currentHeadSha: 'b'.repeat(40), complete: false, passed: false,
    });
  });
  it('reads every page and refuses a head change between pages', async () => {
    let count = 0;
    const transport = createStubGithubTransport({ respond: (request) => request.url.endsWith('/graphql')
      ? { status: 200, body: ++count === 1 ? page([check('SUCCESS')], sha, 'next') : page([check('FAILURE')], 'b'.repeat(40)) }
      : { status: 200, body: { statuses: [], check_runs: [] } } });
    const client = await createTestGithubApiClient(transport);
    const input = { route: { owner: 'octo-org', name: 'example-app' }, headSha: sha,
      observation: { pullRequestNumber: 7, selection: 'all' as const } };
    const result = await readGithubPullRequestChecks(input, { client, now: fixedClock(1000), signal: transport.context.signal });
    expect(result.observation).toMatchObject({ state: 'superseded', passed: false });
    expect(count).toBe(2);
  });
  it('carries withheld permission as unknown evidence instead of a green or no-checks observation', async () => {
    const transport = createStubGithubTransport({ respond: () => ({ status: 403, body: { message: 'Resource not accessible' } }) });
    const client = await createTestGithubApiClient(transport);
    const result = await readGithubPullRequestChecks({ route: { owner: 'octo-org', name: 'example-app' }, headSha: sha,
      observation: { pullRequestNumber: 7, selection: 'all' } }, { client, now: fixedClock(1000), signal: transport.context.signal });
    expect(result.observation).toMatchObject({ state: 'unknown', passed: false, failure: { class: 'permission' } });
  });
  it('does not preserve green evidence when the provider transport fails', async () => {
    const transport = createStubGithubTransport({ respond: () => { throw new Error('offline'); } });
    const client = await createTestGithubApiClient(transport);
    const result = await readGithubPullRequestChecks({ route: { owner: 'octo-org', name: 'example-app' }, headSha: sha,
      observation: { pullRequestNumber: 7, selection: 'all' } }, { client, now: fixedClock(1000), signal: transport.context.signal });
    expect(result.observation).toMatchObject({ state: 'unknown', passed: false, failure: { class: 'transient' } });
  });
  it('does not reuse green evidence after an undecodable provider answer', async () => {
    const transport = createStubGithubTransport({ respond: () => ({ status: 200, rawBody: new TextEncoder().encode('{') }) });
    const client = await createTestGithubApiClient(transport);
    const result = await readGithubPullRequestChecks({ route: { owner: 'octo-org', name: 'example-app' }, headSha: sha,
      observation: { pullRequestNumber: 7, selection: 'all' } }, { client, now: fixedClock(1000), signal: transport.context.signal });
    expect(result.observation).toMatchObject({ state: 'unknown', passed: false });
  });
  it('includes later-page failures instead of deciding from a green first page', async () => {
    let count = 0;
    const transport = createStubGithubTransport({ respond: () => ({ status: 200,
      body: ++count === 1 ? page([check('SUCCESS')], sha, 'next')
        : page([{ ...check('FAILURE'), id: 'check-2' }]),
    }) });
    const client = await createTestGithubApiClient(transport);
    const result = await readGithubPullRequestChecks({ route: { owner: 'octo-org', name: 'example-app' }, headSha: sha,
      observation: { pullRequestNumber: 7, selection: 'all' } }, { client, now: fixedClock(1000), signal: transport.context.signal });
    expect(result.observation).toMatchObject({ state: 'failed', passed: false, complete: true });
    expect(count).toBe(2);
  });
});
