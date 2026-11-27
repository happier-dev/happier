import { PluginError } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { normalizeScmHostingRepositoryIdentity } from '@happier-dev/plugin-sdk/scm';

export function reviewSessionRepositoryMismatch() {
  return new PluginError({
    code: 'repositoryMismatch',
    effectAttempted: false,
    message: 'Select a Session with a checkout of the pull request repository.',
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
  return checkout?.repo.isRepo && checkout.repo.rootPath && repository
    ? { repository, rootPath: checkout.repo.rootPath }
    : null;
}
