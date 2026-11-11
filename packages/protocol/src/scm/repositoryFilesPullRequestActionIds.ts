import type { DeploymentMoveToRepositoryInputV1 } from '../deployments/deploymentMoveToRepositoryV1.js';
import { DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 } from '../deployments/deploymentActionIdsV1.js';

const REPOSITORY_FILES_PULL_REQUEST_ACTION_IDS_V1 = [
  'scm.file.read', 'scm.worktree.create', 'scm.status.snapshot', 'scm.commit.create',
  'scm.pullRequest.openOrReuse', 'scm.worktree.remove', 'daemon.filesystem.writeFile',
] as const;
const REPOSITORY_FILES_PULL_REQUEST_WRITE_ACTION_IDS_V1 = [...REPOSITORY_FILES_PULL_REQUEST_ACTION_IDS_V1, 'daemon.filesystem.delete'] as const;
const REPOSITORY_MERGE_CONTINUATION_ACTION_IDS_V1 = ['scm.status.snapshot', 'scm.pullRequest.get', 'scm.remote.fetch', 'scm.file.read'] as const;
const REPOSITORY_PROVISIONING_ACTION_IDS_V1 = ['scm.repository.init', 'scm.hostingRepository.publish'] as const;
export type RepositoryFilesPullRequestChildActionIdV1 = typeof REPOSITORY_FILES_PULL_REQUEST_WRITE_ACTION_IDS_V1[number]
  | typeof REPOSITORY_MERGE_CONTINUATION_ACTION_IDS_V1[number] | typeof REPOSITORY_PROVISIONING_ACTION_IDS_V1[number];
const repositoryChildActionIds: ReadonlySet<string> = new Set([...REPOSITORY_FILES_PULL_REQUEST_WRITE_ACTION_IDS_V1,
  ...REPOSITORY_MERGE_CONTINUATION_ACTION_IDS_V1, ...REPOSITORY_PROVISIONING_ACTION_IDS_V1]);

/** One role identity serves the SCM writer and each reviewed composition that uses it. */
export function repositoryFilesPullRequestChildRoleV1(actionId: RepositoryFilesPullRequestChildActionIdV1): string;
export function repositoryFilesPullRequestChildRoleV1(actionId: string): string | undefined;
export function repositoryFilesPullRequestChildRoleV1(actionId: string): string | undefined {
  return repositoryChildActionIds.has(actionId) ? `repository.${actionId}` : undefined;
}

export const DEPLOYMENT_MOVE_DEFINITION_CHILD_ROLE_V1 = 'move.definition';
export type DeploymentMoveToRepositoryChildActionIdV1 = RepositoryFilesPullRequestChildActionIdV1
  | typeof DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1;

/** Move's reviewed switch uses the incumbent Environment writer after its merge reads. */
export function deploymentMoveToRepositoryChildRoleV1(actionId: DeploymentMoveToRepositoryChildActionIdV1): string;
export function deploymentMoveToRepositoryChildRoleV1(actionId: string): string | undefined;
export function deploymentMoveToRepositoryChildRoleV1(actionId: string): string | undefined {
  return actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 ? DEPLOYMENT_MOVE_DEFINITION_CHILD_ROLE_V1
    : repositoryFilesPullRequestChildRoleV1(actionId);
}

function children<TAction extends RepositoryFilesPullRequestChildActionIdV1>(actions: readonly TAction[]) {
  return actions.map(action => ({ action, role: repositoryFilesPullRequestChildRoleV1(action) }));
}

/** The finite file/commit/PR writer; provisioning and merge reads belong to their callers. */
export const REPOSITORY_FILES_PULL_REQUEST_CHILDREN_V1 = children(REPOSITORY_FILES_PULL_REQUEST_WRITE_ACTION_IDS_V1);
export const REPOSITORY_FILES_PULL_REQUEST_READ_CHILDREN_V1 = children(['scm.status.snapshot', 'scm.file.read']);

/** Preparation declares only the selected Move branch's actual children. */
export function deploymentMoveToRepositoryReviewedChildrenV1(
  input: DeploymentMoveToRepositoryInputV1,
): Readonly<{ children: readonly Readonly<{ action: DeploymentMoveToRepositoryChildActionIdV1; role: string;
  scopeInput?: Readonly<{ serverId: string; environmentId: string }> }>[] }> {
  if (input.continuation || input.pullRequestReference) return { children: [
    ...children(REPOSITORY_MERGE_CONTINUATION_ACTION_IDS_V1),
    ...(input.mode === 'apply' ? [{ action: DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1,
      role: DEPLOYMENT_MOVE_DEFINITION_CHILD_ROLE_V1, scopeInput: { serverId: input.serverId, environmentId: input.environmentId } } as const] : []),
  ] };
  if (input.mode === 'preview') return { children: REPOSITORY_FILES_PULL_REQUEST_READ_CHILDREN_V1 };
  return { children: [...children(REPOSITORY_FILES_PULL_REQUEST_ACTION_IDS_V1),
    ...(input.createRepository ? children(REPOSITORY_PROVISIONING_ACTION_IDS_V1) : [])] };
}
