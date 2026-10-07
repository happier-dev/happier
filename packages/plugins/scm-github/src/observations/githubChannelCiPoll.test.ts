import { describe, expect, it } from 'vitest';
import { pollGithubIssueCommentsForChannels } from './githubIssueCommentPollRuntime.js';
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
  return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}

describe('GitHub Channel CI observations', () => {
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
      if (input.url.endsWith('/issues/1')) return response({ id: 5, number: 1, pull_request: {} });
      if (input.url.endsWith('/pulls/1')) return response({ head: { sha: 'abc123' } });
      if (input.url.endsWith('/permission')) return response({ permission, user: { id, login: 'happier-bot' } });
      if (input.url.endsWith('/graphql')) return response({ data: { repository: { pullRequest: {
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
      expect(first.checkpointAfterBatch).not.toHaveProperty('pullRequestChecks');
      expect(urls.some((url) => url.endsWith('/permission'))).toBe(false);
      return;
    }
    expect(first.observations).toHaveLength(1);
    expect(first.observations[0]).toMatchObject({ eventCandidate: null, observation: { kind: 'fullText', observation: {
      endpoint, scopedTriggerKind: 'ciFailed', occurredAt: Date.parse(hasTimestamps ? '2026-08-10T12:00:01Z' : '2026-08-10T11:59:59Z'),
      actor: { principalId: '99', kind: 'integration', repositoryWriteAccess: access },
      message: { providerTimestamp: Date.parse(hasTimestamps ? '2026-08-10T12:00:01Z' : '2026-08-10T11:59:59Z'),
        text: expect.stringContaining(_name === 'multiple failed checks' ? 'Tests, Lint' : 'Tests') },
    } } });
    expect(urls).toContain('https://api.github.com/repos/acme/widgets/collaborators/happier-bot/permission');
    const replay = await pollGithubIssueCommentsForChannels({ ...input, checkpoint: first.checkpointAfterBatch });
    expect(replay.kind === 'batch' ? replay.observations : []).toEqual([]);
    const lostResponseReplay = await pollGithubIssueCommentsForChannels({ ...input, nowMs: nowMs + 60_000 });
    expect(lostResponseReplay.kind === 'batch' ? lostResponseReplay.observations : []).toEqual(first.observations);
  });

  it('does not turn successful CI into an observation', async () => {
    const client = { requestWithoutFollowingRedirects: async () => { throw new Error('No redirect reads expected'); }, request: async (input: Parameters<GithubApiClientV1['request']>[0]) => {
      if (input.url.includes('/issues/comments')) return response([]);
      if (input.url.endsWith('/issues/1')) return response({ id: 5, number: 1, pull_request: {} });
      if (input.url.endsWith('/pulls/1')) return response({ head: { sha: 'abc123' } });
      if (input.url.endsWith('/graphql')) return response({ data: { repository: { pullRequest: {
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
    expect(result.kind === 'batch' ? result.observations : []).toEqual([]);
  });
});
