import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  encodePlainArtifactStoredContent,
} from '@happier-dev/protocol';
import {
  DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
  DeploymentEnvironmentContentV1Schema,
} from '@happier-dev/deployment-protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import type { StoredCredentials } from '@/persistence';
import type { RpcActionExecutorContext } from '@/rpc/handlers/_actionDispatchAdapter';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { normalizeStoredComposeDefinitionInput } from '@/workspaces/projectSetup/nativeComposeSource';
import { createDaemonDeploymentActionDeps } from './createDaemonDeploymentActionDeps';
import { createOwnServerDeploymentRuntimeForHost } from './targets/ownServer/ownServerDeploymentHostRuntime';

afterEach(() => vi.restoreAllMocks());

// Home admits a Move root's Artifact reads only for the Environment content and
// its candidate (server deploymentPreparationAuthorization
// readDeploymentMoveToRepositoryHttpPurpose). Target-link content is runtime
// placement, which a definition Move never consumes.
it('moves a stored definition through the installed host without opening target-link content', async () => {
  const detail = createDeploymentEnvironmentDetailV1();
  const environment = {
    ...detail.environment,
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
      repository: {
        kind: 'github',
        deployment: 'https://github.com',
        repository: 'owner/app',
      },
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
