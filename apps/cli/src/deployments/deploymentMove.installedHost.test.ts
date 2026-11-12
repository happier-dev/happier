import axios from 'axios';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { requesterAccountEncryptionMode } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
  type ActionExecuteResult,
} from '@happier-dev/protocol';
import {
  DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
  DeploymentEnvironmentContentV1Schema,
} from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { DeploymentEnvironmentUpdateInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { StoredCredentials } from '@/persistence';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import type { ScmBackendRegistry } from '@/scm/registry';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import {
  createBareGitRemoteFixture,
  createLocalScmRepositoryFixture,
  runScmExecutable,
} from '@/testkit/scm/scmBackendContractFixtures';
import { createGithubForgeHttpFixture } from '@/testkit/scm/githubForgeHttp';
import {
  createLocalGitForgeHostConfig,
  createLocalGitForgeTransport,
} from '@/testkit/scm/localGitForgeTransport';
import {
  createPlainProjectAccountRefRow,
  projectAccountRowsReadHttpResponse,
} from '@/workspaces/projectAccountRows.testkit';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createDeploymentGitRegistry } from './targets/ownServer/exactCommitRelease.testkit';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  withdrawActiveProjectAccountRowsSnapshot();
});
// The installed daemon's own plugin runtime supplies the Git backend and forge.
let runtime: Awaited<
  ReturnType<typeof createAdmittedPluginRuntimeFixture>
> | null = null;
beforeAll(async () => {
  runtime = await createAdmittedPluginRuntimeFixture({
    controller: pluginReloadController,
    runtimeOptions: {
      pluginIds: ['happier.scm.backend.git', 'happier.scm.forge.github'],
    },
  });
});
afterAll(async () => {
  await runtime?.dispose();
  await pluginReloadController.shutdown();
});

const repository = {
  kind: 'github' as const,
  deployment: 'https://github.com',
  repository: 'owner/app',
};

/**
 * The installed daemon host with its real Move, Environment, Source, Account-row,
 * SCM and filesystem owners. Home HTTP is the boundary. It admits a Move root's
 * Artifact reads only for the Environment content and its candidate (server
 * readDeploymentMoveToRepositoryHttpPurpose).
 */
async function createInstalledMoveHost(
  options: Readonly<{
    checkout?: Readonly<{ rootPath: string }>;
    scmRegistry?: ScmBackendRegistry;
    admission?: RpcActionExecutorContext['machineAdmission'];
  }> = {},
) {
  const detail = createDeploymentEnvironmentDetailV1();
  const environment = {
    ...detail.environment,
    projectSourceId: 'source',
    runtimeTargetLinkId: detail.targetLinks[0]!.targetLink.id,
  };
  detail.content = DeploymentEnvironmentContentV1Schema.parse({
    ...detail.content,
    definition: await normalizeStoredComposeDefinitionInput({
      from: 'compose',
      document: 'services:\n  app:\n    image: nginx:1\n',
      profiles: [],
      services: ['app'],
    }),
  });
  const definition = detail.content.definition;
  if (definition.kind !== 'stored')
    throw new Error('Expected a stored definition fixture');
  const credentials: StoredCredentials = {
    token: `h.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.s`,
    encryption: null,
  };
  const artifactReads: string[] = [];
  const artifactWrites: string[] = [];
  const createdArtifacts = new Map<string, object>();
  vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness')
      return {
        status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }),
      };
    if (path === '/v1/account/encryption')
      return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    artifactReads.push(path);
    const created = createdArtifacts.get(path);
    if (created && config?.headers?.['x-fixture-effect'] === 'deployments.environments.moveToRepository')
      return { status: 200, data: created };
    if (path !== `/v1/artifacts/${environment.contentArtifactId}`)
      return {
        status: 403,
        data: {
          error: 'credential_scope_denied',
          authorizationRefusal: 'verification_purpose',
        },
      };
    return {
      status: 200,
      data: {
        id: environment.contentArtifactId,
        ownerAccountId: 'account',
        access: 'owner',
        publicAudience: 'none',
        encryptionMode: 'plain',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encodePlainArtifactStoredContent({
          kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
          title: 'Staging',
        }),
        body: encodePlainArtifactStoredContent({
          body: JSON.stringify(detail.content),
        }),
        headerVersion: 1,
        bodyVersion: 1,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    };
  });
  const rows = options.checkout
    ? [
        createPlainProjectAccountRefRow({
          id: 'workspace',
          serverId: 'home',
          machineId: 'controller',
          rootPath: options.checkout.rootPath,
          createdAtMs: 1,
          repositoryIdentity: repository,
          source: { sourceId: 'source', revision: 2 },
        }),
      ]
    : [];
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
    if (
      String(url).endsWith('/v1/artifacts') &&
      body &&
      typeof body === 'object' &&
      'id' in body &&
      typeof body.id === 'string'
    ) {
      artifactWrites.push(body.id);
      createdArtifacts.set(`/v1/artifacts/${encodeURIComponent(body.id)}`, { ...body,
        ownerAccountId: 'account', access: 'owner', publicAudience: 'none', encryptionMode: 'plain',
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
      return {
        status: 200,
        data: { id: body.id, headerVersion: 1, bodyVersion: 1 },
      };
    }
    if (!String(url).includes(PROJECT_ACCOUNT_ROWS_ROUTE_V1))
      throw new Error(`Unexpected Home write ${String(url)}`);
    return projectAccountRowsReadHttpResponse(rows, String(url), body);
  });
  vi.spyOn(axios, 'request').mockImplementation(async (request) => {
    const path = new URL(request.url!).pathname;
    if (
      request.method === 'GET' &&
      path === `/v1/deployments/environments/${environment.id}`
    )
      return {
        status: 200,
        data: {
          ok: true,
          environment,
          targetLinks: detail.targetLinks.map((link) => link.targetLink),
        },
      };
    if (request.method === 'GET' && path === '/v1/projects/sources/source')
      return {
        status: 200,
        data: ProjectSourcesReadOutputV1Schema.parse({
          ok: true,
          canManage: true,
          source: {
            id: 'source',
            revision: 2,
            name: 'App',
            audience: [],
            createdByAccountId: 'account',
            repository: {
              protocol: 'https',
              provider: {
                id: 'github',
                kind: 'github',
                displayName: 'GitHub',
                baseUrl: 'https://github.com',
              },
              repository: {
                nameWithOwner: 'owner/app',
                cloneUrl: 'https://github.com/owner/app.git',
              },
            },
          },
        }),
      };
    throw new Error(`Unexpected Home request ${request.method} ${path}`);
  });
  const host = {
    credentials,
    accountArtifacts: createCredentialedAccountArtifactStore(credentials),
    serverId: 'home',
    serverHttpBaseUrl: 'https://move.test',
    machineId: 'controller',
    resolveRequesterIdentity: async () => ({
      kind: 'unknown' as const,
      reason: 'requester_authority_unavailable' as const,
    }),
  };
  const runtime = createOwnServerDeploymentRuntimeForHost({
    ...host,
    acquirePluginRuntimeRegistryLease: async () => {
      throw new Error('Move cannot execute native effects');
    },
  });
  const deps = createDaemonDeploymentActionDeps({
    ...host,
    runtime,
    ...(options.scmRegistry ? { scmRegistry: options.scmRegistry } : {}),
  });
  const context = {
    serverId: 'home',
    runtimeAccountId: 'account',
    surface: 'cli' as const,
    authority: 'account_automation' as const,
    machineAdmission: options.admission ?? {
      actorAccountId: 'account',
      custodianAccountId: 'account',
      machineId: 'controller',
      installationId: 'installation',
      role: 'manage',
      encryptionMode: 'plain',
    },
    verifyMachineAdmissionCurrent: async () => true,
  } satisfies RpcActionExecutorContext;
  return {
    deps,
    context,
    environment,
    definition,
    artifactReads,
    artifactWrites,
  };
}

/**
 * In the signed UI path this is the reviewed-child transport. Home refuses its
 * SCM and filesystem children (effect_family, REPLAY-129-UI af8da82f) and admits
 * only Move's reviewed Environment update (server isDeploymentMoveToRepositoryHttpEffect).
 */
function createHomeChildTransport(revision: number) {
  const transported: string[] = [];
  const execute = async (
    action: string,
    input: unknown,
  ): Promise<ActionExecuteResult> => {
    transported.push(action);
    if (action !== 'deployments.environments.update')
      return {
        ok: false,
        errorCode: 'action_forbidden',
        error: 'action_forbidden',
      };
    const update = DeploymentEnvironmentUpdateInputV1Schema.parse(input);
    expect(update.expectedRevision).toBe(revision);
    return {
      ok: true,
      result: {
        ok: true,
        environmentId: update.environmentId,
        revision: revision + 1,
      },
    };
  };
  return { transported, execute };
}

it('moves a stored definition through the installed host without opening target-link content', async () => {
  const { deps, context, environment, definition, artifactReads } =
    await createInstalledMoveHost();
  // A stale pin is Move's own first content decision, reached only after the definition read.
  const result = await deps.deploymentMoveToRepository!(
    {
      mode: 'preview',
      serverId: 'home',
      environmentId: environment.id,
      definition: {
        contentRevision: definition.contentRevision + 1,
        composeDigest: definition.composeDigest,
      },
      path: 'deploy/app/compose.yaml',
      workspace: { kind: 'workspace-ref', serverId: 'home', id: 'workspace' },
      repository,
      baseCommit: 'a'.repeat(40),
      baseBranch: 'main',
    },
    context,
    async () => {
      throw new Error('Preview must not run children');
    },
  );

  expect(result, JSON.stringify(result)).toEqual({
    kind: 'conflict',
    reason: 'definition_changed',
  });
  expect(artifactReads).toEqual([
    `/v1/artifacts/${environment.contentArtifactId}`,
  ]);
});

it('previews the file changes by reading the reviewed checkout on the placed Machine', async () => {
  const git = createLocalScmRepositoryFixture({
    executable: 'git',
    repoMode: '.git',
    prefix: 'deployment-move-installed-',
  });
  try {
    runScmExecutable(git.rootPath, 'git', [
      'remote',
      'add',
      'origin',
      'https://github.com/owner/app.git',
    ]);
    const { deps, context, environment, definition } =
      await createInstalledMoveHost({ checkout: git });
    const home = createHomeChildTransport(environment.revision);
    const result = await deps.deploymentMoveToRepository!(
      {
        mode: 'preview',
        serverId: 'home',
        environmentId: environment.id,
        definition: {
          contentRevision: definition.contentRevision,
          composeDigest: definition.composeDigest,
        },
        path: git.trackedPath,
        workspace: { kind: 'workspace-ref', serverId: 'home', id: 'workspace' },
        repository,
        baseCommit: git.headCommit,
        baseBranch: git.branchName,
      },
      context,
      home.execute,
    );

    expect(result, JSON.stringify(result)).toMatchObject({
      kind: 'preview',
      review: {
        path: git.trackedPath,
        baseCommit: git.headCommit,
        before: 'base\n',
        files: [
          {
            path: git.trackedPath,
            before: 'base\n',
            content: definition.document,
          },
        ],
      },
    });
    expect(home.transported).toEqual([]);
  } finally {
    await rm(git.rootPath, { recursive: true, force: true });
  }
});

it.each([false, true])('previews, opens the pull request and switches after merge inside the reviewed checkout (signed=%s)', async signed => {
  const git = createLocalScmRepositoryFixture({
    executable: 'git',
    repoMode: '.git',
    prefix: 'deployment-move-journey-',
  });
  const remote = createBareGitRemoteFixture('deployment-move-journey-remote-');
  const url = 'https://github.com/owner/app.git';
  const hostGit = await createLocalGitForgeHostConfig({
    url,
    remotePath: remote.remotePath,
  });
  try {
    vi.stubEnv('GIT_CONFIG_GLOBAL', hostGit.path);
    for (const [name, value] of [
      ['GIT_AUTHOR_NAME', 'Move Test'],
      ['GIT_AUTHOR_EMAIL', 'move@example.test'],
      ['GIT_COMMITTER_NAME', 'Move Test'],
      ['GIT_COMMITTER_EMAIL', 'move@example.test'],
    ] as const)
      vi.stubEnv(name, value);
    runScmExecutable(remote.remotePath, 'git', [
      'symbolic-ref',
      'HEAD',
      `refs/heads/${git.branchName}`,
    ]);
    runScmExecutable(git.rootPath, 'git', ['remote', 'add', 'origin', url]);
    runScmExecutable(git.rootPath, 'git', [
      'push',
      remote.remotePath,
      `${git.branchName}:${git.branchName}`,
    ]);
    runScmExecutable(git.rootPath, 'git', [
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      `refs/remotes/origin/${git.branchName}`,
    ]);
    // Forge HTTP and the OS Git remote are the external boundaries.
    const forge = createGithubForgeHttpFixture({
      nameWithOwner: 'owner/app',
      cloneUrl: url,
    });
    const scmRegistry = createDeploymentGitRegistry(
      { resolveScmHostingProviderRegistry: async () => forge.hosting },
      createLocalGitForgeTransport({ url, remotePath: remote.remotePath }),
    );
    const { deps, context, environment, definition, artifactWrites } =
      await createInstalledMoveHost({ checkout: git, scmRegistry });
    const home = createHomeChildTransport(environment.revision);
    const input = {
      mode: 'preview' as const,
      serverId: 'home',
      environmentId: environment.id,
      definition: {
        contentRevision: definition.contentRevision,
        composeDigest: definition.composeDigest,
      },
      path: git.trackedPath,
      workspace: {
        kind: 'workspace-ref' as const,
        serverId: 'home',
        id: 'workspace',
      },
      repository,
      baseCommit: git.headCommit,
      baseBranch: git.branchName,
    };

    const preview = await deps.deploymentMoveToRepository!(
      input,
      context,
      home.execute,
    );
    expect(preview, JSON.stringify(preview)).toMatchObject({
      kind: 'preview',
      review: { before: 'base\n' },
    });

    const opened = await deps.deploymentMoveToRepository!(
      { ...input, mode: 'apply' },
      context,
      home.execute,
    );
    expect(opened, JSON.stringify(opened)).toMatchObject({
      kind: 'pullRequest',
      continuation: {
        pullRequest: { number: 4, state: 'open', baseBranch: git.branchName },
        document: definition.document,
      },
    });
    if (!('kind' in opened) || opened.kind !== 'pullRequest')
      throw new Error('Expected an opened pull request');
    const { continuation } = opened;
    // The branch reached the remote and its commit holds the exported definition.
    expect(
      runScmExecutable(remote.remotePath, 'git', [
        'show',
        `${continuation.headCommit}:${git.trackedPath}`,
      ]),
    ).toBe(definition.document.trimEnd());
    // The worktree the writer created inside the checkout is removed again.
    expect(
      runScmExecutable(git.rootPath, 'git', [
        'worktree',
        'list',
        '--porcelain',
      ]).match(/^worktree /gmu),
    ).toHaveLength(1);

    // The forge merges the pull request into the base branch.
    runScmExecutable(remote.remotePath, 'git', [
      'update-ref',
      `refs/heads/${git.branchName}`,
      continuation.headCommit,
    ]);
    forge.setPullRequest({
      ...continuation.pullRequest,
      state: 'merged',
      headSha: continuation.headCommit,
      mergeCommitSha: continuation.headCommit,
    });
    let switched;
    if (signed) {
      const signedRequests: { effectActionId: string; method: string; path: string }[] = [];
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'fixture-root', binding: {
        serverIdentityId: 'home', accountId: 'account', custodianAccountId: 'account', machineId: 'controller',
        installationId: 'installation', actionId: 'deployments.environments.moveToRepository', requestId: 'continue-request',
        requestEnvelopeDigest: 'A'.repeat(43), target: { kind: 'machine', machineId: 'controller' },
        environmentId: environment.id, accountEncryptionMode: 'plain', admittedMachineRole: 'manage',
        authentication: { kind: 'account', tokenEpoch: 1 },
      } });
      // The Home HTTP boundary rejects a metadata GET signed as an update.
      // Keep the installed host, child issuer and continuation execution real.
      Object.defineProperties(authorization, {
        requesterAccountProjection: { value: { accountId: 'account', serverId: 'home',
          accountEncryptionMode: 'plain', isCurrent: async () => true } },
        requesterHttpProjection: { value: {
          accountId: 'account', serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://move.test',
          accountEncryptionMode: 'plain', isCurrent: async () => true,
          createRequestHeaders: async (request: { effectActionId: string; method: string; path: string }) => {
            signedRequests.push({ effectActionId: request.effectActionId, method: request.method, path: request.path });
            // The verified host signer carries its admitted Account mode locally.
            return { 'x-fixture-effect': request.effectActionId, [requesterAccountEncryptionMode]: 'plain' as const };
          },
        } },
      });
      const originalRequest = vi.mocked(axios.request).getMockImplementation()!;
      vi.mocked(axios.request).mockImplementation(async request => {
        const path = new URL(request.url!).pathname;
        if (path === '/v1/deployments/environments/' + environment.id) {
          const effect = request.headers?.['x-fixture-effect'];
          if (request.method === 'GET' && effect !== 'deployments.environments.get') return {
            status: 403, data: { error: 'action_forbidden', authorizationRefusal: 'verification_purpose' },
          };
          if (request.method === 'PATCH') return { status: 200, data: {
            ok: true, environmentId: environment.id, revision: environment.revision + 1,
          } };
        }
        return originalRequest(request);
      });
      const executor = createActionExecutor(deps);
      const result = await executor.execute('deployments.environments.moveToRepository',
        { ...input, mode: 'apply', continuation }, { ...context, actionCaller: { kind: 'host' },
          externalActionExecutionAuthorization: authorization, externalActionTarget: { kind: 'machine', machineId: 'controller' },
          actionsSettings: ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            'deployments.environments.moveToRepository': ['cli'],
            'deployments.environments.update': ['cli'],
          } }),
        });
      expect(result, JSON.stringify({ result, signedRequests })).toMatchObject({ ok: true, result: { kind: 'switched' } });
      if (!result.ok) throw new Error(result.errorCode);
      switched = result.result;
    } else switched = await deps.deploymentMoveToRepository!(
      { ...input, mode: 'apply', continuation }, context, home.execute,
    );
    expect(switched, JSON.stringify(switched)).toEqual({
      kind: 'switched',
      environmentId: environment.id,
      revision: environment.revision + 1,
      commitSha: continuation.headCommit,
    });
    expect(artifactWrites).toHaveLength(1);
    expect(home.transported).toEqual(signed ? [] : ['deployments.environments.update']);
  } finally {
    await hostGit.cleanup();
    await rm(git.rootPath, { recursive: true, force: true });
    await rm(remote.remotePath, { recursive: true, force: true });
  }
});

it("refuses a Move into another Account's checkout with a typed reason before any repository effect", async () => {
  const git = createLocalScmRepositoryFixture({
    executable: 'git',
    repoMode: '.git',
    prefix: 'deployment-move-member-',
  });
  try {
    runScmExecutable(git.rootPath, 'git', [
      'remote',
      'add',
      'origin',
      'https://github.com/owner/app.git',
    ]);
    const { deps, context, environment, definition } =
      await createInstalledMoveHost({
        checkout: git,
        admission: {
          actorAccountId: 'account',
          custodianAccountId: 'machine-owner',
          machineId: 'controller',
          installationId: 'installation',
          role: 'manage',
          encryptionMode: 'plain',
        },
      });
    const home = createHomeChildTransport(environment.revision);
    const result = await deps.deploymentMoveToRepository!(
      {
        mode: 'preview',
        serverId: 'home',
        environmentId: environment.id,
        definition: {
          contentRevision: definition.contentRevision,
          composeDigest: definition.composeDigest,
        },
        path: git.trackedPath,
        workspace: { kind: 'workspace-ref', serverId: 'home', id: 'workspace' },
        repository,
        baseCommit: git.headCommit,
        baseBranch: git.branchName,
      },
      context,
      home.execute,
    );

    expect(result).toEqual({
      kind: 'refused',
      reason: 'checkout_owner_required',
    });
    expect(home.transported).toEqual([]);
  } finally {
    await rm(git.rootPath, { recursive: true, force: true });
  }
});
