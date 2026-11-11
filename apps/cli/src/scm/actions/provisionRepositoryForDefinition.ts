import type { DeploymentMoveToRepositoryInputV1 } from '@happier-dev/protocol/deployments/deploymentMoveToRepositoryV1';
import { readScmHostingRepositoryIdentity, type ScmHostingRepositoryIdentityV1 } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { projectSourceRepositorySelectorFromHostingSummaryV1,
  type ProjectSourceRepositorySelectorV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { ScmRepositoryInitResponseSchema, ScmHostingRepositoryPublishResponseSchema } from '@happier-dev/protocol/scm/repositoryProvisioning';
import { ScmCommitCreateResponseSchema } from '@happier-dev/protocol/scm';
import { FilesystemWriteFileOutputSchema } from '@happier-dev/protocol/actions/filesystemActionFamily';
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
  const cwd = input.checkout.rootPath;
  let phase = 'init';
  const partial = (errorCode: string): RepositoryForDefinitionProvisionResult => ({ kind: 'partial', phase, errorCode, cwd });
  const recipe = previewRepositoryForDefinition(input.createRepository);
  try {
    signal?.throwIfAborted();
    const initialized = ScmRepositoryInitResponseSchema.parse(await host.executeScm('scm.repository.init', {
      cwd, initialBranch: recipe.initialBranch,
    }));
    if (!initialized.success) return partial(initialized.errorCode ?? 'COMMAND_FAILED');
    const branch = initialized.snapshot?.branch;
    if (!branch?.head) return partial('COMMAND_OUTCOME_UNKNOWN');
    const baseBranch = branch.head;
    let baseCommit = branch.headOid;
    if (!baseCommit) {
      phase = 'seed';
      for (const file of recipe.files) {
        signal?.throwIfAborted();
        const written = FilesystemWriteFileOutputSchema.parse(await host.writeFile({ rootPath: cwd, path: file.path,
          content: Buffer.from(file.content, 'utf8').toString('base64'), expectedHash: null }));
        if (!written.success) return partial(written.errorCode ?? 'file_replace_failed');
      }
      phase = 'commit';
      signal?.throwIfAborted();
      const committed = ScmCommitCreateResponseSchema.parse(await host.executeScm('scm.commit.create', {
        cwd, message: 'Initialize application repository', expectedHeadOid: null, expectedRef: `refs/heads/${baseBranch}`,
        scope: { kind: 'paths', include: recipe.files.map(file => file.path) },
      }));
      if (!committed.success) return partial(committed.errorCode ?? 'COMMAND_FAILED');
      if (committed.publication?.state !== 'published' || !committed.publication.candidateOid)
        return partial('COMMAND_OUTCOME_UNKNOWN');
      baseCommit = committed.publication.candidateOid;
    }
    phase = 'publish';
    signal?.throwIfAborted();
    const published = ScmHostingRepositoryPublishResponseSchema.parse(await host.executeScm('scm.hostingRepository.publish', {
      cwd, ...recipe.createRepository,
    }));
    if (!published.success) return partial(published.errorCode ?? 'COMMAND_FAILED');
    const repository = readScmHostingRepositoryIdentity(published.repository.provider);
    if (!repository || !published.pushed) return partial('COMMAND_OUTCOME_UNKNOWN');
    return { kind: 'provisioned', cwd, repository, baseBranch, baseCommit,
      sourceRepository: projectSourceRepositorySelectorFromHostingSummaryV1(published.repository, input.createRepository.remoteUrlKind ?? 'https') };
  } catch (error) {
    return partial(signal?.aborted ? 'cancelled'
      : error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'invalid_action_output');
  }
}
