import { describe, expect, it } from 'vitest';
import { GithubIssueCommentPollResponseError, pollGithubIssueCommentsForChannels } from './githubIssueCommentPollRuntime.js';
import type { GithubApiClientV1 } from './githubApiClient.js';

const config = {
  v: 1 as const,
  repository: { v: 1 as const, repositoryId: '77', owner: 'acme', name: 'widgets', nameWithOwner: 'acme/widgets' },
  integrationPrincipal: { id: '99', label: 'happier-bot' },
};
const endpoint = { kind: 'githubPullRequest' as const, audience: 'shared' as const,
  id: 'github:repository:77:issue:5:number:1', parentId: '77', parentLabel: 'acme/widgets' };
const checkpoint = { v: 1, updatedAtIso: '2026-08-10T12:00:00Z', commentIdAtUpdatedAt: '0', etag: null };
function response(body: unknown, status = 200) {
  return { status, headers: {
    'x-ratelimit-remaining': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1_000) + 3_600),
  }, body: new TextEncoder().encode(JSON.stringify(body)) };
}

describe('GitHub Channel CI observations', () => {
  it.each([false, true])('batches only CI-demanded PRs and preserves captured-head correspondence (advanced=%s)', async advanced => {
    const urls: string[] = [];
    const endpoints = [1, 2, 3].map(number => ({ ...endpoint, id: `github:repository:77:issue:${number + 4}:number:${number}` }));
    const client = { requestWithoutFollowingRedirects: async () => { throw new Error('No redirects'); },
      request: async (input: Parameters<GithubApiClientV1['request']>[0]) => {
        urls.push(input.url);
        const pathname = new URL(input.url).pathname;
        const pr = /\/pulls\/(\d+)$/u.exec(pathname);
        if (pr) return response({ number: Number(pr[1]), base: { repo: { id: 77 } }, state: 'open', mergeable: true,
          head: { sha: `head-${pr[1]}`, ref: `feature-${pr[1]}` } });
        if (pathname === '/graphql') {
          // GitHub HTTP is the boundary: honor the requested aliases and the summary selection.
          const { variables } = JSON.parse(new TextDecoder().decode(input.body)) as { variables: Record<string, unknown> };
          const data: Record<string, unknown> = {};
          for (const [key, number] of Object.entries(variables)) {
            if (!key.startsWith('number')) continue;
            expect(number).not.toBe(3);
            const suffix = key.slice('number'.length);
            const head = advanced && number === 2 ? 'advanced-2' : `head-${number}`;
            data[suffix ? `row${suffix}` : 'repository'] = { databaseId: 77, pullRequest: {
              headRefOid: head, reviewDecision: 'APPROVED',
              ...(variables[`includeSummary${suffix}`] === true ? {
                mergeStateStatus: 'CLEAN', reviewThreads: { nodes: [], pageInfo: { hasPreviousPage: false } },
              } : {}),
              commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: {
                nodes: [{ __typename: 'StatusContext', id: `check-${number}`, context: 'Tests', state: 'SUCCESS', isRequired: true,
                  createdAt: '2026-08-10T12:00:00Z', updatedAt: '2026-08-10T12:00:01Z' }],
                pageInfo: { hasNextPage: false },
              } } } }] },
            } };
          }
          return response({ data });
        }
        throw new Error(`Unexpected request ${input.url}`);
      },
    } satisfies GithubApiClientV1;
    const result = await pollGithubIssueCommentsForChannels({ client, config, checkpoint, limit: 10,
      connectionId: 'connection-1', providerConnectionKey: 'github:repository:77', commentDemand: false,
      pullRequestEndpoints: endpoints, ciEndpoints: endpoints.slice(0, 2), nowMs: 1000,
      signal: new AbortController().signal });
    expect(result.kind).toBe('batch');
    if (result.kind !== 'batch') throw new Error('Expected CI observations');
    const checks = result.observations.flatMap(row => row.observation.kind === 'fullText'
      && row.observation.observation.pullRequestUpdate?.event.kind === 'check' ? [row.observation.observation] : []);
    expect(checks).toHaveLength(advanced ? 1 : 2);
    expect(result.pullRequestEndpoints?.[0]).toMatchObject({ pullRequestState: { fixResolution: {
      headRevision: 'head-1', resolved: true, incomplete: false,
    } } });
    expect(result.pullRequestEndpoints?.[1]).toMatchObject({ pullRequestState: { fixResolution: {
      headRevision: advanced ? 'advanced-2' : 'head-2', resolved: !advanced, incomplete: advanced,
    } } });
    expect(result.pullRequestEndpoints?.[2]?.kind === 'githubPullRequest' && result.pullRequestEndpoints[2].pullRequestState)
      .not.toHaveProperty('fixResolution');
    expect(urls.filter(url => new URL(url).pathname === '/graphql')).toHaveLength(1);
    expect(urls).toHaveLength(4); // Three stable PR reads and one demanded checks batch.
    expect(urls.filter(url => new URL(url).pathname.startsWith('/repositories/77/pulls/'))).toHaveLength(3);
  });

  it('reads one immutable repository route per cycle across rename/reuse and still publishes changed PR state', async () => {
    const urls: string[] = [];
    let state = 'open';
    const client: GithubApiClientV1 = {
      requestWithoutFollowingRedirects: async () => { throw new Error('No redirect reads'); },
      request: async ({ url }) => {
        urls.push(url);
        // The old owner/name is now another repository. It must never be read.
        if (new URL(url).pathname === '/repos/acme/widgets/issues/1') {
          return response({ id: 999, number: 1, pull_request: {} });
        }
        expect(new URL(url).pathname).toBe('/repositories/77/pulls/1');
        return response({ id: 123, number: 1, base: { repo: { id: 77, full_name: 'renamed/widgets' } }, state, merged: state === 'merged' });
      },
    };
    let previous = endpoint;
    for (const [index, nextState] of ['open', 'open', 'merged'].entries()) {
      state = nextState;
      const result = await pollGithubIssueCommentsForChannels({ client, config, checkpoint, limit: 10,
        connectionId: 'connection-1', providerConnectionKey: 'github:repository:77', commentDemand: false,
        pullRequestEndpoints: [previous], nowMs: index + 1 });
      const next = result.kind === 'batch' || result.kind === 'checkpointOnly' ? result.pullRequestEndpoints?.[0] : undefined;
      expect(next).toMatchObject({ pullRequestState: { state: nextState } });
      if (next?.kind !== 'githubPullRequest') throw new Error('Expected PR state');
      if (index === 1) expect(next).toBe(previous);
      previous = { ...previous, ...next };
      expect(urls).toHaveLength(index + 1);
    }
  });

  it.each([301, 404, 403])('preserves unavailable status %s with one read and no mutable-route fallback', async status => {
    const urls: string[] = [];
    const client: GithubApiClientV1 = {
      requestWithoutFollowingRedirects: async () => { throw new Error('No redirect reads'); },
      request: async ({ url }) => { urls.push(url); return response({}, status); },
    };
    await expect(pollGithubIssueCommentsForChannels({ client, config, checkpoint, limit: 10,
      connectionId: 'connection-1', providerConnectionKey: 'github:repository:77', commentDemand: false,
      pullRequestEndpoints: [endpoint] })).rejects.toMatchObject({
        constructor: GithubIssueCommentPollResponseError, response: { status },
      });
    expect(urls).toEqual(['https://api.github.com/repositories/77/pulls/1']);
  });

  it.each([
    { number: 1, base: { repo: { id: 999 } } },
    { number: 2, base: { repo: { id: 77 } } },
    { number: 1 },
  ])('refuses a PR representation outside the pinned repository/number', async body => {
    const client: GithubApiClientV1 = {
      requestWithoutFollowingRedirects: async () => { throw new Error('No redirect reads'); },
      request: async () => response(body),
    };
    await expect(pollGithubIssueCommentsForChannels({ client, config, checkpoint, limit: 10,
      connectionId: 'connection-1', providerConnectionKey: 'github:repository:77', commentDemand: false,
      pullRequestEndpoints: [endpoint] })).rejects.toBeInstanceOf(RangeError);
  });

  it.each([['open', false, 'open'], ['closed', true, 'merged'], ['closed', false, 'closed'], ['unexpected', false, 'unknown']] as const)(
    'refreshes exact PR state without comments or a CI subscription: %s', async (state, merged, expected) => {
      const client = { requestWithoutFollowingRedirects: async () => { throw new Error('No redirects'); }, request: async ({ url }: Parameters<GithubApiClientV1['request']>[0]) => {
        if (url.includes('/issues/comments')) return response([]);
        if (url.endsWith('/pulls/1')) return response({ id: 123, number: 1, base: { repo: { id: 77 } }, state, merged, draft: true });
        throw new Error(`Unexpected request ${url}`);
      } } satisfies GithubApiClientV1;
      const result = await pollGithubIssueCommentsForChannels({ client, config, checkpoint, limit: 10,
        connectionId: 'connection-1', providerConnectionKey: 'github:repository:77',
        pullRequestEndpoints: [endpoint], nowMs: 1000, signal: new AbortController().signal });
      expect(result).toMatchObject({ kind: 'batch', pullRequestEndpoints: [{ ...endpoint,
        pullRequest: { repository: 'acme/widgets', number: 1 },
        pullRequestState: { state: expected, observedAt: 1000 },
      }] });
      expect(result.kind === 'batch' ? result.observations : []).toEqual([]);
    });

  it.each([
    ['writer', 'write', 99, true, true, '2026-08-10T11:59:59Z'], ['reader', 'read', 99, false, true, '2026-08-10T11:59:59Z'],
    ['unknown', 'unexpected', 99, null, true, '2026-08-10T11:59:59Z'], ['identity mismatch', 'write', 123, null, true, '2026-08-10T11:59:59Z'],
    ['missing provider timestamps', 'write', 99, true, false, '2026-08-10T11:59:59Z'],
    ['missing suite timestamp', 'write', 99, true, false, null], ['invalid suite timestamp', 'write', 99, true, false, 'invalid'],
    ['multiple failed checks', 'write', 99, true, true, '2026-08-10T11:59:59Z'],
  ] as const)('observes failed checks with authenticated principal evidence: %s', async (_name, permission, id, access, hasTimestamps, suiteCreatedAt) => {
    const nowMs = Date.parse('2026-08-10T12:00:02Z');
    const urls: string[] = [];
    const client = { requestWithoutFollowingRedirects: async () => { throw new Error('No redirect reads expected'); }, request: async (input: Parameters<GithubApiClientV1['request']>[0]) => {
      urls.push(input.url);
      if (input.url.includes('/issues/comments')) return response([]);
      if (input.url.endsWith('/pulls/1')) return response({ number: 1, base: { repo: { id: 77 } }, head: { sha: 'abc123', ref: 'feature' } });
      if (input.url.endsWith('/permission')) return response({ permission, user: { id, login: 'happier-bot' } });
      if (input.url.endsWith('/graphql')) return response({ data: { row0: { databaseId: 77, pullRequest: {
        headRefOid: 'abc123', commits: { nodes: [{ commit: { oid: 'abc123', statusCheckRollup: {
          contexts: { nodes: (_name === 'multiple failed checks' ? ['check-1', 'check-2'] : ['check-1']).map((checkId) => ({ __typename: 'CheckRun', id: checkId, name: checkId === 'check-1' ? 'Tests' : 'Lint', status: 'COMPLETED',
            conclusion: 'FAILURE', detailsUrl: null, checkSuite: { createdAt: suiteCreatedAt }, startedAt: hasTimestamps ? '2026-08-10T12:00:00Z' : null,
            completedAt: hasTimestamps ? '2026-08-10T12:00:01Z' : null, isRequired: false })), pageInfo: { hasNextPage: false } },
        } } }] },
      } } } });
      throw new Error(`Unexpected request ${input.url}`);
    } } satisfies GithubApiClientV1;
    const input = { client, config, checkpoint, limit: 10, connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77', ciEndpoints: [endpoint], nowMs, signal: new AbortController().signal };
    const first = await pollGithubIssueCommentsForChannels(input);
    expect(first.kind).toBe('batch');
    if (first.kind !== 'batch') throw new Error('Expected failed CI batch');
    if (suiteCreatedAt === null || suiteCreatedAt === 'invalid') {
      expect(first.observations).toEqual([]);
      expect(urls.some((url) => url.endsWith('/permission'))).toBe(false);
      return;
    }
    expect(first.observations).toHaveLength(_name === 'multiple failed checks' ? 2 : 1);
    expect(first.observations[0]).toMatchObject({ eventCandidate: null, observation: { kind: 'fullText', observation: {
      endpoint, scopedTriggerKind: 'ciFailed', occurredAt: Date.parse(hasTimestamps ? '2026-08-10T12:00:01Z' : '2026-08-10T11:59:59Z'),
      actor: { principalId: '99', kind: 'integration', repositoryWriteAccess: access },
      message: { providerTimestamp: Date.parse(hasTimestamps ? '2026-08-10T12:00:01Z' : '2026-08-10T11:59:59Z'),
        text: expect.stringContaining('Tests') },
    } } });
    expect(urls).toContain('https://api.github.com/repos/acme/widgets/collaborators/happier-bot/permission');
    const replay = await pollGithubIssueCommentsForChannels({ ...input, checkpoint: first.checkpointAfterBatch });
    expect(replay.kind === 'batch' ? replay.observations : []).toEqual([]);
    const lostResponseReplay = await pollGithubIssueCommentsForChannels({ ...input, nowMs: nowMs + 60_000 });
    // A replay retains native evidence, not the freshness of the endpoint's
    // mutable PR-state enrichment. The core dedupes the admitted native event.
    const expectedReplay = first.observations.map(entry => {
      if (entry.observation.kind !== 'fullText') throw new Error('Expected full CI observation');
      const observation = entry.observation.observation;
      if (observation.endpoint.kind !== 'githubPullRequest') throw new Error('Expected GitHub PR endpoint');
      const pullRequestState = observation.endpoint.pullRequestState;
      if (pullRequestState === undefined) throw new Error('Expected current PR state enrichment');
      expect(pullRequestState.observedAt).toBe(nowMs);
      return { ...entry, observation: { ...entry.observation, observation: { ...observation,
        endpoint: { ...observation.endpoint, pullRequestState: { ...pullRequestState, observedAt: nowMs + 60_000 } },
      } } };
    });
    expect(lostResponseReplay.kind === 'batch' ? lostResponseReplay.observations : []).toEqual(expectedReplay);
  });

  it('projects successful CI as one passed status transition', async () => {
    const client = { requestWithoutFollowingRedirects: async () => { throw new Error('No redirect reads expected'); }, request: async (input: Parameters<GithubApiClientV1['request']>[0]) => {
      if (input.url.includes('/issues/comments')) return response([]);
      if (input.url.endsWith('/pulls/1')) return response({ number: 1, base: { repo: { id: 77 } }, head: { sha: 'abc123', ref: 'feature' } });
      if (input.url.endsWith('/graphql')) return response({ data: { row0: { databaseId: 77, pullRequest: {
        headRefOid: 'abc123', commits: { nodes: [{ commit: { oid: 'abc123', statusCheckRollup: {
          contexts: { nodes: [{ __typename: 'CheckRun', id: 'check-1', name: 'Tests', status: 'COMPLETED',
            conclusion: 'SUCCESS', detailsUrl: null, startedAt: null, completedAt: '2026-08-10T12:00:01Z',
            isRequired: false }], pageInfo: { hasNextPage: false } },
        } } }] },
      } } } });
      throw new Error(`Unexpected request ${input.url}`);
    } } satisfies GithubApiClientV1;
    const input = { client, config, checkpoint, limit: 10, connectionId: 'connection-1',
      providerConnectionKey: 'github:repository:77', ciEndpoints: [endpoint], signal: new AbortController().signal };
    const result = await pollGithubIssueCommentsForChannels(input);
    expect(result.kind === 'batch' ? result.observations : []).toMatchObject([{ observation: { kind: 'fullText', observation: { pullRequestUpdate: { event: { kind: 'check', state: 'passed', name: 'Tests' } } } } }]);
  });
});
