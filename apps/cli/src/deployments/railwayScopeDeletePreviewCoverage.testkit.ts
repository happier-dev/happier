import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import {
  DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1,
  DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
} from '@happier-dev/deployment-protocol';
import {
  DeploymentEnvironmentContentV1Schema,
  DeploymentTargetLinkContentV1Schema,
} from '@happier-dev/deployments/contracts/v1';
import {
  DeploymentEnvironmentCreateResultV1Schema,
  DeploymentTargetLinkResultV1Schema,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { ProjectSourcesCreateOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import type {
  ActionsService,
  PluginAccountActionContext,
} from '@happier-dev/plugin-sdk/actions';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { railwayScopeDeleteActions } from '../../../../packages/plugins/deploy-railway/src/platform/deleteScope';
import type { DeploymentSocketHomeFixture } from '../../../server/sources/testkit/deploymentSocketHome.testkit.mjs';

type Invoke = (name: string, input: unknown) => Promise<ActionExecuteResult>;
type Artifacts = Pick<
  ReturnType<typeof createCredentialedAccountArtifactStore>,
  'create'
>;

/**
 * Runs the Railway scope Delete preview handler with real Railway Links in the scope and its
 * Actions service bound to the CLI Action executor, Artifact store and a real E2EE Home, so any
 * Happier read it makes meets the same admission an Account Action meets live. Railway's HTTP is
 * the only stub. The bundled Account runtime activation is not exercised here; the handler is
 * the module that runtime loads.
 */
export async function runRailwayScopeDeletePreviewCoverage({
  home,
  artifacts,
  invoke,
  settlePublicApproval,
  signal,
}: Readonly<{
  home: DeploymentSocketHomeFixture;
  artifacts: Artifacts;
  invoke: Invoke;
  signal: AbortSignal;
  settlePublicApproval(
    invoke: Invoke,
    pending: ActionExecuteResult,
  ): Promise<ActionExecuteResult>;
}>) {
  if (home.encryptionMode !== 'e2ee')
    throw new Error('The scope preview coverage requires E2EE Link content');
  const resultOf = async (name: string, input: unknown) => {
    const result = await settlePublicApproval(
      invoke,
      await invoke(name, input),
    );
    if (!result.ok)
      throw new Error(
        `${name} refused: ${JSON.stringify({ errorCode: result.errorCode, failureCause: result.failureCause })}`,
      );
    return result.result;
  };
  const save = async (kind: string, title: string, body: unknown) => {
    const artifact = await artifacts.create({
      header: { kind, title },
      body: JSON.stringify(body),
    });
    return {
      contentArtifactId: artifact.artifactId,
      contentHeaderVersion: artifact.revision.headerVersion,
      contentBodyVersion: artifact.revision.bodyVersion,
    };
  };
  const sourceResponse = await fetch(`${home.baseUrl}/v1/projects/sources`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${home.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      serverId: home.serverId,
      requestKey: randomUUID(),
      name: 'Orders',
      audience: [],
    }),
  });
  const source = ProjectSourcesCreateOutputV1Schema.parse(
    await sourceResponse.json(),
  );
  if (!source.ok)
    throw new Error(`Scope fixture Source refused: ${source.error}`);

  const credentialRef = {
    service: {
      pluginId: 'happier.machine.railway',
      localId: 'railway-account',
    },
    accountId: randomUUID(),
  };
  const project = { id: 'orders-project', name: 'Orders' };
  const staging = { id: 'orders-staging', name: 'staging' };
  const database = { id: 'orders-db', name: 'Orders database' };
  const document = 'services:\n  web:\n    image: nginx:alpine\n';
  const linkEnvironment = async (
    name: string,
    railwayEnvironmentId: string,
  ) => {
    const content = DeploymentEnvironmentContentV1Schema.parse({
      name,
      retainPreviousDeployments: 0,
      definition: {
        kind: 'stored',
        contentRevision: 1,
        document,
        profiles: [],
        services: ['web'],
        composeDigest: `sha256:${createHash('sha256').update(document).digest('hex')}`,
      },
      bindings: [],
    });
    const created = DeploymentEnvironmentCreateResultV1Schema.parse(
      await resultOf('deployments.environments.create', {
        serverId: home.serverId,
        projectSourceId: source.source.id,
        requestKey: randomUUID(),
        protection: 'nonProduction',
        purpose: 'standard',
        deployerMode: 'managers',
        controllerMachineId: home.machineId,
        ...(await save(DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, name, content)),
      }),
    );
    if (!created.ok)
      throw new Error(`Scope fixture Environment refused: ${created.error}`);
    const purpose = {
      consumer: {
        pluginId: 'happier.deploy.railway-data',
        localId: 'postgresql-link',
      },
      purpose: 'cloud-api',
    };
    const linkContent = DeploymentTargetLinkContentV1Schema.parse({
      providerResourceOrigin: 'created',
      providerIdentity: {
        providerAccountId: project.id,
        providerResourceId: database.id,
        providerEnvironment: railwayEnvironmentId,
      },
      providerEnvironment: {
        kind: 'native',
        selection: {
          projectId: project.id,
          environmentId: railwayEnvironmentId,
          serviceId: database.id,
        },
      },
      credentialPrincipal: {
        kind: 'account',
        accountId: home.accountId,
        purpose,
        target: { kind: 'account', account: credentialRef },
      },
    });
    const linked = DeploymentTargetLinkResultV1Schema.parse(
      await resultOf('deployments.targets.link', {
        serverId: home.serverId,
        environmentId: created.environmentId,
        expectedRevision: created.revision,
        requestKey: randomUUID(),
        targetId: 'postgresql',
        role: 'data',
        targetKind: 'railway-postgresql',
        machines: [],
        source: {
          kind: 'plugin',
          contribution: {
            pluginId: 'happier.deploy.railway-data',
            localId: 'postgresql',
          },
        },
        ...(await save(
          DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1,
          `${name} database`,
          linkContent,
        )),
      }),
    );
    if (!linked.ok || !('targetLinkId' in linked))
      throw new Error(`Scope fixture Link refused: ${JSON.stringify(linked)}`);
    return {
      environment: { id: created.environmentId, name },
      link: { id: linked.targetLinkId, name: `${name} database` },
    };
  };
  await linkEnvironment('Orders staging', staging.id);
  await linkEnvironment('Orders production', 'orders-production');

  const connection = (items: object[]) => ({
    edges: items.map((node) => ({ node })),
    pageInfo: { hasNextPage: false, endCursor: null },
  });
  const queries: string[] = [];
  const http = createPluginHttpFixture({
    async request(request) {
      const { query } = JSON.parse(new TextDecoder().decode(request.body)) as {
        query: string;
      };
      queries.push(query);
      if (!query.includes('environment(id:'))
        throw new Error('Unexpected Railway GraphQL operation');
      const body = {
        data: {
          postgres: { id: 'postgres-template' },
          environment: {
            ...staging,
            projectId: project.id,
            serviceInstances: connection([
              {
                serviceId: database.id,
                serviceName: database.name,
                deletedAt: null,
                service: { templateId: 'postgres-template' },
              },
            ]),
            volumeInstances: connection([]),
          },
        },
      };
      return {
        status: 200,
        headers: {},
        body: new TextEncoder().encode(JSON.stringify(body)),
      };
    },
  });
  // The plugin host's Actions service contract: the domain result, or a PluginError for a refusal.
  const actions = {
    async execute(actionId: string, input: unknown) {
      const result = await invoke(actionId, input);
      if (!result.ok) throw new PluginError({ code: result.errorCode });
      return result.result;
    },
  } as unknown as ActionsService;
  const context = {
    signal,
    accountScope: { serverId: home.serverId, accountId: home.accountId },
    services: { actions, http },
  } as unknown as PluginAccountActionContext;
  const action = railwayScopeDeleteActions['environment-delete-preview'];
  if (!action) throw new Error('The environment preview Action is required');
  const preview = await action.run(
    {
      credentialRef,
      projectId: project.id,
      environmentId: staging.id,
      credentialPrincipal: {
        kind: 'account',
        accountId: home.accountId,
        purpose: {
          consumer: {
            pluginId: 'happier.deploy.railway',
            localId: 'environment-delete-preview',
          },
          purpose: 'cloud-api',
        },
        target: { kind: 'account', account: credentialRef },
      },
    } as never,
    context as never,
  );
  // Railway Links exist in this scope, and the Action admission refuses their content to every
  // Account Action, so the review says the Happier side was not checked instead of failing.
  expect(preview).toEqual({
    scope: staging,
    environments: [],
    services: [database],
    databases: [database],
    volumes: [],
    happierLinks: 'not-checked',
  });
  expect(queries.some((query) => query.includes('mutation'))).toBe(false);
}
