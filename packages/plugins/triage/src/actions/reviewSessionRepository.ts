import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import {
  normalizeScmHostingRepositoryIdentity,
  parseScmRemoteUrl,
  sameScmHostingRepositoryIdentity,
  type ScmHostingRepositoryIdentityV1,
} from '@happier-dev/plugin-sdk/scm';

export function reviewSessionRepositoryMismatch(repository: ScmHostingRepositoryIdentityV1) {
  return new PluginError({
    code: 'repositoryMismatch',
    effectAttempted: false,
    message: `Select a Session with a checkout that has a remote for ${repository.repository}.`,
  });
}

export async function readReviewSessionRepository(
  sessionId: string,
  { signal, services }: Readonly<{
    signal?: AbortSignal;
    services: Pick<PluginAccountActionContext['services'], 'actions'>;
  }>,
) {
  const status = await services.actions.execute('scm.status.snapshot', { sessionId, detail: 'facts' }, { signal });
  const checkout = 'success' in status && status.success ? status.snapshot : undefined;
  const provider = checkout?.hostingProvider;
  const repository = provider && normalizeScmHostingRepositoryIdentity({
    kind: provider.kind, deployment: provider.baseUrl, repository: provider.nameWithOwner,
  });
  return checkout?.repo.isRepo && checkout.repo.rootPath
    ? { repository, remotes: checkout.repo.remotes, rootPath: checkout.repo.rootPath }
    : null;
}

/** A fork can still host review preparation for a repository present in its configured fetch remotes. */
export function reviewSessionHasRepository(
  checkout: NonNullable<Awaited<ReturnType<typeof readReviewSessionRepository>>>,
  repository: ScmHostingRepositoryIdentityV1,
): boolean {
  if (sameScmHostingRepositoryIdentity(checkout.repository, repository)) return true;
  const expected = parseScmRemoteUrl(`${repository.deployment}/${repository.repository}`);
  if (expected?.syntax !== 'url') return false;
  const expectedPath = normalizeScmHostingRepositoryIdentity({ ...repository, repository: expected.path });
  return checkout.remotes.some(({ fetchUrl }) => {
    const remote = fetchUrl && parseScmRemoteUrl(fetchUrl);
    if (!remote || remote.host !== expected.host) return false;
    const port = remote.syntax === 'scp' || (remote.protocol === 'ssh:' && remote.port === 22) ? null : remote.port;
    return port === expected.port && sameScmHostingRepositoryIdentity(expectedPath,
      normalizeScmHostingRepositoryIdentity({ ...repository, repository: remote.path }));
  });
}
