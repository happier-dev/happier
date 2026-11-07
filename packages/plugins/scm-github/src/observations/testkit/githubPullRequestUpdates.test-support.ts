import { ConversationPollResultV1Schema } from '@happier-dev/channels-protocol/v1';
import type { GithubApiMediaClientV1 } from '../githubApiClient.js';
import { pollGithubIssueCommentsForChannels } from '../githubIssueCommentPollRuntime.js';

const config = { v: 1 as const, repository: { v: 1 as const, repositoryId: '77', owner: 'acme', name: 'widgets', nameWithOwner: 'acme/widgets' }, integrationPrincipal: { id: '99', label: 'owner' } };
const endpoint = { kind: 'githubPullRequest' as const, audience: 'shared' as const, id: 'github:repository:77:issue:5:number:1', pullRequest: { repository: 'acme/widgets', number: 1 } };
const at = '2026-08-10T12:00:00Z';
const later = '2026-08-10T12:01:00Z';
const user = { id: 99, login: 'owner', type: 'User' };
function response(body: unknown, headers: Record<string, string> = {}) { return { status: 200, headers: {
  'x-ratelimit-remaining': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1_000) + 3_600), ...headers,
}, body: new TextEncoder().encode(JSON.stringify(body)) }; }

export function createGithubPullRequestUpdatesFixture() {
  const requests: string[] = [];
  const state = { sha: 'a'.repeat(40), mergeable: true as boolean | null, state: 'open', merged: false, headRepositoryFullName: 'acme/widgets' as string | null, headRepositoryId: 77, inline: [] as unknown[], reviews: [] as unknown[], events: [] as unknown[], comments: [] as unknown[], checks: [] as unknown[], inlinePageSize: 100, afterInlinePage: null as (() => void) | null,
    nativeSummary: {} as Record<string, unknown>, graphqlErrors: [] as unknown[] };
  const client: GithubApiMediaClientV1 = {
    requestWithoutFollowingRedirects: async () => { throw new Error('No redirect reads'); },
    async requestMedia({ url }) { requests.push(url); return { status: 200, headers: {}, body: new TextEncoder().encode('2026-08-10T12:00:00Z ##[group]Run test\n2026-08-10T12:00:00Z assertion failed\n2026-08-10T12:00:00Z ##[endgroup]\n') }; },
    async request({ url, body }) {
      requests.push(url);
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/issues/comments')) return response(state.comments);
      if (parsed.pathname.endsWith('/issues/1')) return response({ id: 5, number: 1, pull_request: {} });
      if (parsed.pathname === '/repositories/77/pulls/1') return response({ number: 1, base: { repo: { id: 77 } }, head: { sha: state.sha, ref: 'feature', repo: { id: state.headRepositoryId, ...(state.headRepositoryFullName === null ? {} : { full_name: state.headRepositoryFullName }) } }, state: state.state, merged: state.merged, mergeable: state.mergeable, updated_at: later,
        closed_at: state.state === 'closed' || state.merged ? later : null, merged_at: state.merged ? later : null, user });
      if (parsed.pathname.endsWith('/pulls/comments')) {
        const since = Date.parse(parsed.searchParams.get('since') ?? '1970-01-01T00:00:00Z');
        const updatedAt = (raw: unknown) => typeof raw === 'object' && raw !== null && 'updated_at' in raw && typeof raw.updated_at === 'string' ? Date.parse(raw.updated_at) : 0;
        const inline = state.inline.filter(raw => updatedAt(raw) >= since).sort((left, right) => updatedAt(left) - updatedAt(right));
        const page = Number(parsed.searchParams.get('page') ?? 1);
        const next = new URL(url); next.searchParams.set('page', String(page + 1));
        const result = response(inline.slice((page - 1) * state.inlinePageSize, page * state.inlinePageSize), inline.length > page * state.inlinePageSize ? { link: `<${next}>; rel="next"` } : {});
        state.afterInlinePage?.();
        return result;
      }
      if (parsed.pathname.endsWith('/pulls/1/reviews')) {
        const page = Number(parsed.searchParams.get('page') ?? 1);
        const perPage = Number(parsed.searchParams.get('per_page') ?? 30);
        const next = new URL(url); next.searchParams.set('page', String(page + 1));
        return response(state.reviews.slice((page - 1) * perPage, page * perPage),
          state.reviews.length > page * perPage ? { link: `<${next}>; rel="next"` } : {});
      }
      if (/\/reviews\/\d+\/comments$/u.test(parsed.pathname)) return response(state.inline);
      if (parsed.pathname.endsWith('/events')) return response(state.events);
      if (parsed.pathname.endsWith('/permission')) return response({ permission: 'write', user });
      if (parsed.pathname === '/graphql') {
        const query: unknown = JSON.parse(new TextDecoder().decode(body));
        const includeSummary = typeof query === 'object' && query !== null && 'variables' in query
          && typeof query.variables === 'object' && query.variables !== null && 'includeSummary0' in query.variables
          && query.variables.includeSummary0 === true;
        return response({
        data: {
          row0: {
            databaseId: 77,
            pullRequest: {
              headRefOid: state.sha,
              reviewDecision: 'APPROVED',
              commits: {
                nodes: [{ commit: { oid: state.sha, statusCheckRollup: {
                  contexts: { nodes: state.checks, pageInfo: { hasNextPage: false } },
                } } }],
              },
              ...(includeSummary ? { mergeStateStatus: 'CLEAN',
                reviewThreads: { nodes: [], pageInfo: { hasPreviousPage: false } }, ...state.nativeSummary } : {}),
            },
          },
        },
        ...(state.graphqlErrors.length === 0 ? {} : { errors: state.graphqlErrors }),
      });
      }
      if (parsed.pathname.endsWith('/actions/runs/81/attempts/2')) return response({ id: 81, run_attempt: 2, head_sha: state.sha, status: 'completed', conclusion: 'failure', repository: { full_name: 'acme/widgets' } });
      if (parsed.pathname.endsWith('/actions/runs/81/attempts/2/jobs')) return response({ total_count: 1, jobs: [{ id: 91, run_id: 81, run_attempt: 2, head_sha: state.sha, name: 'Tests', status: 'completed', conclusion: 'failure', steps: [{ number: 1, name: 'Run test', status: 'completed', conclusion: 'failure', started_at: at, completed_at: later }] }] });
      throw new Error(`Unexpected request ${url}`);
    },
  };
  const input = { client, config, checkpoint: null as unknown, limit: 100, connectionId: 'connection-1', providerConnectionKey: 'github:repository:77', pullRequestEndpoints: [endpoint], feedbackEndpoints: [endpoint], ciEndpoints: [] as typeof endpoint[], commentDemand: true, nowMs: Date.parse(at) };
  return { state, requests, input, async poll() { const result = ConversationPollResultV1Schema.parse(await pollGithubIssueCommentsForChannels(input)); if (result.kind !== 'batch' && result.kind !== 'checkpointOnly') throw new Error('Expected successful poll'); input.checkpoint = result.checkpointAfterBatch; return result.kind === 'batch' ? result.observations.flatMap(row => row.observation.kind === 'fullText' ? [row.observation.observation] : []) : []; } };
}

export { endpoint as githubPullRequestUpdatesEndpoint, at as githubPullRequestUpdatesAt,
  later as githubPullRequestUpdatesLater, user as githubPullRequestUpdatesActor };
