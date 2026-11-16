import { SCM_OPERATION_ERROR_CODES, type ScmPullRequestSummary } from '@happier-dev/plugin-sdk/scm';
import type {
  HostingProviderPullRequestCreateInput, HostingProviderPullRequestGetInput,
  HostingProviderPullRequestListInput, HostingProviderPullRequestsCapability,
} from '@happier-dev/plugin-sdk/scm/hosting';
import { GitlabHostingError as GitlabPullRequestError, authorizeGitlabHosting, requestGitlabHosting as request } from '../hostingRequest.js';
import { buildGitlabApiUrl, GITLAB_REST_MAX_PAGE_SIZE } from '../triage/http/gitlabClient.js';
import { selectGitlabNextPageUrl } from '../triage/http/gitlabLink.js';
import { mapGitlabMergeRequest } from './gitlabMergeRequestMapping.js';

type InvocationInput = HostingProviderPullRequestCreateInput | HostingProviderPullRequestGetInput | HostingProviderPullRequestListInput;

export function createGitlabRestAdapter(): HostingProviderPullRequestsCapability {
  async function authorize(input: InvocationInput) {
    const name = input.provider.nameWithOwner?.trim();
    if (!name || name.split('/').some((part) => !part || part === '.' || part === '..' || /[\u0000-\u0020\u007f]/.test(part))) {
      throw new GitlabPullRequestError('GitLab repository identity is unavailable.', SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, true);
    }
    return { ...await authorizeGitlabHosting(input), name, path: `/projects/${encodeURIComponent(name)}/merge_requests` };
  }

  const adapter: HostingProviderPullRequestsCapability = {
    supportsDraftCreate: true,
    // The token seam currently exposes no exact credential revision. Never use
    // a shared ambient identity as authority for auth-sensitive cached PR reuse.
    getPullRequestAuthProfileKey: () => null,
    async listPullRequests(input) {
      const auth = await authorize(input);
      const query: Array<readonly [string, string]> = [
        ['state', input.state === 'closed' ? 'closed' : input.state === 'merged' ? 'merged' : input.state === 'unknown' ? 'all' : 'opened'],
        ['source_branch', input.head], ['per_page', String(GITLAB_REST_MAX_PAGE_SIZE)],
        ...(input.base ? [['target_branch', input.base] as const] : []),
      ];
      let url = buildGitlabApiUrl(auth.origin, auth.path, query);
      const seen = new Set<string>();
      const rows: ScmPullRequestSummary[] = [];
      while (true) {
        if (seen.has(url)) throw new GitlabPullRequestError('GitLab repeated a merge request continuation.', SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, true);
        seen.add(url);
        const response = await request({ ...auth, url });
        if (!Array.isArray(response.body)) throw new GitlabPullRequestError('GitLab returned an unreadable merge request list.', SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, true);
        for (const value of response.body) {
          const row = mapGitlabMergeRequest(input.provider, value);
          if (!row) throw new GitlabPullRequestError('GitLab returned an unreadable merge request row.', SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, true);
          rows.push(row);
        }
        const next = selectGitlabNextPageUrl(response.headers, auth.origin.origin);
        if (next.kind === 'end') return rows;
        if (next.kind !== 'next') throw new GitlabPullRequestError('GitLab merge request pagination could not be completed.', SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, true);
        url = next.url;
      }
    },
    async getPullRequest(input) {
      if (typeof input.reference.headBranch === 'string') {
        const matches = await adapter.listPullRequests({
          provider: input.provider, head: input.reference.headBranch,
          ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const match = matches.find((row) => row.headBranch === input.reference.headBranch);
        return match?.number ? adapter.getPullRequest({ ...input, reference: { number: match.number } }) : null;
      }
      const auth = await authorize(input);
      let number = typeof input.reference.number === 'number' ? input.reference.number : undefined;
      if (number == null && typeof input.reference.url === 'string') {
        const parsed = new URL(input.reference.url);
        const prefix = `${auth.origin.pathPrefix}/${auth.name}/-/merge_requests/`;
        if (parsed.origin !== auth.origin.origin || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.startsWith(prefix)) {
          throw new GitlabPullRequestError('GitLab merge request URL does not identify this repository.', SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, true);
        }
        const suffix = parsed.pathname.slice(prefix.length);
        if (/^[1-9]\d*$/.test(suffix)) number = Number(suffix);
      }
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) {
        throw new GitlabPullRequestError('A GitLab merge request number is required.', SCM_OPERATION_ERROR_CODES.INVALID_REQUEST, true);
      }
      const response = await request({ ...auth, url: buildGitlabApiUrl(auth.origin, `${auth.path}/${number}`) });
      const row = mapGitlabMergeRequest(input.provider, response.body, { includeDescription: true });
      if (!row) throw new GitlabPullRequestError('GitLab returned an unreadable merge request.', SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, true);
      return row;
    },
    async createPullRequest(input) {
      const auth = await authorize(input);
      const response = await request({
        ...auth, url: buildGitlabApiUrl(auth.origin, auth.path), method: 'POST',
        body: {
          source_branch: input.head, target_branch: input.base,
          title: input.draft && !/^(?:Draft:|WIP:)/i.test(input.title) ? `Draft: ${input.title}` : input.title,
          ...(input.body !== undefined ? { description: input.body } : {}),
        },
      });
      const row = mapGitlabMergeRequest(input.provider, response.body);
      if (!row) throw new GitlabPullRequestError('GitLab returned an unreadable created merge request.', SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
      return row;
    },
  };
  return Object.freeze(adapter);
}

export const gitlabRestPullRequestAdapter = createGitlabRestAdapter();
