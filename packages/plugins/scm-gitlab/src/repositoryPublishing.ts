import { SCM_OPERATION_ERROR_CODES, type ScmHostingRepositorySummary, type ScmHostingRepositoryPublishTarget } from '@happier-dev/plugin-sdk/scm';
import type { HostingProviderRepositoryPublishingCapability, ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import { isRecord, readTrimmedString } from '@happier-dev/plugin-sdk';
import { authorizeGitlabHosting, requestGitlabHosting, GitlabHostingError } from './hostingRequest.js';
import { buildGitlabApiUrl, GITLAB_REST_MAX_PAGE_SIZE } from './triage/http/gitlabClient.js';
import { selectGitlabNextPageUrl } from './triage/http/gitlabLink.js';

type Namespace = { id: number; full_path: string; kind: 'user' | 'group' };
function namespace(raw: unknown): Namespace {
  if (typeof raw !== 'object' || raw === null || !('id' in raw) || typeof raw.id !== 'number'
    || !Number.isSafeInteger(raw.id) || raw.id <= 0 || !('full_path' in raw) || typeof raw.full_path !== 'string'
    || !raw.full_path || !('kind' in raw) || (raw.kind !== 'user' && raw.kind !== 'group')) {
    throw new GitlabHostingError('GitLab returned an unreadable namespace.', SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, true);
  }
  return { id: raw.id, full_path: raw.full_path, kind: raw.kind };
}
function repository(provider: ScmHostingProviderRef, raw: unknown) {
  if (!isRecord(raw)) throw new GitlabHostingError('GitLab returned an unreadable repository.', SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
  const nameWithOwner = readTrimmedString(raw.path_with_namespace);
  const webUrl = readTrimmedString(raw.web_url);
  const visibility = raw.visibility;
  if (!nameWithOwner || !webUrl || (visibility !== 'private' && visibility !== 'internal' && visibility !== 'public')) {
    throw new GitlabHostingError('GitLab returned an unreadable repository.', SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
  }
  return { provider, nameWithOwner, webUrl, visibility,
    ...(typeof raw.http_url_to_repo === 'string' ? { cloneUrl: raw.http_url_to_repo } : {}),
    ...(typeof raw.ssh_url_to_repo === 'string' ? { sshUrl: raw.ssh_url_to_repo } : {}),
    ...(typeof raw.default_branch === 'string' || raw.default_branch === null ? { defaultBranch: raw.default_branch } : {}),
  } satisfies ScmHostingRepositorySummary;
}

/** REST v4 projects/namespaces contract: https://docs.gitlab.com/api/projects/ (checked 2026-11-16). */
export const gitlabRepositoryPublishing: HostingProviderRepositoryPublishingCapability = {
  async describePublishTargets(input) {
    const auth = await authorizeGitlabHosting(input);
    const user = (await requestGitlabHosting({ ...auth, url: buildGitlabApiUrl(auth.origin, '/user') })).body;
    if (typeof user !== 'object' || user === null || !('username' in user) || typeof user.username !== 'string') {
      throw new GitlabHostingError('GitLab returned an unreadable user.', SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, true);
    }
    const namespaces: Namespace[] = [];
    let url = buildGitlabApiUrl(auth.origin, '/namespaces', [['per_page', String(GITLAB_REST_MAX_PAGE_SIZE)]]);
    const seen = new Set<string>();
    while (true) {
      if (seen.has(url)) throw new GitlabHostingError('GitLab repeated a namespace continuation.', SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, true);
      seen.add(url);
      const response = await requestGitlabHosting({ ...auth, url });
      if (!Array.isArray(response.body)) throw new GitlabHostingError('GitLab returned an unreadable namespace list.', SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, true);
      namespaces.push(...response.body.map(namespace));
      const next = selectGitlabNextPageUrl(response.headers, auth.origin.origin);
      if (next.kind === 'end') break;
      if (next.kind !== 'next') throw new GitlabHostingError('GitLab namespace pagination could not be completed.', SCM_OPERATION_ERROR_CODES.COMMAND_FAILED, true);
      url = next.url;
    }
    const summary = { state: 'authenticated', profileKind: 'connected_account' } as const;
    return { auth: summary, targets: namespaces.filter(row => row.kind === 'group' || row.full_path === user.username).map(row => ({
      provider: input.provider, owner: row.full_path, ownerKind: row.kind === 'user' ? 'user' as const : 'org' as const,
      label: row.full_path, isDefault: row.kind === 'user', supportedVisibilities: ['private', 'internal', 'public'],
      supportedRemoteUrlKinds: ['https', 'ssh'], auth: summary,
    } satisfies ScmHostingRepositoryPublishTarget)) };
  },
  async createRepository(input) {
    const auth = await authorizeGitlabHosting(input);
    // The caller's ownerKind is optional. Resolve it from GitLab when absent;
    // never silently create in the personal namespace for a requested group.
    const target = input.ownerKind === 'user' ? null : namespace((await requestGitlabHosting({ ...auth,
      url: buildGitlabApiUrl(auth.origin, `/namespaces/${encodeURIComponent(input.owner)}`) })).body);
    const response = await requestGitlabHosting({ ...auth, url: buildGitlabApiUrl(auth.origin, '/projects'), method: 'POST',
      body: { name: input.repositoryName, path: input.repositoryName, visibility: input.visibility,
        ...(target?.kind === 'group' ? { namespace_id: target.id } : {}),
        ...(input.description === undefined ? {} : { description: input.description }) } });
    return repository(input.provider, response.body);
  },
  async getRepository(input) {
    const auth = await authorizeGitlabHosting(input);
    try {
      const response = await requestGitlabHosting({ ...auth,
        url: buildGitlabApiUrl(auth.origin, `/projects/${encodeURIComponent(`${input.owner}/${input.repositoryName}`)}`) });
      return repository(input.provider, response.body);
    } catch (error) {
      if (error instanceof GitlabHostingError && error.errorCode === SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND) return null;
      throw error;
    }
  },
};
