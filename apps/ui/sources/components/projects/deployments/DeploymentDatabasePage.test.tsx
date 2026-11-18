import * as React from 'react';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeploymentReadControllerV1, isDeploymentDatabaseMoveCandidateV1, selectDeploymentRuntimeTargetLinkV1 } from '@happier-dev/deployments';
import {
  createDeploymentEnvironmentDetailV1,
  createDeploymentEnvironmentHeaderV1,
  createDeploymentReceiptDetailV1,
  createDeploymentSecretVariableBindingV1,
  createDeploymentTargetLinkHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentOwnServerContentV1Schema } from '@happier-dev/deployment-protocol/v1';
import { DeploymentBackupActionInputSchemasV1, deploymentBackupPolicyV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
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
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { AutomationDefinitionDetailsResponseSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { createNightlyBackupsWorkflowV1 } from '@happier-dev/protocol/workflows/builtins/backupExamples';
import { MachineServicesListInputV1Schema, MachineServicesListResultV1Schema } from '@happier-dev/protocol/actions/specs/machine/services';
import { WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';

import { createDatabaseDescriptorV1Fixture } from '@happier-dev/database-protocol/testing/v1';
import { DATABASE_PLUGIN_ID_V1, DATABASE_TARGETS_LIST_ACTION_ID_V1, databaseActionLocalIdV1,
  databaseActionMetadata, DatabaseTargetsListInputV1Schema, type DatabaseDescriptorV1 } from '@happier-dev/database-protocol';
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

type Answers = Readonly<{
  history?: unknown;
  bindingRefusal?: string;
  missedSchedule?: boolean;
}>;

/** A Postgres Environment opened on its Database page; the receipt keeps a pre-migration backup when asked. */
async function renderDatabase(
  input: Readonly<{
    answers?: Answers;
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
    /** The Machine refuses the Move Workflow's start. */
    refuseWorkflowStart?: boolean;
    moveDestinationWithApp?: boolean;
    sourceMultiMachine?: boolean;
    moveWritersUnavailable?: boolean;
    moveDestinationUnprotected?: boolean;
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
        }, { engine: 'mysql', service: 'mysql', port: 3306 }],
      },
    },
  });
  if (input.managed) {
    authored.targetLinks.push({ targetLink: createDeploymentTargetLinkHeaderV1({
      id: 'managed-database', environmentId, role: 'data', targetKind: 'neon', machines: [], members: [],
      source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.neon', localId: 'database' } },
    }), content: { data: { engine: 'postgres' },
      providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'main' },
      providerEnvironment: { kind: 'custom', id: 'main' }, credentialPrincipal: { kind: 'account', accountId: 'account-owner',
        purpose: { consumer: { pluginId: 'happier.deploy.neon', localId: 'database' }, purpose: 'database.manage' },
        target: { kind: 'account', account: { service: { pluginId: 'happier.deploy.neon', localId: 'database' }, accountId: 'token' } } } } });
  }
  // Each case uses its own Home and Machine.
  const detail = { ...authored, environment: { ...authored.environment, serverId, controllerMachineId: machineId },
    targetLinks: authored.targetLinks.map((row) => ({ ...row, targetLink: { ...row.targetLink,
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
    environment: { ...detail.environment, id: 'database-dedicated', revision: 3, runtimeTargetLinkId: 'target-database-dedicated' },
    targetLinks: input.moveManagedDestination ? [{ targetLink: createDeploymentTargetLinkHeaderV1({
      id: 'target-database-dedicated', environmentId: 'database-dedicated', role: 'data', targetKind: 'neon', machines: [], members: [],
      source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.neon', localId: 'database' } },
    }), content: { providerIdentity: { providerAccountId: 'organization', providerResourceId: 'project', providerEnvironment: 'main' },
      providerEnvironment: { kind: 'custom', id: 'main' }, credentialPrincipal: { kind: 'account', accountId: 'owner',
        purpose: { consumer: { pluginId: 'happier.deploy.neon', localId: 'database' }, purpose: 'database.manage' },
        target: { kind: 'account', account: { service: { pluginId: 'happier.deploy.neon', localId: 'database' }, accountId: 'token' } } } } }]
      : detail.targetLinks.filter(row => row.targetLink.role === 'runtime').map(row => ({ ...row, targetLink: { ...row.targetLink,
        id: 'target-database-dedicated', environmentId: 'database-dedicated', activeDeploymentId: 'deployment-dedicated' } })),
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
      ownServer: { rollout: 'recreate', autoRestorePreviousRelease: true, serviceExports: [
        { key: 'database', service: 'postgres', containerPort: 5432, scheme: 'postgres', exposure: 'privateNetwork', privateNetwork: 'shop-net' },
      ] },
      template: { ...detail.content.template!, services: ['postgres'], data: [{ engine: 'postgres', service: 'postgres',
        variables: { username: 'POSTGRES_USER', password: 'POSTGRES_PASSWORD', database: 'POSTGRES_DB' } }] },
    },
  });
  const moveCandidate = await isDeploymentDatabaseMoveCandidateV1(moved.content, selectDeploymentRuntimeTargetLinkV1(moved));
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
      execute: (operand) => {
        effects.push({
          actionId,
          input: DeploymentBackupActionInputSchemasV1[actionId].parse(operand),
        });
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
    environment: { serverId, projectSourceId: detail.environment.projectSourceId, environmentId } };
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
    homes.answer(serverId, `GET /v1/deployments/environments/${environmentId}`, { body: {
      ok: true, environment: { ...detail.environment, controllerMachineId: machineId },
      targetLinks: detail.targetLinks.map(row => row.targetLink),
    } });
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
  const controller = createDeploymentReadControllerV1({
    // The read controller is scoped to the Environment header's own Home id.
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
          ...(input.moveDestination ? [{ environment: moved.environment, title: 'Dedicated Postgres', databaseMoveCandidate: moveCandidate }] : []),
        ], nextCursor: null },
      }),
      readEnvironment: async (_scope, id) => ({ ok: true,
        value: id === moved.environment.id ? { ...moved, databaseMoveCandidate: moveCandidate } : detail }),
      listHistory: async () => ({
        ok: true,
        value: { ok: true, items: [receipt.deployment], nextCursor: null },
      }),
      readReceipt: async () => ({ ok: true, value: receipt }),
    },
  });
  const navigate = vi.fn();
  const back = vi.fn();
  const screen = await renderScreen(
    <ModalProvider><PluginSurfaceDestinationNavigationBindingProvider binding={navigation}>
      <DeploymentDatabasePage
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
      />
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
    },
  };
}

describe('Environment → Database → Private console', () => {
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

describe('Environment → Database → Workbench', () => {
  it('opens the shared workbench for the exact deployment database through environment discovery', async () => {
    const view = await renderDatabase();
    try {
      await view.settle(`${page}.query`);
      expect(view.effects.some(effect => effect.actionId === 'action.invoke')).toBe(false);
      await view.screen.pressByTestIdAsync(`${page}.query`);
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        const { Modal } = await import('@/modal');
        expect(view.opened, JSON.stringify({ effects: view.effects, alerts: vi.mocked(Modal.alert).mock.calls,
          operations: [...actionOperationStore.getSnapshot().operationsByKey.values()] })).toHaveLength(1);
      });
      expect(view.opened[0]).toMatchObject({ destination: { pluginId: DATABASE_PLUGIN_ID_V1, localId: 'database-workbench' },
        subPath: 'console', input: { scope: view.scope,
          descriptor: view.descriptor } });
      expect(view.effects.filter(effect => effect.actionId === 'action.invoke')).toEqual([
        expect.objectContaining({ input: expect.objectContaining({ input: { scope: {
          kind: 'environment', environment: view.scope.environment } } }) })]);
      expect(view.screen.findByTestId('project-deployments.query.sql')).toBeNull();
    } finally { await view.dispose(); }
  });

  it.each([false, true])('opens managed databases through the shared workbench without selecting an arbitrary database (multiple %s)', async multiple => {
    const view = await renderDatabase({ managed: true, multipleManagedDatabases: multiple });
    try {
      await view.settle(`${page}.query`);
      await view.screen.pressByTestIdAsync(`${page}.query`);
      await waitForHomeGovernance(async () => { await act(async () => {}); expect(view.opened).toHaveLength(1); });
      expect(view.opened[0]).toMatchObject({ destination: { pluginId: DATABASE_PLUGIN_ID_V1, localId: 'database-workbench' },
        subPath: 'console', input: { scope: view.scope } });
      if (multiple) expect(view.opened[0]?.input).not.toHaveProperty('descriptor');
      else expect(view.opened[0]?.input).toHaveProperty('descriptor', view.descriptor);
    } finally { await view.dispose(); }
  });

  it.each([
    { origin: 'created' as const, starts: 'remove' },
    { origin: undefined, starts: 'detach' },
  ])('unlinks or deletes a managed database project through the one removal review (origin $origin)', async ({ origin, starts }) => {
    const { definePlugin, DeploymentTargetRoleInputProtocolSchemasV1, DeploymentTargetRoleResultV1ProtocolSchema } = await import('@happier-dev/plugin-sdk');
    const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
    const pluginId = 'com.example.removable-database';
    const execution = { target: 'account', account: { artifactId: 'removal-runtime', exportName: 'activate' } } as const;
    const closed = { type: 'object', properties: {}, additionalProperties: false } as const;
    const plugin = definePlugin({ id: pluginId, version: '1.0.0', displayName: 'Managed Postgres', actions: {
      'projects-delete': { title: 'Delete the recorded project', execution, surfaces: ['ui'], readOnly: false, dangerLevel: 'destructive',
        confirmation: { title: 'Delete this Postgres project and all of its data?' },
        inputSchema: DeploymentTargetRoleInputProtocolSchemasV1['projects.delete'].jsonSchema,
        resultSchema: DeploymentTargetRoleResultV1ProtocolSchema,
        run: async () => ({ v: 1, state: 'succeeded', observedAtMs: 1, providerResourceAbsent: true } as const) },
    }, deploymentTargets: { database: { role: 'data', title: 'Managed Postgres', targetKind: 'database', icon: 'server-outline',
      targetSchema: closed, linkSchema: closed, dataV1: { projects: { delete: 'projects-delete' } } } } });
    const serverId = await homes.addHome({ name: 'Managed removal', serverUrl: `https://managed-removal-${starts}.test`,
      serverIdentityId: `srv_managed_removal_${starts}`, accountId: 'owner', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
      activate: api => plugin.activateAccount(api, execution.account), accountLifetime: account.accountLifetime, publishProjection: true });
    const targetLink = createDeploymentTargetLinkHeaderV1({ id: 'managed-removal', role: 'data', targetKind: 'database', machines: [], members: [],
      source: { kind: 'plugin', contribution: { pluginId, localId: 'database' } } });
    const principal = { kind: 'account' as const, accountId: 'owner',
      purpose: { consumer: { pluginId, localId: 'link' }, purpose: 'deploy-manage' },
      target: { kind: 'account' as const, account: { service: { pluginId, localId: 'database' }, accountId: 'token' } } };
    const detail = createDeploymentEnvironmentDetailV1({ environment: (({ runtimeTargetLinkId: _runtime, ...header }) => header)(createDeploymentEnvironmentHeaderV1({ serverId })),
      targetLinks: [{ targetLink, content: { ...(origin ? { providerResourceOrigin: origin } : {}), credentialPrincipal: principal,
        providerIdentity: { providerAccountId: 'organization', providerResourceId: 'shop-orders', providerEnvironment: 'main' },
        providerEnvironment: { kind: 'custom', id: 'main' } } }] });
    homes.answer(serverId, `GET /v1/deployments/environments/${detail.environment.id}`, { body: { ok: true,
      environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink) } });
    const removals: unknown[] = [];
    await answerExternalActionAccountForHome(homes, serverId, { machineId: detail.environment.controllerMachineId,
      actionId: 'deployments.teardown', tokenEpoch: 0, requesterInvocation: 'required', execute: raw => {
        removals.push(raw);
        return { ok: true, environmentId: detail.environment.id, revision: detail.environment.revision + 1,
          deploymentId: 'data-teardown', deploymentRevision: 1, state: 'queued' };
      } });
    const controller = createDeploymentReadControllerV1({ scope: { serverId, accountId: 'owner', projectSourceId: detail.environment.projectSourceId },
      transport: { listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
        readEnvironment: async () => ({ ok: true, value: detail }),
        listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
        readReceipt: async () => ({ ok: true, value: createDeploymentReceiptDetailV1() }) } });
    const screen = await renderScreen(<ModalProvider><DeploymentDatabasePage controller={controller}
      environmentId={detail.environment.id} database={targetLink.id} demand={shown} phone={false}
      lifetime={account.accountLifetime} review={noReview} restore={null} setBindings={null} onBack={() => {}} onNavigate={() => {}} /></ModalProvider>);
    try {
      await waitForHomeGovernance(async () => { await act(async () => {});
        expect(screen.findByTestId(`${page}.remove`)?.props.onPress).toBeTypeOf('function'); });
      await screen.pressByTestIdAsync(`${page}.remove`);
      // The removal owner picks the start: a project Happier created starts on Delete, a linked one on Unlink.
      await waitForHomeGovernance(async () => { await act(async () => {});
        expect(screen.findByTestId(`project-deployments.disposition.choice:${starts}`)?.props.accessibilityState).toMatchObject({ selected: true }); });
      if (starts === 'detach') await screen.pressByTestIdAsync('project-deployments.disposition.choice:remove');
      expect(screen.getTextContent()).toContain('Delete this Postgres project and all of its data?');
      expect(screen.findByTestId('project-deployments.disposition.confirm')?.props.disabled).toBe(true);
      await act(async () => screen.findByTestId('project-deployments.disposition.resourceConfirmation')!.props.onChangeText('shop-orders'));
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

describe('Environment → Database → Move', () => {
  it('does not offer an app-plus-database destination and refuses a stale selection without effects', async () => {
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const view = await renderDatabase({ moveDestination: true, moveDestinationWithApp: true, storedDefinition: true });
    try {
      await view.settle(`${page}.move`);
      await view.screen.pressByTestIdAsync(`${page}.move`);
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
      await view.settle(`${page}.move`);
      await view.screen.pressByTestIdAsync(`${page}.move`);
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

  it('uses the data owner’s single-Machine prerequisite instead of leaving other source writers running', async () => {
    const view = await renderDatabase({ moveDestination: true, storedDefinition: true, sourceMultiMachine: true });
    try {
      expect(await view.settle(`${page}.connection`)).not.toBeNull();
      expect(view.screen.findByTestId(`${page}.move`)).toBeNull();
      expect(view.effects.filter(effect => effect.actionId === 'workflow.run.start')).toEqual([]);
    } finally { await view.dispose(); }
  });
  it('explains unsupported managed import without starting a copy or offering cutover', async () => {
    const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
    const view = await renderDatabase({ moveDestination: true, moveManagedDestination: true, storedDefinition: true });
    try {
      await view.settle(`${page}.move`);
      await view.screen.pressByTestIdAsync(`${page}.move`);
      const { DeploymentEnvironmentChooser } = await import('./DeploymentEnvironmentCollection');
      expect(view.screen.findByTestId('project-deployments.move.destination:database-dedicated')).toBeNull();
      const chooser = view.screen.findAllByType(DeploymentEnvironmentChooser)[0]!;
      await act(async () => chooser.props.onSelect({ environment: view.moveDestination.environment, title: 'Managed database' }));
      await view.settle('project-deployments.move.destination.unavailable');
      await waitForHomeGovernance(() => expect(view.screen.findAllByType(SurfaceStateCard)
        .find(card => card.props.testID === 'project-deployments.move.destination.unavailable')?.props.diagnosticCode).toBe('unsupported'));
      expect(view.screen.findByTestId('project-deployments.move.copy')?.props.disabled).toBe(true);
      expect(view.screen.findByTestId('project-deployments.move.review')).toBeNull();
      expect(view.effects.filter(effect => getActionSpec(effect.actionId)?.sideEffectClass !== 'read')).toEqual([]);
    } finally { await view.dispose(); }
  });

  it('requires destination backups before copying into an already provisioned database', async () => {
    const view = await renderDatabase({ moveDestination: true, moveDestinationUnprotected: true, storedDefinition: true });
    try {
      await view.settle(`${page}.move`);
      await view.screen.pressByTestIdAsync(`${page}.move`);
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

  it('says a refused Move start in the sheet, with its code under Technical details, never as a bare alert (D25)', async () => {
    const view = await renderDatabase({ moveDestination: true, storedDefinition: true, refuseWorkflowStart: true });
    routerMock.spies.push.mockClear();
    try {
      await view.settle(`${page}.move`);
      await view.screen.pressByTestIdAsync(`${page}.move`);
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
      await view.settle(`${page}.move`);
      await view.screen.pressByTestIdAsync(`${page}.move`);
      await view.settle('project-deployments.move.destination:database-dedicated');
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
      expect(view.effects.filter(effect => effect.actionId === 'machines.services.list')).toHaveLength(1);
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
      await view.settle(`${page}.move`);
      await view.screen.pressByTestIdAsync(`${page}.move`);
      await view.settle('project-deployments.move.destination:database-dedicated');
      await view.screen.pressByTestIdAsync('project-deployments.move.destination:database-dedicated');
      await waitForHomeGovernance(() => expect(view.screen.findByTestId('project-deployments.move.copy')?.props.disabled).toBe(false));
      await view.screen.pressByTestIdAsync('project-deployments.move.copy');
      expect(await view.settle('project-deployments.move.refused')).not.toBeNull();
      expect(view.screen.findByTestId('project-deployments.move.save')).toBeNull();
      expect(view.effects.filter(effect => getActionSpec(effect.actionId)?.sideEffectClass !== 'read')).toEqual([]);
    } finally { await view.dispose(); }
  });
});

describe('Environment → Data → Add (P10)', () => {
  it.each(['ready', 'unreachable'] as const)('hydrates the selected database on its Environment controller and settles its read (%s)', async outcome => {
    const { showDeploymentAddSheet } = await import('./DeploymentDatabasePage');
    const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
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
    { outcome: 'partial', update: false, choices: false }, { outcome: 'applied', update: true, choices: false },
    { outcome: 'applied', update: false, choices: true }, { outcome: 'applied', update: false, choices: false, repository: true },
    { outcome: 'partial', update: false, choices: false, repository: true },
    { outcome: 'partial', update: true, choices: false, repository: true }] as const)('applies the reviewed template through the confirmed Action front door ($outcome, update=$update, choices=$choices, repository=$repository)', async testCase => {
    const { outcome, update, choices } = testCase;
    const repository = 'repository' in testCase && testCase.repository;
    const { showDeploymentAddSheet, showDeploymentTemplateUpdateSheet } = await import('./DeploymentDatabasePage');
    const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
    const serverUrl = `https://database-add-${outcome}.test`;
    const catalogUrl = `${serverUrl}/apps.json`;
    const sourceId = deriveMarketplaceSourceId(catalogUrl);
    const serverId = await homes.addHome({ name: 'Database Add', serverUrl, serverIdentityId: 'srv_database_add',
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
    const app = DeploymentTemplateV1Schema.parse(entry.app);
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
    const previews: unknown[] = [];
    const receivedApplyResults: Array<Readonly<{ ok: boolean; errorCode?: string }>> = [];
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
        if (outcome !== 'applied') return ActionExecuteFailureSchema.parse({ ok: false, errorCode: outcome, error: outcome });
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
    const receiver = createActionExecutor(createActionExecutorBoundaryFixture({
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
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.add.confirm')?.props.disabled).toBe(false));
      if (choices) {
        const prefix = 'project-deployments.add.choices';
        const before = previews.length;
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
        expect(previews).toHaveLength(before);
        expect(applied).toEqual([]);
        expect(screen.findByTestId('project-deployments.add.confirm')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('project-deployments.add.reviewChoices');
        await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.add.confirm')?.props.disabled).toBe(false));
        expect(previews).toHaveLength(before + 1);
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
      expect(receivedApplyResults).toEqual([outcome === 'template_service_conflict'
        ? { ok: false, errorCode: outcome } : { ok: true }]);
      expect(applied).toEqual([expect.objectContaining({ mode: 'apply', ...(update ? {} : { intent: 'add' }), environment: { kind: 'existing',
        environmentId: detail.environment.id, expectedRevision: detail.environment.revision },
        templateRef: expect.objectContaining({ sourceId, itemId: 'postgresql' }),
        bindings: update ? [] : [...(choices ? [{ purpose: 'variable', name: 'DB_USER', phase: 'runtime', source: { kind: 'value', value: 'alice' } }] : []), { purpose: 'variable', name: 'DB_PASSWORD', phase: 'runtime', source: { kind: 'generated', key: 'DB_PASSWORD' } }],
        ...(update ? {} : { generatedSecretAudience: { accountGrants: [], teamGrants: [], groupGrants: [] } }) })]);
      if (choices) expect(applied[0]).toMatchObject({ connectTo: { service: 'app' }, replace: ['DATABASE_URL', 'DIRECT_URL'],
        volumeBindings: [{ templateVolumeId: 'postgres-data', source: 'chosen-data' }] });
      if (update || repository) expect(applied[0]).not.toHaveProperty('deploy');
      if (repository) {
        expect(applied[0]).toMatchObject({ destination: { kind: 'repositoryPullRequest', workspace: { kind: 'workspace-ref', serverId, id: 'checkout' },
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
        expect(navigate).toHaveBeenCalledWith({ tab: 'overview' });
        expect(applied).toHaveLength(1);
      } else {
        const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
        expect(screen.getTextContent()).toContain(readDeploymentRefusalRecoveryV1(outcome)!.remedy);
        expect(screen.findByTestId('project-deployments.add.added')).toBeNull();
        await screen.pressByTestIdAsync('project-deployments.add.refused.next');
        expect(opened).toEqual(['source']);
      }
    } finally { await screen.unmount(); account.dispose(); }
  });

  it('says a refused Add once, from the shared recovery owner, beside its one next step', async () => {
    const { DeploymentAddRefusal } = await import('./DeploymentDatabasePage');
    const opened: string[] = [];
    const screen = await renderScreen(
      <DeploymentAddRefusal testID="add.refusal" code="template_domain_required" onOpenRecovery={(destination) => opened.push(destination)} />,
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
    const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
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
      // availability said once here and not again under Connection; a size the read hasn't reported says "—".
      const strip = view.screen.findAllByProps({ testID: `${page}.facts.strip` })[0];
      expect((strip?.props.facts as readonly { key: string; value: string; detail?: string }[])
        .map(fact => [fact.key, fact.value, fact.detail ?? null])).toEqual([
        ['lastBackup', formatAsOfTime(Date.parse('2026-11-07T10:01:00Z')), null],
        // Kept restore points are the destination's own count for this database's dump source, never counted from History.
        ['restorePoints', '2', null],
        ['availability', t('projects.deployments.databaseAvailabilityOneServer'), t('projects.deployments.databaseAvailabilityNotHighlyAvailable')],
        ['size', '—', null]]);
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
      expect(view.navigate).toHaveBeenCalledWith({ tab: 'settings', section: 'servers-build' });
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
      expect(view.navigate).toHaveBeenCalledWith({ tab: 'settings', section: 'servers-build' });
    } finally { await view.dispose(); }
  });

  it('says why a database defined in its repository cannot be shared here, with no Share that leads nowhere', async () => {
    const view = await renderDatabase({ setBindings: async input => DeploymentActionOutputSchemasV1['deployments.bindings.set'].parse({
      ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1,
    }) });
    try {
      expect(await view.settle(`${page}.connection.private`)).not.toBeNull();
      expect(view.screen.findByTestId(`${page}.connection.private.share`)).toBeNull();
      expect(view.screen.getTextContent()).toContain('repository’s Compose file');
      await view.screen.pressByTestIdAsync(`${page}.connect`);
      expect(await view.settle('project-deployments.connect.needsShare')).not.toBeNull();
      expect(view.screen.findByTestId('project-deployments.connect.openSettings')).toBeNull();
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
        // The native owner pushes its phase on the restore's own Action operation, named by the request id.
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
              requestId: operation?.actionRequestId,
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
      void view.screen.pressByTestIdAsync(
        'project-deployments.restore.confirm',
      );
      expect(
        await view.settle('project-deployments.restore.step.stop'),
      ).not.toBeNull();
      releaseConfirm();
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
      releaseConfirm();
      await view.dispose();
    }
  });
});

// P45 one database presentation: identity and the native console come from protected link facts.
it.each([true, false])('opens a header-only managed database through the Artifact owner and shows only a produced console (console=%s)', async (hasConsole) => {
  const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
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
