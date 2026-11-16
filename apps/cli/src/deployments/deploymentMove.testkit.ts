import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { expect, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createActionExecutor, readHostReviewedChildOperationV1, isHostAdmittedReviewedChildPolicyV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { ProjectSourcesUpdateInputV1Schema, type ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { createDeploymentApprovalScopeResolverV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { DeploymentEnvironmentUpdateInputV1Schema,
  deploymentMoveToRepositoryReviewedChildrenV1, DeploymentMoveToRepositoryInputV1Schema,
  type DeploymentMoveToRepositoryInputV1, type DeploymentMoveToRepositoryContinuationV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { createBareGitRemoteFixture, createLocalScmRepositoryFixture, runScmExecutable } from '@/testkit/scm/scmBackendContractFixtures';
import { createDeploymentGitRegistry } from './targets/ownServer/exactCommitRelease.testkit';
import { createGithubForgeHttpFixture } from '@/testkit/scm/githubForgeHttp';
import { createLocalGitForgeHostConfig, createLocalGitForgeTransport } from '@/testkit/scm/localGitForgeTransport';
import { createDeploymentMoveToRepositoryForHost } from './moveToRepository';
import { createAdmittedCheckoutRepositoryFiles } from './admittedCheckoutRepositoryFiles';
import { assertDeploymentContentAuthorityForHost, resolveDeploymentDefinitionRoleForHost } from './deploymentDefinitionAdmission';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';


export async function createDeploymentMoveFixture({ attach, create, existingCheckout = false }: Readonly<{ attach: boolean; create: boolean; existingCheckout?: boolean }>) {
  const git = createLocalScmRepositoryFixture({ executable: 'git', repoMode: '.git', prefix: 'deployment-move-' });
  const remote = createBareGitRemoteFixture('deployment-move-remote-');
  runScmExecutable(remote.remotePath, 'git', ['symbolic-ref', 'HEAD', `refs/heads/${create ? 'main' : git.branchName}`]);
  const hostGit = await createLocalGitForgeHostConfig({ url: 'https://github.com/owner/app.git', remotePath: remote.remotePath });
  vi.stubEnv('GIT_CONFIG_GLOBAL', hostGit.path);
  const repository = { kind: 'github' as const, deployment: 'https://github.com', repository: 'owner/app' };
  // Forge HTTP/credentials, OS Git transport, Home persistence/metadata and
  // authenticated RPC admission are fixture boundaries. Native Git, registry,
  // provider adapters, host authority decisions and Action composition stay real.
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
  const reviewedDefinitionWrites: boolean[] = [];
  const storage: NonNullable<ActionExecutorDeps['deploymentAction']> = async (action, raw, childContext) => {
    expect(action).toBe('deployments.environments.update');
    const reviewed = isHostAdmittedReviewedChildPolicyV1(readHostReviewedChildOperationV1(childContext, action, raw), action, raw);
    reviewedDefinitionWrites.push(reviewed);
    expect(reviewed).toBe(true);
    const input = DeploymentEnvironmentUpdateInputV1Schema.parse(raw);
    expect(input.expectedRevision).toBe(detail.environment.revision);
    detail.content = DeploymentEnvironmentContentV1Schema.parse(candidates.get(input.contentArtifactId));
    detail.environment.revision += 1;
    return { ok: true as const, environmentId: detail.environment.id, revision: detail.environment.revision };
  };
  const move = createDeploymentMoveToRepositoryForHost({ serverId: 'home', machineId: workspace.machineId,
    assertCurrent: assertDeploymentContentAuthorityForHost,
    requireDefinitionManage: async context => {
      expect(await resolveDeploymentDefinitionRoleForHost(context, { serverId: 'home', machineId: workspace.machineId,
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }) })).toBe('manage');
    },
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
    // The installed daemon's one checkout scope, with the forge and OS Git remote as boundaries.
    repositoryFiles: (cwd, context) => createAdmittedCheckoutRepositoryFiles({ root: cwd, context, registry }),
    createContent: async content => { const id = `candidate-${candidates.size}`; candidates.set(id, content);
      return { contentArtifactId: id, contentHeaderVersion: 1, contentBodyVersion: 1 }; },
  });
  const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"deployments.environments.update": Object.keys(ActionSurfaceSchema.shape), "deployments.environments.moveToRepository": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), deploymentMoveToRepository: move, deploymentAction: storage,
    prepareHostReviewedChildren: async ({ actionId, input }) => actionId === 'deployments.environments.moveToRepository'
      ? deploymentMoveToRepositoryReviewedChildrenV1(DeploymentMoveToRepositoryInputV1Schema.parse(input)) : null,
    resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(async () => { throw new Error('Use metadata boundary'); },
      async () => ({ ok: true, environment: { id: 'environment', projectSourceId: 'source', purpose: 'standard' } })) });
  const context = { serverId: 'home', runtimeAccountId: 'account', surface: 'cli' as const, authority: 'account_automation' as const,
    actionCaller: { kind: 'host' as const }, actionRequestId: 'move-request',
    machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: workspace.machineId,
      installationId: 'fixture-installation', role: 'manage', encryptionMode: 'plain' },
    verifyMachineAdmissionCurrent: async () => true } satisfies RpcActionExecutorContext;
  const executeMove = (input: DeploymentMoveToRepositoryInputV1) => executor.execute('deployments.environments.moveToRepository', input,
    { ...context, actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces:
      { 'deployments.environments.moveToRepository': ['cli'],
        ...Object.fromEntries(deploymentMoveToRepositoryReviewedChildrenV1(input).children.map(child => [child.action, ['cli']])) } }) });
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
  const seedMergedPullRequest = async ({ edited, state = 'merged' }: Readonly<{ edited: boolean; state?: 'open' | 'merged' }>) => {
    await writeFile(join(git.rootPath, git.trackedPath), initial.document);
    await writeFile(join(git.rootPath, 'runtime.env'), 'PUBLIC_VALUE=one\n');
    runScmExecutable(git.rootPath, 'git', ['add', git.trackedPath, 'runtime.env']);
    runScmExecutable(git.rootPath, 'git', ['commit', '-m', 'Export stored definition']);
    const headCommit = runScmExecutable(git.rootPath, 'git', ['rev-parse', 'HEAD']);
    const mergedDocument = edited ? initial.document.replace('nginx:1', 'nginx:2') : initial.document;
    const mergedPublicFiles = [{ path: 'runtime.env', content: edited ? 'PUBLIC_VALUE=two\n' : 'PUBLIC_VALUE=one\n' }];
    await writeFile(join(git.rootPath, git.trackedPath), mergedDocument);
    await writeFile(join(git.rootPath, 'runtime.env'), mergedPublicFiles[0]!.content);
    runScmExecutable(git.rootPath, 'git', ['add', git.trackedPath, 'runtime.env']);
    runScmExecutable(git.rootPath, 'git', ['commit', '--allow-empty', '-m', 'Reviewed merged definition']);
    const mergedCommit = runScmExecutable(git.rootPath, 'git', ['rev-parse', 'HEAD']);
    runScmExecutable(git.rootPath, 'git', ['push', remote.remotePath, `${git.branchName}:${git.branchName}`]);
    const pullRequest = { provider, number: 4, title: 'Existing Move', url: 'https://github.com/owner/app/pull/4', state,
      baseBranch: git.branchName, headBranch: 'happier/move-existing', headSha: headCommit,
      headRepositoryNameWithOwner: 'owner/app', ...(state === 'merged' ? { mergeCommitSha: mergedCommit } : {}) };
    forge.setPullRequest(pullRequest);
    const continuation: DeploymentMoveToRepositoryContinuationV1 = { pullRequest, headCommit, document: initial.document,
      definition: input.definition, source: { id: source.id, revision: source.revision }, path: input.path,
      publicFiles: initial.publicFiles, selectors: { profiles: initial.profiles, services: initial.services } };
    return { continuation, mergedCommit, mergedDocument, mergedPublicFiles };
  };
  return { git, remote, forge, repository, detail, initial, input, executeMove, sourceRepository, seedMergedPullRequest,
    reviewedDefinitionWrites, readSource: () => source,
    cleanup: async () => {
      await hostGit.cleanup();
      await rm(git.rootPath, { recursive: true, force: true });
      await rm(remote.remotePath, { recursive: true, force: true });
    },
  };
}
