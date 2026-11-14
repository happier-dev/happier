import type { ScmHostingOperationV1 } from '../plugins/contributions/scmHostingProviders.js';
import type { ParsedPluginManifestV2 } from '../plugins/manifest/v2.js';

/** Remote effects exercised by the existing local SCM operation owners. */
const SCM_HOSTING_OPERATION_ROOT_ACTION_IDS_V1 = {
  listPullRequests: ['scm.pullRequest.list', 'scm.pullRequest.openOrReuse', 'scm.pullRequest.runStacked'],
  getPullRequest: ['scm.pullRequest.get', 'scm.pullRequest.openOrReuse', 'scm.pullRequest.checkout',
    'scm.pullRequest.prepareWorktree', 'scm.pullRequest.runStacked'],
  createPullRequest: ['scm.pullRequest.openOrReuse', 'scm.pullRequest.runStacked'],
  resolvePullRequestCheckoutReference: ['scm.pullRequest.checkout', 'scm.pullRequest.prepareWorktree'],
  describePublishTargets: ['scm.hostingRepository.describePublishTargets'],
  createRepository: ['scm.hostingRepository.publish'],
  getRepository: ['scm.hostingRepository.get', 'scm.hostingRepository.publish', 'scm.pullRequest.list'],
  describeCloneTargets: ['scm.repository.clone'],
} as const satisfies Readonly<Record<ScmHostingOperationV1, readonly string[]>>;

/** Stored manifest authority is parsed once by its owner; this only reads its declared mapping. */
export function isScmHostingOperationActionForRootV1(
  rootActionId: string,
  actionIdentity: Readonly<{ pluginId: string; localId: string }>,
  manifest: Readonly<{ id: string; contributes: Pick<ParsedPluginManifestV2['contributes'], 'scmHostingProviders'> }>,
): boolean {
  if (manifest.id !== actionIdentity.pluginId) return false;
  return (manifest.contributes.scmHostingProviders ?? []).some(provider =>
    Object.entries(provider.operationActions ?? {}).some(([operation, localId]) =>
      localId === actionIdentity.localId
      && (SCM_HOSTING_OPERATION_ROOT_ACTION_IDS_V1[operation as ScmHostingOperationV1] as readonly string[])
        .includes(rootActionId)));
}
