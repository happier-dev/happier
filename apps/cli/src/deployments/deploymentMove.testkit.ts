import { expect, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createActionExecutor, readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { ProjectSourcesUpdateInputV1Schema, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { DeploymentEnvironmentUpdateInputV1Schema,
  deploymentMoveToRepositoryReviewedChildrenV1, DeploymentMoveToRepositoryInputV1Schema,
  type DeploymentMoveToRepositoryInputV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { createBareGitRemoteFixture, createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createDeploymentGitRegistry } from './targets/ownServer/exactCommitRelease.testkit';
import { createGithubForgeHttpFixture } from '@/testkit/scm/githubForgeHttp';
import { createLocalGitForgeHostConfig, createLocalGitForgeTransport } from '@/testkit/scm/localGitForgeTransport';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { commitGuardedFileReplace } from '@/rpc/handlers/fileSystem/commitGuardedFileReplace';
import { createDeploymentMoveToRepositoryForHost } from './moveToRepository';


export async function createDeploymentMoveFixture({ attach, create, existingCheckout = false }: Readonly<{ attach: boolean; create: boolean; existingCheckout?: boolean }>) {
  const git = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'deployment-move-' });
  const remote = createBareGitRemoteFixture('deployment-move-remote-');
  const hostGit = await createLocalGitForgeHostConfig({ url: 'https://github.com/owner/app.git', remotePath: remote.remotePath });
  vi.stubEnv('GIT_CONFIG_GLOBAL', hostGit.path);
  const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/app' };
  // Only Forge HTTP, credentials and OS Git configuration are replaced. Registry,
  // provider adapters, native Git and the Action composition remain real.
  const forge = createGithubForgeHttpFixture({ nameWithOwner: 'owner/app', cloneUrl: 'https://github.com/owner/app.git', repositoryExists: !create });
  const { provider } = forge;
  const registry = createDeploymentGitRegistry({ resolveScmHostingProviderRegistry: async () => forge.hosting },
    createLocalGitForgeTransport({ url: 'https://github.com/owner/app.git', remotePath: remote.remotePath }));
  vi.stubEnv('GIT_AUTHOR_NAME', 'Move Test'); vi.stubEnv('GIT_AUTHOR_EMAIL', 'move@example.test');
  vi.stubEnv('GIT_COMMITTER_NAME', 'Move Test'); vi.stubEnv('GIT_COMMITTER_EMAIL', 'move@example.test');
  const detail = createDeploymentEnvironmentDetailV1();
  detail.environment.id = 'environment';
  detail.environment.projectSourceId = 'source';
  detail.environment.controllerMachineId = 'different-controller';
  detail.content = DeploymentEnvironmentContentV1Schema.parse({ ...detail.content,
    definition: await normalizeStoredComposeDefinitionInput({ from: 'compose', document: 'services:\n  app:\n    image: nginx:1\n    env_file: runtime.env\n',
      profiles: [], services: ['app'], publicFiles: [{ path: 'runtime.env', content: 'PUBLIC_VALUE=one\n' }] }) });
  const workspace: WorkspaceRefV1 = { id: 'workspace', serverId: 'home', machineId: 'workspace-machine', rootPath: git.rootPath,
    createdAtMs: 1, ...(!create ? { repositoryIdentity: repository, source: { sourceId: 'source', revision: 2 } } : {}) };
  const sourceRepository = { provider: { id: provider.id, kind: provider.kind, displayName: provider.displayName, baseUrl: provider.baseUrl },
    repository: { nameWithOwner: 'owner/app', cloneUrl: 'https://github.com/owner/app.git' }, protocol: 'https' as const };
  let source: ProjectSourceV1 = { id: 'source', revision: 2, name: 'App', audience: [], createdByAccountId: 'account',
    ...(!attach ? { repository: sourceRepository } : {}) };
  const candidates = new Map<string, unknown>();
  const storage: NonNullable<ActionExecutorDeps['deploymentAction']> = async (action, raw, childContext) => {
    expect(action).toBe('deployments.environments.update');
    expect(readHostAdmittedReviewedChildV1(childContext)?.role).toBe('move.definition');
    const input = DeploymentEnvironmentUpdateInputV1Schema.parse(raw);
    expect(input.expectedRevision).toBe(detail.environment.revision);
    detail.content = DeploymentEnvironmentContentV1Schema.parse(candidates.get(input.contentArtifactId));
    detail.environment.revision += 1;
    return { ok: true as const, environmentId: detail.environment.id, revision: detail.environment.revision };
  };
  const move = createDeploymentMoveToRepositoryForHost({ serverId: 'home', machineId: workspace.machineId,
    assertCurrent: async () => {}, requireDefinitionManage: async () => {},
    readEnvironment: async () => detail, readSource: async () => ({ ok: true, source, canManage: true }),
    updateSource: async raw => {
      const input = ProjectSourcesUpdateInputV1Schema.parse(raw);
      expect(input.expectedRevision).toBe(source.revision);
      source = { ...source, revision: source.revision + 1, repository: input.patch.repository ?? undefined };
      return { ok: true, source, canManage: true };
    },
    acceptWorkspace: async (_workspace, attached, identity) => {
      workspace.source = { sourceId: attached.id, revision: attached.revision };
      workspace.repositoryIdentity = identity;
    },
    readWorkspaceRows: async () => ({ workspaceRefs: [workspace], relationships: [], source: 'network',
      organizations: [], rows: [], graphRevision: 'absent', loadedAtMs: 1, scopeKey: 'home:account' }), scmRegistry: registry,
    repositoryFiles: (cwd, _context, invoke) => {
      const execute: typeof invoke = (action, input) => invoke(action, input);
      const unwrap = async (result: ReturnType<typeof invoke>) => {
        const output = await result;
        if (!output.ok) throw Object.assign(new Error(output.errorCode), { code: output.errorCode });
        return output.result;
      };
      return { executeScm: (action, input) => unwrap(execute(action, { cwd, ...Object(input) })),
        writeFile: input => unwrap(execute('daemon.filesystem.writeFile', input)),
        deleteFile: (input: { rootPath: string; path: string; recursive: false }) => unwrap(execute('daemon.filesystem.delete', input)) };
    }, storage,
    createContent: async content => { const id = `candidate-${candidates.size}`; candidates.set(id, content);
      return { contentArtifactId: id, contentHeaderVersion: 1, contentBodyVersion: 1 }; },
  });
  const executor = createActionExecutor({ deploymentMoveToRepository: move, deploymentAction: storage, isActionApprovalRequired: () => false,
    prepareHostReviewedChildren: async ({ actionId, input }) => actionId === 'deployments.environments.moveToRepository'
      ? deploymentMoveToRepositoryReviewedChildrenV1(DeploymentMoveToRepositoryInputV1Schema.parse(input)) : null,
    scmActionExecute: ({ actionId, input, context }) => executeScmActionOperation({ actionId, input,
      registry, workingDirectory: git.rootPath, signal: context.signal }),
    filesystemActionExecute: async ({ actionId, input }) => {
      if (actionId === 'daemon.filesystem.delete') {
        const deletion = (await import('@happier-dev/protocol/actions/filesystemActionFamily')).FilesystemDeleteInputSchema.parse(input);
        await rm(join(deletion.rootPath, deletion.path), { recursive: deletion.recursive });
        return { success: true };
      }
      if (actionId !== 'daemon.filesystem.writeFile') throw new Error('Unexpected filesystem effect');
      const write = (await import('@happier-dev/protocol/actions/filesystemActionFamily')).FilesystemWriteFileInputSchema.parse(input);
      return commitGuardedFileReplace({ destPath: join(write.rootPath, write.path), expectation: write.expectedHash,
        source: { kind: 'bytes', bytes: Buffer.from(write.content, 'base64') } });
    },
    resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async () => { throw new Error('Use metadata boundary'); },
      async () => ({ ok: true, environment: { id: 'environment', projectSourceId: 'source', purpose: 'standard' } })) });
  const context = { serverId: 'home', runtimeAccountId: 'account', surface: 'cli' as const, authority: 'account_automation' as const,
    actionCaller: { kind: 'host' as const }, actionRequestId: 'move-request' };
  const executeMove = (input: DeploymentMoveToRepositoryInputV1) => executor.execute('deployments.environments.moveToRepository', input,
    { ...context, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces:
      Object.fromEntries(deploymentMoveToRepositoryReviewedChildrenV1(input).children.map(child => [child.action, ['cli']])) }) });
  const initial = detail.content.definition;
  if (initial.kind !== 'stored') throw new Error('Expected stored input');
  const input: DeploymentMoveToRepositoryInputV1 = { mode: 'preview', serverId: 'home', environmentId: 'environment',
    definition: { contentRevision: initial.contentRevision, composeDigest: initial.composeDigest },
    ...(create ? { createRepository: { providerKind: 'github', owner: 'owner', repositoryName: 'app', visibility: 'private' } }
      : { repository, ...(attach ? { sourceRepository } : {}), baseCommit: git.headCommit, baseBranch: git.branchName }),
    workspace: { kind: 'workspace-ref', serverId: 'home', id: workspace.id }, path: git.trackedPath };
  if (create && !existingCheckout) {
    await rm(join(git.rootPath, '.git'), { recursive: true, force: true });
    await rm(join(git.rootPath, git.trackedPath));
  } else {
    runScmExecutable(git.rootPath, 'git', ['remote', 'add', 'origin', 'https://github.com/owner/app.git']);
    runScmExecutable(git.rootPath, 'git', ['push', remote.remotePath, `${git.branchName}:${git.branchName}`]);
    runScmExecutable(git.rootPath, 'git', ['symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${git.branchName}`]);
  }
  return { git, remote, forge, repository, detail, initial, input, executeMove, sourceRepository, readSource: () => source,
    cleanup: async () => {
      await hostGit.cleanup();
      await rm(git.rootPath, { recursive: true, force: true });
      await rm(remote.remotePath, { recursive: true, force: true });
    },
  };
}
