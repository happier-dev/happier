import * as React from 'react';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1, selectDeploymentRuntimeTargetLinkV1 } from '@happier-dev/deployments';
import { createDeploymentEnvironmentDetailV1, createDeploymentReceiptDetailV1, createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import {
  createDeploymentEnvironmentHeaderV1,
  createDeploymentSecretVariableBindingV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol/v1';
import { DeploymentOwnServerContentV1Schema } from '@happier-dev/deployments/contracts/v1';
import { DeploymentBackupActionInputSchemasV1, deploymentBackupPolicyV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, DeploymentEnvironmentListResultV1Schema, readDeploymentActionOperationRequestIdV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import {
  act,
  standardCleanup,
  changeTextTestInstance,
  waitForTestEvent,
} from '@/dev/testkit';
import { renderAccountScreen as renderScreen } from '@/dev/testkit/render/renderAccountScreen';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { deriveMarketplaceSourceId } from '@happier-dev/protocol/marketplace';
import { DeploymentTemplateV1Schema, BUILT_IN_REGISTRY_SOURCES_V1, projectPluginRegistrySourceDeclarationV1,
  REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/registries';
import { listHappierAppCatalogV1, readHappierAppCatalogItemV1 } from '@happier-dev/protocol/registries/formats/happierAppCatalog';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { applyProjectAccountRowsFixture, createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { DeploymentTemplateInstantiateInputV1Schema, DeploymentTemplateInstantiateResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { decodeBase64 } from '@happier-dev/plugin-sdk/protocol';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { AutomationDefinitionDetailsResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { createNightlyBackupsWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/backupExamples';
import { MachineServicesListInputV1Schema, MachineServicesListResultV1Schema } from '@happier-dev/protocol/actions/specs/machine/services';
import { WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import { DATABASE_PLUGIN_ID_V1, DATABASE_TARGETS_LIST_ACTION_ID_V1 } from '@happier-dev/database-protocol';
import { DatabaseTargetsListInputV1Schema, type DatabaseDescriptorV1 } from '@happier-dev/plugin-sdk/database';
import { databaseActionLocalIdV1 } from '@happier-dev/database-protocol';
import { databaseActionMetadata } from '@happier-dev/plugin-sdk/actions';
import { PluginProjectedActionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { createPluginPagePlacementFixture } from '@/dev/testkit/fixtures/pluginPageProjectionFixture';
import { createPluginSurfaceDestinationNavigationBinding, PluginSurfaceDestinationNavigationBindingProvider }
  from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import type { PluginSurfaceOpenRequest } from '@/components/plugins/surfaces/openPluginSurface';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const routerMock = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => routerMock.module);
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  () => ({
    machineRpcWithServerScope: vi.fn(async () => {
      throw new Error('controller_unavailable');
    }),
  }),
);
// Native recycler layout is a platform boundary; real row renderers run beneath it.
vi.mock('@legendapp/list/react-native', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/legendList')).createCapturingLegendListMock({
    original: await importOriginal<Record<string, unknown>>() }).module);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
      renderCustomModals: true,
    }).module,
);

// Only the Home's HTTP boundary is answered; the page's real Action front door, executor and parsers run.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } =
  await import('@/sync/ops/actions/actionAccountContext');
const { DeploymentDatabasePage } = await import('./DeploymentDatabasePage');
const { actionOperationStore } =
  await import('@/sync/domains/actionOperations/actionOperationStore');
const { ModalProvider } = await import('@/modal');
const { withPopoverWebGlobals } = await import('@/dev/testkit/harness/popoverHarness');

afterEach(async () => {
  const { Modal } = await import('@/modal');
  Modal.hideAll();
  actionOperationStore.reset();
  await standardCleanup();
  await homes.reset();
});

const shown = { mounted: true, visible: true, focused: true };
const noReview = { pendingId: null, request: () => {}, open: () => {} };
const page = 'project-deployments.database';
let homeCount = 0;
const snapshotId = 'c'.repeat(64);

function manifest(environmentId: string, id: string, time: string) {
  return {
    schemaVersion: 1,
    environmentId,
    sourceId: 'database',
    kind: 'dump',
    configRevision: 1,
    repositoryId: 'a'.repeat(64),
    producerChecksumSha256: 'b'.repeat(64),
    totalBytesProcessed: 42,
    totalFilesProcessed: 1,
    snapshot: {
      snapshotId: id,
      treeId: 'd'.repeat(64),
      hostname: 'runtime',
      time,
      paths: ['dump'],
      tags: [],
    },
  };
}

type InventoryRefusal = 'effect_in_progress' | 'repository_password_incorrect';

type Answers = Readonly<{
  history?: unknown;
  bindingRefusal?: string;
  missedSchedule?: boolean;
  inventoryBeforeRead?: () => Promise<InventoryRefusal | null> | InventoryRefusal | null;
}>;

/** A Postgres Environment opened on its Database page; the receipt keeps a pre-migration backup when asked. */
async function renderDatabase(
  input: Readonly<{
    answers?: Answers;
    workbenchDiscoveryRefused?: boolean | (() => boolean);
    /** Read the Database subject and Workbench target through the real selected-Environment transport. */
    readDatabaseAutomations?: boolean;
    countEnvironmentAcquisitions?: boolean;
    noRuntimeLink?: boolean;
    detached?: boolean;
    /** Open from the Project Source route with a saved Workflow to link. */
    linkWorkflow?: string;
    databaseSizeActionRefused?: boolean;
    database?: string;
    retainedBackup?: boolean;
    noBackup?: boolean;
    /** The Environment's Compose file is stored in Happier (shareable from Settings), not in its repository. */
    storedDefinition?: boolean;
    databaseOnly?: boolean;
    restore?: React.ComponentProps<typeof DeploymentDatabasePage>['restore'];
    setBindings?: React.ComponentProps<typeof DeploymentDatabasePage>['setBindings'];
    /** The Environment shares the database on a private network (its saved export). */
    shared?: boolean;
    moveDestination?: boolean;
    /** Exercise the picker across Projects and Machines through the public read transport. */
    movePickerScope?: boolean;
    /** The Machine refuses the Move Workflow's start. */
    refuseWorkflowStart?: boolean;
    moveDestinationWithApp?: boolean;
    sourceMultiMachine?: boolean;
    moveWritersUnavailable?: boolean;
    moveDestinationUnprotected?: boolean;
    /** The destination is a dedicated PostgreSQL that is not shared on a private network yet. */
    moveDestinationUnshared?: boolean;
    moveManagedDestination?: boolean;
    managed?: boolean;
    multipleManagedDatabases?: boolean;
    /** Keeps the last 3 copies (a prune-able retention) and also backs up the database's named data volume. */
    keepLastWithVolume?: boolean;
  }> = {},
) {
  await homes.reset();
  // A fresh Home per case.
  const serverIdentityId = `srv_database_${++homeCount}`;
  const machineId = `machine-${homeCount}`;
  const serverId = await homes.addHome({
    name: 'Database',
    serverUrl: 'https://database-page.test',
    serverIdentityId,
    accountId: 'account-owner',
    currentAccount: true,
  });
  const account = await captureLazyActionAccountContext(serverId);
  const base = createDeploymentEnvironmentDetailV1();
  const environmentId = base.environment.id;
  const backup = {
    configRevision: 1,
    destinationRef: {
      pluginId: 'happier.backup.destinations',
      localId: 'open',
    },
    occurrenceId: 'nightly',
    config: {},
    credentialBindings: [],
    ownership: { environmentId, prefix: 'shop/' },
    sources: [
      {
        kind: 'dump' as const,
        sourceId: 'database',
        service: 'postgres',
        consistency: 'logical' as const,
      },
      ...(input.keepLastWithVolume ? [{ kind: 'volume' as const, sourceId: 'postgres-data', service: 'postgres', volume: 'postgres-data', consistency: 'stopDuringCopy' as const }] : []),
    ],
    retention: input.keepLastWithVolume ? { kind: 'keep' as const, last: 3 } : { kind: 'keepEverything' as const },
  };
  const authored = createDeploymentEnvironmentDetailV1({
    content: {
      ...base.content,
      ...(input.noBackup ? { backup: undefined } : { backup }),
      ...(input.storedDefinition ? { definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}`,
        document: input.moveDestination && !input.databaseOnly
          ? 'services:\n  app:\n    image: shop:1\n    environment:\n      DATABASE_URL: postgres://shop:password@postgres:5432/shop\n    depends_on: [postgres]\n  postgres:\n    image: postgres:17\n'
          : 'services:\n  postgres:\n    image: postgres:17\n', profiles: [], services: input.moveDestination && !input.databaseOnly ? ['app', 'postgres'] : ['postgres'],
        primaryService: input.moveDestination && !input.databaseOnly ? 'app' : 'postgres' } } : {}),
      ...(input.shared ? { ownServer: { rollout: 'recreate' as const, autoRestorePreviousRelease: true, serviceExports: [
        { key: 'database', service: 'postgres', containerPort: 5432, scheme: 'postgres', exposure: 'privateNetwork' as const,
          privateNetwork: 'shop-net' },
      ] } } : {}),
      template: {
        templateRef: {
          sourceId: 'apps',
          itemId: 'postgres',
          version: '17',
          ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` },
        },
        definition: {
          kind: 'stored',
          contentRevision: 1,
          composeDigest: `sha256:${'b'.repeat(64)}`,
        },
        services: ['postgres', 'mysql'],
        data: [{
          engine: 'postgres',
          version: '17',
          service: 'postgres',
          port: 5432,
        }, ...(input.movePickerScope ? [] : [{ engine: 'mysql' as const, service: 'mysql', port: 3306 }])],
      },
    },
  });
  if (input.managed) {
    authored.targetLinks.push({ targetLink: createDeploymentTargetLinkHeaderV1({
      id: 'managed-database', environmentId, role: 'data', targetKind: 'neon', machines: [], members: [],
      ...(input.detached ? { state: 'detached', detachedAtMs: 1 } as const : {}),
      source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.neon', localId: 'database' } },
    }), content: { data: { engine: 'postgres' },
      providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'main' },
      providerEnvironment: { kind: 'native', selection: { branchId: 'main' } }, credentialPrincipal: { kind: 'account', accountId: 'account-owner',
        purpose: { consumer: { pluginId: 'happier.deploy.neon', localId: 'database' }, purpose: 'database.manage' },
        target: { kind: 'account', account: { service: { pluginId: 'happier.deploy.neon', localId: 'database' }, accountId: 'token' } } } } });
  }
  // Each case uses its own Home and Machine.
  const detail = { ...authored, environment: { ...authored.environment,
    serverId: input.moveDestination || input.movePickerScope || input.readDatabaseAutomations ? serverIdentityId : serverId,
    controllerMachineId: machineId,
    ...(input.noRuntimeLink ? { runtimeTargetLinkId: undefined } : {}) },
    targetLinks: (input.noRuntimeLink ? authored.targetLinks.filter(row => row.targetLink.role !== 'runtime')
      : authored.targetLinks).map((row) => ({ ...row, targetLink: { ...row.targetLink,
    // Measure the route's own acquisition before deployed size or backup Actions need their own admission.
    ...(input.countEnvironmentAcquisitions && !input.managed ? { activeDeploymentId: undefined } : {}),
    ...(row.targetLink.source.kind === 'host' && Array.isArray(row.targetLink.machines)
      ? { machines: [machineId, ...(input.sourceMultiMachine ? [`${machineId}-second`] : [])] } : {}),
    ...(row.targetLink.source.kind === 'host' && Array.isArray(row.targetLink.members)
      ? { members: row.targetLink.members.flatMap((member) => [{ ...member, machineId },
          ...(input.sourceMultiMachine ? [{ ...member, machineId: `${machineId}-second` }] : [])]) } : {}) } })) } as typeof authored;
  homes.answer(serverId, `GET /v1/deployments/environments/${environmentId}`, { body: {
    ok: true, environment: { ...detail.environment, controllerMachineId: machineId },
    targetLinks: detail.targetLinks.map(row => row.targetLink),
  } });
  const moved = createDeploymentEnvironmentDetailV1({
    environment: { ...detail.environment, id: 'database-dedicated', revision: 3, runtimeTargetLinkId: 'target-database-dedicated',
      contentArtifactId: 'artifact-database-dedicated',
      ...(input.movePickerScope ? { projectSourceId: 'source-dedicated' } : {}) },
    // The live #204 managed shape: the App keeps its own-server runtime and adds a retained provider data link.
    targetLinks: [...detail.targetLinks.filter(row => row.targetLink.role === 'runtime').map(row => ({ ...row, targetLink: { ...row.targetLink,
      id: 'target-database-dedicated', environmentId: 'database-dedicated', activeDeploymentId: 'deployment-dedicated' } })),
    ...(input.moveManagedDestination ? [{ targetLink: createDeploymentTargetLinkHeaderV1({
      id: 'data-database-dedicated', environmentId: 'database-dedicated', role: 'data', targetKind: 'neon', machines: [], members: [],
      source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.neon', localId: 'database' } },
      contentArtifactId: 'artifact-data-database-dedicated',
    }) }] : [])],
    content: { ...detail.content, name: 'Dedicated Postgres',
      backup: input.moveDestinationUnprotected ? undefined : { ...backup,
        ownership: { environmentId: 'database-dedicated', prefix: 'dedicated/' } },
      definition: { kind: 'stored', contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}`,
        document: input.moveDestinationWithApp
          ? 'services:\n  app:\n    image: shop:1\n  postgres:\n    image: postgres:17\n'
          : 'services:\n  postgres:\n    image: postgres:17\n', profiles: [],
        services: input.moveDestinationWithApp ? ['app', 'postgres'] : ['postgres'], primaryService: 'postgres' },
      bindings: [
        { purpose: 'variable', phase: 'runtime', name: 'POSTGRES_USER', source: { kind: 'value', value: 'shop' } },
        { purpose: 'variable', phase: 'runtime', name: 'POSTGRES_DB', source: { kind: 'value', value: 'shop' } },
        createDeploymentSecretVariableBindingV1({ name: 'POSTGRES_PASSWORD', phase: 'runtime', resourceId: 'database-password', resourceRevision: 1 }),
      ],
      ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true, serviceExports: input.moveDestinationUnshared ? [] : [
        { key: 'database', service: 'postgres', containerPort: 5432, scheme: 'postgres', exposure: 'privateNetwork', privateNetwork: 'shop-net' },
      ] },
      template: { ...detail.content.template!, services: ['postgres'], data: [{ engine: 'postgres', service: 'postgres',
        variables: { username: 'POSTGRES_USER', password: 'POSTGRES_PASSWORD', database: 'POSTGRES_DB' } }] },
    },
  });
  const movePickerQueries: URLSearchParams[] = [];
  if (input.moveDestination || input.movePickerScope) {
    // A data link whose content the requester may not read: the Home omits it from the Move page.
    const hiddenLinkIds = new Set<string>();
    const neighbor = (id: string, engine: 'postgres' | 'mysql', targetMachineId: string, hiddenDataLink = false) => createDeploymentEnvironmentDetailV1({
      environment: { ...moved.environment, id, projectSourceId: detail.environment.projectSourceId,
        contentArtifactId: `artifact-${id}`, runtimeTargetLinkId: `target-${id}` },
      content: { ...moved.content, name: id, definition: { kind: 'stored', contentRevision: 1,
        composeDigest: `sha256:${'b'.repeat(64)}`, document: `services:\n  ${engine}:\n    image: ${engine}:latest\n`,
        profiles: [], services: [engine], primaryService: engine },
        template: { ...moved.content.template!, services: [engine], data: [{ engine, service: engine }] } },
      targetLinks: [...moved.targetLinks.filter(row => row.targetLink.role === 'runtime').map(row => ({ ...row, targetLink: { ...row.targetLink,
        id: `target-${id}`, environmentId: id, machines: [targetMachineId],
        members: [{ machineId: targetMachineId, installationId: 'installation-a', state: 'active' }] } })),
      ...(hiddenDataLink ? [{ targetLink: createDeploymentTargetLinkHeaderV1({ id: `data-${id}`, environmentId: id, role: 'data',
        targetKind: 'neon', machines: [], members: [], contentArtifactId: `artifact-data-${id}`,
        source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.neon', localId: 'database' } } }) }] : [])],
    });
    if (input.moveManagedDestination) hiddenLinkIds.add('data-database-hidden-link');
    const environments = [detail, ...(input.moveDestination ? [moved] : []),
      ...(input.moveDestination && input.movePickerScope
        ? [neighbor('database-other-machine', 'postgres', `${machineId}-other`), neighbor('database-mysql', 'mysql', machineId),
          ...(input.moveManagedDestination ? [neighbor('database-hidden-link', 'mysql', machineId, true)] : [])] : [])];
    // HTTP and Artifact storage are boundaries; the Action, transport, candidate classifier and read owners stay real.
    for (const environment of environments) {
      await account.createArtifactDocument({ artifactId: environment.environment.contentArtifactId,
        header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: environment.content.name }, body: JSON.stringify(environment.content) });
      for (const row of environment.targetLinks) {
        // Selected platform details open their private method through the same Artifact boundary.
        if (row.targetLink.source.kind === 'plugin' && row.content) await account.createArtifactDocument({
          artifactId: row.targetLink.contentArtifactId,
          header: { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: environment.content.name }, body: JSON.stringify(row.content),
        });
      }
      homes.answer(serverId, `GET /v1/deployments/environments/${environment.environment.id}`, { body: {
        ok: true, environment: { ...environment.environment, serverId: serverIdentityId },
        targetLinks: environment.targetLinks.map(row => row.targetLink),
      } });
    }
    homes.answer(serverId, 'GET /v1/deployments/environments', { select: (_body, request) => {
      const query = new URL(request.url).searchParams;
      movePickerQueries.push(query);
      // The Home applies the selected Project before the public transport opens the page's private content.
      const selected = environments.filter(environment => !query.has('projectSourceId')
        || environment.environment.projectSourceId === query.get('projectSourceId'));
      return { body: DeploymentEnvironmentListResultV1Schema.parse({ ok: true,
        items: selected.map(environment => ({ ...environment.environment, serverId: serverIdentityId })),
        runtimeTargetLinks: selected.flatMap(environment => environment.targetLinks
          .filter(row => row.targetLink.id === environment.environment.runtimeTargetLinkId).map(row => row.targetLink)),
        // The Home's Move projection: the page's live data links its exact-read admission lets this requester see.
        ...(query.get('dataTargetLinks') === 'true' ? { dataTargetLinks: selected.flatMap(environment => environment.targetLinks
          .filter(row => row.targetLink.role === 'data' && !hiddenLinkIds.has(row.targetLink.id)).map(row => row.targetLink)) } : {}),
        nextCursor: null, coverage: 'complete' }) };
    } });
  }
  const plain = createDeploymentReceiptDetailV1();
  const receipt = input.retainedBackup
    ? createDeploymentReceiptDetailV1({
        deployment: plain.deployment,
        content: DeploymentOwnServerContentV1Schema.parse({
          ...plain.content,
          ownServer: {
            approvedInputBasis: {
              v: 1,
              environmentId,
              environmentRevision: 1,
              targetLinkId: plain.deployment.targetLinkId,
              targetLinkRevision: 1,
              sourceIntent: plain.content.sourceIntent,
              manifestFingerprint: 'manifest',
              configInputDigests: [],
              physicalProjectName: 'project',
              toolVersion: '2.40.1',
              services: ['app'],
              profiles: [],
              members: [
                { machineId, installationId: 'installation-a' },
              ],
              bindings: [],
              images: [],
              ownServer: {
                rollout: 'recreate',
                autoRestorePreviousRelease: true,
                migration: { service: 'app', argv: ['migrate'] },
                migrationFailurePolicy: 'ask',
                backupBeforeMigration: true,
              },
            },
            preMigrationBackup: {
              sourceFormat: 'postgresCustom',
              target: {
                service: 'postgres',
                adapter: 'postgres-v1',
                database: 'shop',
              },
              repository: { repository: 's3:https://backup.test/bucket' },
              configuration: backup,
              source: manifest(
                environmentId,
                snapshotId,
                '2026-11-01T12:00:00Z',
              ),
            },
          },
        }),
      })
    : plain;

  const effects: Array<{ actionId: string; input: Record<string, unknown> }> =
    [];
  if (input.readDatabaseAutomations) {
    homes.answer(serverId, 'POST /v3/automations/query', {
      body: { automations: [], attached: [], nextCursor: null, skippedNotSharedCount: 0 },
    });
    await answerExternalActionAccountForHome(homes, serverId, {
      machineId, installationId: 'installation-a', actionId: 'deployments.data.size', tokenEpoch: 0,
      failure: () => input.databaseSizeActionRefused
        ? { errorCode: 'target_unavailable', error: 'target_unavailable' } : null,
      execute: raw => {
        const operand = DeploymentActionInputSchemasV1['deployments.data.size'].parse(raw);
        effects.push({ actionId: 'deployments.data.size', input: operand });
        return { ok: true, size: { service: operand.service, deploymentId: operand.deploymentId,
          size: { status: 'available', bytes: 4096, measurement: 'database_bytes', observedAtMs: 1 },
          growth: { status: 'unavailable', reason: 'previous_sample_required' } } };
      },
    });
  }
  if (input.answers?.missedSchedule) {
    const response = AutomationDefinitionDetailsResponseSchema.parse({ automations: [{
      id: 'nightly-backups', name: 'Nightly backups', description: null, enabled: true,
      scheduleOccurrences: [],
      targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
      workflowDefinitionId: null, scopeSessionId: null,
      assignments: [{ machineId, enabled: true, priority: 0, updatedAt: 1 }],
      triggers: [{ id: 'nightly-schedule', kind: 'schedule', revision: 0, enabled: true,
        createdAt: 1, updatedAt: 1, nextRunAt: 2, triggerDefinitionEnvelope: null,
        schedule: { kind: 'interval', scheduleExpr: null, everyMs: 60_000, timezone: null } }],
      executionRecipe: { v: 2, templateVersion: 1, triggerEvidence: null, workflow: { t: 'plain', v: {
        workspace: { directory: '~' }, executionTarget: { kind: 'detached_run' },
        inlineDefinition: createNightlyBackupsWorkflowV1(),
        inputs: { backupEnvironment: { environmentId: detail.environment.id, serverId: account.accountLifetime.scope.serverId },
          backupPolicy: deploymentBackupPolicyV1(backup), verificationLevel: 'manifestReadBack' },
      } } },
    }], nextCursor: null });
    homes.answer(serverId, 'POST /v3/automations/query', { body: response });
  }
  for (const actionId of [
    'deployments.backups.history',
    'deployments.backups.run',
    'deployments.backups.inventory',
    'deployments.backups.prune',
  ] as const) {
    await answerExternalActionAccountForHome(homes, serverId, {
      machineId,
      installationId: 'installation-a',
      actionId,
      tokenEpoch: 0,
      failure: result => result === 'effect_in_progress' || result === 'repository_password_incorrect' ? {
        errorCode: result, error: result, details: projectDeploymentFailureRecoveryV1({}, result),
      } : null,
      execute: async (operand) => {
        effects.push({
          actionId,
          input: DeploymentBackupActionInputSchemasV1[actionId].parse(operand),
        });
        if (actionId === 'deployments.backups.inventory') {
          const refusal = await input.answers?.inventoryBeforeRead?.();
          if (refusal) return refusal;
        }
        return actionId === 'deployments.backups.prune'
            ? { kind: 'pruned', environmentId, configRevision: 1, forgottenSnapshotIds: ['f'.repeat(64)] }
            : actionId === 'deployments.backups.inventory'
            ? { kind: 'inventory', environmentId, configRevision: 1, repositoryId: 'a'.repeat(64), snapshots: [
              { snapshot: manifest(environmentId, snapshotId, '2026-11-01T12:00:00Z').snapshot,
                source: { sourceId: 'database', kind: 'dump' },
                verification: { kind: 'verified', backupOperationId: 'pre-migration', configRevision: 1 } },
              { snapshot: manifest(environmentId, 'f'.repeat(64), '2026-11-06T03:00:00Z').snapshot,
                source: { sourceId: 'database', kind: 'dump' },
                verification: { kind: 'verified', backupOperationId: 'nightly', configRevision: 1 } },
            ] }
            : actionId === 'deployments.backups.run'
            ? {
                kind: 'verified',
                operationId: 'manual-backup',
                manifests: [
                  manifest(
                    environmentId,
                    'e'.repeat(64),
                    '2026-11-07T10:00:00Z',
                  ),
                ],
              }
            : (effects.some((effect) => effect.actionId === 'deployments.backups.run') ? {
                kind: 'history', environmentId, configRevision: 1,
                lastSuccessfulBackup: { operationId: 'manual-backup', completedAt: Date.parse('2026-11-07T10:01:00Z'),
                  configRevision: 1, snapshotIds: ['e'.repeat(64)] },
                history: { entries: [{ operationId: 'manual-backup', action: 'backup', state: 'succeeded',
                  startedAt: Date.parse('2026-11-07T10:00:00Z'), completedAt: Date.parse('2026-11-07T10:01:00Z'),
                  configRevision: 1, snapshotIds: ['e'.repeat(64)] }] },
              } : input.answers?.history ?? {
                kind: 'history',
                environmentId,
                configRevision: 1,
                history: { entries: [] },
              });
      },
    });
  }
  const scope = { kind: 'environment' as const,
    environment: { serverId: input.readDatabaseAutomations ? detail.environment.serverId : serverId,
      projectSourceId: detail.environment.projectSourceId, environmentId } };
  const descriptor: DatabaseDescriptorV1 = { ...createDatabaseDescriptorV1Fixture(),
    target: input.managed ? { kind: 'managed_deployment', environment: scope.environment,
      targetLinkId: 'managed-database', contribution: { pluginId: 'happier.deploy.neon', contributionId: 'database' },
      platformProjectId: 'project', branchId: 'main', database: 'shop' } : { kind: 'deployment_service',
      environment: scope.environment,
      deploymentId: receipt.deployment.id, targetLinkId: receipt.deployment.targetLinkId,
      serviceId: 'postgres', database: 'shop' },
    placement: { serverId, accountId: account.accountId, machineId, installationId: 'installation-a' } };
  await answerExternalActionAccountForHome(homes, serverId, {
    machineId, installationId: 'installation-a', actionId: 'action.invoke', tokenEpoch: 0,
    failure: () => (typeof input.workbenchDiscoveryRefused === 'function'
      ? input.workbenchDiscoveryRefused() : input.workbenchDiscoveryRefused)
      ? { errorCode: 'plugin_service_unavailable', error: 'Plugin service unavailable' }
      : null,
    execute: raw => {
      const invocation = getActionSpec('action.invoke').inputSchema.parse(raw);
      effects.push({ actionId: 'action.invoke', input: invocation });
      expect(invocation.action).toEqual({ pluginId: DATABASE_PLUGIN_ID_V1,
        localId: databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1) });
      DatabaseTargetsListInputV1Schema.parse(invocation.input);
      return { targets: [descriptor, ...(input.multipleManagedDatabases && descriptor.target.kind === 'managed_deployment'
        ? [{ ...descriptor, target: { ...descriptor.target, database: 'other' } }] : [])], completeness: { complete: true } };
    },
  });
  const opened: PluginSurfaceOpenRequest[] = [];
  // The AppShell's observed daemon declaration is a real boundary, alongside the answered Home HTTP transport.
  const localId = databaseActionLocalIdV1(DATABASE_TARGETS_LIST_ACTION_ID_V1);
  const metadata = databaseActionMetadata[DATABASE_TARGETS_LIST_ACTION_ID_V1];
  const executionOrigin = { serverIdentityId, materializationRef: {
    pluginId: DATABASE_PLUGIN_ID_V1, machineId, materializationId: 'database-current' } };
  const projectedAction = { ...PluginProjectedActionV2Schema.parse({ id: localId, pluginId: DATABASE_PLUGIN_ID_V1,
    title: metadata.title, dangerLevel: metadata.dangerLevel, readOnly: metadata.readOnly,
    placementBindings: metadata.placementBindings, scopes: ['global'], surfaces: ['ui', 'cli', 'plugin'],
    execution: { target: 'daemon' }, occurrenceId: 'database:current', available: true }), executionOrigin,
    hostOrigin: { serverId, machineId, executionOrigin, phase: 'current' as const, interactionEnabled: true } };
  const projection = { ...EMPTY_PLUGIN_UI_PROJECTION,
    actionsById: { [`${DATABASE_PLUGIN_ID_V1}/${localId}`]: projectedAction } };
  const withdrawProjection = publishCommittedAppShellPluginUiProjection(() => projection);
  const unregisterActionPort = registerCurrentUiContextActionPort((surface, hostAction) => createCurrentUiContextVoiceToolPort({
    invocationSurface: surface, hostAction, readProjection: () => projection, readNavigationBinding: () => navigation,
    reader: { readCurrentUiContext: () => null, resolveCurrentUiCommand: () => null, subscribe: () => () => {} },
  }));
  const navigation = createPluginSurfaceDestinationNavigationBinding({ targetKind: 'app',
    accountLifetime: account.accountLifetime,
    placements: [{ ...createPluginPagePlacementFixture({ pluginId: DATABASE_PLUGIN_ID_V1,
      localId: 'database-workbench', title: 'Database', targetKind: 'app' }), occurrenceId: projectedAction.occurrenceId,
      executionOrigin, hostOrigin: projectedAction.hostOrigin }] });
  const unregisterNavigation = navigation.registerOwner({ container: 'appPage',
    handler: resolution => { opened.push(resolution.request); return { ok: true }; } });
  let setBindings = input.setBindings ?? null;
  if (input.moveDestination) {
    await answerExternalActionAccountForHome(homes, serverId, {
      machineId, installationId: 'installation-a', actionId: 'machines.services.list', tokenEpoch: 0, requesterInvocation: 'optional',
      execute: raw => {
        effects.push({ actionId: 'machines.services.list', input: MachineServicesListInputV1Schema.parse(raw) });
        return MachineServicesListResultV1Schema.parse(input.moveWritersUnavailable
        ? { kind: 'snapshot', services: [] }
        : { kind: 'snapshot', services: [{ serviceId: 'instance/app', name: 'Shop app', authority: 'project',
          lifecyclePurpose: 'deployment', generation: 'app-generation', state: 'running', native: { phase: 'running', readiness: 'ready' },
          environmentId, deployment: { deploymentId: 'deployment-a', installationId: 'installation-a',
            service: { kind: 'deployment', machineId, environmentId, environmentInstanceId: 'instance', composeService: 'app', serviceId: 'instance/app' } },
          capabilities: { start: true, stop: true, restart: true, logs: true, accounting: false } }] });
      },
    });
    await answerExternalActionAccountForHome(homes, serverId, {
      machineId, installationId: 'installation-a', actionId: 'workflow.run.start', tokenEpoch: 0,
      failure: result => {
        const code = result && typeof result === 'object' ? Reflect.get(result, 'errorCode') : null;
        return typeof code === 'string' ? { errorCode: code, error: code } : null;
      },
      execute: raw => {
        const operand = WorkflowRunStartRequestV1Schema.parse(raw);
        effects.push({ actionId: 'workflow.run.start', input: operand });
        if (input.refuseWorkflowStart) return { errorCode: 'machine_unavailable' };
        return { admission: 'created', run: createWorkflowRunSummaryFixture({ id: operand.runId, machineId,
          ownerAccountId: 'account-owner', origin: { kind: 'direct' } }) };
      },
    });
    await answerExternalActionAccountForHome(homes, serverId, {
      machineId, installationId: 'installation-a', actionId: 'deployments.environments.update', tokenEpoch: 0,
      execute: raw => {
        const operand = DeploymentActionInputSchemasV1['deployments.environments.update'].parse(raw);
        effects.push({ actionId: 'deployments.environments.update', input: operand });
        return { ok: true, environmentId, revision: detail.environment.revision + 1 };
      },
    });
  }
  if (input.answers?.bindingRefusal) {
    const code = input.answers.bindingRefusal;
    await answerExternalActionAccountForHome(homes, serverId, {
      machineId, installationId: 'installation-a', actionId: 'deployments.bindings.set', tokenEpoch: 0,
      execute: () => DeploymentActionOutputSchemasV1['deployments.bindings.set'].parse({ ok: false, error: code }),
    });
    homes.answer(serverId, '/v1/deployments/environments/environment-web', { body: {
      ok: true, environment: { ...detail.environment, id: 'environment-web', revision: 4, controllerMachineId: machineId }, targetLinks: [],
    } });
    const { createDeploymentActions } = await import('./deploymentActions');
    setBindings = createDeploymentActions(account.accountLifetime, detail.environment.projectSourceId).setBindings;
  }
  if (input.readDatabaseAutomations && !input.moveDestination && !input.movePickerScope) {
    await account.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
      header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Shop database' }, body: JSON.stringify(detail.content) });
    if (input.managed) {
      for (const row of detail.targetLinks) {
        if (row.targetLink.id !== 'managed-database' || !row.content) continue;
        await account.createArtifactDocument({
          artifactId: row.targetLink.contentArtifactId,
          header: { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'Retained database' },
          body: JSON.stringify(row.content),
        });
      }
    }
  }
  const publicReadTransport = input.moveDestination || input.movePickerScope || input.readDatabaseAutomations
    ? (await import('./deploymentReadTransport')).createDeploymentReadTransport(account.accountLifetime) : null;
  const readRetainedReceipt = vi.fn(async () => ({ ok: true as const, value: receipt }));
  const controller = createDeploymentReadControllerV1({
    scope: {
      serverId: detail.environment.serverId,
      accountId: 'account-owner',
      projectSourceId: 'source-app',
    },
    transport: {
      listEnvironments: async () => ({
        ok: true,
        value: { items: [
          { environment: detail.environment, title: 'Shop database' },
          { environment: createDeploymentEnvironmentHeaderV1({ id: 'environment-web', revision: 4,
            serverId, projectSourceId: detail.environment.projectSourceId }), title: 'Shop web' },
        ], nextCursor: null },
      }),
      // Move destinations read through the real transport; no test-supplied candidate fact.
      readEnvironment: async (scope, id, options) => publicReadTransport && (
        (id !== environmentId && input.moveDestination) || (id === environmentId && input.countEnvironmentAcquisitions))
        ? publicReadTransport.readEnvironment(scope, id, options) : { ok: true, value: detail },
      listHistory: async () => ({
        ok: true,
        value: { ok: true, items: [receipt.deployment], nextCursor: null },
      }),
      readReceipt: readRetainedReceipt,
      listDataServicePage: async (_scope, query) => {
        const data = detail.content.template?.data?.find(service => service.service === query.database);
        return { ok: true, value: { items: [{ environment: detail.environment, content: detail.content, title: detail.content.name,
          selected: { detail: { ...detail, runtimeTargetLink: selectDeploymentRuntimeTargetLinkV1(detail) },
            address: data ? { kind: 'selfHosted', data } : null },
        }], nextCursor: null, coverage: 'partial' as const } };
      },
      ...(publicReadTransport ? { listEnvironments: publicReadTransport.listEnvironments } : {}),
      ...(input.readDatabaseAutomations && publicReadTransport ? { listDataServicePage: publicReadTransport.listDataServicePage } : {}),
    },
  });
  const navigate = vi.fn();
  const back = vi.fn();
  const ProjectDeploymentsView = input.linkWorkflow ? (await import('./ProjectDeploymentsBody')).ProjectDeploymentsView : null;
  const reviewedWorkflowAudiences: unknown[] = [];
  if (input.linkWorkflow) {
    const { ProjectSourcesReadOutputV1Schema } = await import('@happier-dev/protocol/projects/sources/projectSourceV1');
    const sourceId = detail.environment.projectSourceId;
    homes.answer(serverId, `GET /v1/projects/sources/${sourceId}`, { body: ProjectSourcesReadOutputV1Schema.parse({ ok: true,
      canManage: true, source: { id: sourceId, name: 'Shop', revision: 1, createdByAccountId: account.accountId,
        owner: { kind: 'account', accountId: account.accountId }, audience: [] } }) });
    await account.createArtifactDocument({ artifactId: input.linkWorkflow, header: { kind: 'workflow-definition.v1',
      definitionId: input.linkWorkflow, revision: { headerVersion: 1, bodyVersion: 1 }, metadata: { title: 'Restore review' } },
      body: JSON.stringify({ kind: 'workflow-definition.v1', definition: createNightlyBackupsWorkflowV1() }) });
    homes.answer(serverId, `GET /v1/artifacts/${input.linkWorkflow}/access/grants`, { select: (_body, request) => {
      const requested = new URL(request.url).searchParams.get('requestedAudience');
      reviewedWorkflowAudiences.push(requested === null ? null : JSON.parse(requested));
      return { body: { artifactId: input.linkWorkflow, ownerAccountId: account.accountId,
        access: 'owner', grants: [], missingAudience: [] } };
    } });
    routerMock.module.router.setParams({ deploymentEnvironment: environmentId, deploymentService: 'postgres' });
  }
  const screen = await renderScreen(
    <ModalProvider><PluginSurfaceDestinationNavigationBindingProvider binding={navigation}>
      {ProjectDeploymentsView ? <ProjectDeploymentsView controller={controller} sourceId={detail.environment.projectSourceId}
        demand={shown} lifetime={account.accountLifetime} serverId={serverId} accountId={account.accountId} /> : <DeploymentDatabasePage
        controller={controller}
        environmentId={environmentId}
        database={input.database ?? (input.managed ? 'managed-database' : 'postgres')}
        demand={shown}
        phone={false}
        lifetime={account.accountLifetime}
        review={noReview}
        restore={input.restore ?? null}
        setBindings={setBindings}
        onBack={back}
        onNavigate={navigate}
      />}
    </PluginSurfaceDestinationNavigationBindingProvider></ModalProvider>,
  );
  const settle = async (testID: string) => {
    await act(async () => {
      await Promise.race([
        waitForTestEvent(
          screen.subscribe,
          () => screen.findByTestId(testID),
          (node) => node !== null,
        ),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    });
    return screen.findByTestId(testID);
  };
  return {
    screen,
    settle,
    effects,
    opened, descriptor, scope,
    environmentId,
    serverIdentityId,
    machineId,
    readSelectedDatabase: () => publicReadTransport?.listDataServicePage({ serverId: detail.environment.serverId,
      accountId: account.accountId, projectSourceId: detail.environment.projectSourceId }, { environmentId, database: 'postgres' },
    { signal: new AbortController().signal }),
    movePickerQueries,
    readRetainedReceipt,
    requests: () => homes.requests,
    reviewedWorkflowAudiences,
    accountId: account.accountId,
    moveDestination: moved,
    readScheduleSets: async () => {
      const { createDeploymentActions } = await import('./deploymentActions');
      return createDeploymentActions(account.accountLifetime).backupScheduleSets({ environmentId });
    },
    navigate,
    back,
    dispose: async () => {
      await screen.unmount();
      controller.retire();
      unregisterNavigation();
      unregisterActionPort();
      withdrawProjection();
      account.dispose();
      if (input.linkWorkflow) routerMock.resetParams();
    },
  };
}

describe('Environment → Database → Private console', () => {
  it('shares the active inventory read between Database and Restore and retries only on request', async () => {
    let readCount = 0;
    let startRead!: () => void;
    const started = new Promise<void>(resolve => { startRead = resolve; });
    let finishRead!: (refusal: InventoryRefusal) => void;
    const firstRead = new Promise<InventoryRefusal>(resolve => { finishRead = resolve; });
    let firstPending = true;
    const view = await renderDatabase({
      restore: async () => { throw new Error('Restore must not run during inventory'); },
      answers: { inventoryBeforeRead: () => {
        readCount += 1;
        if (readCount === 1) {
          startRead();
          return firstRead;
        }
        return firstPending ? 'effect_in_progress' : null;
      } },
    });
    const picker = 'project-deployments.restore';
    try {
      expect(await view.settle(`${page}.restore`)).not.toBeNull();
      await started;
      await view.screen.pressByTestIdAsync(`${page}.restore`);
      expect(await view.settle(`${picker}.choices.loading`)).not.toBeNull();
      firstPending = false;
      await act(async () => finishRead('repository_password_incorrect'));
      expect(await view.settle(`${picker}.choices.failed`)).not.toBeNull();
      const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
      const card = view.screen.findAllByType(SurfaceStateCard)
        .find(node => node.props.testID === `${picker}.choices.failed`);
      expect(card?.props.reason).toContain('repository rejected its password');
      expect(readCount).toBe(1);
      await view.screen.pressByTestIdAsync(`${picker}.choices.failed-action`);
      expect(await view.settle(`${picker}.choice.${'f'.repeat(64)}`)).not.toBeNull();
      expect(readCount).toBe(2);
    } finally {
      finishRead('repository_password_incorrect');
      await view.dispose();
    }
  });

  it('shows one console row: Open where the workbench can open it, never beside a contradicting unavailable row', async () => {
    const view = await renderDatabase({ storedDefinition: true });
    try {
      expect(await view.settle(`${page}.query`)).not.toBeNull();
      expect(view.screen.findByTestId(`${page}.console.access`)).toBeNull();
      for (const control of ['open', 'add', 'domains']) {
        expect(view.screen.findByTestId(`${page}.console.${control}`)).toBeNull();
      }
      expect(view.effects.some(effect => effect.actionId === 'deployments.templates.instantiate')).toBe(false);
    } finally { await view.dispose(); }
  });
});

function expectOpenedDatabaseConsole(view: Awaited<ReturnType<typeof renderDatabase>>) {
  const [request] = view.opened;
  expect(request?.destination).toEqual({ pluginId: DATABASE_PLUGIN_ID_V1, localId: 'database-workbench' });
  expect(request).not.toHaveProperty('input');
  const [prefix, serverId, machineId, installationId, kind, selector, mode] = request?.subPath?.split('/') ?? [];
  expect([prefix, serverId, machineId, installationId, kind, mode]).toEqual([
    '~run-on', view.serverIdentityId, view.machineId, view.descriptor.placement.installationId, 'target', 'console',
  ]);
  const { target, engine, label, origin } = view.descriptor;
  const selected = JSON.parse(new TextDecoder().decode(decodeBase64(selector!, 'base64url')));
  expect(selected).toEqual(target.kind === 'managed_deployment'
    ? { target, display: { engine, label, origin: origin.label } }
    : target);
}

describe('Environment → Database → Workbench', () => {
  it('reviews a saved Workflow link for the selected Database using the Project Source audience', () => withPopoverWebGlobals(async () => {
    const workflowId = '7ebe2403-2fdc-4c60-acc5-ae43cd15da20';
    const view = await renderDatabase({ readDatabaseAutomations: true, linkWorkflow: workflowId });
    const { ValueFieldSelect } = await import('@/components/ui/forms/ValueFieldSelect');
    const { SelectionList } = await import('@/components/ui/selectionList');
    const { DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1 } = await import('@happier-dev/protocol/deployments/deploymentActionIdsV1');
    try {
      expect(await view.settle('subject-triggers-link')).not.toBeNull();
      await view.screen.pressByTestIdAsync('subject-triggers-link');
      const picker = () => view.screen.findAllByType(SelectionList).find(list => list.props.testID === 'resource-link-pick');
      await waitForHomeGovernance(() => expect(picker()?.props.rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []))
        .toEqual(expect.arrayContaining([expect.objectContaining({ id: workflowId })])));
      await act(async () => picker()!.props.onSelect(workflowId));
      const when = () => view.screen.findAllByType(ValueFieldSelect).find(select => select.props.testID === 'resource-link-when');
      const choice = `action:after:${DEPLOYMENT_BACKUP_RESTORE_ACTION_ID_V1}`;
      await waitForHomeGovernance(() => expect(when()?.props.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: choice })])));
      await act(async () => when()!.props.onSelect(choice));
      await waitForHomeGovernance(() => expect(view.reviewedWorkflowAudiences)
        .toContainEqual([{ kind: 'account', accountId: view.accountId }]));
      await waitForHomeGovernance(() => expect(view.screen.findByTestId('resource-link-submit')?.props.disabled).toBe(false));
    } finally { await view.dispose(); }
  }));

  it('reads only the selected database when the Environment declares two', async () => {
    const view = await renderDatabase({ readDatabaseAutomations: true });
    try {
      await waitForHomeGovernance(async () => {
        expect(view.screen.findByTestId('subject-triggers-add')).not.toBeNull();
        expect(view.effects.filter(effect => effect.actionId === 'deployments.data.size').map(effect => effect.input.service))
          .toEqual(['postgres']);
      });
      expect(view.effects.filter(effect => effect.actionId === 'action.invoke')).toEqual([expect.objectContaining({
        input: expect.objectContaining({ input: { scope: { ...view.scope,
          selection: { kind: 'native_service', service: 'postgres' } } } }),
      })]);
    } finally { await view.dispose(); }
  });

  it.each([false, true])('retries discovery for the selected Database when size Action refused is %s', async databaseSizeActionRefused => {
    let refused = true;
    const view = await renderDatabase({ readDatabaseAutomations: true, databaseSizeActionRefused,
      workbenchDiscoveryRefused: () => refused });
    try {
      expect(await view.settle('subject-triggers')).not.toBeNull();
      expect(await view.settle('subject-triggers-read-retry')).not.toBeNull();
      expect(view.screen.findByTestId(`${page}.variables`)).not.toBeNull();
      refused = false;
      await view.screen.pressByTestIdAsync('subject-triggers-read-retry');
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        expect(view.screen.findByTestId('subject-triggers-read-retry')).toBeNull();
        expect(view.screen.findByTestId('subject-triggers')).not.toBeNull();
        expect(view.screen.findByTestId('subject-triggers-add')).not.toBeNull();
        const queries = homes.requestsFor('/v3/automations/query').map(request => request.input);
        expect(queries).toContainEqual(expect.objectContaining({
          subject: { kind: 'database', serverId: view.serverIdentityId,
            target: { kind: 'environment', environmentId: view.environmentId, service: 'postgres' } },
        }));
        const discoveries = view.effects.filter(effect => effect.actionId === 'action.invoke');
        expect(discoveries.length).toBeGreaterThan(0);
        for (const discovery of discoveries) expect(discovery.input).toMatchObject({
          input: { scope: { kind: 'environment', environment: { serverId: view.serverIdentityId, environmentId: view.environmentId } } },
        });
      });
    } finally { await view.dispose(); }
  });

  it.each([{ managed: false, detached: false }, { managed: true, detached: true }])(
    'acquires the Environment once when opening a Database route ($detached)',
    async ({ managed, detached }) => {
      const view = await renderDatabase({ managed, detached, noBackup: true,
        readDatabaseAutomations: true, countEnvironmentAcquisitions: true });
      try {
        expect(await view.settle(`${page}.header`)).not.toBeNull();
        expect(homes.requests.filter(request => request.path.split('?')[0] === `/v1/deployments/environments/${view.environmentId}`)
          .map(request => request.path))
          .toHaveLength(1);
        expect(view.effects.filter(effect => effect.actionId === 'action.invoke' || effect.actionId === 'deployments.data.size')).toHaveLength(0);
        if (detached) {
          expect(view.screen.findByTestId(`${page}.cleanup`)).not.toBeNull();
          expect(view.screen.findByTestId(`${page}.query`)).toBeNull();
        }
      } finally { await view.dispose(); }
    },
  );

  it('opens the exact deployment database without rediscovering its target', async () => {
    const view = await renderDatabase({ readDatabaseAutomations: true });
    try {
      await view.settle(`${page}.query`);
      expect(await view.settle('subject-triggers-add')).not.toBeNull();
      expect(view.effects.filter(effect => effect.actionId === 'action.invoke')).toHaveLength(1);
      await view.screen.pressByTestIdAsync(`${page}.query`);
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        const { Modal } = await import('@/modal');
        expect(view.opened, JSON.stringify({ effects: view.effects, alerts: vi.mocked(Modal.alert).mock.calls,
          operations: [...actionOperationStore.getSnapshot().operationsByKey.values()] })).toHaveLength(1);
      });
      expectOpenedDatabaseConsole(view);
      expect(view.effects.filter(effect => effect.actionId === 'action.invoke')).toEqual([
        expect.objectContaining({ input: expect.objectContaining({ input: { scope: {
          kind: 'environment', environment: view.scope.environment, selection: { kind: 'native_service', service: 'postgres' } } } }) })]);
      expect(view.screen.findByTestId('project-deployments.query.sql')).toBeNull();
    } finally { await view.dispose(); }
  });

  it('shows the Workbench discovery refusal in Details without rediscovering the target', async () => {
    const view = await renderDatabase({ readDatabaseAutomations: true, workbenchDiscoveryRefused: true });
    const details = 'project-deployments.outcome.refused.other.details';
    try {
      await view.settle(`${page}.query`);
      expect(await view.settle('subject-triggers-read-retry')).not.toBeNull();
      const attempts = () => homes.requestsFor('/v1/actions/action.invoke');
      const before = attempts().length;
      await view.screen.pressByTestIdAsync(`${page}.query`);
      expect(await view.settle(details)).not.toBeNull();
      await view.screen.pressByTestIdAsync(details);
      expect(view.screen.getTextContent()).toContain('plugin_service_unavailable');
      expect(attempts()).toHaveLength(before);
      expect(view.opened).toEqual([]);
    } finally { await view.dispose(); }
  });

  it('opens the exact managed database through the shared Workbench', async () => {
    const view = await renderDatabase({ managed: true, readDatabaseAutomations: true });
    try {
      await waitForHomeGovernance(() => {
        expect(view.effects.filter(effect => effect.actionId === 'action.invoke')).toHaveLength(1);
        const button = view.screen.findByTestId(`${page}.query`);
        expect(button).not.toBeNull();
        expect(button?.props['aria-disabled']).not.toBe(true);
      });
      await view.screen.pressByTestIdAsync(`${page}.query`);
      await waitForHomeGovernance(async () => { await act(async () => {}); expect(view.opened).toHaveLength(1); });
      expectOpenedDatabaseConsole(view);
      expect(view.opened[0]).not.toHaveProperty('input');
      expect(view.readRetainedReceipt).not.toHaveBeenCalled();
      expect(view.effects.filter(effect => effect.actionId === 'action.invoke')).toEqual([
        expect.objectContaining({ input: expect.objectContaining({ input: { scope: {
          ...view.scope, selection: { kind: 'managed_link', targetLinkId: 'managed-database' } } } }) })]);
    } finally { await view.dispose(); }
  });

  it('reports an unavailable exact target when the managed link has multiple databases', async () => {
    const view = await renderDatabase({ managed: true, multipleManagedDatabases: true, readDatabaseAutomations: true });
    try {
      await waitForHomeGovernance(() => {
        expect(view.effects.filter(effect => effect.actionId === 'action.invoke')).toHaveLength(1);
        const button = view.screen.findByTestId(`${page}.query`);
        expect(button).not.toBeNull();
        expect(button?.props['aria-disabled']).not.toBe(true);
      });
      await view.screen.pressByTestIdAsync(`${page}.query`);
      const details = 'project-deployments.outcome.refused.other.details';
      expect(await view.settle(details)).not.toBeNull();
      await view.screen.pressByTestIdAsync(details);
      expect(view.screen.getTextContent()).toContain('database_target_unavailable');
      expect(view.opened).toEqual([]);
    } finally { await view.dispose(); }
  });

  it.each([
    { origin: 'created' as const, starts: 'remove', detached: false },
    { origin: undefined, starts: 'detach', detached: false },
    { origin: 'created' as const, starts: 'remove', detached: true },
  ])('reviews removal for a managed database project (origin $origin, detached $detached)', async ({ origin, starts, detached }) => {
    const { definePlugin, deploymentTargetRoleWithNativeSelectorV1, DeploymentTargetRoleInputProtocolSchemasV1, DeploymentTargetRoleResultV1ProtocolSchema } = await import('@happier-dev/plugin-sdk');
    const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployments/testing/v1');
    const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
    const pluginId = 'com.example.removable-database';
    const execution = { target: 'account', account: { artifactId: 'removal-runtime', exportName: 'activate' } } as const;
    const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
    const nativeSelectorSchema = { ...closed, properties: { branchId: { type: 'string', minLength: 1 } } } as const;
    const plugin = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Managed Postgres', actions: {
      'projects-delete': { title: 'Delete the recorded project', execution, surfaces: ['ui'], readOnly: false, dangerLevel: 'destructive',
        confirmation: { title: 'Delete this Postgres project and all of its data?' },
        inputSchema: deploymentTargetRoleWithNativeSelectorV1(DeploymentTargetRoleInputProtocolSchemasV1['projects.delete'].jsonSchema, nativeSelectorSchema),
        resultSchema: DeploymentTargetRoleResultV1ProtocolSchema,
        run: async () => ({ v: 1, state: 'succeeded', observedAtMs: 1, providerResourceAbsent: true } as const) },
    }, deploymentTargets: { database: { role: 'data', title: 'Managed Postgres', targetKind: 'database', icon: 'server-outline',
      targetSchema: closed, linkSchema: closed, nativeSelectorSchema, dataV1: { projects: { delete: 'projects-delete' } } } } });
    const serverId = await homes.addHome({ name: 'Managed removal', serverUrl: `https://managed-removal-${starts}.test`,
      serverIdentityId: `srv_managed_removal_${starts}`, accountId: 'owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
      activate: api => plugin.activateAccount(api, execution.account), accountLifetime: account.accountLifetime, publishProjection: true });
    const targetLink = createDeploymentTargetLinkHeaderV1({ id: 'managed-removal', role: 'data', targetKind: 'database', machines: [], members: [],
      ...(detached ? { state: 'detached', detachedAtMs: 1 } as const : {}),
      source: { kind: 'plugin', contribution: { pluginId, localId: 'database' } } });
    const principal = { kind: 'account' as const, accountId: 'owner',
      purpose: { consumer: { pluginId, localId: 'link' }, purpose: 'deploy-manage' },
      target: { kind: 'account' as const, account: { service: { pluginId, localId: 'database' }, accountId: 'token' } } };
    const resourceName = 'shop-orders';
    const detail = createDeploymentEnvironmentDetailV1({ environment: (({ runtimeTargetLinkId: _runtime, ...header }) => header)(createDeploymentEnvironmentHeaderV1({ serverId })),
      targetLinks: [{ targetLink, content: { ...(origin ? { providerResourceOrigin: origin } : {}), credentialPrincipal: principal,
        preparedNative: { projectName: resourceName },
        providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project-123', providerEnvironment: 'main' },
        providerEnvironment: { kind: 'native', selection: { branchId: 'main' } } } }] });
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
      environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink) } });
    await account.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
      header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: detail.content.name }, body: JSON.stringify(detail.content) });
    await account.createArtifactDocument({ artifactId: targetLink.contentArtifactId,
      header: { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: resourceName }, body: JSON.stringify(detail.targetLinks[0]!.content) });
    const removals: unknown[] = [];
    await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
      actionId: 'deployments.teardown', tokenEpoch: 0, requesterInvocation: 'required', execute: raw => {
        removals.push(raw);
        return { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1,
          deploymentId: 'data-teardown', deploymentRevision: 1, state: 'queued' };
      } });
    const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
    const controller = createDeploymentReadControllerV1({ scope: { serverId, accountId: 'owner', projectSourceId: detail.environment.projectSourceId },
      transport: createDeploymentReadTransport(account.accountLifetime) });
    const screen = await renderScreen(<ModalProvider><DeploymentDatabasePage controller={controller}
      environmentId={detail.environment.id} database={targetLink.id} demand={shown} phone={false}
      lifetime={account.accountLifetime} review={noReview} restore={null} setBindings={null} onBack={() => {}} onNavigate={() => {}} /></ModalProvider>);
    try {
      await waitForHomeGovernance(async () => { await act(async () => {});
        expect(screen.findByTestId(`${page}.remove`)?.props.onPress).toBeTypeOf('function'); });
      if (detached) {
        expect(screen.findByTestId(`${page}.cleanup`)).not.toBeNull();
        expect(screen.findByTestId(`${page}.manage`)).toBeNull();
        expect(screen.findByTestId(`${page}.variables`)).toBeNull();
      }
      await screen.pressByTestIdAsync(`${page}.remove`);
      // The removal owner picks the start: a project Happier created starts on Delete, a linked one on Unlink.
      await waitForHomeGovernance(async () => { await act(async () => {});
        expect(screen.findByTestId(`project-deployments.disposition.choice:${starts}`)?.props.accessibilityState).toMatchObject({ selected: true }); });
      if (starts === 'detach') await screen.pressByTestIdAsync('project-deployments.disposition.choice:remove');
      const resourceConfirmation = screen.findByTestId('project-deployments.disposition.resourceConfirmation');
      expect(resourceConfirmation).not.toBeNull();
      const { t } = await import('@/text');
      const prompt = t('projects.deployments.platformLink.typeToDelete', { resource: resourceName });
      expect(screen.getTextContent()).toContain(prompt);
      expect(resourceConfirmation?.props.accessibilityLabel).toBe(prompt);
      await act(async () => resourceConfirmation!.props.onChangeText('project-123'));
      expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(true);
      await act(async () => screen.findByTestId('project-deployments.disposition.resourceConfirmation')!.props.onChangeText(resourceName));
      await waitForHomeGovernance(async () => { await act(async () => {});
        expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(false); });
      await screen.pressByTestIdAsync('project-deployments.disposition.confirm');
      await waitForHomeGovernance(async () => { await act(async () => {}); expect(removals).toHaveLength(1); });
      // Deleting the project leaves the Environment; only its data link goes.
      expect(removals[0]).toMatchObject({ environmentId: detail.environment.id, targetLinkId: targetLink.id, providerRemoval: 'delete' });
      expect(removals[0]).not.toHaveProperty('removeEnvironment');
    } finally { await screen.unmount(); controller.retire(); await installed.dispose(); account.dispose(); }
  });


});

/** Move is a page-level database operation: it is the page header ⋯'s entry, never a section's action slot. */
async function chooseMoveFromHeaderMenu(view: Awaited<ReturnType<typeof renderDatabase>>) {
  const { PageHeaderMenu } = await import('@/components/ui/layout/PageHeaderEntityParts');
  expect(await view.settle(`${page}.menu.trigger`)).not.toBeNull();
  expect(view.screen.findByTestId(`${page}.usedBy`)).not.toBeNull();
  expect(view.screen.findByTestId(`${page}.move`)).toBeNull();
  const menu = view.screen.findAllByType(PageHeaderMenu).find(node => node.props.testID === `${page}.menu`);
  const move = menu?.props.actions.find((action: { id: string }) => action.id === 'move');
  expect(move?.testID).toBe(`${page}.move`);
  await act(async () => { await move.onSelect(); });
}

describe('Environment → Database → Move', () => {
  it.each([true, false])('opens Move only with a serving runtime Link from the selected database read (%s)', async hasRuntimeLink => {
    const view = await renderDatabase({ readDatabaseAutomations: true, moveDestination: true,
      storedDefinition: true, databaseOnly: true, noRuntimeLink: !hasRuntimeLink });
    try {
      expect(await view.settle(`${page}.header`)).not.toBeNull();
      if (hasRuntimeLink) {
        expect(await view.settle(`${page}.menu.trigger`)).not.toBeNull();
        await chooseMoveFromHeaderMenu(view);
        expect(await view.settle('project-deployments.move.destination:database-dedicated')).not.toBeNull();
      } else {
        expect(view.screen.findByTestId(`${page}.move`)).toBeNull();
        expect(view.screen.findByTestId(`${page}.menu.trigger`)).toBeNull();
      }
      const result = await view.readSelectedDatabase();
      expect(result).toMatchObject({ ok: true, value: { items: [{ selected: { detail: {
        runtimeTargetLink: hasRuntimeLink ? { activeDeploymentId: 'deployment-a' } : null,
      } } }] } });
    } finally { await view.dispose(); }
  });

  it('offers dedicated Postgres across Projects and Machines and excludes unsupported destinations', async () => {
    const view = await renderDatabase({ moveDestination: true, movePickerScope: true, storedDefinition: true, databaseOnly: true });
    try {
        expect(await view.settle(`${page}.menu.trigger`)).not.toBeNull();
      await chooseMoveFromHeaderMenu(view);
      const destination = await view.settle('project-deployments.move.destination:database-dedicated');
      expect(destination, JSON.stringify({ queries: view.movePickerQueries.map(query => Object.fromEntries(query)),
        failures: view.screen.findAll(node => typeof node.props.diagnosticCode === 'string')
          .map(node => ({ testID: node.props.testID, code: node.props.diagnosticCode })), text: view.screen.getTextContent() })).not.toBeNull();
      expect(view.screen.findByTestId('project-deployments.move.destination:database-other-machine')).not.toBeNull();
      for (const environmentId of [view.environmentId, 'database-mysql']) {
        expect(view.screen.findByTestId(`project-deployments.move.destination:${environmentId}`)).toBeNull();
      }
      await view.screen.pressByTestIdAsync('project-deployments.move.destination:database-dedicated');
      // Reading the chosen destination works on its own row, never as a line that grows and shrinks the sheet.
      expect(view.screen.findByTestId('project-deployments.move.destination.loading')).toBeNull();
      await waitForHomeGovernance(() => expect(view.screen.findByTestId('project-deployments.move.copy')?.props.disabled).toBe(false));
      // One Account page supplies the picker; selecting opens the cross-Project detail through the same owner.
      expect(view.movePickerQueries.map(query => ({ machineId: query.get('machineId'), projectSourceId: query.get('projectSourceId') })))
        .toEqual([{ machineId: null, projectSourceId: null }]);
      // The public source also reads targets through action.invoke; its boundary verifies the exact read-only contribution.
      expect(view.effects.filter(effect => effect.actionId === 'workflow.run.start'
        || effect.actionId === 'deployments.environments.update')).toEqual([]);
    } finally { await view.dispose(); }
  });
  it('does not offer an app-plus-database destination and refuses a stale selection without effects', async () => {
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const view = await renderDatabase({ moveDestination: true, moveDestinationWithApp: true, storedDefinition: true });
    try {
      await view.settle(`${page}.menu.trigger`);
      await chooseMoveFromHeaderMenu(view);
      const { DeploymentEnvironmentChooser } = await import('./DeploymentEnvironmentCollection');
      const chooser = view.screen.findAllByType(DeploymentEnvironmentChooser)[0]!;
      expect(view.screen.findByTestId('project-deployments.move.destination:database-dedicated')).toBeNull();
      // A row selected before its refreshed content is classified still reaches the same destination owner.
      await act(async () => chooser.props.onSelect({ environment: view.moveDestination.environment, title: 'App and database' }));
      await view.settle('project-deployments.move.destination.unavailable');
      expect(view.screen.findAllByType(SurfaceStateCard)
        .find(card => card.props.testID === 'project-deployments.move.destination.unavailable')?.props.diagnosticCode).toBe('unsupported');
      expect(view.screen.findByTestId('project-deployments.move.copy')?.props.disabled).toBe(true);
      expect(view.screen.findByTestId('project-deployments.move.save')).toBeNull();
      expect(view.effects.filter(effect => getActionSpec(effect.actionId)?.sideEffectClass !== 'read')).toEqual([]);
    } finally { await view.dispose(); }
  });
  it('explains that a database-only Environment has no connected services without admitting a Move', async () => {
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const { t } = await import('@/text');
    const view = await renderDatabase({ moveDestination: true, storedDefinition: true, databaseOnly: true });
    try {
      await view.settle(`${page}.menu.trigger`);
      await chooseMoveFromHeaderMenu(view);
      expect(await view.settle('project-deployments.move.destination:database-dedicated')).not.toBeNull();
      await view.screen.pressByTestIdAsync('project-deployments.move.destination:database-dedicated');
      await waitForHomeGovernance(() => expect(view.screen.findByTestId('project-deployments.move.copy')?.props.disabled).toBe(false));
      await view.screen.pressByTestIdAsync('project-deployments.move.copy');
      expect(await view.settle('project-deployments.move.refused')).not.toBeNull();
      const refusal = view.screen.findAllByType(SurfaceStateCard)
        .find(card => card.props.testID === 'project-deployments.move.refused');
      expect(refusal?.props.diagnosticCode).toBe('no_connected_services');
      expect(refusal?.props.reason).toBe(t('projects.deployments.move.noConnectedServices'));
      expect(view.screen.findByTestId('project-deployments.move.save')).toBeNull();
      expect(view.effects.filter(effect => getActionSpec(effect.actionId)?.sideEffectClass !== 'read')).toEqual([]);
    } finally { await view.dispose(); }
  });

  it('offers Move on a deployed PostgreSQL before backups are set up', async () => {
    const view = await renderDatabase({ noBackup: true, storedDefinition: true });
    try {
      expect(await view.settle(`${page}.menu.trigger`)).not.toBeNull();
      await chooseMoveFromHeaderMenu(view);
      await view.screen.pressByTestIdAsync('project-deployments.move.source.setUpBackups');
      expect(routerMock.spies.push).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({
        deploymentEnvironment: view.environmentId, deploymentTab: 'settings', deploymentSection: 'backups' }) }));
      expect(view.effects.some(effect => effect.actionId === 'workflow.run.start')).toBe(false);
    } finally { await view.dispose(); }
  });

  it('uses the data owner’s single-Machine prerequisite instead of leaving other source writers running', async () => {
    const view = await renderDatabase({ moveDestination: true, storedDefinition: true, sourceMultiMachine: true });
    try {
      expect(await view.settle(`${page}.connection`)).not.toBeNull();
      expect(view.screen.findByTestId(`${page}.move`)).toBeNull();
        expect(view.screen.findByTestId(`${page}.menu.trigger`)).toBeNull();
      expect(view.effects.filter(effect => effect.actionId === 'workflow.run.start')).toEqual([]);
    } finally { await view.dispose(); }
  });
  it('lists a managed data link from the real Move page as unavailable with its reason, never as a selectable destination', async () => {
    const { Item } = await import('@/components/ui/lists/Item');
    const { t } = await import('@/text');
    // Like the live App: an app-plus-database definition is no native destination, so only the managed fact offers it.
    const view = await renderDatabase({ moveDestination: true, moveManagedDestination: true, moveDestinationWithApp: true,
      movePickerScope: true, storedDefinition: true, databaseOnly: true });
    try {
      await view.settle(`${page}.menu.trigger`);
      const beforePicker = view.requests().length;
      await chooseMoveFromHeaderMenu(view);
      // Managed positive and native control come from the Home's page projection, never an injected flag.
      expect(await view.settle('project-deployments.move.destination:database-dedicated')).not.toBeNull();
      expect(view.screen.findByTestId('project-deployments.move.destination:database-other-machine')).not.toBeNull();
      // A link the Home hid from this requester offers nothing.
      expect(view.screen.findByTestId('project-deployments.move.destination:database-hidden-link')).toBeNull();
      // Opening the picker is one list page plus one batched Artifact read, whatever the Environment count.
      const pickerPaths = view.requests().slice(beforePicker).map(request => request.path.split('?')[0])
        .filter(path => path.startsWith('/v1/deployments/') || path.startsWith('/v1/artifacts/'));
      expect(pickerPaths).toEqual(['/v1/deployments/environments', '/v1/artifacts/read']);
      expect(view.movePickerQueries.at(-1)?.get('dataTargetLinks')).toBe('true');
      // The managed row explains itself where it is listed (the Move destination owner refuses its import) and
      // cannot be chosen; a native destination beside it stays selectable and says where it runs.
      const row = (id: string) => view.screen.findAllByType(Item)
        .find(node => node.props.testID === `project-deployments.move.destination:${id}`)!.props;
      expect(row('database-dedicated')).toMatchObject({ disabled: true,
        subtitle: t('projects.deployments.databaseMoveManagedUnnamed') });
      expect(row('database-other-machine').disabled).toBe(false);
      expect(row('database-other-machine').icon).toBeTruthy();
      expect(view.screen.findByTestId('project-deployments.move.copy')?.props.disabled).toBe(true);
      expect(view.screen.findByTestId('project-deployments.move.review')).toBeNull();
      expect(view.effects.filter(effect => getActionSpec(effect.actionId)?.sideEffectClass !== 'read')).toEqual([]);
    } finally { await view.dispose(); }
  });

  it('requires destination backups before copying into an already provisioned database', async () => {
    const view = await renderDatabase({ moveDestination: true, moveDestinationUnprotected: true, storedDefinition: true });
    try {
      await view.settle(`${page}.menu.trigger`);
      await chooseMoveFromHeaderMenu(view);
      await view.settle('project-deployments.move.destination:database-dedicated');
      await view.screen.pressByTestIdAsync('project-deployments.move.destination:database-dedicated');
      expect(await view.settle('project-deployments.move.destination.unavailable')).not.toBeNull();
      expect(view.screen.findByTestId('project-deployments.move.copy')?.props.disabled).toBe(true);
      expect(view.effects.some(effect => effect.actionId === 'deployments.backups.run')).toBe(false);
      // The prerequisite leads to where it is met: the destination's Settings › Backups (PAGE-ACCEPT-176 D23).
      await view.screen.pressByTestIdAsync('project-deployments.move.destination.setUpBackups');
      expect(routerMock.spies.push).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({
        deploymentEnvironment: 'database-dedicated', deploymentTab: 'settings', deploymentSection: 'backups' }) }));
    } finally { await view.dispose(); }
  });

  it('leads a destination that is not ready yet to where it is shared, the way backups lead to Backups', async () => {
    const view = await renderDatabase({ moveDestination: true, moveDestinationUnshared: true, storedDefinition: true });
    try {
      await view.settle(`${page}.menu.trigger`);
      await chooseMoveFromHeaderMenu(view);
      await view.settle('project-deployments.move.destination:database-dedicated');
      await view.screen.pressByTestIdAsync('project-deployments.move.destination:database-dedicated');
      expect(await view.settle('project-deployments.move.destination.unavailable')).not.toBeNull();
      expect(view.screen.findByTestId('project-deployments.move.copy')?.props.disabled).toBe(true);
      await view.screen.pressByTestIdAsync('project-deployments.move.destination.share');
      expect(routerMock.spies.push).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({
        deploymentEnvironment: 'database-dedicated', deploymentTab: 'settings', deploymentSection: 'sharing' }) }));
    } finally { await view.dispose(); }
  });

  it('says a refused Move start in the sheet, with its code under Technical details, never as a bare alert (D25)', async () => {
    const view = await renderDatabase({ moveDestination: true, storedDefinition: true, refuseWorkflowStart: true });
    routerMock.spies.push.mockClear();
    try {
      await view.settle(`${page}.menu.trigger`);
      await chooseMoveFromHeaderMenu(view);
      await view.settle('project-deployments.move.destination:database-dedicated');
      await view.screen.pressByTestIdAsync('project-deployments.move.destination:database-dedicated');
      await waitForHomeGovernance(() => expect(view.screen.findByTestId('project-deployments.move.copy')?.props.disabled).toBe(false));
      await view.screen.pressByTestIdAsync('project-deployments.move.copy');
      await view.settle('project-deployments.move.save');
      await view.screen.pressByTestIdAsync('project-deployments.move.save');
      expect(await view.settle('project-deployments.move.review.refused')).not.toBeNull();
      const { Modal } = await import('@/modal');
      expect(vi.mocked(Modal.alert)).not.toHaveBeenCalled();
      expect(routerMock.spies.push).not.toHaveBeenCalled();
    } finally { await view.dispose(); }
  });

  it('reviews source writers and the cutover before admitting one persisted Workflow, with no page-owned effects', async () => {
    const view = await renderDatabase({ moveDestination: true, storedDefinition: true });
    try {
      await view.settle(`${page}.menu.trigger`);
      await chooseMoveFromHeaderMenu(view);
      await view.settle('project-deployments.move.destination:database-dedicated');
      // The sheet names the app it re-points, by its Compose service (R21-D7).
      const { t } = await import('@/text');
      expect(view.screen.getTextContent()).toContain(t('projects.deployments.databaseMoveLeadApp', { app: 'app' }));
      await view.screen.pressByTestIdAsync('project-deployments.move.destination:database-dedicated');
      await waitForHomeGovernance(() => expect(view.screen.findByTestId('project-deployments.move.copy')?.props.disabled).toBe(false));
      await view.screen.pressByTestIdAsync('project-deployments.move.copy');
      const review = await view.settle('project-deployments.move.save');
      const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
      const refusalCodes = view.screen.findAllByType(SurfaceStateCard).map(card => card.props.diagnosticCode);
      expect(review, JSON.stringify({ refusalCodes, effects: view.effects })).not.toBeNull();
      // A writer reads as its Compose service, not the runtime's internal service id (W5 live #172c).
      const writerTexts = view.screen.findByTestId('project-deployments.move.writer:instance/app')!
        .findAll(node => typeof node.props?.children === 'string').map(node => node.props.children);
      expect(writerTexts).toContain('app');
      expect(writerTexts).not.toContain('instance/app');
      const { CodeBlockView } = await import('@/components/ui/code/blocks/CodeBlockView');
      const { isMap, parseDocument } = await import('yaml');
      const compose = view.screen.findAllByType(CodeBlockView).find(block => block.props.language === 'yaml');
      expect(compose).toBeDefined();
      const document = parseDocument(compose!.props.code);
      expect(document.errors).toEqual([]);
      expect(isMap(document.contents) && document.contents.flow !== true).toBe(true);
      expect(compose!.props.code).toContain('${DB_MOVE_PORT}');
      expect(compose!.props.code).not.toMatch(/\$\{[^}]*[\r\n]/u);
      expect(compose!.props.wrap).not.toBe(true);
      expect(view.effects.filter(effect => getActionSpec(effect.actionId)?.sideEffectClass !== 'read')).toEqual([]);
      await view.screen.pressByTestIdAsync('project-deployments.move.save');
      await waitForHomeGovernance(() => expect(view.effects.some(effect => effect.actionId === 'workflow.run.start')).toBe(true));
      expect(view.effects.filter(effect => effect.actionId === 'workflow.run.start')).toHaveLength(1);
      const admitted = view.effects.find(effect => effect.actionId === 'workflow.run.start')?.input;
      expect(admitted).toMatchObject({ executionTarget: { kind: 'detached_run' }, source: { kind: 'saved' },
        inputs: { dataMove: { writers: [{ machineId: view.machineId, serviceId: 'instance/app', expectedGeneration: 'app-generation' }],
          sourceId: 'database', origin: { environmentId: view.environmentId },
          restoreTarget: { environmentId: 'database-dedicated', targetLinkId: 'target-database-dedicated', deploymentId: 'deployment-a' },
          health: { environmentId: 'database-dedicated', deploymentId: 'deployment-dedicated' },
          cutover: { patch: { definition: { from: 'compose', services: ['app'] } } } } } });
      expect(view.effects.filter(effect => effect.actionId !== 'workflow.run.start'
        && getActionSpec(effect.actionId)?.sideEffectClass !== 'read')).toEqual([]);
      expect(routerMock.spies.push).toHaveBeenCalledWith(expect.stringContaining(String(admitted?.runId)));
    } finally { await view.dispose(); }
  });

  it('requires writer review when the native service cannot be identified and starts no backup', async () => {
    const view = await renderDatabase({ moveDestination: true, moveWritersUnavailable: true, storedDefinition: true });
    try {
      await view.settle(`${page}.menu.trigger`);
      await chooseMoveFromHeaderMenu(view);
      await view.settle('project-deployments.move.destination:database-dedicated');
      await view.screen.pressByTestIdAsync('project-deployments.move.destination:database-dedicated');
      await waitForHomeGovernance(() => expect(view.screen.findByTestId('project-deployments.move.copy')?.props.disabled).toBe(false));
      await view.screen.pressByTestIdAsync('project-deployments.move.copy');
      expect(await view.settle('project-deployments.move.refused')).not.toBeNull();
      expect(view.screen.findByTestId('project-deployments.move.save')).toBeNull();
      expect(view.effects.filter(effect => getActionSpec(effect.actionId)?.sideEffectClass !== 'read')).toEqual([]);
    } finally { await view.dispose(); }
  });

  it('leads from an empty destination list to Store databases, for any Machine (D23)', async () => {
    const view = await renderDatabase({ storedDefinition: true, movePickerScope: true });
    routerMock.spies.push.mockClear();
    try {
      await view.settle(`${page}.menu.trigger`);
      await chooseMoveFromHeaderMenu(view);
      expect(await view.settle('project-deployments.move.destination.empty')).not.toBeNull();
      await view.screen.pressByTestIdAsync('project-deployments.move.destination.empty.action');
      const href = String(routerMock.spies.push.mock.calls.at(-1)?.[0]);
      const query = new URLSearchParams(href.split('?')[1]);
      expect({ view: query.get('view'), kind: query.get('kind'), filters: JSON.parse(query.get('filters') ?? 'null'),
        machine: query.get('machine') }).toEqual({ view: 'kind', kind: 'app',
        filters: { category: { include: ['database'], exclude: [] } }, machine: null });
      expect(view.effects.filter(effect => getActionSpec(effect.actionId)?.sideEffectClass !== 'read')).toEqual([]);
    } finally { await view.dispose(); }
  });
});

describe('Environment → Data → Add (P10)', () => {
  it.each(['ready', 'unreachable'] as const)('hydrates the selected database on its Environment controller and settles its read (%s)', async outcome => {
    const { showDeploymentAddSheet } = await import('./DeploymentDatabasePage');
    const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployments/testing/v1');
    const { normalizePluginInstalledUiDeclarations } = await import('@/sync/domains/plugins/ui/projection');
    const { unionPluginUiProjections } = await import('@/sync/domains/plugins/ui/projectionUnion');
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { createConnectedAccountDescriptorProjectionLoadingState } = await import('@/sync/domains/connectedServices/connectedAccountDescriptorProjection');
    const { storage } = await import('@/sync/domains/state/storage');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const serverIdentityId = `srv_database_controller_${outcome}`;
    const serverId = await homes.addHome({ name: 'Controller database', serverUrl: `https://database-controller-${outcome}.test`,
      serverIdentityId, accountId: 'account-owner', currentAccount: true });
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: { v: 2, sources: [],
      disabledSourceIds: BUILT_IN_REGISTRY_SOURCES_V1.map(source => source.id) } }] });
    for (const path of ['/v1/account/entity-rows/prompt-library', '/v1/account/entity-rows/prompt-library/registry-sources']) {
      homes.answer(serverId, path, { body: await (await catalog.handle(path))!.json() });
    }
    const bundled: unknown = JSON.parse(await readFile(new URL('../../../../../../packages/plugins/deployment-templates/resources/registry/apps.json', import.meta.url), 'utf8'));
    if (!bundled || typeof bundled !== 'object' || !('apps' in bundled) || !Array.isArray(bundled.apps)) throw new Error('Expected bundled catalog');
    const appCatalog = { schemaVersion: 1 as const, apps: bundled.apps };
    const base = createDeploymentEnvironmentDetailV1();
    const link = createDeploymentTargetLinkHeaderV1();
    if (link.targetKind !== 'ownServer') throw new Error('Expected own server');
    const member = link.members[0]!;
    const detail = { ...base, environment: { ...base.environment, controllerMachineId: member.machineId }, runtimeTargetLink: link, memberVersions: {}, secretRevisions: [],
      content: { ...base.content, definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}`,
        document: 'services:\n  app:\n    image: app:1\n', profiles: [], services: ['app'], primaryService: 'app' } } };
    const pluginId = 'happier.deployment-templates';
    const occurrenceId = 'database-templates:1';
    const declaration = projectPluginRegistrySourceDeclarationV1({ pluginId, pluginVersion: '1.0.0', definition: {
      id: 'apps', title: 'Data services', format: 'happier-catalog', kinds: ['app'], packageContent: { path: 'resources/registry/apps.json' },
    } });
    const sourceId = declaration.id;
    const packageContent = { pluginId, pluginVersion: '1.0.0', occurrenceId, path: 'resources/registry/apps.json' };
    const selectedItem = readHappierAppCatalogItemV1({ sourceId, catalog: appCatalog, fetchedAt: 1, itemId: 'postgresql', packageContent });
    const arbitrary = createMachineFixture({ id: 'c71-arbitrary-own-machine', createdAt: 2, activeAt: Date.now() });
    const controller = createMachineFixture({ id: member.machineId, createdAt: 1, activeAt: Date.now(), installationId: member.installationId });
    const inventory = [arbitrary, controller];
    const reads: string[] = [];
    const previews: unknown[] = [];
    const machines = { machineId: controller.id, installationId: member.installationId, tokenEpoch: 0,
      additionalMachines: [{ machineId: arbitrary.id }] };
    await answerExternalActionAccountForHome(homes, serverId, { ...machines, actionId: 'registries.items.list', requesterInvocation: 'none', execute: () =>
      REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse({ pages: [listHappierAppCatalogV1({ sourceId, catalog: appCatalog, fetchedAt: 1 })] }) });
    await answerExternalActionAccountForHome(homes, serverId, { ...machines, actionId: 'registries.items.read', requesterInvocation: 'none',
      failure: result => ActionExecuteFailureSchema.safeParse(result).data ?? null,
      execute: (_input, transport) => {
        reads.push(transport.target.machineId);
        return transport.target.machineId !== controller.id || outcome === 'unreachable'
          ? { ok: false, errorCode: 'invalid_encrypted_envelope', error: 'invalid_encrypted_envelope' }
          : REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse({ item: selectedItem });
      } });
    await answerExternalActionAccountForHome(homes, serverId, { ...machines, actionId: 'deployments.templates.instantiate', execute: raw => {
      const input = DeploymentTemplateInstantiateInputV1Schema.parse(raw);
      previews.push(input);
      return DeploymentTemplateInstantiateResultV1Schema.parse({ kind: 'preview', review: { templateRef: input.templateRef,
        profiles: [], services: ['postgresql'], bindings: [], generatedSecrets: [], domains: [], capacity: [] } });
    } });
    homes.answer(serverId, `/v1/deployments/environments/${detail.environment.id}`, { body: { ok: true, environment: detail.environment, targetLinks: [] } });
    const account = await captureLazyActionAccountContext(serverId);
    storage.setState({ settingsScope: account.accountLifetime.scope, profileScope: account.accountLifetime.scope });
    storage.getState().activateProfileScope(account.accountLifetime.scope);
    await publishMachineInventoryForTest(account.accountLifetime.scope, inventory);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const origins = inventory.map(machine => ({ serverIdentityId, materializationRef: { machineId: machine.id, pluginId, materializationId: 'database-templates' } }));
    const pluginUiProjection = unionPluginUiProjections(inventory.map((machine, index) => ({ machineId: machine.id, serverId, phase: 'current' as const,
      interactionEnabled: true, selectableExecutionOrigins: [origins[index]!], projection: normalizePluginInstalledUiDeclarations({}, undefined, {
        id: pluginId, displayName: 'Data services', version: '1.0.0', enabled: true, occurrenceId, source: { kind: 'path', locator: '/plugins/database-templates' },
      }, [{ ...declaration, occurrenceId, executionOrigin: origins[index]! }]) })), new Map([[pluginId, origins[1]!]])).pluginUiProjection;
    const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection, pluginBrowserProjection: null,
      phase: 'current', interactionEnabled: true, machineId: controller.id, serverId, platform: 'web', accountLifetime: account.accountLifetime,
      reloadConnectedAccountProjection: () => {}, connectedAccountProjectionState: createConnectedAccountDescriptorProjectionLoadingState('database-controller'),
      clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {} }}><ModalProvider>{null}</ModalProvider></AppShellPluginUiProjectionValueProvider>);
    try {
      await act(async () => showDeploymentAddSheet({ detail, review: noReview, machineName: () => 'Controller',
        catalogFilters: { source: { include: [sourceId], exclude: [] } }, lifetime: account.accountLifetime }));
      const rowId = `store.kind.app.row.app|${sourceId}|postgresql`;
      await waitForHomeGovernance(() => expect(screen.findByTestId(rowId), screen.getTextContent()).not.toBeNull());
      await screen.pressByTestIdAsync(rowId);
      if (outcome === 'ready') {
        await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.add.confirm')?.props.disabled).toBe(false));
        expect(previews).toEqual([expect.objectContaining({ mode: 'preview', machineId: controller.id,
          templateRef: expect.objectContaining({ sourceId, itemId: 'postgresql' }) })]);
      } else {
        await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.add.itemUnavailable')).not.toBeNull());
        expect(screen.getTextContent()).not.toContain('Checking');
        expect(screen.findByTestId('project-deployments.add.confirm')?.props.disabled).toBe(true);
        expect(previews).toEqual([]);
      }
      expect(new Set(reads)).toEqual(new Set([controller.id]));
    } finally { await screen.unmount(); account.dispose(); }
  });

  it.each([{ outcome: 'applied', update: false, choices: false }, { outcome: 'template_service_conflict', update: false, choices: false },
    { outcome: 'deployment_conflict', update: false, choices: false },
    { outcome: 'partial', update: false, choices: false }, { outcome: 'applied', update: true, choices: false },
    { outcome: 'applied', update: false, choices: true }, { outcome: 'applied', update: false, choices: false, repository: true },
    { outcome: 'partial', update: false, choices: false, repository: true },
    { outcome: 'partial', update: true, choices: false, repository: true }] as const)('applies the reviewed template through the confirmed Action front door ($outcome, update=$update, choices=$choices, repository=$repository)', async testCase => {
    const { outcome, update, choices } = testCase;
    const repository = 'repository' in testCase && testCase.repository;
    const { showDeploymentAddSheet, showDeploymentTemplateUpdateSheet } = await import('./DeploymentDatabasePage');
    const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployments/testing/v1');
    const serverUrl = `https://database-add-${outcome}.test`;
    const catalogUrl = `${serverUrl}/apps.json`;
    const sourceId = deriveMarketplaceSourceId(catalogUrl);
    const serverIdentityId = 'srv_database_add';
    const serverId = await homes.addHome({ name: 'Database Add', serverUrl, serverIdentityId,
      accountId: 'account-owner', currentAccount: true });
    const catalog = createPromptLibraryCatalogBoundary({ records: [{ key: 'registry-sources', value: { v: 2,
      sources: [{ id: sourceId, title: 'Apps', url: catalogUrl, format: 'happier-catalog', kinds: ['app'], enabled: true, addedAt: 1 }],
      disabledSourceIds: [] } }] });
    for (const path of ['/v1/account/entity-rows/prompt-library', '/v1/account/entity-rows/prompt-library/registry-sources']) {
      homes.answer(serverId, path, { body: await (await catalog.handle(path))!.json() });
    }
    const bundled: unknown = JSON.parse(await readFile(new URL('../../../../../../packages/plugins/deployment-templates/resources/registry/apps.json', import.meta.url), 'utf8'));
    if (!bundled || typeof bundled !== 'object' || !('apps' in bundled) || !Array.isArray(bundled.apps)) throw new Error('Expected bundled catalog');
    const entry: unknown = bundled.apps.find((value: { itemId: string }) => value.itemId === 'postgresql');
    if (!entry || typeof entry !== 'object' || !('app' in entry)) throw new Error('Expected bundled PostgreSQL');
    const listed = DeploymentTemplateV1Schema.parse(entry.app);
    const app = DeploymentTemplateV1Schema.parse({ ...listed,
      domains: [{ key: 'web', service: listed.compose.services[0], containerPort: 5432, protocol: 'https', required: false }] });
    homes.answer(serverId, '/apps.json', { body: { schemaVersion: 1, apps: [{ itemId: 'postgresql', app }] } });
    const account = await captureLazyActionAccountContext(serverId);
    const { storage } = await import('@/sync/domains/state/storage');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    storage.setState({ settingsScope: account.accountLifetime.scope, profileScope: account.accountLifetime.scope });
    storage.getState().activateProfileScope(account.accountLifetime.scope);
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const base = createDeploymentEnvironmentDetailV1();
    // The Environment already sets the app's connection values; the template's own DB_USER is new to it.
    const existingBindings = choices ? ['DATABASE_URL', 'DIRECT_URL'].map(name => ({ purpose: 'variable' as const, name,
      phase: 'runtime' as const, source: { kind: 'value' as const, value: 'postgres://old' } })) : base.content.bindings;
    const detail = { ...base, runtimeTargetLink: createDeploymentTargetLinkHeaderV1(), memberVersions: {}, secretRevisions: [],
      content: { ...base.content, bindings: existingBindings, definition: repository ? { kind: 'repository' as const, ref: 'main', compose: { path: 'deploy/compose.yaml', profiles: [], services: ['app'] } } : { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}`,
        document: 'services:\n  app:\n    image: app:1\n', profiles: [], services: ['app'], primaryService: 'app' } } };
    const link = detail.runtimeTargetLink;
    if (link.targetKind !== 'ownServer') throw new Error('Expected own server');
    const member = link.members[0]!;
    const checkoutMachineId = repository ? 'checkout-machine' : member.machineId;
    if (repository) {
      const identity = { kind: 'github' as const, deployment: 'https://github.com', repository: 'acme/app' };
      const checkout = { id: 'checkout', serverId, machineId: checkoutMachineId, rootPath: '/project', createdAtMs: 1,
        repositoryIdentity: identity, source: { sourceId: detail.environment.projectSourceId, revision: 2 } };
      applyProjectAccountRowsFixture(storage, { workspaceRefs: [checkout] });
      homes.answer(serverId, `POST ${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`, {
        body: createPlainProjectAccountRowListFixture({ workspaceRefs: [checkout] }),
      });
      storage.getState().updateWorkspaceScmSnapshot(checkout, { projectKey: 'checkout-machine:/project', fetchedAt: Date.now(),
        repo: { isRepo: true, rootPath: checkout.rootPath },
        branch: { head: 'main', headOid: 'a'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 0, detached: false },
        stashCount: 0, hasConflicts: false, entries: [], totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0,
          includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 } });
      homes.answer(serverId, `/v1/projects/sources/${detail.environment.projectSourceId}`, { body: { ok: true, canManage: true,
        source: { id: detail.environment.projectSourceId, revision: 2, name: 'App', audience: [], createdByAccountId: account.accountId,
          repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
            repository: { nameWithOwner: identity.repository }, protocol: 'https' } } } });
    }
    homes.answer(serverId, `/v1/deployments/environments/${detail.environment.id}`, { body: {
      ok: true, environment: { ...detail.environment, controllerMachineId: member.machineId }, targetLinks: [] } });
    const applied: unknown[] = [];
    const previews: ReturnType<typeof DeploymentTemplateInstantiateInputV1Schema.parse>[] = [];
    const receivedApplyResults: Array<Readonly<{ ok: boolean; errorCode?: string }>> = [];
    const refusalDetails = outcome === 'deployment_conflict' ? { requiredFact: 'transaction_commit' } : undefined;
    const templateHost = (raw: unknown) => {
        const input = DeploymentTemplateInstantiateInputV1Schema.parse(raw);
        if (input.mode === 'preview') {
          previews.push(input);
          return DeploymentTemplateInstantiateResultV1Schema.parse({ kind: 'preview',
          review: { templateRef: input.templateRef, connectToServices: ['app'], document: 'services:\n  app:\n    image: app:2\n', profiles: app.compose.profiles, services: app.compose.services, bindings: [],
            generatedSecrets: app.generatedSecrets.map(secret => ({ name: secret.key, phase: 'runtime', key: secret.key, profile: secret.profile })),
            domains: [], ...(input.deploy ? { deploy: input.deploy } : {}),
            ...(input.destination.kind === 'repositoryPullRequest' ? { repositoryChange: { ...input.destination,
              files: [{ path: input.destination.composePath, before: 'services: {}\n', content: 'services:\n  app:\n    image: app:2\n' },
                ...(update ? [{ path: 'deploy/obsolete.conf', before: 'legacy-setting=true\n', content: null }] : [])] } } : {}) } });
        }
        applied.push(input);
        if (outcome === 'partial') return DeploymentTemplateInstantiateResultV1Schema.parse({ kind: 'partial',
          environmentId: detail.environment.id, revision: 2, targetLinkId: link.id,
          ...(repository ? { repositoryChange: { kind: 'partial', stage: 'pullRequest', errorCode: 'FEATURE_UNSUPPORTED',
            worktree: { path: '/checkout/.worktrees/add-database', branchName: 'add-database' }, headCommit: 'b'.repeat(40), writtenPaths: ['deploy/compose.yaml'] } }
            : { definition: { kind: 'stored', contentRevision: 2, composeDigest: `sha256:${'c'.repeat(64)}` } }),
          savedSecrets: [{ name: 'DB_PASSWORD', phase: 'runtime', source: {
            kind: 'secret', ref: 'happier:shared-secret:v1:database-password', resourceRevision: 7,
          } }], phase: repository ? 'repository' : 'deploy', errorCode: repository ? 'FEATURE_UNSUPPORTED' : 'deployment_access_denied' });
        if (outcome !== 'applied') return ActionExecuteFailureSchema.parse({ ok: false, errorCode: outcome, error: outcome, details: refusalDetails });
        if (repository) return DeploymentTemplateInstantiateResultV1Schema.parse({ kind: 'pullRequest', environmentId: detail.environment.id,
          revision: 2, savedSecrets: [], headCommit: 'b'.repeat(40), branchName: 'add-database', pullRequest: {
            provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' }, title: 'Add PostgreSQL',
            url: 'https://github.com/acme/app/pull/42', number: 42, baseBranch: 'main', headBranch: 'add-database', state: 'open' } });
        return DeploymentTemplateInstantiateResultV1Schema.parse({ kind: 'applied', environmentId: detail.environment.id,
          revision: 2, targetLinkId: link.id, savedSecrets: [], definition: { kind: 'stored', contentRevision: 2,
            composeDigest: `sha256:${'c'.repeat(64)}` } });
    };
    const { createUiDeploymentActionDeps } = await import('@/sync/api/deployments/deploymentActions');
    const { resolveActionsSettingsV1FromState } = await import('@/sync/domains/settings/actionsSettings');
    const { createUiActionAutomationPortV1 } = await import('@/sync/ops/actions/actionAutomations');
    const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
      actionAutomations: createUiActionAutomationPortV1(account),
      resolveEnvironmentApprovalScope: createUiDeploymentActionDeps(account).resolveEnvironmentApprovalScope,
      // Installed host preparation/effects are the system boundary. Protocol policy and confirmation stay real.
      prepareDeploymentTemplateInstantiation: async ({ input }) => {
        const preview = DeploymentTemplateInstantiateResultV1Schema.parse(templateHost({ ...input, mode: 'preview' }));
        if (preview.kind !== 'preview') throw new Error('Expected template preview');
        return { input, preview: projectNativeJsonValueForTransport(preview.review), hostReviewedChildren: {
          children: input.deploy ? [{ action: 'deployments.deploy' as const, role: 'template.deploy' }] : [],
          executeAdmittedAction: async () => {
            const result = templateHost(input);
            return 'ok' in result ? result : { ok: true as const, result };
          },
        } };
      },
      deploymentTemplateInstantiate: async input => templateHost(input),
    }));
    const boundary = await answerExternalActionAccountForHome(homes, serverId, { actionId: 'deployments.templates.instantiate',
      machineId: checkoutMachineId, installationId: member.installationId, tokenEpoch: 0,
      failure: result => ActionExecuteFailureSchema.safeParse(result).data ?? null,
      execute: async (input, transport) => {
        if (!('authentication' in transport.authorization.binding) || !account.serverIdentityId)
          throw new Error('Expected Account-authorized Home ingress');
        const result = await receiver.execute('deployments.templates.instantiate', input, {
          surface: transport.invocation.surface,
          authority: transport.invocation.authority === 'present_user' ? resolveInvocationAuthority({
            credential: transport.authorization.binding.authentication.kind, surface: transport.invocation.surface,
            actionId: 'deployments.templates.instantiate' }) : transport.invocation.authority,
          actionCaller: transport.invocation.caller, presentUserConfirmation: transport.invocation.presentUserConfirmation,
          serverId, serverIdentityId: account.serverIdentityId, runtimeAccountId: account.accountId,
          externalActionTarget: transport.target, externalActionExecutionAuthorization: transport.authorization,
          originalActionEnvelope: transport.envelope, actionRequestId: transport.requestId,
          actionsSettings: resolveActionsSettingsV1FromState(storage.getState()),
          signExternalActionApprovalInput: ({ actionId, input, target, requesterConfirmation, sessionTargetsV1 }) =>
            boundary.signApprovalInput({ authorizationToken: transport.authorization.token, actionId, input, target,
              ...(requesterConfirmation ? { requesterConfirmation } : {}), ...(sessionTargetsV1 ? { sessionTargetsV1 } : {}) }),
        });
        if (DeploymentTemplateInstantiateInputV1Schema.parse(input).mode === 'apply') receivedApplyResults.push({
          ok: result.ok, ...(!result.ok ? { errorCode: result.errorCode } : {}) });
        return result.ok ? result.result : result;
      } });
    const opened: string[] = [];
    const navigate = vi.fn();
    const review = { ...noReview, request: vi.fn() };
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    try {
      await act(async () => update ? showDeploymentTemplateUpdateSheet({ detail, review, machineName: () => 'vps-2',
        catalogFilters: {}, lifetime: account.accountLifetime, template: { sourceId, itemId: 'postgresql' },
        onOpenRecovery: destination => opened.push(destination), onNavigate: navigate })
        : showDeploymentAddSheet({ detail, review, machineName: () => 'vps-2',
          catalogFilters: {}, lifetime: account.accountLifetime, onOpenRecovery: destination => opened.push(destination), onNavigate: navigate }));
      const rowId = `store.kind.app.row.app|${sourceId}|postgresql`;
      if (repository) {
        await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.add.workspace')).not.toBeNull());
        const choice = screen.findAll(node => node.props.testID === 'project-deployments.add.workspace' && typeof node.props.onSelect === 'function')[0];
        if (!choice) throw new Error('Expected checkout choice');
        await act(async () => { choice.props.onSelect(serverId + ':checkout'); });
      }
      if (!update) {
        await waitForHomeGovernance(() => expect(screen.findByTestId(rowId)).not.toBeNull());
        await screen.pressByTestIdAsync(rowId);
      }
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.add.confirm')?.props.disabled,
        screen.getTextContent()).toBe(false));
      const domainField = 'project-deployments.add.choices.domain.web';
      if (repository || update) {
        expect(screen.findHostByTestId(domainField)).toBeNull();
      } else {
        expect(screen.findHostByTestId(domainField)).not.toBeNull();
      }
      const selectsDomain = outcome === 'applied' && !repository && !update && !choices;
      const before = previews.length;
      if (selectsDomain) {
        await act(async () => { changeTextTestInstance(screen.findHostByTestId(domainField)!, 'db.example.test'); });
      }
      if (choices) {
        const prefix = 'project-deployments.add.choices';
        const user = screen.findHostByTestId(`${prefix}.variable.DB_USER`);
        expect(user).not.toBeNull();
        await act(async () => { changeTextTestInstance(user!, 'alice'); });
        await act(async () => { changeTextTestInstance(screen.findHostByTestId(`${prefix}.volume.postgres-data`)!, 'chosen-data'); });
        const connect = screen.findAll(node => node.props.testID === `${prefix}.connectTo` && typeof node.props.onSelect === 'function')[0];
        expect(connect).toBeTruthy();
        await act(async () => { connect!.props.onSelect('app'); });
        // Only a value the Environment already has can be replaced.
        expect(screen.findAll(node => node.props.testID === `${prefix}.replace.DB_USER`)).toHaveLength(0);
        for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
          const replace = screen.findAll(node => node.props.testID === `${prefix}.replace.${key}` && typeof node.props.onValueChange === 'function')[0];
          expect(replace).toBeTruthy();
          await act(async () => { replace!.props.onValueChange(true); });
        }
      }
      if (choices || selectsDomain) {
        expect(previews).toHaveLength(before);
        expect(applied).toEqual([]);
        // Changed choices are reviewed by the primary press itself, never a disabled Add with no reason (D27).
        expect(screen.findByTestId('project-deployments.add.confirm')?.props.disabled).toBe(false);
        expect(screen.findByTestId('project-deployments.add.reviewChoices')).toBeNull();
        await screen.pressByTestIdAsync('project-deployments.add.confirm');
        await waitForHomeGovernance(() => expect(previews).toHaveLength(before + 1));
        expect(applied).toEqual([]);
        await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.add.confirm')?.props.disabled).toBe(false));
        expect(previews).toHaveLength(before + 1);
      }
      const reviewedDeployment = previews.at(-1)?.deploy;
      const selectedDomain = [{ templateDomainId: 'web', hostname: 'db.example.test' }];
      if (selectsDomain) {
        expect(previews.at(-1)).toMatchObject({ deploy: { requestKey: expect.any(String) }, domainBindings: selectedDomain });
      }
      if (update && !repository) {
        expect(screen.findByTestId('project-deployments.template.diff')).not.toBeNull();
        expect(screen.getTextContent()).toMatch(/image: app:\s*2/);
      }
      if (repository) {
        expect(screen.findByTestId('project-deployments.template.repositoryDiff')).not.toBeNull();
        if (update) {
          const { DiffViewer } = await import('@/components/ui/code/diff/DiffViewer');
          expect(screen.findAllByType(DiffViewer).map(view => view.props)).toContainEqual(expect.objectContaining({
            oldText: 'legacy-setting=true\n', newText: '',
          }));
        }
      }
      await screen.pressByTestIdAsync('project-deployments.add.confirm');
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.add.added')
        ?? screen.findByTestId('project-deployments.add.refused')
        ?? screen.findByTestId('project-deployments.add.progress')).not.toBeNull());
      expect(receivedApplyResults).toEqual([outcome === 'template_service_conflict' || outcome === 'deployment_conflict'
        ? { ok: false, errorCode: outcome } : { ok: true }]);
      expect(applied).toEqual([expect.objectContaining({ mode: 'apply', ...(update ? {} : { intent: 'add' }), environment: { kind: 'existing',
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision },
        templateRef: expect.objectContaining({ sourceId, itemId: 'postgresql' }),
        bindings: update ? [] : [...(choices ? [{ purpose: 'variable', name: 'DB_USER', phase: 'runtime', source: { kind: 'value', value: 'alice' } }] : []), { purpose: 'variable', name: 'DB_PASSWORD', phase: 'runtime', source: { kind: 'generated', key: 'DB_PASSWORD' } }],
        ...(update ? {} : { generatedSecretAudience: { accountGrants: [], teamGrants: [], groupGrants: [] } }) })]);
      if (choices) expect(applied[0]).toMatchObject({ connectTo: { service: 'app' }, replace: ['DATABASE_URL', 'DIRECT_URL'],
        volumeBindings: [{ templateVolumeId: 'postgres-data', source: 'chosen-data' }] });
      if (selectsDomain) expect(applied[0]).toMatchObject({ domainBindings: selectedDomain, deploy: reviewedDeployment });
      if (update || repository) expect(applied[0]).not.toHaveProperty('deploy');
      if (repository) {
        expect(applied[0]).toMatchObject({ destination: { kind: 'repositoryPullRequest', workspace: { kind: 'workspace-ref', serverId: serverIdentityId, id: 'checkout' },
          composePath: 'deploy/compose.yaml', baseCommit: 'a'.repeat(40), sourceRevision: 2 } });
        expect(screen.getTextContent()).toContain(outcome === 'partial' ? 'add-database' : 'github.com/acme/app/pull/42');
      }
      expect(review.request).not.toHaveBeenCalled();
      expect(homes.artifacts(serverId).list()).toEqual([]);
      if (outcome === 'applied') expect(screen.findByTestId('project-deployments.add.refused')).toBeNull();
      else if (outcome === 'partial') {
        expect(screen.findByTestId('project-deployments.add.progress')).not.toBeNull();
        expect(screen.findByTestId('project-deployments.add.added')).toBeNull();
        expect(screen.findByTestId('project-deployments.add.confirm')).toBeNull();
        expect(screen.findByTestId('project-deployments.add.back')).toBeNull();
        expect(screen.findByTestId('project-deployments.add.done')).not.toBeNull();
        expect(screen.getTextContent()).toContain('DB_PASSWORD');
        const { DeploymentPartialProgress } = await import('./DeploymentPartialProgress');
        expect(screen.findByType(DeploymentPartialProgress)?.props.progress).toMatchObject({
          environmentId: detail.environment.id, revision: 2, targetLinkId: link.id,
          ...(repository ? { phase: 'repository', repositoryChange: { headCommit: 'b'.repeat(40) } }
            : { definition: { contentRevision: 2 }, phase: 'deploy' }),
          savedSecrets: [{ name: 'DB_PASSWORD', source: { resourceRevision: 7 } }],
        });
        await screen.pressByTestIdAsync('project-deployments.add.done');
        expect(navigate).toHaveBeenCalledExactlyOnceWith({ tab: 'overview', section: null });
        expect(applied).toHaveLength(1);
      } else {
        const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
        const recovery = readDeploymentRefusalRecoveryV1(outcome, refusalDetails)!;
        expect(screen.getTextContent()).toContain(recovery.remedy);
        expect(screen.findByTestId('project-deployments.add.added')).toBeNull();
        await screen.pressByTestIdAsync('project-deployments.add.refused.next');
        expect(opened).toEqual([recovery.nextAction.destination]);
      }
    } finally { await screen.unmount(); account.dispose(); }
  });

  it('says a refused Add once, from the shared recovery owner, beside its one next step', async () => {
    const { DeploymentAddRefusal } = await import('./DeploymentDatabasePage');
    const { readDeploymentRefusal } = await import('./deploymentActionOutcome');
    const opened: string[] = [];
    const screen = await renderScreen(
      <DeploymentAddRefusal testID="add.refusal" refusal={readDeploymentRefusal('template_domain_required')}
        onOpenRecovery={(destination) => opened.push(destination)} />,
    );
    try {
      const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
      const recovery = readDeploymentRefusalRecoveryV1('template_domain_required')!;
      expect(screen.getTextContent()).toContain(recovery.remedy);
      // One message, no raw code beside it.
      expect(screen.getTextContent()).not.toContain('template_domain_required');
      await screen.pressByTestIdAsync('add.refusal.next');
      expect(opened).toEqual(['domains']);
    } finally { await screen.unmount(); }
  });

  it('chooses from the Store catalog as an embedded picker, filtered to databases, not a Store page inside the sheet', async () => {
    const serverId = await homes.addHome({ name: 'Database picker', serverUrl: 'https://database-picker.test',
      serverIdentityId: 'srv_database_picker', accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const { showDeploymentAddSheet } = await import('./DeploymentDatabasePage');
    const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployments/testing/v1');
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, runtimeTargetLink: createDeploymentTargetLinkHeaderV1(), memberVersions: {}, secretRevisions: [],
      content: { ...base.content, definition: { kind: 'stored' as const, contentRevision: 1, composeDigest: `sha256:${'b'.repeat(64)}`,
        document: 'services:\n  app:\n    image: app:1\n', profiles: [], services: ['app'], primaryService: 'app' } } };
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    try {
      await act(async () => {
        showDeploymentAddSheet({ detail, review: noReview, machineName: () => 'vps-2',
          catalogFilters: { category: { include: ['database'], exclude: [] } },
          lifetime: account.accountLifetime });
      });
      const { StoreRegistryItemPicker } = await import('@/components/store/StoreKindPage');
      const picker = screen.root.findAllByType(StoreRegistryItemPicker)[0];
      expect(picker?.props.initialFilters).toEqual({ category: { include: ['database'], exclude: [] } });
      // No second page frame (header, project scope chip, page ⋯) inside the sheet.
      expect(screen.findByTestId('store.kind.app')).toBeNull();
    } finally { await screen.unmount(); account.dispose(); }
  });

  it('opens managed database preparation even when this Environment keeps its services in its repository', async () => {
    const { showDeploymentAddSheet } = await import('./DeploymentDatabasePage');
    const serverId = await homes.addHome({ name: 'Managed Add', serverUrl: 'https://managed-add.test',
      serverIdentityId: 'srv_managed_add', accountId: 'owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const base = createDeploymentEnvironmentDetailV1({ environment: createDeploymentEnvironmentHeaderV1({ serverId }) });
    const detail = { ...base, runtimeTargetLink: null, memberVersions: {}, secretRevisions: [],
      content: { ...base.content, definition: { kind: 'repository' as const, ref: 'main' } } };
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    try {
      await act(async () => showDeploymentAddSheet({ detail, review: noReview, machineName: () => 'Controller',
        catalogFilters: { category: { include: ['database'], exclude: [] } }, lifetime: account.accountLifetime }));
      expect(screen.findByTestId('project-deployments.add.managed')).not.toBeNull();
      await screen.pressByTestIdAsync('project-deployments.add.managed');
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        expect(screen.findByTestId('managed-data')).not.toBeNull();
      });
    } finally { await screen.unmount(); account.dispose(); }
  });

  it('asks for an admitted workspace before adding a template to an Environment defined in its repository', async () => {
    const serverId = await homes.addHome({ name: 'Repository Add', serverUrl: 'https://repository-add.test',
      serverIdentityId: 'srv_repository_add', accountId: 'account-owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const { showDeploymentAddSheet } = await import('./DeploymentDatabasePage');
    const base = createDeploymentEnvironmentDetailV1();
    const detail = { ...base, runtimeTargetLink: null, memberVersions: {}, secretRevisions: [],
      content: { ...base.content, definition: { kind: 'repository' as const, ref: 'main' } } };
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    try {
      await act(async () => {
        showDeploymentAddSheet({ detail, review: noReview, machineName: () => 'vps-2',
          catalogFilters: { category: { include: ['database'], exclude: [] } },
          lifetime: account.accountLifetime });
      });
      // Repository Add authors a pull request in the person's selected checkout.
      // Without that checkout (or a Compose path), it must expose the workspace
      // choice rather than offering an inline template mutation it cannot apply.
      expect(screen.findByTestId('project-deployments.add.repository')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.add.workspace')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.add.picker')).toBeNull();
      expect(screen.findByTestId('project-deployments.add.confirm')).toBeNull();
    } finally { await screen.unmount(); account.dispose(); }
  });
});

describe('Environment → Data → Database page (P9)', () => {
  it('shows the size read refusal instead of a dash on the declared database', async () => {
    const { t } = await import('@/text');
    const view = await renderDatabase();
    try {
      await view.settle(`${page}.facts.strip`);
      const strip = view.screen.findAllByProps({ testID: `${page}.facts.strip` })[0];
      expect((strip?.props.facts as readonly { key: string; value: string }[]).find(fact => fact.key === 'size')?.value)
        .toBe(t('projects.deployments.services.sizeCellUnavailable'));
    } finally { await view.dispose(); }
  });

  it('settles backup facts after Back up now from a real missed-schedule notice', async () => {
    const view = await renderDatabase({ answers: { missedSchedule: true } });
    try {
      expect(await view.readScheduleSets()).toEqual([expect.objectContaining({
        automationId: 'nightly-backups', missedSchedules: [expect.objectContaining({ triggerId: 'nightly-schedule' })],
      })]);
      expect(await view.settle(`${page}.missed.action`)).not.toBeNull();
      await view.screen.pressByTestIdAsync(`${page}.missed.action`);
      expect(await view.settle(`${page}.history.manual-backup`)).not.toBeNull();
      const { formatAsOfTime } = await import('@/utils/time/formatAsOfTime');
      // Last backup is said once, in the facts row (PFC-FIDELITY G18): the Backups section repeats no Last backup row.
      expect(view.screen.findAllByProps({ testID: `${page}.lastGood` })).toHaveLength(0);
      expect(view.effects.filter(effect => effect.actionId === 'deployments.backups.history')).toHaveLength(2);
      expect(view.effects.filter(effect => effect.actionId === 'deployments.backups.run')).toHaveLength(1);
      const { t } = await import('@/text');
      // The facts row under the header leads with the same Last backup (unverified: no detail), then the one-server
      // availability said once here and not again under Connection. This fixture has no size transport.
      const strip = view.screen.findAllByProps({ testID: `${page}.facts.strip` })[0];
      expect((strip?.props.facts as readonly { key: string; value: string; detail?: string }[])
        .map(fact => [fact.key, fact.value, fact.detail ?? null])).toEqual([
        ['lastBackup', formatAsOfTime(Date.parse('2026-11-07T10:01:00Z')), null],
        // Kept restore points are the destination's own count for this database's dump source, never counted from History.
        ['restorePoints', '2', null],
        ['availability', t('projects.deployments.databaseAvailabilityOneServer'), t('projects.deployments.databaseAvailabilityNotHighlyAvailable')],
        ['size', t('projects.deployments.services.sizeCellUnavailable'), null]]);
      expect(view.screen.findAllByProps({ testID: `${page}.connection.availability` })).toHaveLength(0);
    } finally { await view.dispose(); }
  });

  it('resolves each retained database by its service after a second database was added', async () => {
    const view = await renderDatabase({ database: 'mysql' });
    try {
      expect(await view.settle('project-deployments.database')).not.toBeNull();
      expect(view.screen.getTextContent()).toContain('MySQL');
      expect(view.screen.getTextContent()).toContain('3306');
    } finally { await view.dispose(); }
  });

  it('reads backup history once on open, shows it, and Back up now runs the same Action an agent uses', async () => {
    const view = await renderDatabase({
      answers: {
        history: {
          kind: 'history',
          environmentId: 'ignored',
          configRevision: 1,
          lastSuccessfulBackup: {
            operationId: 'nightly-2',
            completedAt: Date.parse('2026-11-05T03:04:00Z'),
            configRevision: 1,
            snapshotIds: ['f'.repeat(64)],
          },
          lastVerification: {
            operationId: 'verify-2', completedAt: Date.parse('2026-11-05T03:10:00Z'), configRevision: 1,
            backupOperationId: 'nightly-2', snapshotId: 'f'.repeat(64), level: 'manifestReadBack', result: 'verified',
          },
          history: {
            entries: [
              {
                operationId: 'nightly-3',
                action: 'backup',
                state: 'failed',
                startedAt: 10,
                completedAt: 20,
                configRevision: 1,
                snapshotIds: [],
                code: 'backup_failed',
                step: 'dump',
              },
              {
                operationId: 'nightly-2',
                action: 'backup',
                state: 'succeeded',
                startedAt: 1,
                completedAt: 2,
                configRevision: 1,
                snapshotIds: ['f'.repeat(64)],
              },
            ],
          },
        },
      },
    });
    try {
      expect(await view.settle(`${page}.history.nightly-3`)).not.toBeNull();
      expect(
        view.screen.findByTestId(`${page}.history.nightly-2`),
      ).not.toBeNull();
      expect(view.screen.findByTestId(`${page}.status`)).not.toBeNull();
      expect(view.screen.getTextContent()).toContain('postgres:5432');
      // A readback that checked this very backup is said under Last backup in the facts row.
      const { t } = await import('@/text');
      const strip = view.screen.findAllByProps({ testID: `${page}.facts.strip` })[0];
      expect((strip?.props.facts as readonly { key: string; detail?: string }[]).find(fact => fact.key === 'lastBackup')?.detail)
        .toBe(t('projects.deployments.databaseBackupVerified'));
      // One history read per opening, sized to this target; the page never polls.
      expect(view.effects.filter((effect) => effect.actionId === 'deployments.backups.history')).toHaveLength(1);
      const history = view.effects.find((effect) => effect.actionId === 'deployments.backups.history')!.input;
      // The agent path is the same Action with the same published input.
      expect(DeploymentBackupActionInputSchemasV1['deployments.backups.history'].parse(history)).toEqual({
        serverId: view.serverIdentityId, environmentId: view.environmentId, expectedRevision: 1, configRevision: 1,
        machineId: view.machineId, installationId: 'installation-a', targetLinkId: 'target-link', deploymentId: 'deployment-a',
      });
      await view.screen.pressByTestIdAsync(`${page}.run`);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
      expect(view.effects.find((effect) => effect.actionId === 'deployments.backups.run')?.input).toEqual(history);
      expect(await view.settle(`${page}.history.manual-backup`)).not.toBeNull();
      const { formatAsOfTime } = await import('@/utils/time/formatAsOfTime');
      // Back up now's run settles the facts row's Last backup, the one place it is said.
      await vi.waitFor(() => expect((view.screen.findAllByProps({ testID: `${page}.facts.strip` })[0]?.props.facts as
        readonly { key: string; value: string }[]).find(fact => fact.key === 'lastBackup')?.value)
        .toBe(formatAsOfTime(Date.parse('2026-11-07T10:01:00Z'))));
      expect(view.screen.findAllByProps({ testID: `${page}.lastGood` })).toHaveLength(0);
      expect(view.effects.filter((effect) => effect.actionId === 'deployments.backups.history')).toHaveLength(2);
    } finally {
      await view.dispose();
    }
  });

  it('owns the backup operations Settings links to: Remove old backups now and restoring its named data volume (owner 2026-11-17)', async () => {
    const view = await renderDatabase({ keepLastWithVolume: true, restore: vi.fn() as never });
    try {
      expect(await view.settle(`${page}.history.empty`)).not.toBeNull();
      // Prune: the same Action Settings had, now offered once, here, in the Backups section's ⋯.
      expect(await view.settle(`${page}.more`)).not.toBeNull();
      const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
      const more = view.screen.findAllByType(DropdownMenu).filter(node => (node.props.items as Array<{ id: string }>)
        .some(item => item.id === 'prune'));
      expect(more).toHaveLength(1);
      // Pressing it submits a request the prune Action admits (the executor parses it with the protocol schema): the
      // same deployment and config revision Back up now sends (WAVE-REVIEW F2).
      await act(async () => { (more[0]!.props.onSelect as (id: string) => void)('prune'); });
      await vi.waitFor(() => expect(view.effects.filter(effect => effect.actionId === 'deployments.backups.prune')).toHaveLength(1));
      expect(view.effects.find(effect => effect.actionId === 'deployments.backups.prune')?.input).toMatchObject({
        deploymentId: expect.any(String), configRevision: 1, retention: { kind: 'keep', last: 3 } });
      await vi.waitFor(() => expect(view.screen.getTextContent()).toContain('Removed 1 old backup'));
      // Restore offers this database's named volume next to its dump.
      expect(await view.settle(`${page}.restore`)).not.toBeNull();
      await view.screen.pressByTestIdAsync(`${page}.restore`);
      await vi.waitFor(() => expect(view.screen.getTextContent()).toContain('postgres-data'));
    } finally {
      await view.dispose();
    }
  });

  it('connects an app in another Environment through the shared chooser and one bindings.set, the Action an agent uses', async () => {
    const sets: unknown[] = [];
    const view = await renderDatabase({ shared: true, setBindings: async (input) => {
      sets.push(DeploymentActionInputSchemasV1['deployments.bindings.set'].parse({ ...input, serverId: 'home' }));
      return DeploymentActionOutputSchemasV1['deployments.bindings.set'].parse({
        ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1,
      });
    } });
    try {
      // Opening reads the backup history; let it settle so no native read outlives this case.
      expect(await view.settle(`${page}.history.empty`)).not.toBeNull();
      expect(await view.settle(`${page}.connect`)).not.toBeNull();
      await view.screen.pressByTestIdAsync(`${page}.connect`);
      // The source itself is never a destination.
      expect(await view.settle('project-deployments.connect.destination:environment-web')).not.toBeNull();
      expect(view.screen.findByTestId(`project-deployments.connect.destination:${view.environmentId}`)).toBeNull();
      await view.screen.pressByTestIdAsync('project-deployments.connect.destination:environment-web');
      await view.screen.pressByTestIdAsync('project-deployments.connect.confirm');
      expect(await view.settle('project-deployments.connect.connected')).not.toBeNull();
      expect(sets).toEqual([{ serverId: 'home', environmentId: 'environment-web', expectedRevision: 4, remove: [], set: [{
        purpose: 'variable', name: 'DATABASE_URL', phase: 'runtime',
        source: { kind: 'reference', environmentId: view.environmentId, export: 'database', via: 'auto' },
      }] }]);
    } finally { await view.dispose(); }
  });

  it('keeps the binding writer revision refusal visible instead of reporting Connected', async () => {
    const view = await renderDatabase({ shared: true, answers: { bindingRefusal: 'deployment_conflict' } });
    try {
      await view.settle(`${page}.history.empty`);
      await view.screen.pressByTestIdAsync(`${page}.connect`);
      await view.settle('project-deployments.connect.destination:environment-web');
      await view.screen.pressByTestIdAsync('project-deployments.connect.destination:environment-web');
      await view.screen.pressByTestIdAsync('project-deployments.connect.confirm');
      await waitForHomeGovernance(() => expect(view.screen.findByTestId('project-deployments.connect.refused')
        ?? view.screen.findByTestId('project-deployments.connect.connected')).not.toBeNull());
      expect(view.screen.findByTestId('project-deployments.connect.connected')).toBeNull();
      expect(view.screen.findAllByProps({ testID: 'project-deployments.connect.refused',
        diagnosticCode: 'deployment_conflict' })).not.toHaveLength(0);
    } finally { await view.dispose(); }
  });

  it('says what Connect needs when the database is not shared with other Environments', async () => {
    const view = await renderDatabase({ storedDefinition: true, setBindings: async input => DeploymentActionOutputSchemasV1['deployments.bindings.set'].parse({
      ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1,
    }) });
    try {
      // Opening reads the backup history; let it settle so no native read outlives this case.
      expect(await view.settle(`${page}.history.empty`)).not.toBeNull();
      await view.settle(`${page}.connect`);
      await view.screen.pressByTestIdAsync(`${page}.connect`);
      expect(await view.settle('project-deployments.connect.needsShare')).not.toBeNull();
      expect(view.screen.findByTestId('project-deployments.connect.confirm')).toBeNull();
      await view.screen.pressByTestIdAsync('project-deployments.connect.openSettings');
      expect(view.navigate).toHaveBeenCalledWith({ tab: 'settings', section: 'sharing' });
    } finally { await view.dispose(); }
  });

  it('says an unprotected database is not backed up and leads to Set up backups', async () => {
    const view = await renderDatabase({ noBackup: true });
    try {
      expect(await view.settle(`${page}.backups.setUp`)).not.toBeNull();
      // "None yet" is said once, by the facts row; the Backups section leads straight to Set up backups.
      expect(view.screen.getTextContent().split('None yet')).toHaveLength(2);
      expect(view.screen.findAllByProps({ testID: `${page}.lastGood` })).toHaveLength(0);
      await view.screen.pressByTestIdAsync(`${page}.backups.setUp`);
      expect(view.navigate).toHaveBeenCalledWith({ tab: 'settings', section: 'backups' });
    } finally { await view.dispose(); }
  });

  it('leads a database nothing shares to Private sharing from its Private network row', async () => {
    const view = await renderDatabase({ storedDefinition: true });
    try {
      expect(await view.settle(`${page}.connection.private.share`)).not.toBeNull();
      await view.screen.pressByTestIdAsync(`${page}.connection.private.share`);
      expect(view.navigate).toHaveBeenCalledWith({ tab: 'settings', section: 'sharing' });
    } finally { await view.dispose(); }
  });

  it('leads repository-defined database sharing to its Settings editor from both entry points', async () => {
    const setBindings = vi.fn<NonNullable<React.ComponentProps<typeof DeploymentDatabasePage>['setBindings']>>(async input =>
      DeploymentActionOutputSchemasV1['deployments.bindings.set'].parse({
      ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1,
    }));
    const view = await renderDatabase({ setBindings });
    try {
      expect(await view.settle(`${page}.connection.private.share`)).not.toBeNull();
      await view.screen.pressByTestIdAsync(`${page}.connection.private.share`);
      expect(view.navigate).toHaveBeenNthCalledWith(1, { tab: 'settings', section: 'sharing' });
      await view.screen.pressByTestIdAsync(`${page}.connect`);
      expect(await view.settle('project-deployments.connect.needsShare')).not.toBeNull();
      expect(view.screen.findByTestId('project-deployments.connect.confirm')).toBeNull();
      await view.screen.pressByTestIdAsync('project-deployments.connect.openSettings');
      expect(view.navigate).toHaveBeenNthCalledWith(2, { tab: 'settings', section: 'sharing' });
      expect(setBindings).not.toHaveBeenCalled();
    } finally { await view.dispose(); }
  });

  it('says so when the database is no longer in the Environment and leads back to Overview', async () => {
    const view = await renderDatabase({ database: 'gone' });
    try {
      expect(await view.settle(`${page}.gone`)).not.toBeNull();
      expect(view.effects).toEqual([]);
    } finally {
      await view.dispose();
    }
  });

  it('offers an authored upload destination without guessing the database from its backup source id', async () => {
    const restore = vi.fn();
    const view = await renderDatabase({ retainedBackup: false, restore });
    try {
      expect(await view.settle(`${page}.restore`)).not.toBeNull();
      await view.screen.pressByTestIdAsync(`${page}.restore`);
      const database = await view.settle('project-deployments.restore.uploadDatabase');
      expect(database).not.toBeNull();
      expect(database?.props.value).toBe('');
      expect(view.screen.findByTestId('project-deployments.restore.upload')).not.toBeNull();
      expect(restore).not.toHaveBeenCalled();
    } finally { await view.dispose(); }
  });

  it('restores the kept backup from the page and shows each step the running restore pushes', async () => {
    let releaseConfirm!: () => void;
    const confirmGate = new Promise<void>((resolve) => {
      releaseConfirm = resolve;
    });
    const restore = vi.fn(
      async (
        input: Record<string, unknown>,
        operation?: { actionRequestId: string },
      ) => {
        if (input.mode === 'prepare') {
          return DeploymentActionOutputSchemasV1[
            'deployments.backups.restore'
          ].parse({
            kind: 'prepared',
            operationId: 'prepare-1',
            evidence: {
              input: {},
              native: {
                prepared: {
                  kind: 'prepared',
                  operationId: 'prepare-1',
                  source: manifest(
                    String(input.environmentId),
                    snapshotId,
                    '2026-11-01T12:00:00Z',
                  ),
                  sourceFormat: 'postgresCustom',
                  destination: {
                    service: 'postgres',
                    adapter: 'postgres-v1',
                    database: 'shop',
                    environmentId: input.environmentId,
                    revision: 1,
                    stagingDatabase: 'shop_staging',
                    recoveryDatabase: 'shop_recovery',
                    databaseExists: true,
                    hasMeaningfulData: false,
                    writerServices: ['app'],
                  },
                  repository: { repository: 's3:https://backup.test/bucket' },
                },
                configuration: {
                  configRevision: 1,
                  destinationRef: {
                    pluginId: 'happier.backup.destinations',
                    localId: 'open',
                  },
                  occurrenceId: 'nightly',
                  config: {},
                  credentialBindings: [],
                  sources: [
                    {
                      kind: 'dump',
                      sourceId: 'database',
                      service: 'postgres',
                      consistency: 'logical',
                    },
                  ],
                  ownership: {
                    environmentId: input.environmentId,
                    prefix: 'shop/',
                  },
                  retention: { kind: 'keepEverything' },
                },
              },
            },
          });
        }
        // The daemon retains the restore intent identity, independently of this press's transport UUID.
        const { ActionOperationSnapshotV1Schema } =
          await import('@happier-dev/protocol/actions/operations/v1');
        actionOperationStore.mergeSnapshots({
          serverId: 'home',
          snapshots: [
            ActionOperationSnapshotV1Schema.parse({
              version: 1,
              operationId: 'restore-op',
              revision: 2,
              actionId: 'deployments.backups.restore',
              state: 'running',
              scope: { accountId: 'account-owner', machineId: 'machine-a' },
              title: 'Restore',
              requestId: readDeploymentActionOperationRequestIdV1('deployments.backups.restore', { ...input, serverId: 'home' }),
              createdAt: 1,
              startedAt: 2,
              progress: { kind: 'phase', phase: 'restore.stop.running', label: 'Stop writers' },
              cancellation: 'unsupported',
            }),
          ],
        });
        await confirmGate;
        return DeploymentActionOutputSchemasV1[
          'deployments.backups.restore'
        ].parse({
          kind: 'restored',
          verified: true,
          nextAction: 'none',
          evidence: {},
          steps: [
            { id: 'safety', status: 'skipped' },
            { id: 'stop', status: 'completed' },
            { id: 'restore', status: 'completed' },
            { id: 'start', status: 'completed' },
            { id: 'health', status: 'completed' },
          ],
        });
      },
    );
    const view = await renderDatabase({
      retainedBackup: true,
      restore: restore as never,
    });
    try {
      // Opening reads the backup history; let it settle so no native read outlives this case.
      expect(await view.settle(`${page}.history.empty`)).not.toBeNull();
      expect(await view.settle(`${page}.restore`)).not.toBeNull();
      await view.screen.pressByTestIdAsync(`${page}.restore`);
      // The sheet lists the inventory: the kept pre-migration capture and a scheduled run's snapshot.
      expect(await view.settle(`project-deployments.restore.choice.${snapshotId}`)).not.toBeNull();
      await view.screen.pressByTestIdAsync(`project-deployments.restore.choice.${'f'.repeat(64)}`);
      expect(
        await view.settle('project-deployments.restore.check'),
      ).not.toBeNull();
      await view.screen.pressByTestIdAsync('project-deployments.restore.check');
      expect(
        await view.settle('project-deployments.restore.confirm'),
      ).not.toBeNull();
      await act(async () => { view.screen.pressByTestId('project-deployments.restore.confirm'); });
      expect(
        await view.settle('project-deployments.restore.step.stop'),
      ).not.toBeNull();
      await act(async () => { releaseConfirm(); });
      expect(
        await view.settle('project-deployments.restore.result.restored'),
      ).not.toBeNull();
      expect(
        view.screen.findByTestId('project-deployments.restore.step.health'),
      ).not.toBeNull();
      expect(restore.mock.calls.map(([input]) => input.mode)).toEqual([
        'prepare',
        'confirm',
      ]);
      // A scheduled snapshot names its exact run on both steps; the same restore Action an agent calls.
      for (const [input] of restore.mock.calls) {
        expect(DeploymentActionInputSchemasV1['deployments.backups.restore'].parse({ ...input, serverId: 'home' })).toMatchObject({
          deploymentId: 'deployment-a',
          source: { kind: 'repository', snapshotId: 'f'.repeat(64), backupOperationId: 'nightly' },
        });
      }
    } finally {
      try { await act(async () => { releaseConfirm(); }); } finally { await view.dispose(); }
    }
  });
});

// P45 one database presentation: identity and the native console come from protected link facts.
it.each([true, false])('opens a header-only managed database through the Artifact owner and shows only a produced console (console=%s)', async (hasConsole) => {
  const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployments/testing/v1');
  const { Item } = await import('@/components/ui/lists/Item');
  const { PageHeader } = await import('@/components/ui/layout/PageHeader');
  const serverId = await homes.addHome({ name: 'Managed identity', serverUrl: 'https://managed-identity.test', serverIdentityId: 'srv_managed_identity', accountId: 'owner', currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
  const targetLink = createDeploymentTargetLinkHeaderV1({ id: 'managed-identity', role: 'data', targetKind: 'example-provider', machines: [], members: [], source: { kind: 'plugin', contribution: { pluginId: 'com.example.database', localId: 'database' } } });
  const detail = createDeploymentEnvironmentDetailV1({ environment: (({ runtimeTargetLinkId: _runtime, ...header }) => header)(createDeploymentEnvironmentHeaderV1({ serverId })),
    targetLinks: [{ targetLink, content: { data: { engine: 'postgres', version: '17',
      ...(hasConsole ? { providerConsole: { url: 'https://console.example.test/project', label: 'Provider console' } } : {}) } } }] });
  await account.createArtifactDocument({ artifactId: detail.environment.contentArtifactId,
    header: { kind: 'deployment-environment.v1', title: detail.content.name }, body: JSON.stringify(detail.content) });
  await account.createArtifactDocument({ artifactId: targetLink.contentArtifactId,
    header: { kind: 'deployment-target-link.v1', title: 'Customer database' }, body: JSON.stringify(detail.targetLinks[0]!.content) });
  homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
    environment: detail.environment, targetLinks: [targetLink] } });
  const controller = createDeploymentReadControllerV1({ scope: { serverId, accountId: 'owner', projectSourceId: detail.environment.projectSourceId },
    transport: createDeploymentReadTransport(account.accountLifetime) });
  const screen = await renderScreen(<DeploymentDatabasePage controller={controller} environmentId={detail.environment.id} database={targetLink.id}
    demand={shown} phone={false} lifetime={account.accountLifetime} review={noReview} restore={null} setBindings={null} onBack={() => {}} onNavigate={() => {}} />);
  try {
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(screen.findAllByType(PageHeader).some(header => header.props.title === 'PostgreSQL 17')).toBe(true); });
    const console = screen.findAllByType(Item).find(row => row.props.testID === page + '.providerConsole');
    expect(Boolean(console)).toBe(hasConsole);
    if (console) {
      const open = vi.fn();
      vi.stubGlobal('open', open);
      try {
        await homes.setActionPolicy(serverId, 'links.openExternal', 'ui', 'off');
        await act(async () => { await console.props.onPress(); });
        expect(open).not.toHaveBeenCalled();
        await homes.setActionPolicy(serverId, 'links.openExternal', 'ui', 'allowed');
        await act(async () => { await console.props.onPress(); });
        expect(open.mock.calls.map(call => call[0])).toEqual(['https://console.example.test/project']);
      } finally { vi.unstubAllGlobals(); }
    }
  } finally { await screen.unmount(); controller.retire(); account.dispose(); }
});
