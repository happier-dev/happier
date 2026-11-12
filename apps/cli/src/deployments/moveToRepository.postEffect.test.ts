import { rm } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DeploymentMoveToRepositoryInputV1Schema, DeploymentMoveToRepositoryResultV1Schema } from '@happier-dev/protocol/deployments/deploymentMoveToRepositoryV1';
import { ProjectSourceV1Schema, ProjectSourceRepositorySelectorV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { readScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { WorkspaceRefV1WriteSchema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createLocalScmRepositoryFixture, createBareGitRemoteFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createGithubForgeHttpFixture } from '@/testkit/scm/githubForgeHttp';
import { createLocalGitForgeHostConfig, createLocalGitForgeTransport } from '@/testkit/scm/localGitForgeTransport';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { createDeploymentGitRegistry } from './targets/ownServer/exactCommitRelease.testkit';
import { createAdmittedCheckoutRepositoryFiles } from './admittedCheckoutRepositoryFiles';
import { createDeploymentMoveToRepositoryForHost } from './moveToRepository';

describe('Move definition post-effect refusal', () => {
  it('retains the opened PR and actual child refusal phase for retry', async () => {
    const git = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'move-source-refusal-' });
    const remote = createBareGitRemoteFixture('move-source-refusal-remote-');
    const url = 'https://github.com/octocat/Hello-World.git';
    const hostConfig = await createLocalGitForgeHostConfig({ url, remotePath: remote.remotePath });
    vi.stubEnv('GIT_CONFIG_GLOBAL', hostConfig.path);
    const forge = createGithubForgeHttpFixture({ nameWithOwner: 'octocat/Hello-World', cloneUrl: url });
    const registry = createDeploymentGitRegistry({ resolveScmHostingProviderRegistry: async () => forge.hosting },
      createLocalGitForgeTransport({ url, remotePath: remote.remotePath }));
    try {
      runScmExecutable(git.rootPath, 'git', ['remote', 'add', 'origin', url]);
      runScmExecutable(git.rootPath, 'git', ['push', remote.remotePath, `${git.branchName}:${git.branchName}`]);
      runScmExecutable(git.rootPath, 'git', ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${git.branchName}`]);
      const base = createDeploymentEnvironmentDetailV1();
      const definition = await normalizeStoredComposeDefinitionInput({ from: 'compose',
        document: 'services: {app: {image: nginx:1}}', profiles: [], services: ['app'] });
      const source = ProjectSourceV1Schema.parse({ id: base.environment.projectSourceId, revision: 1,
        name: 'App', audience: [], createdByAccountId: 'owner' });
      const repository = readScmHostingRepositoryIdentity(forge.provider);
      if (!repository) throw new Error('Forge fixture must resolve a repository identity');
      const { remoteName: _remote, urlSafety: _safety, nameWithOwner: _name, ...provider } = forge.provider;
      const sourceRepository = ProjectSourceRepositorySelectorV1Schema.parse({ provider,
        repository: { nameWithOwner: 'octocat/Hello-World', cloneUrl: url }, protocol: 'https' });
      const workspace = WorkspaceRefV1WriteSchema.parse({ id: 'workspace', serverId: 'home', machineId: 'machine',
        rootPath: git.rootPath, createdAtMs: 0, source: { sourceId: source.id, revision: source.revision }, repositoryIdentity: repository });
      const refusal = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'action_forbidden', error: 'action_forbidden',
        requestId: 'move-source-refusal', failureCause: { phase: 'projects.sources.update', errorClass: 'Error',
          errorCode: 'action_forbidden', httpStatus: 403 } });
      const unexpected = async (): Promise<never> => { throw new Error('Unexpected subsequent effect'); };
      // Home storage and Forge HTTP are boundaries; repository admission, native Git and PR composition remain real.
      const move = createDeploymentMoveToRepositoryForHost({ serverId: 'home', machineId: 'machine',
        assertCurrent: async () => {}, requireDefinitionManage: async () => {},
        readEnvironment: async () => ({ environment: base.environment, content: { ...base.content, definition } }),
        readSource: async () => ({ ok: true, source, canManage: true }), updateSource: async () => refusal,
        acceptWorkspace: unexpected, readWorkspaceRows: async () => ({ source: 'network', workspaceRefs: [workspace],
          relationships: [], organizations: [], rows: [], graphRevision: 'absent', loadedAtMs: 0, scopeKey: 'home:owner' }),
        repositoryFiles: () => createAdmittedCheckoutRepositoryFiles({ root: git.rootPath, context: {}, registry }),
        createContent: unexpected,
      });
      const input = DeploymentMoveToRepositoryInputV1Schema.parse({ mode: 'apply', serverId: 'home',
        environmentId: base.environment.id, definition: { contentRevision: definition.contentRevision, composeDigest: definition.composeDigest },
        path: 'deploy/compose.yaml', workspace: { kind: 'workspace-ref', serverId: 'home', id: workspace.id },
        repository, sourceRepository, baseCommit: git.headCommit, baseBranch: git.branchName });
      const result = DeploymentMoveToRepositoryResultV1Schema.parse(await move(input, {}, unexpected));
      expect(result).toMatchObject({ kind: 'partial', phase: refusal.failureCause!.phase, errorCode: refusal.errorCode,
        continuation: { pullRequest: { number: 4, url: 'https://github.com/octocat/Hello-World/pull/4' },
          headCommit: expect.stringMatching(/^[a-f0-9]{40,64}$/), document: definition.document } });
      if (result.kind !== 'partial' || !result.continuation) throw new Error('Move must retain its opened PR');
      expect(runScmExecutable(remote.remotePath, 'git', ['show', `${result.continuation.headCommit}:deploy/compose.yaml`]))
        .toBe(definition.document.trimEnd());
    } finally {
      vi.unstubAllEnvs();
      await hostConfig.cleanup();
      await rm(git.rootPath, { recursive: true, force: true });
      await rm(remote.remotePath, { recursive: true, force: true });
    }
  });
});
