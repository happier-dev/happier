import type { ScmPullRequestSummary } from '@happier-dev/protocol/scm/pullRequests';
import { createScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import { createGithubRestAdapter } from '../../../../../packages/plugins/scm-github/src/pullRequests/restAdapter';
import { createGithubRepositoryRestAdapter } from '../../../../../packages/plugins/scm-github/src/repositoryProvisioning/githubRepositoryRestAdapter';
import { githubHostingProviderAdapter, GITHUB_SCM_HOSTING_PROVIDER_ID } from '../../../../../packages/plugins/scm-github/src/adapter';
import { PLUGIN_MANIFEST } from '../../../../../packages/plugins/scm-github/src/manifest';

/** Fake Forge HTTP and token acquisition with the real registry and GitHub adapters. */
export function createGithubForgeHttpFixture(input: Readonly<{
  nameWithOwner: string; cloneUrl: string; repositoryExists?: boolean; pullRequestWriteStatus?: number;
}>) {
  const provider = { id: GITHUB_SCM_HOSTING_PROVIDER_ID, kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com',
    nameWithOwner: input.nameWithOwner, remoteName: 'origin', urlSafety: { allowedSchemes: ['https:'] } };
  let repositoryCreated = input.repositoryExists ?? true;
  let pullRequest: ScmPullRequestSummary | null = null;
  let tokenRequests = 0;
  const httpRequests: { method: string; path: string }[] = [];
  const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, statusText: 'Fixture',
    json: async () => body, text: async () => JSON.stringify(body) });
  const rawPullRequest = () => pullRequest && ({ number: pullRequest.number, title: pullRequest.title, html_url: pullRequest.url,
    state: pullRequest.state === 'merged' ? 'closed' : pullRequest.state, merged: pullRequest.state === 'merged',
    merge_commit_sha: pullRequest.mergeCommitSha, base: { ref: pullRequest.baseBranch }, head: { ref: pullRequest.headBranch,
      sha: pullRequest.headSha, repo: { full_name: input.nameWithOwner } } });
  const fetcher: NonNullable<Parameters<typeof createGithubRestAdapter>[0]>['fetcher'] = async (url, init) => {
    const parsed = new URL(url);
    httpRequests.push({ method: init?.method ?? 'GET', path: parsed.pathname });
    if (parsed.pathname === `/repos/${input.nameWithOwner}/pulls` && init?.method === 'POST') {
      if (input.pullRequestWriteStatus !== undefined) return response({ message: 'Forge unavailable' }, input.pullRequestWriteStatus);
      const request = JSON.parse(String(init.body)) as { base: string; head: string; title: string };
      pullRequest = { provider, number: 4, title: request.title, url: `https://github.com/${input.nameWithOwner}/pull/4`,
        baseBranch: request.base, headBranch: request.head, headRepositoryNameWithOwner: input.nameWithOwner, state: 'open' };
      return response(rawPullRequest());
    }
    if (parsed.pathname === `/repos/${input.nameWithOwner}/pulls`) {
      const closed = pullRequest?.state === 'merged' || pullRequest?.state === 'closed';
      return response(pullRequest && closed === (parsed.searchParams.get('state') === 'closed') ? [rawPullRequest()] : []);
    }
    if (parsed.pathname === `/repos/${input.nameWithOwner}/pulls/4`) return pullRequest ? response(rawPullRequest()) : response({}, 404);
    if (init?.method === 'POST' && (parsed.pathname === '/user/repos' || /^\/orgs\/[^/]+\/repos$/.test(parsed.pathname)))
      repositoryCreated = true;
    else if (parsed.pathname !== `/repos/${input.nameWithOwner}`) throw new Error(`Unexpected Forge fixture request: ${parsed.pathname}`);
    return repositoryCreated ? response({ full_name: input.nameWithOwner, html_url: `https://github.com/${input.nameWithOwner}`,
      clone_url: input.cloneUrl, visibility: 'private', default_branch: 'main' }) : response({}, 404);
  };
  const resolveToken = async () => { tokenRequests += 1; return { kind: 'available' as const, token: 'fixture' }; };
  const declaration = PLUGIN_MANIFEST.contributes.scmHostingProviders![0]!;
  const { title, ...definition } = declaration;
  const hosting = createScmHostingProviderRegistry({ providers: [{ ...definition, pluginId: PLUGIN_MANIFEST.id,
    displayName: typeof title === 'string' ? title : title.fallback }], runtimeRegistrations: [{
    pluginId: PLUGIN_MANIFEST.id, occurrenceId: 'fixture', registration: { id: declaration.id, adapter: {
      routing: githubHostingProviderAdapter, pullRequests: createGithubRestAdapter({ fetcher, resolveToken }),
      repositoryPublishing: createGithubRepositoryRestAdapter({ fetcher, resolveToken }),
    } },
  }] });
  return { provider, hosting, repositoryCreated: () => repositoryCreated, httpRequests, tokenRequests: () => tokenRequests,
    setPullRequest: (summary: ScmPullRequestSummary) => { pullRequest = summary; } };
}
