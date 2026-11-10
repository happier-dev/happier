import type { DeploymentMoveToRepositoryInputV1 } from '@happier-dev/protocol/deployments/deploymentMoveToRepositoryV1';
import type { ScmHostingRepositoryIdentityV1 } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import type { ProjectSourceRepositorySelectorV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { RepositoryFilesPullRequestHost } from './repositoryFilesPullRequest';

export type RepositoryForDefinitionProvisionResult = Readonly<{
  kind: 'provisioned'; cwd: string; repository: ScmHostingRepositoryIdentityV1; baseCommit: string; baseBranch: string;
  sourceRepository: ProjectSourceRepositorySelectorV1;
}> | Readonly<{ kind: 'partial'; phase: string; errorCode: string; cwd: string }>;

export function previewRepositoryForDefinition(createRepository: NonNullable<DeploymentMoveToRepositoryInputV1['createRepository']>,
  existingBase?: Readonly<{ baseCommit: string; baseBranch: string }>) {
  return { initialBranch: existingBase?.baseBranch ?? 'main',
    files: existingBase ? [] : [{ path: 'README.md', content: `# ${createRepository.repositoryName}\n` }],
    createRepository: { ...createRepository, pushCurrentBranch: true as const } };
}

export async function provisionRepositoryForDefinition(input: Readonly<{
  checkout: Pick<WorkspaceRefV1, 'rootPath'>;
  createRepository: NonNullable<DeploymentMoveToRepositoryInputV1['createRepository']>;
}>, host: RepositoryFilesPullRequestHost, signal?: AbortSignal): Promise<RepositoryForDefinitionProvisionResult> {
  return { kind: 'partial', phase: 'checkout', errorCode: 'FEATURE_UNSUPPORTED', cwd: input.checkout.rootPath };
}
