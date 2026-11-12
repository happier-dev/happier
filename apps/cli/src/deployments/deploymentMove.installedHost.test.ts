import axios from 'axios';
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
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { StoredCredentials } from '@/persistence';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import {
  createLocalScmRepositoryFixture,
  runScmExecutable,
} from '@/testkit/scm/scmBackendContractFixtures';
import {
  createPlainProjectAccountRefRow,
  projectAccountRowsReadHttpResponse,
} from '@/workspaces/projectAccountRows.testkit';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';

afterEach(() => {
  vi.restoreAllMocks();
  withdrawActiveProjectAccountRowsSnapshot();
});
// The installed daemon's own plugin runtime supplies the Git backend and forge.
let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>> | null = null;
beforeAll(async () => {
  runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
    runtimeOptions: { pluginIds: ['happier.scm.backend.git', 'happier.scm.forge.github'] } });
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
 * The installed daemon host with its real Move, Environment, Source and Account-row
 * owners. Home HTTP is the boundary. It admits a Move root's Artifact reads only for
 * the Environment content and its candidate (server
 * readDeploymentMoveToRepositoryHttpPurpose).
 */
async function createInstalledMoveHost(
  checkout?: Readonly<{ rootPath: string }>,
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
  vi.spyOn(axios, 'get').mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness')
      return {
        status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode: 'plain' }),
      };
    if (path === '/v1/account/encryption')
      return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
    artifactReads.push(path);
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
  const rows = checkout
    ? [
        createPlainProjectAccountRefRow({
          id: 'workspace',
          serverId: 'home',
          machineId: 'controller',
          rootPath: checkout.rootPath,
          createdAtMs: 1,
          repositoryIdentity: repository,
          source: { sourceId: 'source', revision: 2 },
        }),
      ]
    : [];
  vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
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
  const deps = createDaemonDeploymentActionDeps({ ...host, runtime });
  const context = {
    serverId: 'home',
    runtimeAccountId: 'account',
    surface: 'cli' as const,
    authority: 'account_automation' as const,
    machineAdmission: {
      actorAccountId: 'account',
      custodianAccountId: 'account',
      machineId: 'controller',
      installationId: 'installation',
      role: 'manage',
      encryptionMode: 'plain',
    },
    verifyMachineAdmissionCurrent: async () => true,
  } satisfies RpcActionExecutorContext;
  return { deps, context, environment, definition, artifactReads };
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
      await createInstalledMoveHost(git);
    // In the signed UI path this transport is the reviewed-child SCM hop. Home refuses it
    // (effect_family on GET /v1/machines/<id>, REPLAY-129-UI af8da82f), so any use fails.
    const transported: string[] = [];
    const refusedByHome = async (
      action: string,
    ): Promise<ActionExecuteResult> => {
      transported.push(action);
      return {
        ok: false,
        errorCode: 'action_forbidden',
        error: 'action_forbidden',
      };
    };
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
      refusedByHome,
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
    expect(transported).toEqual([]);
  } finally {
    await rm(git.rootPath, { recursive: true, force: true });
  }
});
