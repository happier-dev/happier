import {
  createManagedCpuOptionsFixture,
  createMachineProvisionerEditorManifestFixture,
  createEnabledMachinePluginIntentReadFixture,
  createPlainManagedMachinePresetFixture,
  createMachineProvisionerOptionsFixture,
  createDelegatedManagedPresetFixture,
} from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { projectPrivateLabelForRecipientV1, sealPrivateLabelV1 } from '@happier-dev/protocol/crypto/privateLabelV1';
import {
  ExternalActionExecutionAuthorizationV1Schema,
  ExternalActionExecutionAuthorizationRequestV1Schema,
  ExternalActionRequestEnvelopeSchema,
} from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import * as React from 'react';
import { Dimensions } from 'react-native';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui/currentUiContext';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  createHomeGovernanceHarness,
  createAccountTokenForTests,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { installMachinesSettingsCommonModuleMocks } from '../machinesSettingsTestHelpers';
import {
  teamSummaryFixture,
  teamCapabilitiesFixture,
} from '@/dev/testkit/fixtures/teamFixtures';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { createManagedControllerMachineFixture as createMachineFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import {
  PluginJsonSchemaV2Schema,
  type PluginJsonSchemaV2,
} from '@happier-dev/protocol/plugins/contributions/jsonSchema';
import {
  PluginProjectedActionV2Schema} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import {
  DaemonContributionRegistryProjectionDescribeResponseSchema,
  DaemonPluginActionSchemasReadResponseSchema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { MachineProvisionersListResultV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { MachinePresetDetailModel } from './MachinePresetDetail';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/publicTypes';
import { ManagedMachinePresetCreateInputV1Schema, ManagedMachinePresetUpdateInputV1Schema, ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { openManagedMachinePresetContentV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { publishMachineActivityForTest, publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';

const route = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), params: {} as Record<string, string | string[] | undefined> }));
const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
// Execution-host discovery is a platform boundary; these mounted native flows use the app host.
const runtimeHost = vi.hoisted(() => ({ current: null as 'browser' | 'native' | null }));
vi.mock('@/utils/system/runtimeFetch', async importActual => {
  const actual = await importActual<typeof import('@/utils/system/runtimeFetch')>();
  return { ...actual, readRuntimeFetchHost: (input: RequestInfo | URL) => runtimeHost.current
    ? Promise.resolve(runtimeHost.current) : actual.readRuntimeFetchHost(input) };
});
// Native application identity is an OS boundary; match the existing artifact-cache host setup.
vi.mock('expo-application', () => ({ applicationId: null, nativeApplicationVersion: null, nativeBuildVersion: null }));
// Vitest substitutes Metro's deferred loader, not the admitted Action or inventory logic.
vi.mock(
  '@/sync/ops/actions/frontDoorRuntimeActionExecutor',
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')
      >();
    const { createFrontDoorActionExecuteForVitest } =
      await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return {
      ...original,
      createFrontDoorActionExecute:
        createFrontDoorActionExecuteForVitest(original),
    };
  },
);
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async () => {
    const { createServerScopedMachineRpcBoundaryMock } =
      await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
  },
);
installMachinesSettingsCommonModuleMocks({
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true }).module;
  },
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: route, params: () => route.params }).module;
  },
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
const { CurrentUiContextCommandsProvider, useCurrentUiContextComposedCommands } = await import('@/components/appShell/currentUiContext/CurrentUiContextCommands');
const { usePublishCurrentUiContext } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
// Transform the real owners after the transport/platform boundaries, outside the case budget.
const { MachinePresetView, MachinePresetScreen } = await import('./MachinePresetView');
const { ManagedMachineDetailScreen } = await import('./ManagedMachineDetail');
const { ManagedMachineConfigurationScreen } = await import('./ManagedMachineConfigurationScreen');
const { AllMachinesIndex: MachinesSettingsView } =
  await import('@/components/machines/index/AllMachinesIndex');
const { ManagedMachineConfigurationView } =
  await import('./ManagedMachineConfigurationView');
const { MachineProvisionerPicker } = await import('./MachineProvisionerPicker');
const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
const { Item } = await import('@/components/ui/lists/Item');
const { MachineConfigurationReceipt } =
  await import('./MachineConfigurationReceipt');
const { MachinePresetDetail, ManagedFieldRow } = await import('./MachinePresetDetail');
const { DropdownMenu } =
  await import('@/components/ui/forms/dropdown/DropdownMenu');
const { HappierBrandMark } =
  await import('@/components/ui/media/HappierBrandMark');
const { t } = await import('@/text');
const { formatManagedSizeBytes } = await import('./managedConfigurationPresentation');
const { ModalProvider } = await import('@/modal');
const { resolveServerProfileScopeIdForIdentifier } =
  await import('@/sync/domains/server/serverProfiles');
const { clearDaemonMergedProjectionCacheForTests } =
  await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { resetMachineProjectionReadsForTests } =
  await import('@/sync/ops/machineContributionRegistryProjection');
beforeEach(async () => {
  await harness.reset();
  runtimeHost.current = null;
  const { storage } = await import('@/sync/domains/state/storage');
  // The inventory's ordered rows and exact-id index are one fixture lifetime.
  storage.setState({ machines: {}, machineListByServerId: {}, machineRecordsByServerId: {}, machineListStatusByServerId: {} });
  route.push.mockReset();
  route.replace.mockReset();
  route.params = {};
  (
    await import('@/sync/ops/actions/scopedHomeActionExecutor')
  ).resetScopedHomeActionExecutorsForTests();
  clearDaemonMergedProjectionCacheForTests();
  resetMachineProjectionReadsForTests();
  boundary.rpc
    .mockReset()
    .mockResolvedValue({ ok: false, code: 'unsupported' });
});
afterEach(async () => {
  standardCleanup();
  // Retire credential-owned projections before the next global MMKV reset removes their profiles.
  await harness.reset();
  (
    await import('@/sync/domains/machines/reachability/machineReachability')
  ).clearMachineRequestReachabilityForTest();
});

const preset = {
  id: 'preset',
  homeId: 'srv_history',
  revision: 3,
  name: 'Build box',
  owner: { kind: 'account', accountId: 'owner' },
  launch: {
    provider: { pluginId: 'custom.compute', localId: 'native' },
    schemaVersion: 1,
    name: 'Future guest',
    choices: {},
  },
  controller: { machineId: 'controller', installationId: 'installation' },
  simultaneousLimit: { maximum: 2 },
} as const;
const savedCredential = {
  purpose: { consumer: preset.launch.provider, purpose: 'native-management' },
  account: {
    service: { pluginId: 'custom.compute', localId: 'native-account' },
    accountId: 'saved-native-account',
  },
} as const;
const resource = {
  id: 'resource',
  homeId: 'srv_history',
  custodianAccountId: 'owner',
  preset: { id: 'preset', revision: 1, contentEncryptionMode: 'plain' },
  launch: { ...preset.launch, name: 'Original guest' },
  controller: preset.controller,
  resource: {
    contributionRef: preset.launch.provider,
    schemaVersion: 1,
    value: { nativeId: 'original' },
  },
  allocation: 'bound',
  creationState: 'active',
  desired: 'start',
  desiredWhen: 'now',
  intentRevision: 1,
  retention: { kind: 'until-delete' },
  wakeOnAcceptedMessage: false,
  enrolledMachineId: 'guest',
} as const;
const provisioner: MachineProvisionersListResultV1['provisioners'][number] = {
  contribution: preset.launch.provider,
  occurrenceId: 'occurrence',
  credentialPurposes: [],
  acquireExecutionTarget: 'daemon' as const,
  descriptor: {
    id: 'native',
    title: 'Custom compute',
    icon: 'server',
    resourceKind: 'VM',
    schemaVersion: 1,
    launchSchema: {
      type: 'object',
      properties: { cpu: { type: 'integer', minimum: 1 } },
      additionalProperties: false,
    },
    resourceSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    platforms: ['linux'],
    prerequisites: [],
    billing: { location: 'cloud', stoppedBilling: 'billed' },
    retention: { supportedIntents: ['delete'] },
    actions: {
      check: 'check',
      options: 'options',
      acquire: 'acquire',
      bootstrap: 'bootstrap',
      inspect: 'inspect',
      destroy: 'destroy',
    },
  },
};

function seedOptionsDeclaration(
  row: MachineProvisionersListResultV1['provisioners'][number],
  inputSchema: PluginJsonSchemaV2,
  schemaAvailable: boolean | 'missing-input-schema' = true,
  installed?: Readonly<Record<string, unknown>>,
) {
  const localId = row.descriptor.actions.options;
  if (!localId)
    throw new Error('The provisioner must declare an options Action');
  const action = { pluginId: row.contribution.pluginId, localId };
  const actionKey = buildQualifiedPluginContributionKey(action);
  // Infrastructure role metadata may be CLI/plugin-only. Reading its public
  // schema for a managed options query does not make it a new UI Action.
  const projectedAction = PluginProjectedActionV2Schema.parse({
    id: action.localId,
    pluginId: action.pluginId,
    occurrenceId: row.occurrenceId,
    title: 'Read native options',
    scopes: ['machine'],
    surfaces: ['cli', 'plugin'],
    execution: { target: 'daemon' },
    available: true,
    dangerLevel: 'safe',
  });
  const projection =
    DaemonContributionRegistryProjectionDescribeResponseSchema.parse({
      protocolVersion: 1,
      projection: {
        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        agentsById: {},
        diagnostics: [],
        familiesById: { ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.familiesById,
          machineProvisioners: { family: 'machineProvisioners', entriesById: {
            [buildQualifiedPluginContributionKey(row.contribution)]: {
              id: buildQualifiedPluginContributionKey(row.contribution), pluginId: action.pluginId,
              pluginVersion: '1.0.0', occurrenceId: row.occurrenceId, definition: row.descriptor,
            },
          } },
        },
        installedPackagesById: {
          [action.pluginId]: {
            ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE.installedPackagesById[
              'acme.review'
            ],
            id: action.pluginId,
            ...installed,
          },
        },
        actionsById: { [actionKey]: projectedAction },
      },
    });
  boundary.rpc.mockImplementation(
    async (request: {
      machineId: string;
      method: string;
      payload: unknown;
    }) => {
      if (
        request.method ===
        RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
      )
        return projection;
      if (request.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ) {
        expect(request.machineId).toBe(preset.controller.machineId);
        expect(request.payload).toEqual({
          machineId: preset.controller.machineId,
          expectedOccurrenceId: projectedAction.occurrenceId,
          qualifiedActionId: actionKey,
        });
        return DaemonPluginActionSchemasReadResponseSchema.parse(
          schemaAvailable === 'missing-input-schema'
            ? { ok: true }
            : schemaAvailable
              ? { ok: true, inputSchema }
              : { ok: false, code: 'stale_occurrence' },
        );
      }
      return { ok: false, code: 'unsupported' };
    },
  );
}

function sizeControl(screen: Awaited<ReturnType<typeof renderSettingsView>>) {
  return screen.tree.findAll(
    (node) =>
      node.props.testID === 'managed-config.sizes' &&
      typeof node.props.onChange === 'function',
  )[0];
}

async function editPresetCpu(screen: Awaited<ReturnType<typeof renderSettingsView>>) {
  await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:cpu'), screen.getTextContent()).not.toBeNull());
  await act(async () => screen.changeTextByTestId('managed-config.field:cpu', '4'));
  expect(screen.findByTestId('managed-config.field:cpu')?.props.value).toBe('4');
  expectNoNativePresetReads();
}

function expectNoNativePresetReads() {
  expect(harness.requestsFor('/v1/actions/machines.provisioners.check')).toEqual([]);
  expect(harness.requestsFor('/v1/actions/machines.provisioners.options')).toEqual([]);
}

function readCreatedPreset(input: unknown) {
  const stored = ManagedMachinePresetCreateInputV1Schema.parse(input);
  expect(stored.contentEncryptionMode).toBe('plain');
  expect(stored.recipients).toEqual([]);
  const content = openManagedMachinePresetContentV1({ presetId: stored.id, mode: 'plain', content: stored.content });
  if (!content) throw new Error('Expected the sealed Plain preset creation content');
  return { ...stored, ...content };
}

function readUpdatedPreset(input: unknown) {
  const stored = ManagedMachinePresetUpdateInputV1Schema.parse(input);
  expect(stored.patch.contentEncryptionMode).toBe('plain');
  expect(stored.patch.recipients).toEqual([]);
  const content = openManagedMachinePresetContentV1({ presetId: stored.id, mode: 'plain', content: stored.patch.content });
  if (!content) throw new Error('Expected the sealed Plain preset update content');
  return { ...stored, patch: { ...stored.patch, ...content } };
}

function poolName(poolId: string, name: string) {
  return { kind: 'available' as const, label: projectPrivateLabelForRecipientV1({
    stored: sealPrivateLabelV1({ mode: 'plain', binding: { entity: 'machine_pool', field: 'name', id: poolId }, value: name }),
    recipientAccountId: 'owner',
  }) };
}

async function seedPresetDeclaration(serverId: string, image = false,
  descriptorPatch: Partial<typeof provisioner.descriptor> = {}) {
  const { defineProtocolNumber, defineProtocolObject, defineProtocolString } = await import('@happier-dev/protocol/plugins/actions/protocolComposableSchema');
  const cpu = defineProtocolNumber({ integer: true, minimum: 1 });
  const launch = defineProtocolObject({ cpu: image ? cpu : cpu.optional(),
    ...(image ? { image: defineProtocolString() } : {}) }, { policy: 'closed' });
  const resource = defineProtocolObject({}, { policy: 'closed' });
  const manifest = createMachineProvisionerEditorManifestFixture({ pluginId: provisioner.contribution.pluginId,
    descriptor: { ...provisioner.descriptor, ...descriptorPatch, launchSchema: launch.jsonSchema, resourceSchema: resource.jsonSchema } });
  return seedAccountProvisioner(serverId, manifest);
}

async function seedAccountProvisioner(serverId: string, input: unknown) {
  const { PluginPortableReleaseManifestV1Schema } =
    await import('@happier-dev/protocol/plugins/availability');
  const { installBundledPluginUiDeclarationsForTests } = await import('@/dev/testkit/mocks/bundledPluginUiAssets');
  const { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection, clearPluginAccountAvailabilityProjection } =
    await import('@/sync/domains/plugins/availability/projection');
  const { projectAccountManagedProvisioners } = await import('@happier-dev/cli-common/machines/managed/provisioners');
  const manifest = PluginPortableReleaseManifestV1Schema.parse(input);
  onTestFinished(installBundledPluginUiDeclarationsForTests([{ pluginId: manifest.id, pluginVersion: manifest.version,
    packageName: manifest.id, displayName: resolvePluginLocalizedStringV2Text(manifest.displayName), hasMachineProvisioners: true, entriesById: {}, normalizedManifest: manifest }]));
  onTestFinished(clearPluginAccountAvailabilityProjection);
  const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId) || serverId, accountId: 'owner' };
  replacePluginAccountAvailabilityProjection({ scope, snapshot: { availabilityCursor: 1,
    intentReads: [{ pluginId: manifest.id, response: createEnabledMachinePluginIntentReadFixture(manifest) }], materializations: [], snapshots: [] } });
  const declarations = await readPluginAccountAvailability(scope).ensureCurrentAccountExecutionDeclarations({ family: 'machineProvisioners' });
  if (declarations.kind !== 'available') throw new Error('Expected the Account provisioner declaration');
  const selected = projectAccountManagedProvisioners(declarations.declarations)
    .find(row => row.contribution.pluginId === manifest.id);
  if (!selected) throw new Error('Expected the declared Account provisioner');
  return selected;
}

async function seed(machinePoolsEnabled?: boolean, teamsEnabled?: boolean) {
  const serverId = await harness.addHome({
    name: 'History',
    serverUrl: 'https://history.example',
    serverIdentityId: 'srv_history',
    accountId: 'owner',
    currentAccount: true,
    machinePoolsEnabled,
    teamsEnabled,
  });
  await harness.addHome({
    name: 'Other',
    serverUrl: 'https://other.example',
    serverIdentityId: 'srv_other',
    accountId: 'other',
  });
  harness.answer(serverId, '/v1/machines/presets/recipient-census', { body: { kind: 'ready', contentEncryptionMode: 'plain', recipients: [] } });
  const sealed = createDelegatedManagedPresetFixture({ preset, descriptor: provisioner.descriptor,
    custodianAccountId: 'owner', installationPublicKey: encodeBase64(
      tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).publicKey, 'base64url') });
  harness.answer(serverId, '/v1/machines/presets/get', {
    body: { kind: 'found', preset: { ...sealed, teamAcquireDelegated: false } },
  });
  harness.answer(serverId, '/v1/machines/managed/actions/list', {
    select: (input) => ({
      body: {
        machines:
          input && typeof input === 'object' && 'archived' in input
            ? []
            : [resource],
      },
    }),
  });
  return serverId;
}

async function seedConfiguration(serverId: string, image = false,
  descriptorPatch: Partial<typeof provisioner.descriptor> = {}) {
  const declaredProvisioner = await seedPresetDeclaration(serverId, image, descriptorPatch);
  const listedProvisioner = { ...provisioner, descriptor: { ...provisioner.descriptor, ...descriptorPatch } };
  seedOptionsDeclaration(
    provisioner,
    PluginJsonSchemaV2Schema.parse({
      type: 'object',
      properties: {},
      additionalProperties: false,
    }),
  );
  const machine = createMachineFixture({
    id: preset.controller.machineId,
    installationId: preset.controller.installationId,
    activeAt: Date.now(),
  });
  const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
  await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, [machine]);
  for (const [actionId, result] of [
    [
      'machines.provisioners.list',
      { controller: preset.controller, provisioners: [listedProvisioner] },
    ],
    ['machines.provisioners.check', { available: true }],
    [
      'machines.provisioners.options',
      createManagedCpuOptionsFixture([
        { id: 'saved', title: 'Saved size' },
        { id: 'large', title: 'Larger size', cpu: 4 },
      ]),
    ],
  ] as const) {
    if (actionId !== 'machines.provisioners.list') {
      await answerExternalActionAccountForHome(harness, serverId, {
        actionId, machineId: preset.controller.machineId, installationId: preset.controller.installationId,
        tokenEpoch: 0,
        execute: (input, { target }) => {
          expect(target).toEqual({ kind: 'machine', machineId: preset.controller.machineId });
          expect(input).toMatchObject({ homeId: preset.homeId, controller: preset.controller });
          return result;
        },
      });
      continue;
    }
    harness.answer(serverId, `/v1/actions/${actionId}`, {
      select: (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        // Preset authoring reads the Account's declarations without executing native roles.
        if (actionId === 'machines.provisioners.list' && request.target?.kind !== 'machine') return {
          body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result: { provisioners: [declaredProvisioner] } } },
        };
        expect(request.target).toEqual({
          kind: 'machine',
          machineId: preset.controller.machineId,
        });
        expect(request.input).toMatchObject({
          homeId: preset.homeId,
          controller: preset.controller,
        });
        return {
          body: {
            v: 1,
            actionId,
            requestId: request.requestId,
            execution: { ok: true, result },
          },
        };
      },
    });
  }
  return scopeId;
}

describe('reachable preset detail', () => {
  it('lets the agent open Details while the first preset read awaits approval', async () => {
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const { storage } = await import('@/sync/domains/state/storage');
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    // The terminal bearer narrows this UI read to Account automation, whose Ask opens a durable approval.
    const accountId = 'owner';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId, session: 'terminal-test' })).toString('base64url')}.test`;
    const serverId = await harness.addHome({ name: 'History', serverUrl: 'https://preset-approval.test',
      serverIdentityId: preset.homeId, accountId, credentials: { token } });
    const scope = { serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId };
    storage.setState({ profileScope: scope, settingsScope: scope });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    await harness.requireUiApproval(serverId, 'machines.presets.get');
    const authority = captureActiveServerAccountScopeLifetime();
    function Publication() {
      const commands = useCurrentUiContextComposedCommands();
      usePublishCurrentUiContext(React.useMemo(() => ({ commands }), [commands]));
      return null;
    }
    const surface = (visible: boolean) => <CurrentUiContextCommandsProvider authority={authority}>
      <Publication />{visible ? <MachinePresetView serverId={scope.serverId} presetId={preset.id} /> : null}
    </CurrentUiContextCommandsProvider>;
    const screen = await renderMountedCurrentUiContext(surface(true));
    try {
      const control = 'machine-preset.approval.action';
      await waitForHomeGovernance(() => expect(screen.findByTestId(control)).not.toBeNull());
      const [approval] = harness.artifacts(serverId).list();
      if (!approval) throw new Error('Expected the persisted preset read approval');
      const expectedRoute = buildApprovalHref(approval.id, scope.serverId);
      await screen.pressByTestIdAsync(control);
      expect(route.push.mock.calls).toEqual([[expectedRoute]]);
      const executor = createDefaultActionExecutor();
      const readCommands = async () => {
        const read = await executor.execute('ui.current_context.read', {}, { surface: 'agent' });
        if (!read.ok) throw new Error(`Expected current context, got ${read.errorCode}`);
        return CurrentUiContextSnapshotV1Schema.parse(read.result).commands;
      };
      const inventory = await readCommands();
      expect(inventory.map(command => command.title)).toEqual([t('approvals.details')]);
      const commandId = inventory[0]!.id;
      await act(async () => {
        expect(await executor.execute('ui.current_context.command.invoke', { commandId }, { surface: 'agent' })).toMatchObject({ ok: true });
      });
      expect(route.push.mock.calls).toEqual([[expectedRoute], [expectedRoute]]);
      await screen.update(surface(false));
      expect(screen.findByTestId(control)).toBeNull();
      expect(await readCommands()).toEqual([]);
      expect(await executor.execute('ui.current_context.command.invoke', { commandId }, { surface: 'agent' })).toMatchObject({ ok: false });
    } finally { await screen.unmount(); }
  });

  it('explains how to get the key for an authorized Team preset without offering a premature retry', async () => {
    const { createEncryptionFromAuthCredentials } = await import('@/auth/encryption/createEncryptionFromAuthCredentials');
    const { sealManagedMachinePresetContentV1 } = await import('@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
    const { computeContentPublicKeyFingerprint } = await import('@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint');
    const credentials = {
      token: createAccountTokenForTests('member', { currentAccount: true }),
      secret: encodeBase64(new Uint8Array(32).fill(39), 'base64url'),
    };
    const ownerEncryption = await createEncryptionFromAuthCredentials({
      token: createAccountTokenForTests('owner', { currentAccount: true }),
      secret: encodeBase64(new Uint8Array(32).fill(37), 'base64url'),
    });
    const contentPublicKey = ownerEncryption.contentDataKey;
    const serverId = await harness.addHome({
      name: 'History', serverUrl: 'https://history.example', serverIdentityId: preset.homeId,
      accountId: 'member', currentAccount: true, teamsEnabled: true, accountEncryptionMode: 'e2ee', credentials,
    });
    const sealed = sealManagedMachinePresetContentV1({
      presetId: preset.id, mode: 'e2ee', content: { v: 1, name: preset.name, launch: preset.launch },
      recipientCensus: [{
        account: { kind: 'account', accountId: 'owner', name: null, firstName: null, lastName: null, username: null, avatarUrl: null },
        readiness: { status: 'available', contentPublicKey: encodeBase64(contentPublicKey, 'base64'),
          contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentPublicKey) },
        envelopeStatus: 'missing',
      }],
      randomBytes: length => new Uint8Array(length).fill(23),
    });
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: { id: preset.id, homeId: preset.homeId, revision: preset.revision,
        owner: { kind: 'team', teamId: 'team' }, contentEncryptionMode: 'e2ee', controller: preset.controller, ...sealed } },
    });
    const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId={preset.id} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.read-state-reason')).not.toBeNull());
      // Waiting for a key is not a failure: no code and no Details disclosure.
      expect(screen.findAll(node => String(node.props?.testID ?? '').startsWith('machine-preset.read-state-diagnostic'))).toHaveLength(0);
      expect(screen.findByTestId('machine-preset.read-state-action')).toBeNull();
      expect(screen.tree.findAllByType(MachinePresetDetail)).toHaveLength(0);
    } finally { await screen.unmount(); }
  });

  it('headless preset preparation retains last reports without guessing an operation host and follows actual scoped pushes', async () => {
    const serverId = await seed();
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    const { useMachinePresetPreparation } = await import('./useMachinePresets');
    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    const { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } = await import('@happier-dev/protocol/machines/managed/machinePresetActionsV1');
    const opened = { ...createPlainManagedMachinePresetFixture({ ...preset, preparation: { enabled: true } }).opened,
      prepared: { operationId: 'previous-build', status: 'building' as const,
        binding: { machineId: 'prepare-host', cliIdentity: 'supplier-identity', credentialConfigurations: [], configuration: {
          launch: { provider: preset.launch.provider, schemaVersion: preset.launch.schemaVersion, choices: preset.launch.choices },
        } } } };
    const { ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
    const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
    const ownerAnswer = createDeferred<unknown>();
    boundary.rpc.mockImplementation(async request => request.method === ACTION_OPERATION_RPC_METHODS_V2.get
      ? ownerAnswer.promise : { kind: 'unsupported' });
    let displayed = opened;
    const onChanged = vi.fn();
    const hook = await renderHook(() => useMachinePresetPreparation({ serverId: scopeId, preset: displayed,
      machineId: 'next-builder', onChanged }));
    try {
      expect(hook.getCurrent().reportedStatus).toBe('building');
      expect(hook.getCurrent().estimates).toBeNull();
      expect(hook.getCurrent().readySummary).toBeNull();
      expect(hook.getCurrent().interrupted).toBe(false);
      expect(hook.getCurrent().awaitingOperation).toBe(true);
      expect(hook.getCurrent().operation).toBeNull();
      expect(hook.getCurrent().canCancel).toBe(false);
      expect(onChanged).not.toHaveBeenCalled();
      await waitForHomeGovernance(() => expect(boundary.rpc.mock.calls).toEqual([
        [expect.objectContaining({ serverId: scopeId, accountId: 'owner', machineId: 'prepare-host',
          method: ACTION_OPERATION_RPC_METHODS_V2.get, payload: { operationId: 'previous-build', waitForTerminal: true } })],
      ]));
      const snapshot = { version: 1 as const, operationId: 'previous-build', revision: 1,
        actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1, state: 'running' as const,
        scope: { accountId: 'owner', machineId: 'prepare-host' }, title: 'Prepare preset',
        createdAt: 1, startedAt: 2, cancellation: 'supported' as const,
        progress: { kind: 'phase' as const, phase: 'build-image', label: 'Build image', steps: [
          { id: 'prepare-inputs', label: 'Prepare build inputs', state: 'succeeded' as const, startedAt: 1, settledAt: 2 },
          { id: 'build-image', label: 'Build image', state: 'running' as const, startedAt: 2 },
          { id: 'save-image', label: 'Save prepared image', state: 'pending' as const },
        ] } };
      await act(async () => actionOperationStore.mergeSnapshots({ serverId: scopeId, snapshots: [snapshot] }));
      expect(hook.getCurrent().operation?.snapshot.scope.machineId).toBe('prepare-host');
      expect(hook.getCurrent().steps).toEqual(snapshot.progress.steps);
      await act(async () => actionOperationStore.mergeSnapshots({ serverId: scopeId,
        snapshots: [{ ...snapshot, revision: 2, progress: { kind: 'indeterminate', steps: snapshot.progress.steps } }] }));
      expect(hook.getCurrent().steps).toEqual(snapshot.progress.steps);
      expect(hook.getCurrent().interrupted).toBe(false);
      expect(hook.getCurrent().canCancel).toBe(true);
      await hook.rerender();
      expect(onChanged).not.toHaveBeenCalled();
      await act(async () => actionOperationStore.mergeSnapshots({ serverId: scopeId,
        snapshots: [{ ...snapshot, revision: 3, state: 'succeeded', settledAt: 3 }] }));
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(hook.getCurrent().canCancel).toBe(false);
      expect(hook.getCurrent().interrupted).toBe(true);
      await hook.rerender();
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(hook.getCurrent().reportedStatus).toBe('building');
      await act(async () => actionOperationStore.mergeSnapshots({ serverId: scopeId,
        snapshots: [{ ...snapshot, operationId: 'another-build', scope: { ...snapshot.scope, accountId: 'another-account' } }] }));
      displayed = { ...opened, prepared: { ...opened.prepared, operationId: 'another-build' } };
      await hook.rerender();
      expect(hook.getCurrent().operation).toBeNull();
      expect(hook.getCurrent().canCancel).toBe(false);
    } finally {
      await hook.unmount();
      ownerAnswer.resolve({ kind: 'not_found' });
      actionOperationStore.reset();
    }
  });
  it('reattaches a still-running preparation after reload from the persisted owner host', async () => {
    const serverId = await seed();
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    const { useMachinePresetPreparation } = await import('./useMachinePresets');
    const { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } = await import('@happier-dev/protocol/machines/managed/machinePresetActionsV1');
    const { ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
    const snapshot = { version: 1 as const, operationId: 'reload-build', revision: 4,
      actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1, state: 'running' as const,
      scope: { accountId: 'owner', machineId: 'actual-builder' }, title: 'Prepare preset',
      createdAt: 1, startedAt: 2, cancellation: 'supported' as const,
      progress: { kind: 'phase' as const, phase: 'build-image', label: 'Build prepared image', steps: [
        { id: 'prepare-inputs', label: 'Prepare build inputs', state: 'succeeded' as const },
        { id: 'build-image', label: 'Build prepared image', state: 'running' as const },
        { id: 'save-image', label: 'Save prepared image', state: 'pending' as const },
      ] } };
    const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
    const ownerAnswer = createDeferred<unknown>();
    boundary.rpc.mockImplementation(async request => request.method === ACTION_OPERATION_RPC_METHODS_V2.get
      ? ownerAnswer.promise : { kind: 'unsupported' });
    const opened = { ...createPlainManagedMachinePresetFixture({ ...preset, preparation: { enabled: true } }).opened,
      prepared: { operationId: snapshot.operationId, status: 'building' as const,
        binding: { cliIdentity: 'supplier-identity', machineId: snapshot.scope.machineId, credentialConfigurations: [], configuration: {
          launch: { provider: preset.launch.provider, schemaVersion: preset.launch.schemaVersion, choices: preset.launch.choices },
        } } } };
    const hook = await renderHook(() => useMachinePresetPreparation({ serverId: scopeId, preset: opened,
      machineId: 'stale-selection', onChanged: () => {} }));
    try {
      await waitForHomeGovernance(() => expect(boundary.rpc.mock.calls).toEqual(expect.arrayContaining([
        [expect.objectContaining({ serverId: scopeId, accountId: 'owner', machineId: snapshot.scope.machineId,
          method: ACTION_OPERATION_RPC_METHODS_V2.get, payload: { operationId: snapshot.operationId, waitForTerminal: true } })],
      ])));
      expect(hook.getCurrent().interrupted).toBe(false);
      expect(hook.getCurrent().awaitingOperation).toBe(true);
      expect(hook.getCurrent().canCancel).toBe(false);
      await act(async () => ownerAnswer.resolve({ kind: 'found', operation: snapshot }));
      await waitForHomeGovernance(() => expect(hook.getCurrent().operation?.snapshot.state).toBe('running'));
      expect(hook.getCurrent().interrupted).toBe(false);
      expect(hook.getCurrent().steps).toEqual(snapshot.progress.steps);
    } finally { await hook.unmount(); }
  });
  it('exposes prepared measurements and canonical configuration staleness without treating a rename as stale', async () => {
    const serverId = await seed();
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    const { ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
    const { useMachinePresetPreparation } = await import('./useMachinePresets');
    const opened = createPlainManagedMachinePresetFixture({ ...preset, preparation: { enabled: true } }).opened;
    const prepared = { operationId: 'measured-build', status: 'ready' as const, artifactSizeBytes: 1024, builtAt: 1700000000000, builtFromRevision: 7,
      artifact: { contributionRef: preset.launch.provider, schemaVersion: preset.launch.schemaVersion, value: { image: 'native-snapshot' } },
      binding: { machineId: 'prepare-host', cliIdentity: 'supplier-identity', credentialConfigurations: [], configuration: {
        launch: { provider: preset.launch.provider, schemaVersion: preset.launch.schemaVersion, choices: preset.launch.choices },
      } } };
    let measured = true;
    let launch = opened.launch;
    const hook = await renderHook(() => useMachinePresetPreparation({ serverId, preset: { ...opened, launch,
      prepared: measured ? prepared : (({ artifactSizeBytes: _size, builtAt: _time, builtFromRevision: _revision, ...unknown }) => unknown)(prepared) },
      machineId: null, onChanged: () => {} }));
    try {
      expect(hook.getCurrent().estimates).toEqual({ storageBytes: 1024, cost: { kind: 'unpriced', provider: null } });
      expect(hook.getCurrent().readySummary).toEqual({ builtAt: 1700000000000, builtFromRevision: 7, storageBytes: 1024, stale: false });
      measured = false;
      await hook.rerender();
      expect(hook.getCurrent().estimates).toEqual({ storageBytes: null, cost: { kind: 'unpriced', provider: null } });
      expect(hook.getCurrent().readySummary).toEqual({ builtAt: null, builtFromRevision: null, storageBytes: null, stale: false });
      launch = { ...opened.launch!, choices: { image: 'changed-image' } };
      await hook.rerender();
      expect(hook.getCurrent().readySummary?.stale).toBe(true);
      launch = { ...opened.launch!, name: 'Renamed launch' };
      await hook.rerender();
      expect(hook.getCurrent().readySummary?.stale).toBe(false);
      expect(boundary.rpc.mock.calls).toEqual([
        [expect.objectContaining({ serverId: scopeId, accountId: 'owner', machineId: 'prepare-host',
          method: ACTION_OPERATION_RPC_METHODS_V2.get, payload: { operationId: 'measured-build', waitForTerminal: true } })],
      ]);
    } finally { await hook.unmount(); }
  });
  it('headless preset preparation sends the displayed revision and retries through the same admitted Action', async () => {
    const serverId = await seed();
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    const { useMachinePresetPreparation } = await import('./useMachinePresets');
    const { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } = await import('@happier-dev/protocol/machines/managed/machinePresetActionsV1');
    const { ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
    const { ActionExecuteFailureSchema } = await import('@happier-dev/protocol/actions/actionExecutionResult');
    const { computeActionReviewDigestV1 } = await import('@happier-dev/protocol/actions/decisionAuthority');
    boundary.rpc.mockResolvedValue({ kind: 'not_found' });
    const inputs: unknown[] = [];
    // The remote daemon is the network boundary: like setup updates, its initial own-Account
    // UI request carries back a review, and the confirmed replay carries the private invocation.
    await answerExternalActionAccountForHome(harness, serverId, {
      actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1, machineId: 'selected-builder', installationId: 'builder-installation', tokenEpoch: 0,
      requesterInvocation: 'optional',
      failure: result => { const failure = ActionExecuteFailureSchema.safeParse(result); return failure.success ? failure.data : null; },
      execute: (input, context) => {
        const review = { actionArgs: input, preview: { summary: 'Build a prepared image for this preset' } };
        const reviewDigest = computeActionReviewDigestV1(MACHINE_PRESET_PREPARE_ACTION_ID_V1, review);
        if (context.invocation?.presentUserConfirmation?.reviewDigest !== reviewDigest) return {
          ok: false, errorCode: 'action_interactive_review_required', error: 'action_interactive_review_required',
          details: { review, reviewDigest },
        };
        inputs.push(input);
        return { status: 'accepted', operationId: 'new-build', machineId: 'admitted-builder' };
      },
    });
    const opened = createPlainManagedMachinePresetFixture({ ...preset, preparation: { enabled: true } }).opened;
    const onChanged = vi.fn();
    const hook = await renderHook((displayed: typeof opened) => useMachinePresetPreparation({ serverId: scopeId, preset: displayed,
      machineId: 'selected-builder', onChanged }), { initialProps: opened });
    const modalHost = await renderSettingsView(<ModalProvider />);
    const confirmPreparation = async (run: () => Promise<unknown>) => {
      let result: Promise<unknown> | undefined;
      await act(async () => { result = run(); });
      await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
      await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-approve');
      await act(async () => { await result; });
    };
    try {
      await confirmPreparation(hook.getCurrent().prepare);
      expect(hook.getCurrent().error).toBeNull();
      expect(inputs).toEqual([{ homeId: preset.homeId, id: preset.id, expectedRevision: preset.revision, machineId: 'selected-builder' }]);
      await waitForHomeGovernance(() => expect(boundary.rpc.mock.calls).toEqual(expect.arrayContaining([
        [expect.objectContaining({ serverId: scopeId, accountId: 'owner', machineId: 'admitted-builder', method: ACTION_OPERATION_RPC_METHODS_V2.get,
          payload: { operationId: 'new-build', waitForTerminal: true } })],
      ])));
      await hook.rerender({ ...opened, revision: opened.revision + 1 });
      await confirmPreparation(hook.getCurrent().retry);
      expect(inputs).toHaveLength(2);
      expect(inputs[1]).toEqual({ homeId: preset.homeId, id: preset.id, expectedRevision: preset.revision + 1, machineId: 'selected-builder' });
      expect(onChanged).toHaveBeenCalledTimes(2);
    } finally { await hook.unmount(); await modalHost.unmount(); }
  });
  it.each([false, true])('preset preparation shows Interrupted and Retry admits the current revision, while Stop uses the actual live builder (pool=%s)', async pooled => {
    const serverId = await seed(pooled);
    const scopeId = await seedConfiguration(serverId);
    const { replaceManagedMachinePresetPreparationV1 } = await import('@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
    const { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } = await import('@happier-dev/protocol/machines/managed/machinePresetActionsV1');
    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    const { ACTION_OPERATION_RPC_METHODS_V1, ACTION_OPERATION_RPC_METHODS_V2 } = await import('@happier-dev/protocol/actions/operations/v1');
    const stored = createPlainManagedMachinePresetFixture({ ...preset, preparation: { enabled: true },
      ...(pooled ? { controller: undefined, controllerPoolId: '00000000-0000-4000-8000-000000000001' } : {}) });
    const selected = pooled ? { machineId: 'picked-builder', installationId: 'picked-installation' } : preset.controller;
    if (pooled) await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, [
      createMachineFixture({ id: preset.controller.machineId, installationId: preset.controller.installationId, activeAt: Date.now() }),
      createMachineFixture({ id: selected.machineId, installationId: selected.installationId, activeAt: Date.now() }),
    ]);
    const prepared = { operationId: 'lost-builder-operation', status: 'building' as const,
      binding: { machineId: 'prepare-host', cliIdentity: 'supplier-identity', credentialConfigurations: [], configuration: {
        launch: { provider: preset.launch.provider, schemaVersion: preset.launch.schemaVersion, choices: preset.launch.choices },
      } } };
    const preparedContent = replaceManagedMachinePresetPreparationV1({ presetId: preset.id, mode: 'plain',
      content: stored.content, expectedOperationId: null, prepared });
    if (!preparedContent) throw new Error('Expected the operational preparation writer');
    let current = { ...stored, content: preparedContent.content };
    harness.answer(serverId, '/v1/machines/presets/get', { select: () => ({ body: { kind: 'found', preset: current } }) });
    harness.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'action.operations.cancel': ['ui'] } },
    } }, version: 1 } });
    const inputs: unknown[] = [];
    const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
    const previousOwnerAnswer = createDeferred<unknown>();
    const replacementOwnerAnswer = createDeferred<unknown>();
    await answerExternalActionAccountForHome(harness, serverId, {
      actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1, machineId: selected.machineId,
      installationId: selected.installationId, tokenEpoch: 0, requesterInvocation: 'optional',
      execute: input => {
        inputs.push(input);
        actionOperationStore.mergeSnapshots({ serverId: scopeId, snapshots: [{
          version: 1, operationId: 'replacement-build', revision: 1, actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1,
          state: 'running', scope: { accountId: 'owner', machineId: 'actual-image-builder' }, title: 'Prepare preset',
          createdAt: 1, cancellation: 'supported',
        }] });
        return { status: 'accepted', operationId: 'replacement-build', machineId: 'actual-image-builder' };
      },
    });
    boundary.rpc.mockImplementation(async request => {
      if (request.method === ACTION_OPERATION_RPC_METHODS_V1.cancel) return { kind: 'requested' };
      if (request.method !== ACTION_OPERATION_RPC_METHODS_V2.get) return { kind: 'unsupported' };
      return request.payload.operationId === prepared.operationId ? previousOwnerAnswer.promise : replacementOwnerAnswer.promise;
    });
    const restorePopoverGlobals = withPopoverWebGlobals();
    const screen = await renderSettingsView(<MachinePresetView serverId={scopeId} presetId={preset.id} />);
    try {
      await waitForHomeGovernance(() => expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({
        serverId: scopeId, accountId: 'owner', machineId: 'prepare-host', method: ACTION_OPERATION_RPC_METHODS_V2.get,
        payload: { operationId: prepared.operationId, waitForTerminal: true },
      })));
      expect(screen.getTextContent()).not.toContain(t('voiceAssistant.interrupted'));
      expect(screen.findByTestId('machine-preset.preparation.retry')).toBeNull();
      await act(async () => previousOwnerAnswer.resolve({ kind: 'not_found' }));
      await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('voiceAssistant.interrupted')));
      expect(inputs).toEqual([]);
      expect(screen.findByTestId('machine-preset.preparation.stop')).toBeNull();
      if (pooled) {
        await screen.pressByTestIdAsync('machine-preset.preparation.target.chip');
        await act(async () => reportPopoverContentLayout(screen.tree, { width: 400, height: 500 }));
        await screen.pressByTestIdAsync(`machine-preset.preparation.target.picker-option:${selected.machineId}`);
      }
      current = { ...current, revision: current.revision + 1 };
      const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
      await act(async () => publishHomeAccountChange(scopeId, [preset.id], { source: 'socket', changeKinds: ['account'] }));
      await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/get').length).toBe(2));
      await flushHookEffects();
      await screen.pressByTestIdAsync('machine-preset.preparation.retry');
      await waitForHomeGovernance(() => expect(inputs).toEqual([{ homeId: preset.homeId, id: preset.id,
        expectedRevision: preset.revision + 1, machineId: selected.machineId }]));
      await waitForHomeGovernance(() => expect(boundary.rpc).toHaveBeenCalledWith(expect.objectContaining({
        serverId: scopeId, accountId: 'owner', machineId: 'actual-image-builder', method: ACTION_OPERATION_RPC_METHODS_V2.get,
        payload: { operationId: 'replacement-build', waitForTerminal: true },
      })));
      await screen.pressByTestIdAsync('machine-preset.preparation.stop');
      await waitForHomeGovernance(() => expect(boundary.rpc.mock.calls).toEqual(expect.arrayContaining([
        [expect.objectContaining({ serverId: scopeId, machineId: 'actual-image-builder',
          method: ACTION_OPERATION_RPC_METHODS_V1.cancel, payload: { operationId: 'replacement-build' } })],
      ])));
      expect(inputs).toHaveLength(1);
      // The finite owner lost its live receipt after reporting the running build.
      await act(async () => replacementOwnerAnswer.resolve({ kind: 'not_found' }));
      await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(t('voiceAssistant.interrupted')));
      expect(screen.findByTestId('machine-preset.preparation.stop')).toBeNull();
      expect(screen.findByTestId('machine-preset.preparation.retry')).not.toBeNull();
      expect(inputs).toHaveLength(1);
      const status = pooled ? 'cancelled' : 'failed';
      const settled = replaceManagedMachinePresetPreparationV1({ presetId: preset.id, mode: 'plain', content: current.content,
        expectedOperationId: prepared.operationId, prepared: { ...prepared, status } });
      if (!settled) throw new Error('Expected the operational terminal report');
      current = { ...current, revision: current.revision + 1, content: settled.content };
      await act(async () => publishHomeAccountChange(scopeId, [preset.id], { source: 'socket', changeKinds: ['account'] }));
      await waitForHomeGovernance(() => {
        expect(screen.getTextContent()).toContain(t(status === 'failed'
          ? 'inbox.actionOperations.status.failed' : 'machinePresets.prepareNotBuilt'));
        expect(screen.findByTestId('machine-preset.preparation.retry')).not.toBeNull();
      });
      expect(inputs).toHaveLength(1);
      current = { ...current, archivedAt: 3 };
      await act(async () => publishHomeAccountChange(scopeId, [preset.id], { source: 'socket', changeKinds: ['account'] }));
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.archived')).not.toBeNull());
      expect(screen.findByTestId('machine-preset.preparation')).toBeNull();
      expect(inputs).toHaveLength(1);
    } finally {
      await screen.unmount();
      previousOwnerAnswer.resolve({ kind: 'not_found' });
      replacementOwnerAnswer.resolve({ kind: 'not_found' });
      actionOperationStore.reset();
      restorePopoverGlobals();
    }
  });
  it('offers the existing in-place Review when preset preparation Stop awaits approval and cancels its actual builder after confirmation', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    const { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } = await import('@happier-dev/protocol/machines/managed/machinePresetActionsV1');
    const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
    const { replaceManagedMachinePresetPreparationV1 } = await import('@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
    const stored = createPlainManagedMachinePresetFixture({ ...preset, preparation: { enabled: true } });
    const prepared = { operationId: 'approval-build', status: 'building' as const,
      binding: { machineId: 'actual-image-builder', cliIdentity: 'supplier-identity', credentialConfigurations: [], configuration: {
        launch: { provider: preset.launch.provider, schemaVersion: preset.launch.schemaVersion, choices: preset.launch.choices },
      } } };
    const operational = replaceManagedMachinePresetPreparationV1({ presetId: preset.id, mode: 'plain',
      content: stored.content, expectedOperationId: null, prepared });
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: {
      ...stored, content: operational.content,
    } } });
    await harness.requireUiApproval(serverId, 'action.operations.cancel');
    actionOperationStore.mergeSnapshots({ serverId: scopeId, snapshots: [{
      version: 1, operationId: prepared.operationId, revision: 1, actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1,
      state: 'running', scope: { accountId: 'owner', machineId: 'actual-image-builder' }, title: 'Prepare preset',
      createdAt: 1, cancellation: 'supported',
    }] });
    const modalHost = await renderSettingsView(<ModalProvider />);
    const screen = await renderSettingsView(<MachinePresetView serverId={scopeId} presetId={preset.id} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.preparation.stop')).not.toBeNull());
      await screen.pressByTestIdAsync('machine-preset.preparation.stop');
      await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
      const { ACTION_OPERATION_RPC_METHODS_V1 } = await import('@happier-dev/protocol/actions/operations/v1');
      expect(boundary.rpc.mock.calls.filter(([request]) => request.method === ACTION_OPERATION_RPC_METHODS_V1.cancel)).toEqual([]);
      boundary.rpc.mockResolvedValue({ kind: 'requested' });
      await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-approve');
      await waitForHomeGovernance(() => expect(boundary.rpc.mock.calls.filter(([request]) => request.method === ACTION_OPERATION_RPC_METHODS_V1.cancel))
        .toEqual([[expect.objectContaining({ serverId: scopeId, machineId: 'actual-image-builder',
          payload: { operationId: prepared.operationId } })]]));
      expect(harness.artifacts(serverId).list()).toEqual([]);
      expect(route.push).not.toHaveBeenCalled();
    } finally { await screen.unmount(); await modalHost.unmount(); actionOperationStore.reset(); }
  });
  it('keeps selected preset reads quiet for unrelated Machine pushes and refreshes relevant changes and recovery', async () => {
    const serverId = await seed();
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    const { useMachinePresetDetail } = await import('./useMachinePresets');
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const hook = await renderHook(() => useMachinePresetDetail(scopeId, preset.id));
    const reads = () => [
      harness.requestsFor('/v1/machines/presets/get').length,
      harness.requestsFor('/v1/machines/managed/actions/list').length,
    ];
    try {
      await waitForHomeGovernance(() => expect(hook.getCurrent().state.value?.preset.id).toBe(preset.id));
      expect(reads()).toEqual([1, 2]);
      const retained = hook.getCurrent().state.value;
      for (const machineId of ['other-controller', 'other-guest', 'another-machine']) {
        await act(async () => publishHomeAccountChange(scopeId, [machineId], {
          source: 'socket', changeKinds: ['machine'],
        }));
        await flushHookEffects();
      }
      expect(reads()).toEqual([1, 2]);
      expect(hook.getCurrent().state.value).toBe(retained);

      const changed = { ...preset, revision: preset.revision + 1, name: 'Updated preset' } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
      harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(changed) } });
      await act(async () => publishHomeAccountChange(scopeId, [preset.controller.machineId], {
        source: 'socket', changeKinds: ['machine'],
      }));
      await waitForHomeGovernance(() => expect(hook.getCurrent().state.value?.preset.name).toBe(changed.name));
      expect(reads()).toEqual([2, 4]);

      // Preset writes use Account changes; missing hints and snapshot repair remain conservative.
      for (const event of [
        { entityIds: [preset.id], details: { source: 'socket', changeKinds: ['account'] } },
        { entityIds: ['unknown-machine'], details: { source: 'socket' } },
        { entityIds: [], details: { source: 'socket', changeKinds: ['machine'] } },
        { entityIds: ['other-controller'], details: { source: 'snapshot', changeKinds: ['machine'] } },
        { entityIds: ['other-controller'], details: { source: 'socket', changeKinds: ['machine', 'account'] } },
      ] as const) {
        const previous = reads();
        await act(async () => publishHomeAccountChange(scopeId, event.entityIds, event.details));
        await waitForHomeGovernance(() => expect(reads()).toEqual([previous[0]! + 1, previous[1]! + 2]));
      }
    } finally { await hook.unmount(); }
  });

  it('settles a pending managed birth read as a typed cancellation when its Account changes', async () => {
    const serverId = await seed();
    const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
    await setServerProfileIdentityForUrl('https://history.example', preset.homeId);
    const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
    await setActiveServer({ serverId });
    await harness.setActionPolicy(serverId, 'machines.managed.birth.get', 'ui', 'allowed');
    const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
    const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
    const { readManagedCreationScopeBirthSource } = await import('@/sync/ops/actions/managedCreationScopeBinding');
    const response = createDeferred<void>();
    harness.answer(serverId, 'POST /v1/machines/managed/actions/birth.get', {
      body: { source: null }, respondAfter: response.promise,
    });
    const scope = await renderHook(() => useServerCredentialAccountScopeBinding(serverId));
    let retirement: Readonly<{ dispose(): void }> | undefined;
    try {
      await waitForHomeGovernance(() => expect(scope.getCurrent().binding?.accountId).toBe('owner'));
      const binding = scope.getCurrent().binding!;
      const controller = new AbortController();
      retirement = binding.onRetire(() => controller.abort());
      const rejected = vi.fn();
      const settlement = readManagedCreationScopeBirthSource({ machine: { homeId: preset.homeId, id: resource.id },
        accountLifetime: binding, signal: controller.signal }).catch(rejected);
      await waitForHomeGovernance(() => {
        expect(rejected.mock.calls).toEqual([]);
        expect(harness.requestsFor('/v1/machines/managed/actions/birth.get')).toHaveLength(1);
      });
      await act(async () => { await harness.switchAccount(serverId, 'other-owner'); });
      await flushHookEffects();
      expect(binding.isCurrent()).toBe(false);
      expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ code: 'action_account_scope_changed' }));
      await settlement;
    } finally {
      response.resolve();
      retirement?.dispose();
      await scope.unmount();
    }
  });

  it('opens a setup-only Preset without creation provider, credential or native reads', async () => {
    const serverId = await seed();
    // A real controller and provider exist on this Home, but this Preset does
    // not attach either. Availability must not create demand on their behalf.
    await seedConfiguration(serverId);
    const setupOnly = createPlainManagedMachinePresetFixture({
      id: preset.id, homeId: preset.homeId, revision: 4,
      name: 'Retained build setup', owner: preset.owner,
      setup: { scripts: [{ body: '\r\necho retained setup\r\n', affects: 'none' }] },
    });
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: setupOnly },
    });
    harness.answer(serverId, '/v1/machines/managed/actions/list', {
      body: { machines: [] },
    });
    const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId={setupOnly.id} />);
    try {
      await waitForHomeGovernance(() => expect(screen.tree.findByType(MachinePresetDetail).props.model.name)
        .toBe(setupOnly.opened.name));
      await flushHookEffects({ cycles: 30 });
      expect(screen.findByTestId('machine-preset.read-state')).toBeNull();
      expect(screen.tree.findByType(MachinePresetDetail).props.model.onCreateOne).toBeUndefined();
      expect(harness.requests.filter(request => request.path.includes('machines.provisioners.'))).toEqual([]);
      expect(harness.requests.filter(request => /\/(?:connect|connected-services|account\/profile)(?:\/|$)/.test(request.path))).toEqual([]);
      expect(boundary.rpc).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
  });

  it('holds the preset page itself while its first read runs, then lands the preset in place', async () => {
    const serverId = await seed();
    await seedConfiguration(serverId);
    const setupOnly = createPlainManagedMachinePresetFixture({
      id: preset.id, homeId: preset.homeId, revision: 4,
      name: 'Retained build setup', owner: preset.owner,
      setup: { scripts: [{ body: 'echo held\n', affects: 'none' }] },
    });
    const { createDeferred } = await import('@/dev/testkit/hooks/createDeferred');
    const read = createDeferred<void>();
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: setupOnly }, respondAfter: read.promise });
    harness.answer(serverId, '/v1/machines/managed/actions/list', { body: { machines: [] } });
    const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId={setupOnly.id} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.loading')).not.toBeNull());
      // The preset's own header holds its place, not a generic "Machine presets" page that the preset then replaces.
      expect(screen.findByTestId('machine-preset.detail.header-held')).not.toBeNull();
      expect(screen.findByTestId('machine-preset.read-state')).toBeNull();
      read.resolve();
      await waitForHomeGovernance(() => expect(screen.tree.findByType(MachinePresetDetail).props.model.name)
        .toBe(setupOnly.opened.name));
      expect(screen.findByTestId('machine-preset.loading')).toBeNull();
      expect(screen.findByTestId('machine-preset.detail.header-held')).toBeNull();
    } finally { read.resolve(); await screen.unmount(); }
  });

  it('opens a setup-only Preset editor without making controller readiness a dependency of its Preset read', async () => {
    const serverId = await seed();
    await seedConfiguration(serverId);
    const setupOnly = createPlainManagedMachinePresetFixture({
      id: preset.id, homeId: preset.homeId, revision: 4,
      name: 'Retained editor setup', owner: preset.owner,
      setup: { scripts: [{ body: '\r\necho exact editor setup\r\n', affects: 'none' }] },
    });
    let presetReadAnswered = false;
    harness.answer(serverId, '/v1/machines/presets/get', { select: () => {
      presetReadAnswered = true;
      return { body: { kind: 'found', preset: setupOnly } };
    } });
    const screen = await renderSettingsView(<ManagedMachineConfigurationView serverId={serverId}
      provisioner={buildQualifiedPluginContributionKey(preset.launch.provider)}
      presetId={setupOnly.id} presetOnly initialController={preset.controller} />);
    try {
      await waitForHomeGovernance(() => expect(presetReadAnswered).toBe(true));
      await flushHookEffects({ cycles: 30 });
      expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(1);
      expect(screen.findByTestId('managed-config.error')).toBeNull();
      expect(harness.requests.filter(request => request.path.includes('machines.provisioners.'))).toEqual([]);
      expect(harness.requests.filter(request => /\/(?:connect|connected-services|account\/profile)(?:\/|$)/.test(request.path))).toEqual([]);
      expect(boundary.rpc).not.toHaveBeenCalled();
      expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
      expect(harness.requestsFor('/v1/machines/presets/create')).toEqual([]);
    } finally { await screen.unmount(); }
  });

  it.each([
    ['bundled-local', { pluginId: 'happier.machine.cua', localId: 'local-sandbox' }, 'Cua', 'local'],
    ['bundled-cloud', { pluginId: 'happier.machine.cua', localId: 'byoc' }, 'Cua BYOC', 'cloud'],
    ['unavailable', preset.launch.provider, null, 'unknown'],
  ] as const)('attributes an archived preset receipt to its real service or leaves it unnamed (%s)', async (_kind, provider, title, billing) => {
    const serverId = await seed();
    const archived = { ...preset, archivedAt: 1, launch: { ...preset.launch, provider } } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(archived) } });
    const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId={preset.id} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.archived.action')).not.toBeNull());
    const receipt = screen.tree.findByType(MachineConfigurationReceipt).props.model;
    expect(receipt.spec).toBe(title ?? '');
    expect(receipt.cost).toEqual(billing === 'local'
      // A sentence never says "Runs on Unknown" (VD G2): an unnamed controller is the managing computer.
      ? { kind: 'local', computer: t('managedMachines.receipt.managingComputer'), meters: [],
          note: t('managedMachines.receipt.headroomUnknown', { computer: t('managedMachines.receipt.managingComputer') }) }
      : { kind: 'unpriced', provider: title });
    await screen.unmount();
  });

  it('keeps every billing warning off a preset that runs on its controller and bills nobody', async () => {
    const serverId = await seed();
    const local = { ...preset, preparation: { enabled: true },
      launch: { ...preset.launch, provider: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' } } } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(local) } });
    const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId={preset.id} />);
    await waitForHomeGovernance(() => expect(screen.tree.findByType(MachineConfigurationReceipt).props.model.cost?.kind).toBe('local'));
    expect(screen.getTextContent()).not.toContain(t('machinePresets.limitHelp'));
    // The receipt says No bill, so Prepare ahead keeps its reason and drops the provider charge (L12 review 2, A-1).
    expect(screen.findByTestId('machine-preset.prepare.keep')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain(t('machinePresets.prepareSectionHelp'));
    await screen.unmount();
  });

  it('opens an unqualified managed preset route in the current Home and carries that scope into history', async () => {
    const serverId = await seed();
    const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
    await setActiveServer({ serverId });
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    route.params = { presetId: 'preset' };
    const screen = await renderSettingsView(<MachinePresetScreen />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.detail.machine.resource')).not.toBeNull());
    expect(harness.requestsFor('/v1/machines/presets/get').every(request => request.serverId === serverId)).toBe(true);
    await act(async () => screen.pressByTestId('machine-preset.detail.machine.resource'));
    expect(route.push).toHaveBeenLastCalledWith(`/settings/machines/managed/resource?serverId=${encodeURIComponent(scopeId)}`);
  });

  it('opens an unqualified managed resource route in the current Home', async () => {
    const serverId = await seed();
    const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
    await setActiveServer({ serverId });
    route.params = { id: 'resource' };
    harness.answer(serverId, '/v1/machines/managed/actions/get', { body: { ...resource, enrolledMachineId: undefined } });
    const screen = await renderSettingsView(<ManagedMachineDetailScreen />);
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('Original guest'));
    expect(harness.requestsFor('/v1/machines/managed/actions/get')).toHaveLength(1);
  });

  it.each(['detail', 'editor', 'use'] as const)('reads no private creation data for an unknown Preset (%s)', async surface => {
    const serverId = await seed();
    await seedConfiguration(serverId);
    harness.answer(serverId, '/v1/machines/presets/get', {
      status: 404, body: { kind: 'refused', code: 'preset_not_found' },
    });
    const screen = await renderSettingsView(surface === 'detail'
      ? <MachinePresetView serverId={serverId} presetId="missing-preset" />
      : <ManagedMachineConfigurationView serverId={serverId} presetId="missing-preset"
          provisioner={buildQualifiedPluginContributionKey(preset.launch.provider)}
          presetOnly={surface === 'editor'} onUse={surface === 'use' ? vi.fn() : undefined} />);
    try {
      await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(1));
      await flushHookEffects({ cycles: 30 });
      expect(harness.requests.filter(request => request.path.includes('machines.provisioners.'))).toEqual([]);
      expect(boundary.rpc).not.toHaveBeenCalled();
      if (surface === 'detail') {
        expect(screen.getTextContent()).toContain(t('machinePresets.accessLost'));
        expect(screen.findByTestId('machine-preset.read-state-action')).toBeNull();
      }
      if (surface === 'use') {
        expect(screen.findByTestId('managed-config.error')).toBeTruthy();
        expect(screen.findByTestId('managed-config.use')).toBeNull();
      }
    } finally { await screen.unmount(); }
  });

  it('keeps an explicit unknown managed preset Home from falling through to the current Home', async () => {
    await seed();
    route.params = { presetId: preset.id, serverId: ['missing-home'] };
    const screen = await renderSettingsView(<MachinePresetScreen />);
    await flushHookEffects({ cycles: 3 });
    // The same refusal the cold link gets: the Home is not saved here, so there is nothing to read again.
    expect(screen.findByTestId('managed-route-unknown-home')).not.toBeNull();
    expect(screen.findByTestId('machine-preset.read-state')).toBeNull();
    expect(screen.findByTestId('machine-preset.detail')).toBeNull();
    expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(0);
  });

  it('refuses an explicit unknown Home on the configuration route the same way', async () => {
    await seed();
    route.params = { presetId: preset.id, provisioner: buildQualifiedPluginContributionKey(preset.launch.provider), presetOnly: 'true', serverId: 'missing-home' };
    const screen = await renderSettingsView(<ManagedMachineConfigurationScreen />);
    await flushHookEffects({ cycles: 3 });
    expect(screen.findByTestId('managed-route-unknown-home')).not.toBeNull();
    expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(0);
  });

  it('opens an unqualified managed preset configuration route in the current Home', async () => {
    const serverId = await seed();
    await seedConfiguration(serverId);
    const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
    await setActiveServer({ serverId });
    route.params = { presetId: preset.id, provisioner: buildQualifiedPluginContributionKey(preset.launch.provider), presetOnly: 'true' };
    const screen = await renderSettingsView(<ManagedMachineConfigurationScreen />);
    await editPresetCpu(screen);
    expect(harness.requestsFor('/v1/machines/presets/get').every(request => request.serverId === serverId)).toBe(true);
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(0);
  });

  it('updates Team spending opt-in through the revisioned detail Action and preserves a Manage refusal', async () => {
    const serverId = await seed();
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    const teamPreset = {
      ...preset,
      owner: { kind: 'team', teamId: 'team-1' } as const,
      teamAcquireDelegated: false,
    } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(teamPreset) },
    });
    await harness.requireUiApproval(serverId, 'machines.presets.update');
    const { useMachinePresetDetail } = await import('./useMachinePresets');
    const modalHost = await renderSettingsView(<ModalProvider />);
    const hook = await renderHook(() => useMachinePresetDetail(scopeId, preset.id));
    await waitForHomeGovernance(() =>
      expect(hook.getCurrent().state.value?.preset.id).toBe(preset.id),
    );
    try {
      await act(async () => {
        void hook.getCurrent().update({ teamAcquireDelegated: true });
      });
      await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
      expect(harness.artifacts(serverId).list()).toEqual([]);
      expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(
        0,
      );
      const delegated = {
        ...teamPreset,
        revision: preset.revision + 1,
        teamAcquireDelegated: true,
      } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
      harness.answer(serverId, '/v1/machines/presets/update', {
        body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(delegated) },
      });
      harness.answer(serverId, '/v1/machines/presets/get', {
        body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(delegated) },
      });
      await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-approve');
      await waitForHomeGovernance(() =>
        expect(hook.getCurrent().state.value?.preset.teamAcquireDelegated).toBe(
          true,
        ),
      );
      await act(async () => {
        void hook.getCurrent().update({ teamAcquireDelegated: false });
      });
      await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
      expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1);
      harness.answer(serverId, '/v1/machines/presets/update', {
        status: 403,
        body: { kind: 'refused', code: 'permission_denied' },
      });
      await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-approve');
      await waitForHomeGovernance(() =>
        expect(hook.getCurrent().mutationResult).toEqual({
          kind: 'refused',
          code: 'permission_denied',
        }),
      );
      expect(
        harness
          .requestsFor('/v1/machines/presets/update')
          .map((request) => request.input),
      ).toEqual([
        {
          homeId: preset.homeId,
          id: preset.id,
          expectedRevision: preset.revision,
          patch: { teamAcquireDelegated: true },
        },
        {
          homeId: preset.homeId,
          id: preset.id,
          expectedRevision: delegated.revision,
          patch: { teamAcquireDelegated: false },
        },
      ]);
    } finally {
      await hook.unmount();
      await modalHost.unmount();
    }
  });
  it.each([
    ['fixed', 'https://cloud-images.ubuntu.com/releases/resolute/release-20260927/ubuntu-26.04-server-cloudimg-amd64.img'],
    ['failing', 'template:fixture-missing-g1-options-1111'],
  ] as const)('keeps saved Lima launch facts in the receipt before and after a typed use failure (%s)', async (_kind, image) => {
    const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
    const { Modal, ModalProvider } = await import('@/modal');
    try {
      const serverId = await seed(true, true);
      const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
      const { LIMA_PLUGIN } = await import('../../../../../../../packages/plugins/machine-lima/src/manifest');
      await seedAccountProvisioner(serverId, LIMA_PLUGIN.manifest);
      const { BUNDLED_MACHINE_PROVISIONER_DECLARATIONS } = await import('@/agents/registry/generatedBundledPluginEntries');
      const lima = BUNDLED_MACHINE_PROVISIONER_DECLARATIONS['happier.machine.lima/lima'];
      if (!lima) throw new Error('Expected the bundled Lima declaration');
      const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
      const manifest = PluginPortableReleaseManifestV1Schema.parse(LIMA_PLUGIN.manifest);
      const optionsHints = manifest.contributes.actions.find(action => action.id === lima.descriptor.actions.options)?.inputHints;
      const declaredTitle = (path: string) => {
        const title = optionsHints?.fields.find(field => field.path === path)?.title;
        if (typeof title !== 'string') throw new Error(`Expected Lima's authored title for ${path}`);
        return title;
      };
      const choices = { arch: 'x86_64', cpus: 4, image, store: '/home/happier/.lima', mounts: [], vmType: 'qemu', diskGiB: 100, memoryGiB: 4 };
      const saved = createDelegatedManagedPresetFixture({
        preset: { ...preset, owner: { kind: 'team', teamId: 'team-1' }, controllerDisplayName: undefined,
          launch: { ...preset.launch, provider: lima.contribution, choices } },
        descriptor: lima.descriptor, custodianAccountId: 'other-account',
        installationPublicKey: encodeBase64(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).publicKey, 'base64url'),
      });
      await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, []);
      harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: saved } });
      harness.answer(serverId, '/v1/machines/presets/resolve-acquire', {
        body: { kind: 'resolved', controller: preset.controller, controllerAccess: saved.opened.controllerAccess },
      });
      const { bindHomeDomainActionHttpRequestV1 } = await import('@happier-dev/protocol/actions/homeDomainActionFamily');
      const teamRequest = bindHomeDomainActionHttpRequestV1('teams.get', { v: 1, teamId: 'team-1' });
      harness.answer(serverId, teamRequest.path, { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageSettings: false }) }) });
      harness.answer(serverId, '/v1/actions/machines.managed.acquire/execution-authorization', {
        select: value => {
          const issued = ExternalActionExecutionAuthorizationRequestV1Schema.parse(value);
          const envelope = ExternalActionRequestEnvelopeSchema.parse(issued.envelope);
          return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-signed-saved-lima', binding: {
            serverIdentityId: preset.homeId, accountId: 'owner', authentication: { kind: 'account', tokenEpoch: 0 },
            machineId: preset.controller.machineId, installationId: preset.controller.installationId, custodianAccountId: 'other-account',
            accountEncryptionMode: 'plain', actionId: 'machines.managed.acquire', requestId: envelope.requestId,
            target: envelope.target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
          } }) };
        },
      });
      let acquireRequestId: string | undefined;
      harness.answer(serverId, '/v1/actions/machines.managed.acquire', {
        select: value => {
          if (!value || typeof value !== 'object' || !('envelope' in value)) throw new Error('Expected signed preset use');
          const envelope = ExternalActionRequestEnvelopeSchema.parse(value.envelope);
          acquireRequestId = envelope.requestId;
          return { body: { v: 1, actionId: 'machines.managed.acquire', requestId: envelope.requestId,
            execution: { ok: false, errorCode: 'provider_unavailable', error: 'Native option unavailable',
              details: { kind: 'managedNative', nativeCause: { httpStatusClass: '4xx', code: 'not_found' } } } } };
        },
      });
      const screen = await renderSettingsView(<ManagedMachineConfigurationView serverId={scopeId}
        provisioner={buildQualifiedPluginContributionKey(lima.contribution)} presetId={preset.id} />,
      { wrapper: ({ children }) => <ModalProvider>{children}</ModalProvider> });
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
      expect(screen.findByTestId('managed-config.unavailable')).toBeNull();
      await waitForHomeGovernance(() => expect(screen.tree.findAllByType(MachineConfigurationReceipt)).toHaveLength(1));
      const expectSavedSummary = (rendered = screen) => {
        const receipt = rendered.tree.findByType(MachineConfigurationReceipt).props.model;
        expect(receipt.facts).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'saved:image', label: declaredTitle('image'), value: image }),
          expect.objectContaining({ id: 'saved:store', label: declaredTitle('store'), value: choices.store }),
          expect.objectContaining({ id: 'saved:arch', label: declaredTitle('arch') }),
          expect.objectContaining({ id: 'saved:vmType', label: declaredTitle('vmType') }),
        ]));
        // The declared size roles are the spec line, never repeated as rows (SWEEP-S0VD-164).
        expect(receipt.spec).toBe([t('managedMachines.receipt.cores', { count: 4 }), formatManagedSizeBytes(4 * 1024 ** 3),
          formatManagedSizeBytes(100 * 1024 ** 3)].map(part => part.replace(/ /g, '\u00a0')).join(' · '));
        expect(receipt.facts.filter((fact: { id: string }) => ['saved:cpus', 'saved:memoryGiB', 'saved:diskGiB'].includes(fact.id))).toEqual([]);
        expect(rendered.getTextContent()).toContain(image);
        expect(rendered.getTextContent()).toContain(choices.store);
        expect(receipt.cost?.kind).toBe('local');
      };
      expectSavedSummary();
      await act(async () => screen.pressByTestId('managed-config.create'));
      await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'managed-config.error'
        && node.props.diagnosticCode === 'provider_unavailable'
        && node.props.diagnosticDetail?.includes('not_found')
        && node.props.diagnosticDetail?.includes(acquireRequestId)).length).toBeGreaterThan(0));
      expectSavedSummary();
      await screen.unmount();
      // The saved preset detail consumes the same receipt projection without acquiring native metadata.
      if (_kind === 'fixed') {
        const detail = await renderSettingsView(<MachinePresetView serverId={scopeId} presetId={preset.id} />);
        await waitForHomeGovernance(() => expect(detail.tree.findAllByType(MachineConfigurationReceipt)).toHaveLength(1));
        expectSavedSummary(detail);
        expect(detail.findByTestId('machine-preset.configuration-unavailable')).toBeNull();
        await detail.unmount();
      }
      expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toHaveLength(1);
      expect(harness.requests.filter(row => row.path.includes('/actions/machines.provisioners.'))).toHaveLength(0);
      expect(boundary.rpc.mock.calls.filter(([row]) => row.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
        || row.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ)).toHaveLength(0);
    } finally {
      await act(async () => Modal.hideAll());
      viewport.mockRestore();
    }
  });
  it.each([['use', undefined, 'exact'], ['create', 'Company builder', 'exact'], ['use', undefined, 'pool']] as const)(
    'admits sealed delegated preset without controller inventory or private probes (%s, %s, %s)',
    async (intent, controllerDisplayName, target) => {
      const serverId = await seed();
      const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
      await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, []);
      const delegatedReady = createDelegatedManagedPresetFixture({
        preset: {
          ...preset,
          owner: { kind: 'team', teamId: 'team-1' },
          controllerDisplayName,
          retention: { kind: 'unused', afterMs: 60_000, effect: 'delete' },
          wakeOnAcceptedMessage: false,
        },
        descriptor: {
          ...provisioner.descriptor,
          enrollmentRole: 'sandbox',
          retention: { supportedIntents: ['start', 'stop', 'delete'] },
          actions: { ...provisioner.descriptor.actions, power: 'power' },
        },
        custodianAccountId: 'company',
        installationPublicKey: encodeBase64(
          tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)).publicKey,
          'base64url',
        ),
      });
      const delegated = target === 'pool'
        ? ManagedMachinePresetV1Schema.parse({ ...delegatedReady, controller: undefined, controllerPoolId: '6be84651-2df7-4125-aac4-0d093217b198' })
        : delegatedReady;
      harness.answer(serverId, '/v1/machines/presets/get', {
        body: { kind: 'found', preset: delegated },
      });
      harness.answer(serverId, '/v1/machines/presets/resolve-acquire', {
        body: { kind: 'resolved', controller: preset.controller, controllerAccess: delegatedReady.opened.controllerAccess },
      });
      const { bindHomeDomainActionHttpRequestV1 } =
        await import('@happier-dev/protocol/actions/homeDomainActionFamily');
      const request = bindHomeDomainActionHttpRequestV1('teams.get', {
        v: 1,
        teamId: 'team-1',
      });
      harness.answer(serverId, request.path, {
        body: teamSummaryFixture({
          capabilities: teamCapabilitiesFixture({ manageSettings: false }),
        }),
      });
      harness.answer(
        serverId,
        '/v1/actions/machines.managed.acquire/execution-authorization',
        {
          select: (value) => {
            const issued =
              ExternalActionExecutionAuthorizationRequestV1Schema.parse(value);
            const envelope = ExternalActionRequestEnvelopeSchema.parse(
              issued.envelope,
            );
            return {
              body: ExternalActionExecutionAuthorizationV1Schema.parse({
                v: 1,
                token: 'home-signed-delegated-root',
                binding: {
                  serverIdentityId: preset.homeId,
                  accountId: 'owner',
                  authentication: { kind: 'account', tokenEpoch: 0 },
                  machineId: preset.controller.machineId,
                  installationId: preset.controller.installationId,
                  custodianAccountId: 'company',
                  accountEncryptionMode: 'plain',
                  actionId: 'machines.managed.acquire',
                  requestId: envelope.requestId,
                  target: envelope.target,
                  requestEnvelopeDigest:
                    computeExternalActionRequestEnvelopeDigestV1(envelope),
                },
              }),
            };
          },
        },
      );
      harness.answer(serverId, '/v1/actions/machines.managed.acquire', {
        select: (value) => {
          if (!value || typeof value !== 'object' || !('envelope' in value))
            throw new Error('Expected signed delegated Action');
          const envelope = ExternalActionRequestEnvelopeSchema.parse(
            value.envelope,
          );
          if (envelope.v !== 1)
            throw new Error('Expected the fixture plain Account envelope');
          expect(envelope.input).toMatchObject({
            selection: {
              kind: 'preset',
              homeId: preset.homeId,
              id: preset.id,
              revision: preset.revision,
            },
            retention: delegated.retention,
            wakeOnAcceptedMessage: false,
            presetContentOverride: expect.any(Object),
          });
          return {
            body: {
              v: 1,
              actionId: 'machines.managed.acquire',
              requestId: envelope.requestId,
              execution: {
                ok: true,
                result: { managedId: 'delegated-created' },
              },
            },
          };
        },
      });
      const onUse = vi.fn();
      const screen = await renderSettingsView(
        <ManagedMachineConfigurationView
          serverId={scopeId}
          provisioner={buildQualifiedPluginContributionKey(
            preset.launch.provider,
          )}
          presetId={preset.id}
          onUse={intent === 'use' ? onUse : undefined}
        />,
      );
      const actionTestId =
        intent === 'use' ? 'managed-config.use' : 'managed-config.create';
      await waitForHomeGovernance(() =>
        expect(screen.findByTestId(actionTestId)?.props.disabled).toBe(false),
      );
      expect(screen.tree.findByType(MachineConfigurationReceipt).props.model.facts).toContainEqual(
        expect.objectContaining({ id: 'controller', value: target === 'pool' ? expect.any(String) : controllerDisplayName ?? t('managedMachines.receipt.managingComputer') }),
      );
      await act(async () => screen.pressByTestId(actionTestId));
      if (intent === 'use')
        expect(onUse).toHaveBeenCalledWith(
          expect.objectContaining({
            selection: expect.objectContaining({
              kind: 'preset',
              homeId: preset.homeId,
              id: preset.id,
              revision: preset.revision,
            }),
            deferredAuthorPreset: true,
            presetContentOverride: expect.any(Object),
          }),
        );
      else
        await waitForHomeGovernance(() =>
          expect(route.replace, JSON.stringify({ errors: screen.tree.findAll(node => node.props.testID === 'managed-config.error').map(node => ({ code: node.props.diagnosticCode, detail: node.props.diagnosticDetail })), paths: harness.requests.map(row => row.path) })).toHaveBeenCalledWith(
            `/settings/machines/managed/delegated-created?serverId=${encodeURIComponent(scopeId)}`,
          ),
        );
      expect(harness.requestsFor('/v1/machines/presets/resolve-acquire')).toHaveLength(intent === 'create' ? 1 : 0);
      expect(harness.requestsFor('/v1/machines/read-batch')).toHaveLength(0);
      expect(
        harness.requests.filter((row) =>
          row.path.includes('/actions/machines.provisioners.'),
        ),
      ).toHaveLength(0);
      expect(
        boundary.rpc.mock.calls.filter(
          ([row]) =>
            row.method ===
              RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE ||
            row.method === RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ,
        ),
      ).toHaveLength(0);
      expect(
        screen.tree.findAll(
          (node) =>
            typeof node.props.testID === 'string' &&
            (node.props.testID.startsWith('managed-config.credential:') ||
              node.props.testID.startsWith('managed-config.connect:')),
        ),
      ).toHaveLength(0);
      await screen.unmount();
    },
  );
  it.each(['check', 'options'] as const)(
    'keeps a native %s refusal diagnostic on the saved launch',
    async (role) => {
      const serverId = await seed();
      const scopeId = await seedConfiguration(serverId);
      await answerExternalActionAccountForHome(harness, serverId, {
        actionId: `machines.provisioners.${role}`, machineId: preset.controller.machineId,
        installationId: preset.controller.installationId, tokenEpoch: 0,
        execute: () => {
          const nativeCause = {
            httpStatusClass: '4xx',
            code: 'forbidden',
          } as const;
          return role === 'check'
                    ? {
                        available: false,
                        code: 'provider_unavailable',
                        nativeCause,
                      }
                    : {
                        dimensions: {
                          size: [],
                          image: [],
                          location: [],
                          network: [],
                          duration: [],
                        },
                        code: 'provider_unavailable',
                        nativeCause,
                      };
        },
      });
      const screen = await renderSettingsView(
        <MachinePresetView serverId={scopeId} presetId={preset.id} />,
      );
      await waitForHomeGovernance(() =>
        expect(
          screen.tree.findAll(
            (node) =>
              node.props.testID ===
                'machine-preset.configuration-unavailable' &&
              node.props.diagnosticCode ===
                'provider_unavailable · HTTP 4xx · forbidden',
          ).length,
          JSON.stringify({ text: screen.getTextContent(), requests: harness.requests.map(request => request.path) }),
        ).toBeGreaterThan(0),
      );
      expect(
        harness.requestsFor('/v1/actions/machines.managed.acquire'),
      ).toHaveLength(0);
      await screen.unmount();
    },
  );
  it.each([false, true])(
    'preserves the same Home/Account editor through credential rebinding (preset: %s)',
    async (editingPreset) => {
      const serverId = await seed();
      const scopeId = await seedConfiguration(serverId);
      runtimeHost.current = 'native';
      const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
      await setActiveServer({ serverId });
      const screen = await renderSettingsView(
        <ManagedMachineConfigurationView
          serverId={scopeId}
          provisioner={buildQualifiedPluginContributionKey(
            preset.launch.provider,
          )}
          {...(editingPreset ? { presetId: preset.id, presetOnly: true } : {})}
          initialController={preset.controller}
        />,
      );
      if (editingPreset) await editPresetCpu(screen);
      else {
        await waitForHomeGovernance(() => expect(sizeControl(screen)?.props.sizes.some(
          (size: { id: string }) => size.id === 'large'), screen.getTextContent()).toBe(true));
        await act(async () => sizeControl(screen)?.props.onChange('large'));
      }
      if (editingPreset)
        await act(async () =>
          screen.changeTextByTestId(
            'managed-config.setup.setup.input',
            'echo unsaved launch',
          ),
        );
      await waitForHomeGovernance(() =>
        expect(
          screen.findByTestId('managed-config.create')?.props.disabled,
          screen.getTextContent(),
        ).toBe(false),
      );
      const retiredCreate = screen.findByTestId('managed-config.create')?.props
        .onPress;
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      harness.answer(serverId, '/v1/actions/machines.provisioners.list', {
        select: async (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
          await gate;
          return {
            body: {
              v: 1,
              actionId: 'machines.provisioners.list',
              requestId: request.requestId,
              execution: {
                ok: true,
                result: {
                  controller: preset.controller,
                  provisioners: [provisioner],
                },
              },
            },
          };
        },
      });
      try {
        await act(async () => {
          await harness.addHome({
            name: 'Refresh',
            serverUrl: 'https://refresh.example',
            serverIdentityId: 'srv_refresh',
            accountId: 'refresh',
          });
        });
        await flushHookEffects();
        await retiredCreate?.();
        expect(
          harness.requestsFor('/v1/actions/machines.managed.acquire'),
        ).toHaveLength(0);
        expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(
          0,
        );
        if (editingPreset)
          expect(
            screen.findByTestId('managed-config.setup.setup.input')?.props
              .value,
          ).toBe('echo unsaved launch');
        if (editingPreset) expect(screen.findByTestId('managed-config.field:cpu')?.props.value).toBe('4');
        else expect(sizeControl(screen)?.props.value).toBe('large');
      } finally {
        release();
      }
      await waitForHomeGovernance(() =>
        expect(
          screen.findByTestId('managed-config.create')?.props.disabled,
        ).toBe(false),
      );
      if (editingPreset)
        expect(
          screen.findByTestId('managed-config.setup.setup.input')?.props.value,
        ).toBe('echo unsaved launch');
      await act(async () => {
        await harness.switchAccount(serverId, 'other-owner');
      });
      await flushHookEffects();
      expect(
        screen.findByTestId('managed-config.setup.setup.input')?.props.value,
      ).not.toBe('echo unsaved launch');
      await screen.unmount();
    },
  );
  it('retains preset collection and detail across a same-Account rebind and withdraws them on Account loss', async () => {
    const serverId = await seed();
    harness.answer(serverId, '/v1/machines/presets/list', {
      body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture({ ...preset, teamAcquireDelegated: false })] },
    });
    const { useMachinePresets, useMachinePresetDetail } =
      await import('./useMachinePresets');
    const homes = [serverId];
    const visible: boolean[] = [];
    const hook = await renderHook(() => {
      const collection = useMachinePresets(homes);
      const detail = useMachinePresetDetail(serverId, preset.id);
      visible.push(
        collection.presetsByServerId[serverId]?.[0]?.id === preset.id &&
          detail.state.value?.preset.id === preset.id,
      );
      return { collection, detail };
    });
    await waitForHomeGovernance(() =>
      expect(hook.getCurrent().detail.state.value?.preset.id).toBe(preset.id),
    );
    await waitForHomeGovernance(() =>
      expect(
        hook.getCurrent().collection.presetsByServerId[serverId]?.[0]?.id,
      ).toBe(preset.id),
    );
    const start = visible.length;
    await act(async () => {
      await harness.addHome({
        name: 'Refresh',
        serverUrl: 'https://refresh.example',
        serverIdentityId: 'srv_refresh',
        accountId: 'refresh',
      });
    });
    await flushHookEffects();
    expect(visible.slice(start).length).toBeGreaterThan(0);
    expect(visible.slice(start).every(Boolean)).toBe(true);
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'refused', code: 'permission_denied' },
    });
    harness.answer(serverId, '/v1/machines/presets/list', {
      status: 403,
      body: { kind: 'refused', code: 'permission_denied' },
    });
    await act(async () => {
      await harness.switchAccount(serverId, 'other-owner');
    });
    await flushHookEffects();
    expect(hook.getCurrent().detail.state.value).toBeNull();
    expect(
      hook.getCurrent().collection.presetsByServerId[serverId],
    ).toBeUndefined();
    await hook.unmount();
  });
  it('reopens retired resources from the Machines archive without returning them to its active list', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    const { setActiveServer } =
      await import('@/sync/domains/server/serverRuntime');
    await setActiveServer({ serverId, scope: 'tab' });
    await harness.selectHomes([serverId]);
    harness.answer(serverId, '/v1/machines/managed/actions/list', {
      select: (input) => ({
        body: {
          machines:
            input && typeof input === 'object' && 'archived' in input
              ? [{ ...resource, archivedAt: 1 }]
              : [],
        },
      }),
    });
    const screen = await renderSettingsView(<MachinesSettingsView />);
    await waitForHomeGovernance(() => {
      expect(
        Boolean(screen.findByTestId(`settings.machines.archived.${scopeId}`)),
      ).toBe(true);
    });
    expect(
      screen.findByTestId(`settings.machines.managed.${scopeId}.resource`),
    ).toBeNull();
    // Off the rail the fold's own row draws the canonical disclosure caret, closed until it is opened.
    const caretStates = () => [
      ...new Set(
        screen.findRow(`settings.machines.archived.${scopeId}`)!
          .findAll(
            (node) =>
              typeof node.type !== 'string' &&
              node.props.reducedMotion !== undefined &&
              node.props.expanded !== undefined,
          )
          .map((node) => node.props.expanded),
      ),
    ];
    expect(caretStates()).toEqual([false]);
    await act(async () =>
      screen.pressByTestId(`settings.machines.archived.${scopeId}`),
    );
    expect(caretStates()).toEqual([true]);
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId(`settings.machines.managed.${scopeId}.resource`),
      ).not.toBeNull(),
    );
    await act(async () =>
      screen.pressByTestId(`settings.machines.managed.${scopeId}.resource`),
    );
    expect(route.push).toHaveBeenLastCalledWith(
      `/settings/machines/managed/resource?serverId=${encodeURIComponent(scopeId)}`,
    );
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual(
      [],
    );
  });
  it('hides Create one on the addressed Account opt-out while keeping edits and history available', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    harness.answer(serverId, '/v2/account/settings', {
      body: {
        content: {
          t: 'plain',
          v: {
            managedMachineCreationEnabled: false,
          },
        },
        version: 1,
      },
    });
    const screen = await renderSettingsView(
      <MachinePresetView serverId={scopeId} presetId="preset" />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-preset.detail.machine.resource'),
      ).not.toBeNull(),
    );
    await flushHookEffects();
    expect(
      Boolean(screen.findByTestId('machine-preset.detail.createOne')),
    ).toBe(false);
    expect(
      screen.findByTestId('machine-preset.creation-disabled'),
    ).not.toBeNull();
    expect(screen.findByTestId('machine-preset.edit')).not.toBeNull();
    expect(screen.findByTestId('machine-preset.detail.archive')).not.toBeNull();
    harness.answer(serverId, '/v2/account/settings', {
      body: {
        content: {
          t: 'plain',
          v: {
            managedMachineCreationEnabled: true,
          },
        },
        version: 2,
      },
    });
    const { publishHomeAccountChange } =
      await import('@/sync/runtime/orchestration/homeAccountChange');
    await act(async () => publishHomeAccountChange(scopeId));
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-preset.detail.createOne'),
      ).not.toBeNull(),
    );
    expect(screen.findByTestId('machine-preset.creation-disabled')).toBeNull();
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual(
      [],
    );
  });
  it('offers no Create one while its provisioner cannot create here, and says why instead', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    harness.answer(serverId, '/v2/account/settings', {
      body: { content: { t: 'plain', v: { managedMachineCreationEnabled: true } }, version: 1 },
    });
    harness.answer(serverId, 'POST /v1/actions/machines.provisioners.options', {
      status: 503,
      body: { code: 'controller_unavailable' },
    });
    const screen = await renderSettingsView(
      <MachinePresetView serverId={scopeId} presetId="preset" />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-preset.configuration-unavailable'),
        JSON.stringify({ text: screen.getTextContent(), requests: harness.requests.map(request => request.path) }),
      ).not.toBeNull(),
    );
    await flushHookEffects();
    // A form that cannot succeed is never opened: Create one stays as the page's primary, disabled, and the line
    // under the header says why, with Retry as the way on.
    const unavailableModel = screen.tree.findByType(MachinePresetDetail).props.model as MachinePresetDetailModel;
    expect(screen.findByTestId('machine-preset.detail.createOne')).not.toBeNull();
    expect(unavailableModel.createOneDisabled).toBe(true);
    // The same holds when the provisioner list itself can't be read.
    await screen.unmount();
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', {
      status: 503,
      body: { code: 'controller_unavailable' },
    });
    const listFailed = await renderSettingsView(
      <MachinePresetView serverId={scopeId} presetId="preset" />,
    );
    await waitForHomeGovernance(() =>
      expect(listFailed.findByTestId('machine-preset.provider-error')).not.toBeNull(),
    );
    await flushHookEffects();
    expect((listFailed.tree.findByType(MachinePresetDetail).props.model as MachinePresetDetailModel).createOneDisabled).toBe(true);
    await listFailed.unmount();
  });
  it('says why it cannot create once: Managed from and a local receipt inherit the line above quietly', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId, false, { billing: { location: 'local', stoppedBilling: 'not-billed' } });
    harness.answer(serverId, '/v2/account/settings', {
      body: { content: { t: 'plain', v: { managedMachineCreationEnabled: true } }, version: 1 },
    });
    harness.answer(serverId, 'POST /v1/actions/machines.provisioners.options', {
      status: 503,
      body: { code: 'controller_unavailable' },
    });
    const screen = await renderSettingsView(<MachinePresetView serverId={scopeId} presetId="preset" />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.configuration-unavailable'),
      screen.getTextContent()).not.toBeNull());
    // The controller then goes offline: its row states that fact, but no "needs to be online" sentence repeats the cause.
    await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, [createMachineFixture({
      id: preset.controller.machineId, installationId: preset.controller.installationId,
      activeAt: Date.now(), presenceProtocolVersion: 1,
    })]);
    const { storage } = await import('@/sync/domains/state/storage');
    const machine = storage.getState().machineListByServerId[scopeId]?.find(entry => entry.id === preset.controller.machineId);
    if (!machine) throw new Error('Expected the seeded preset controller machine');
    await act(async () => publishMachineActivityForTest([machine], { active: false, activeAt: Date.now() }));
    const model = () => screen.tree.findByType(MachinePresetDetail).props.model as MachinePresetDetailModel;
    await waitForHomeGovernance(() => expect(model().controller?.row.subtitle).toBe(t('status.offline')));
    expect(screen.findByTestId('machine-preset.configuration-unavailable')).not.toBeNull();
    expect(model().controller?.description).toBeUndefined();
    const receipt = screen.tree.findByType(MachineConfigurationReceipt).props.model;
    expect(receipt.cost).toMatchObject({ kind: 'local' });
    expect(receipt.cost.note).toBeUndefined();
    await screen.unmount();
  });
  it('keeps sealed delegated details neutral and enables creation without a readiness projection', async () => {
    const serverId = await seed(true, true);
    const scopeId = await seedConfiguration(serverId);
    const delegated = createDelegatedManagedPresetFixture({
      preset: { ...preset, owner: { kind: 'team', teamId: 'team-1' }, controllerDisplayName: undefined },
      descriptor: { ...provisioner.descriptor, enrollmentRole: 'sandbox' },
      custodianAccountId: 'custodian',
      installationPublicKey: encodeBase64(tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey, 'base64url'),
    });
    const unavailable = delegated;
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: unavailable } });
    const { bindHomeDomainActionHttpRequestV1 } = await import('@happier-dev/protocol/actions/homeDomainActionFamily');
    const teamRequest = bindHomeDomainActionHttpRequestV1('teams.get', { v: 1, teamId: 'team-1' });
    harness.answer(serverId, teamRequest.path, { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageSettings: false }) }) });
    await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, []);
    const screen = await renderSettingsView(<MachinePresetView serverId={scopeId} presetId={preset.id} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.detail.createOne')).not.toBeNull());
    const model = screen.tree.findByType(MachinePresetDetail).props.model as MachinePresetDetailModel;
    expect(model.receipt?.facts).toContainEqual(expect.objectContaining({
      id: 'controller', value: t('managedMachines.receipt.managingComputer'),
    }));
    expect(model.receipt?.facts).not.toContainEqual(expect.objectContaining({ id: 'controller', value: t('common.unknown') }));
    // A controller this Account can't see is a typed state, never a placeholder title without presence (TH D-K).
    expect(model.controller?.row.title).toBe(t('machinePresets.controllerNotShared'));
    expect(model.controller?.row.subtitle).toBe(t('machinePresets.controllerStatusNotShared'));
    expect(screen.findByTestId('machine-preset.configuration-unavailable')).toBeNull();
    await screen.unmount();
  });
  it('withdraws a Team preset editor when its Team read loses access without changing the credential or preset response', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    const teamPreset = {
      ...preset,
      owner: { kind: 'team', teamId: 'team-1' },
      setup: { scripts: [{ body: 'echo team setup' }] },
    } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(teamPreset) },
    });
    const { bindHomeDomainActionHttpRequestV1 } =
      await import('@happier-dev/protocol/actions/homeDomainActionFamily');
    const request = bindHomeDomainActionHttpRequestV1('teams.get', {
      v: 1,
      teamId: 'team-1',
    });
    harness.answer(serverId, request.path, {
      body: teamSummaryFixture({
        capabilities: teamCapabilitiesFixture({ manageSettings: true }),
      }),
    });
    const screen = await renderSettingsView(
      <ManagedMachineConfigurationView
        serverId={scopeId}
        provisioner={buildQualifiedPluginContributionKey(
          preset.launch.provider,
        )}
        presetId={preset.id}
        presetOnly
      />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('managed-config.setup.setup.input')?.props.value,
      ).toBe('echo team setup'),
    );
    harness.answer(serverId, request.path, {
      status: 403,
      body: { code: 'permission_denied' },
    });
    const { refreshTeam } =
      await import('@/sync/engine/teams/teamsDirectoryEngine');
    const { createServerAccountScope } =
      await import('@/sync/domains/scope/serverAccountScope');
    const { createTeamAddress } =
      await import('@/sync/domains/teams/teamAddress');
    const scope = createServerAccountScope(scopeId, 'owner');
    const address = createTeamAddress(scopeId, 'team-1');
    if (!scope || !address)
      throw new Error('Expected the seeded exact Team scope');
    await act(async () => {
      await refreshTeam(scope, address);
    });
    await flushHookEffects();
    expect(screen.findByTestId('managed-config.setup.setup.input')).toBeNull();
    expect(sizeControl(screen)).toBeUndefined();
    expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(1);
  });
  it.each(['permission_denied', 'unavailable'])(
    'refreshes protected editor content on Home changes (%s)',
    async (code) => {
      const serverId = await seed();
      const scopeId = await seedConfiguration(serverId);
      const setup = {
        scripts: [{ body: 'echo protected setup' }],
        secretRefs: { v: 1, bindings: { TOKEN: { ref: 'protected-secret' } } },
      } satisfies NonNullable<Parameters<typeof createPlainManagedMachinePresetFixture>[0]['setup']>;
      harness.answer(serverId, '/v1/machines/presets/get', {
        body: { kind: 'found', preset: createPlainManagedMachinePresetFixture({ ...preset, setup }) },
      });
      await harness.requireUiApproval(serverId, 'machines.presets.update');
      const modalHost = await renderSettingsView(<ModalProvider />);
      const screen = await renderSettingsView(
        <ManagedMachineConfigurationView
          serverId={scopeId}
          provisioner={buildQualifiedPluginContributionKey(
            preset.launch.provider,
          )}
          presetId={preset.id}
          presetOnly
        />,
      );
      await waitForHomeGovernance(() =>
        expect(
          screen.findByTestId('managed-config.setup.setup.input')?.props.value,
        ).toBe(setup.scripts[0]!.body),
      );
      await act(async () =>
        screen.changeTextByTestId(
          'managed-config.setup.setup.input',
          'echo unsaved setup',
        ),
      );
      await editPresetCpu(screen);
      await waitForHomeGovernance(() =>
        expect(
          screen.findByTestId('managed-config.create')?.props.disabled,
        ).toBe(false),
      );
      expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(1);
      await act(async () => screen.pressByTestId('managed-config.create'));
      await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
      expect(harness.artifacts(serverId).list()).toEqual([]);
      expect(harness.requestsFor('/v1/machines/presets/get'), 'Save admission reads the incumbent once').toHaveLength(2);
      harness.answer(serverId, '/v1/machines/presets/get', {
        body: { kind: 'refused', code },
      });
      const { publishHomeAccountChange } =
        await import('@/sync/runtime/orchestration/homeAccountChange');
      await act(async () => publishHomeAccountChange(scopeId));
      await flushHookEffects();
      expect(
        harness.requestsFor('/v1/machines/presets/get'),
        'The mounted preset editor must refresh its read on the same Home wake',
      ).toHaveLength(3);
      if (code === 'permission_denied') {
        expect(
          screen.findByTestId('managed-config.setup.setup.input'),
        ).toBeNull();
        expect(
          screen.findByTestId('managed-config.setup.secret:TOKEN'),
        ).toBeNull();
        expect(screen.findByTestId('managed-config.field:cpu')).toBeNull();
        expect(screen.findByTestId('managed-config.receipt')).toBeNull();
        expect(screen.findByTestId('managed-config.create')).toBeNull();
      } else {
        expect(
          screen.findByTestId('managed-config.setup.setup.input')?.props.value,
        ).toBe('echo unsaved setup');
        expect(screen.findByTestId('managed-config.field:cpu')?.props.value).toBe('4');
      }
      harness.answer(serverId, '/v1/machines/presets/update', {
        body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture({ ...preset, revision: 4 }) },
      });
      if (code === 'permission_denied') {
        expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).toBeNull();
        expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
      } else await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-approve');
      await flushHookEffects();
      if (code === 'permission_denied')
        expect(route.replace).not.toHaveBeenCalled();
      else
        expect(route.replace).toHaveBeenCalledWith(
          `/settings/machines/presets/preset?serverId=${encodeURIComponent(scopeId)}`,
        );
    },
  );
  it.each([true, false, 'missing-input-schema'] as const)(
    'revalidates saved native sizing only through its current declared same-path selectors (schema available: %s)',
    async (schemaAvailable) => {
      const serverId = await seed();
      const scopeId = await seedConfiguration(serverId);
      // Public Cua schemas/options from machine-cua/src/machine/schemas.ts
      // and nativeFacts.ts: runtime, image and reviewed size share launch paths;
      // `on` belongs only to launch, never to the options input.
      const size = {
        cpu: 2,
        memoryBytes: 4 * 1024 ** 3,
        diskBytes: 10 * 1024 ** 3,
      };
      const selectors = {
        runtimeId: 'gvisor',
        imageId: 'ghcr.io/trycua/browser:latest',
        size,
      };
      const launch = { on: 'local', ...selectors };
      const sizeSchema = {
        type: 'object',
        properties: {
          cpu: { type: 'integer', minimum: 1, maximum: 4_294_967_295 },
          memoryBytes: {
            type: 'integer',
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
          },
          diskBytes: {
            type: 'integer',
            minimum: 1,
            maximum: Number.MAX_SAFE_INTEGER,
          },
        },
        required: ['cpu', 'memoryBytes', 'diskBytes'],
        additionalProperties: false,
      };
      const inputSchema = PluginJsonSchemaV2Schema.parse({
        type: 'object',
        properties: {
          runtimeId: {
            anyOf: ['gvisor', 'runc', 'qemu', 'lume'].map((value) => ({
              type: 'string',
              const: value,
            })),
          },
          imageId: { type: 'string', minLength: 1 },
          size: sizeSchema,
        },
        additionalProperties: false,
      });
      const cua: MachineProvisionersListResultV1['provisioners'][number] = {
        ...provisioner,
        contribution: {
          pluginId: 'happier.machine.cua',
          localId: 'local-sandbox',
        },
        descriptor: {
          ...provisioner.descriptor,
          id: 'local-sandbox',
          title: 'Cua local sandbox',
          resourceKind: 'cua-local-sandbox',
          launchSchema: {
            type: 'object',
            properties: {
              ...inputSchema.properties,
              on: { type: 'string', const: 'local' },
            },
            required: ['on', 'runtimeId', 'imageId', 'size'],
            additionalProperties: false,
          },
          billing: { location: 'local', stoppedBilling: 'not-billed' },
          actions: {
            ...provisioner.descriptor.actions,
            options: 'sandbox-options',
          },
        },
      };
      seedOptionsDeclaration(cua, inputSchema, schemaAvailable);
      const saved = {
        ...preset,
        launch: {
          ...preset.launch,
          provider: cua.contribution,
          choices: launch,
        },
      } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
      harness.answer(serverId, '/v1/machines/presets/get', {
        body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(saved) },
      });
      harness.answer(serverId, '/v1/actions/machines.provisioners.list', {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
          return {
            body: {
              v: 1,
              actionId: 'machines.provisioners.list',
              requestId: request.requestId,
              execution: {
                ok: true,
                result: { controller: preset.controller, provisioners: [cua] },
              },
            },
          };
        },
      });
      let available = true;
      await answerExternalActionAccountForHome(harness, serverId, {
      actionId: 'machines.provisioners.options', machineId: preset.controller.machineId,
      installationId: preset.controller.installationId, tokenEpoch: 0,
      execute: (_input, { envelope }) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(envelope);
          expect(request.target).toEqual({
            kind: 'machine',
            machineId: preset.controller.machineId,
          });
          const reviewed =
            request.input !== null &&
            typeof request.input === 'object' &&
            'selectors' in request.input &&
            pluginJsonValuesEqual(request.input.selectors, selectors);
          return createMachineProvisionerOptionsFixture({
                  ...(available && reviewed
                    ? {
                        base: {
                          launch,
                          nativeFacts: {
                            ...(reviewed
                              ? {
                                  size: {
                                    id: '2:4294967296:10737418240',
                                    title: '2 CPU',
                                    cpuCores: size.cpu,
                                    memoryBytes: size.memoryBytes,
                                    diskBytes: size.diskBytes,
                                  },
                                }
                              : {}),
                            image: {
                              id: selectors.imageId,
                              title: selectors.imageId,
                            },
                            location: { id: 'gvisor', title: 'gvisor' },
                          },
                        },
                      }
                    : {}),
                });
        },
    });
      const screen = await renderSettingsView(
        <MachinePresetView serverId={scopeId} presetId={preset.id} />,
      );
      await waitForHomeGovernance(() =>
        expect(screen.findByTestId('machine-preset.detail')).not.toBeNull(),
      );
      if (schemaAvailable !== true) {
        await waitForHomeGovernance(() =>
          expect(
            screen.findByTestId('machine-preset.configuration-unavailable'),
          ).not.toBeNull(),
        );
        expect(
          harness.requestsFor('/v1/actions/machines.provisioners.options'),
        ).toHaveLength(0);
      } else {
        await waitForHomeGovernance(() =>
          expect(
            harness.requestsFor('/v1/actions/machines.provisioners.options')
              .length,
          ).toBeGreaterThan(0),
        );
        const first = ExternalActionRequestEnvelopeV1Schema.parse(
          ExternalActionExecutionAuthorizationRequestV1Schema.parse(
            harness.requestsFor('/v1/actions/machines.provisioners.options')[0]!.input,
          ).envelope,
        );
        expect(first.input).toEqual({
          homeId: preset.homeId,
          controller: preset.controller,
          contribution: cua.contribution,
          selectors,
        });
        await waitForHomeGovernance(() =>
          expect(screen.getTextContent()).toContain('2 CPU'),
        );
        expect(screen.getTextContent()).toContain(selectors.imageId);
        expect(
          screen.findByTestId('machine-preset.configuration-unavailable'),
        ).toBeNull();
        // The native owner can invalidate that exact image's disk sizing.
        // Refresh must retain reviewed sizing and disclose unavailability,
        // never choose a replacement or acquire another resource.
        available = false;
        const { publishHomeAccountChange } =
          await import('@/sync/runtime/orchestration/homeAccountChange');
        await act(async () => publishHomeAccountChange(scopeId));
        await waitForHomeGovernance(() =>
          expect(
            screen.findByTestId('machine-preset.configuration-unavailable'),
          ).not.toBeNull(),
        );
        expect(screen.getTextContent()).toContain('2 CPU');
        expect(screen.getTextContent()).toContain(selectors.imageId);
      }
      expect(
        harness.requestsFor('/v1/actions/machines.managed.acquire'),
      ).toEqual([]);
    },
  );

  it('shows current labelled launch facts from the saved launch rather than the first available choice', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    const originalController = createMachineFixture({
      id: preset.controller.machineId,
      installationId: preset.controller.installationId,
      activeAt: Date.now(),
      metadata: {
        ...createMachineFixture().metadata!,
        displayName: 'Original preset controller',
      },
    });
    await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, [originalController]);
    const saved = {
      ...preset,
      launch: {
        ...preset.launch,
        choices: { cpu: 4 },
        credentials: [savedCredential],
      },
    } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(saved) },
    });
    await answerExternalActionAccountForHome(harness, serverId, {
      actionId: 'machines.provisioners.options', machineId: preset.controller.machineId,
      installationId: preset.controller.installationId, tokenEpoch: 0,
      execute: (_input, { envelope }) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(envelope);
        expect(request.target).toEqual({
          kind: 'machine',
          machineId: preset.controller.machineId,
        });
        expect(request.input).toMatchObject({
          homeId: preset.homeId,
          controller: preset.controller,
        });
        return createMachineProvisionerOptionsFixture(
                request.input &&
                  typeof request.input === 'object' &&
                  'credentials' in request.input &&
                  JSON.stringify(request.input.credentials) ===
                    JSON.stringify([savedCredential])
                  ? {
                      base: {
                        launch: { cpu: 4 },
                        nativeFacts: {
                          size: {
                            id: 'large',
                            title: 'Four cores',
                            cpuCores: 4,
                          },
                          image: { id: 'linux', title: 'Linux guest' },
                          location: { id: 'west', title: 'West coast' },
                        },
                        prices: [
                          {
                            amount: '0.012',
                            currency: 'USD',
                            unit: 'hour',
                            source: 'Native quote',
                            observedAt: 10,
                          },
                        ],
                      },
                    }
                  : {},
              );
      },
    });
    const screen = await renderSettingsView(
      <MachinePresetView serverId={scopeId} presetId={preset.id} />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('machine-preset.detail')).not.toBeNull(),
    );
    await waitForHomeGovernance(() =>
      expect(
        harness.requestsFor('/v1/actions/machines.provisioners.options'),
        screen.getTextContent(),
      ).toHaveLength(1),
    );
    for (const actionId of [
      'machines.provisioners.check',
      'machines.provisioners.options',
    ]) {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(
        ExternalActionExecutionAuthorizationRequestV1Schema.parse(
          harness.requestsFor(`/v1/actions/${actionId}`)[0]!.input,
        ).envelope,
      );
      expect(envelope.input).toMatchObject({ credentials: [savedCredential] });
    }
    await waitForHomeGovernance(() =>
      expect(screen.getTextContent()).toContain('Four cores'),
    );
    expect(screen.getTextContent()).toContain('Linux guest');
    expect(screen.getTextContent()).toContain('West coast');
    expect(screen.getTextContent()).toContain('$0.012');
    expect(screen.getTextContent()).toContain(t('managedMachines.price.perHour'));
    expect(screen.getTextContent()).not.toContain('Other size');
    const { publishHomeAccountChange } =
      await import('@/sync/runtime/orchestration/homeAccountChange');
    const configurationReads = () => ['check', 'options'].map(kind =>
      harness.requestsFor(`/v1/actions/machines.provisioners.${kind}`).length);
    const initialReads = configurationReads();
    await act(async () => {
      publishHomeAccountChange(scopeId, undefined, { machineResourcesAffect: false });
      publishHomeAccountChange('unrelated-home');
    });
    await flushHookEffects();
    expect(configurationReads()).toEqual(initialReads);
    expect(screen.findRowByTitle('Original guest')).not.toBeNull();
    expect(
      screen.tree.findByType(MachineConfigurationReceipt).props.model.facts,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'controller',
          value: 'Original preset controller',
        }),
      ]),
    );
    await answerExternalActionAccountForHome(harness, serverId, {
      actionId: 'machines.provisioners.options', machineId: preset.controller.machineId,
      installationId: preset.controller.installationId, tokenEpoch: 0,
      execute: () => createMachineProvisionerOptionsFixture({
        base: {
          launch: { cpu: 8 },
          nativeFacts: { size: { id: 'other', title: 'Other size' } },
        },
      }),
    });
    await act(async () => publishHomeAccountChange(scopeId));
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-preset.configuration-unavailable'),
      ).not.toBeNull(),
    );
    expect(screen.getTextContent()).toContain('Four cores');
    expect(screen.getTextContent()).toContain('$0.012');
    expect(screen.getTextContent()).toContain(t('managedMachines.price.perHour'));
    expect(screen.getTextContent()).not.toContain('Other size');
    expect(configurationReads()).toEqual(initialReads.map(count => count + 1));
    harness.answer(serverId, 'POST /v1/actions/machines.provisioners.options', {
      status: 503,
      body: { code: 'unavailable' },
    });
    const priorReads = harness.requestsFor(
      '/v1/actions/machines.provisioners.options',
    ).length;
    await act(async () =>
      screen.pressByTestId('machine-preset.configuration-unavailable-action'),
    );
    await waitForHomeGovernance(() =>
      expect(
        harness.requestsFor('/v1/actions/machines.provisioners.options'),
      ).toHaveLength(priorReads + 1),
    );
    expect(screen.getTextContent()).toContain('Four cores');
    expect(screen.getTextContent()).toContain('$0.012');
    expect(screen.getTextContent()).toContain(t('managedMachines.price.perHour'));
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual(
      [],
    );
    // A new installation can reuse a Machine id, but cannot supply the
    // human identity of the preset's retained original controller.
    await act(async () =>
      publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, [{
        ...originalController,
        installationId: 'replacement-installation',
        seq: originalController.seq + 1,
        updatedAt: originalController.updatedAt + 1,
        metadata: {
          ...originalController.metadata!,
          displayName: 'Replacement controller computer',
        },
      }]),
    );
    await flushHookEffects();
    const receipt = screen.tree.findByType(MachineConfigurationReceipt).props
      .model;
    expect(receipt.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'controller',
          value: t('managedMachines.receipt.managingComputer'),
        }),
      ]),
    );
    // The page says what the preset makes; its sections never repeat their own title, and the edit rule is not the page's purpose.
    const detailModel = screen.tree.findByType(MachinePresetDetail).props.model;
    expect(detailModel.audience.description).not.toBe(
      t('machinePresets.audience'),
    );
    expect(detailModel.description).not.toBe(t('machinePresets.futureOnly'));
    expect(detailModel.description).not.toBe('');
    expect(JSON.stringify(receipt.facts)).not.toContain(
      'Replacement controller computer',
    );
    expect(
      receipt.facts.find(
        (fact: { id: string; value: string }) => fact.id === 'controller',
      ).value,
    ).not.toBe(preset.controller.machineId);
  });

  it('reads past a retired provider occurrence by refreshing the catalog, never flashing unavailable (L12 review 2, A-2)', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    // Live right after Save: the catalog the page starts from names a plugin occurrence the controller has replaced,
    // so its first availability answer is "stale"; the controller's next catalog answer names the current one.
    let checks = 0;
    await answerExternalActionAccountForHome(harness, serverId, {
      actionId: 'machines.provisioners.check', machineId: preset.controller.machineId,
      installationId: preset.controller.installationId, tokenEpoch: 0,
      execute: () => ++checks === 1 ? { available: false, code: 'plugin_occurrence_stale' } : { available: true },
    });
    const controllerLists = () => harness.requestsFor('/v1/actions/machines.provisioners.list')
      .filter(request => ExternalActionRequestEnvelopeV1Schema.parse(request.input).target?.kind === 'machine').length;
    const screen = await renderSettingsView(<MachinePresetView serverId={scopeId} presetId={preset.id} />);
    try {
      await waitForHomeGovernance(() => expect(checks).toBeGreaterThan(0));
      await flushHookEffects({ cycles: 30 });
      expect(screen.findByTestId('machine-preset.configuration-unavailable'), screen.getTextContent()).toBeNull();
      // The stale answer asks the catalog again, then the configuration is read against its answer.
      await waitForHomeGovernance(() => expect(checks).toBe(2));
      expect(controllerLists()).toBeGreaterThan(1);
      await flushHookEffects({ cycles: 30 });
      expect(screen.findByTestId('machine-preset.configuration-unavailable')).toBeNull();
    } finally { await screen.unmount(); }
  });

  it('opens New preset through the declaration catalog and saves an exact-controller launch without acquiring', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    const picker = await renderSettingsView(
      <MachineProvisionerPicker serverId={scopeId} presetOnly />,
    );
    // Preset authoring offers the Account declaration before a controller is chosen.
    const providerKey = buildQualifiedPluginContributionKey(
      preset.launch.provider,
    );
    const actionId = `managed-picker.provisioners.cloud.${providerKey}.action`;
    const rowId = `managed-picker.provisioners.cloud.${providerKey}`;
    await waitForHomeGovernance(() =>
      expect(
        picker.findByTestId(actionId) ?? picker.findByTestId(rowId),
      ).not.toBeNull(),
    );
    await act(async () =>
      picker.pressByTestId(picker.findByTestId(actionId) ? actionId : rowId),
    );
    const href = String(route.push.mock.calls.at(-1)?.[0]);
    const destination = new URL(href, 'https://happier.example');
    expect(destination.pathname).toBe(
      `/settings/machines/add/${encodeURIComponent(providerKey)}`,
    );
    expect(Object.fromEntries(destination.searchParams)).toEqual({
      serverId: scopeId,
      presetOnly: 'true',
    });
    await picker.unmount();
    const screen = await renderSettingsView(
      <ManagedMachineConfigurationView
        serverId={scopeId}
        provisioner={providerKey}
        presetOnly
        initialController={preset.controller}
      />,
    );
    await editPresetCpu(screen);
    expect(
      screen.findByTestId('managed-config.receipt:keep:choice:deadline'),
    ).toBeNull();
    harness.answer(serverId, '/v1/machines/presets/create', {
      select: (input) => {
        expect(readCreatedPreset(input)).toMatchObject({
          homeId: preset.homeId,
          name: 'Custom compute',
          owner: preset.owner,
          controller: preset.controller,
          launch: {
            ...preset.launch,
            name: 'Custom compute',
            choices: { cpu: 4 },
          },
        });
        const id = ManagedMachinePresetCreateInputV1Schema.parse(input).id;
        expect(typeof id).toBe('string');
        return {
          body: {
            kind: 'saved',
            preset: createPlainManagedMachinePresetFixture({
              ...preset,
              id,
              revision: 1,
              name: 'Custom compute',
              launch: {
                ...preset.launch,
                name: 'Custom compute',
                choices: { cpu: 4 },
              },
            }),
          },
        };
      },
    });
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(
        false,
      ),
    );
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() =>
      expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(
        1,
      ),
    );
    const createdInput = harness.requestsFor('/v1/machines/presets/create')[0]
      ?.input;
    if (
      !createdInput ||
      typeof createdInput !== 'object' ||
      !('id' in createdInput) ||
      typeof createdInput.id !== 'string'
    ) {
      throw new Error('Expected the strict preset creation input');
    }
    const createdId = createdInput.id;
    await waitForHomeGovernance(() =>
      expect(route.replace).toHaveBeenLastCalledWith(
        `/settings/machines/presets/${createdId}?serverId=${encodeURIComponent(scopeId)}`,
      ),
    );
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual(
      [],
    );
    expectNoNativePresetReads();
  });

  it.each(['exact', 'pool'] as const)('saves a new %s controller target from the real preset editor without acquiring', async target => {
    const serverId = await seed(target === 'pool');
    const scopeId = await seedConfiguration(serverId);
    const providerKey = buildQualifiedPluginContributionKey(preset.launch.provider);
    const screen = await renderSettingsView(
      <ManagedMachineConfigurationView
        serverId={scopeId}
        provisioner={providerKey}
        presetOnly
        initialController={preset.controller}
      />,
    );
    await editPresetCpu(screen);
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
    const poolId = '6be84651-2df7-4125-aac4-0d093217b198';
    if (target === 'pool') {
      const pool = { id: poolId, name: poolName(poolId, 'Build controllers'), description: null, revision: 1, createdAt: 1, updatedAt: 1, members: [] };
      harness.answer(serverId, '/v1/machines/pools/list', { body: { pools: [
        { pool, availability: { state: 'known', connectedCount: 0, enabledCount: 0 }, access: { canManage: true, canResolve: true, canViewMembers: true } },
        { pool: { ...pool, id: '6be84651-2df7-4125-aac4-0d093217b199', name: poolName('6be84651-2df7-4125-aac4-0d093217b199', 'Shared view only') },
          availability: { state: 'known', connectedCount: 0, enabledCount: 0 }, access: { canManage: false, canResolve: false, canViewMembers: false } },
      ] } });
      const targetControl = () => screen.tree.findAllByType(SegmentedChoiceItem)
        .find(row => row.props.testIDPrefix === 'managed-config.controller-target');
      expect(targetControl()?.props.disabled).toBe(false);
      await act(async () => screen.pressByTestId('managed-config.controller-target:pool'));
      expect(targetControl()?.props.value).toBe('pool');
      const poolRow = () => screen.tree.findAllByType(ManagedFieldRow).find(row => row.props.testID === 'managed-config.controller-pool');
      await waitForHomeGovernance(() => expect(poolRow()?.props.row.choices).toEqual([{ id: poolId, title: 'Build controllers' }]));
      await act(async () => poolRow()?.props.row.onChange(poolId));
      // Moving back to Exact adopts the same visible controller; moving to Pool clears it in the save.
      await act(async () => screen.pressByTestId('managed-config.controller-target:exact'));
      expect(targetControl()?.props.value).toBe('exact');
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
      await act(async () => screen.pressByTestId('managed-config.controller-target:pool'));
      expect(targetControl()?.props.value).toBe('pool');
      await waitForHomeGovernance(() => expect(poolRow()?.props.row.disabled).toBe(false));
      await act(async () => poolRow()?.props.row.onChange(poolId));
    }
    expect(
      screen.findByTestId('managed-config.receipt:keep:choice:deadline'),
    ).toBeNull();
    harness.answer(serverId, '/v1/machines/presets/create', {
      select: (input) => {
        expect(readCreatedPreset(input)).toMatchObject({
          homeId: preset.homeId,
          name: 'Custom compute',
          owner: preset.owner,
          ...(target === 'pool' ? { controllerPoolId: poolId } : { controller: preset.controller }),
          launch: {
            ...preset.launch,
            name: 'Custom compute',
            choices: { cpu: 4 },
          },
        });
        const id = ManagedMachinePresetCreateInputV1Schema.parse(input).id;
        expect(typeof id).toBe('string');
        if (target === 'pool') expect(input).not.toHaveProperty('controller');
        return {
          body: {
            kind: 'saved',
            preset: createPlainManagedMachinePresetFixture({
              ...preset,
              id,
              revision: 1,
              name: 'Custom compute',
              launch: {
                ...preset.launch,
                name: 'Custom compute',
                choices: { cpu: 4 },
              },
            }),
          },
        };
      },
    });
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(
        false,
      ),
    );
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() =>
      expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(
        1,
      ),
    );
    const createdInput = harness.requestsFor('/v1/machines/presets/create')[0]
      ?.input;
    if (
      !createdInput ||
      typeof createdInput !== 'object' ||
      !('id' in createdInput) ||
      typeof createdInput.id !== 'string'
    ) {
      throw new Error('Expected the strict preset creation input');
    }
    const createdId = createdInput.id;
    await waitForHomeGovernance(() =>
      expect(route.replace).toHaveBeenLastCalledWith(
        `/settings/machines/presets/${createdId}?serverId=${encodeURIComponent(scopeId)}`,
      ),
    );
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual(
      [],
    );
    expect(harness.requestsFor('/v1/machines/pools/resolve')).toEqual([]);
    expectNoNativePresetReads();
  });

  it.each(['before choosing the pool', 'after choosing the pool'] as const)(
    'authors a new Team pool preset with declaration fields edited %s', async timing => {
      const serverId = await seed(true, true);
      const scopeId = await seedConfiguration(serverId, true);
      await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, [
        createMachineFixture({ id: preset.controller.machineId, installationId: preset.controller.installationId, activeAt: Date.now() }),
        createMachineFixture({ id: 'offline-controller', installationId: 'offline-installation', active: false, activeAt: 1 }),
      ]);
      const team = teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageSettings: true }) });
      harness.answer(serverId, '/v1/teams/list', { body: { items: [team], nextCursor: null } });
      const { bindHomeDomainActionHttpRequestV1 } = await import('@happier-dev/protocol/actions/homeDomainActionFamily');
      harness.answer(serverId, bindHomeDomainActionHttpRequestV1('teams.get', { v: 1, teamId: team.id }).path, { body: team });
      const poolId = '6be84651-2df7-4125-aac4-0d093217b198';
      harness.answer(serverId, '/v1/machines/pools/list', { body: { pools: [{
        pool: { id: poolId, name: poolName(poolId, 'Team builders'), description: null, revision: 1, createdAt: 1, updatedAt: 1,
          audience: { kind: 'team', teamId: team.id }, members: [
            { machineId: preset.controller.machineId, priorityTier: 0, enabled: true, state: 'connected' },
            { machineId: 'offline-controller', priorityTier: 0, enabled: true, state: 'offline' },
          ] },
        availability: { state: 'known', connectedCount: 1, enabledCount: 2 },
        access: { canManage: true, canResolve: true, canViewMembers: true },
      }] } });
      const screen = await renderSettingsView(<ManagedMachineConfigurationView serverId={scopeId}
        provisioner={buildQualifiedPluginContributionKey(preset.launch.provider)} presetOnly initialController={preset.controller} />);
      const field = (testID: string) => screen.tree.findAllByType(ManagedFieldRow).find(row => row.props.testID === testID);
      try {
        await waitForHomeGovernance(() => expect(field('managed-config.audience')?.props.row.choices.some((choice: { id: string }) => choice.id === team.id)).toBe(true));
        expect(field('managed-config.audience')?.props.row.disabled).toBe(false);
        await act(async () => field('managed-config.audience')?.props.row.onChange(team.id));
        await waitForHomeGovernance(() => expect(field('managed-config.limit')?.props.row.disabled).toBe(false));
        await act(async () => field('managed-config.limit')?.props.row.onChange('2'));
        const editLaunch = async () => {
          await editPresetCpu(screen);
          await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.field:image'), screen.getTextContent()).not.toBeNull());
          await act(async () => screen.changeTextByTestId('managed-config.field:image', 'linux'));
          expect(screen.findByTestId('managed-config.field:image')?.props.value).toBe('linux');
        };
        if (timing === 'before choosing the pool') await editLaunch();
        const targetControl = () => screen.tree.findAllByType(SegmentedChoiceItem).find(row => row.props.testIDPrefix === 'managed-config.controller-target');
        await waitForHomeGovernance(() => expect(targetControl()?.props.disabled).toBe(false));
        await act(async () => screen.pressByTestId('managed-config.controller-target:pool'));
        expect(targetControl()?.props.value).toBe('pool');
        await waitForHomeGovernance(() => expect(field('managed-config.controller-pool')?.props.row.choices).toEqual([{ id: poolId, title: 'Team builders' }]));
        expect(field('managed-config.controller-pool')?.props.row.disabled).toBe(false);
        await act(async () => field('managed-config.controller-pool')?.props.row.onChange(poolId));
        if (timing === 'after choosing the pool') await editLaunch();
        expect(screen.findByTestId('managed-config.field:cpu')?.props.value).toBe('4');
        expect(screen.findByTestId('managed-config.field:image')?.props.value).toBe('linux');
        harness.answer(serverId, '/v1/machines/presets/create', { select: input => {
          const saved = ManagedMachinePresetV1Schema.parse({ ...ManagedMachinePresetCreateInputV1Schema.parse(input), revision: 1 });
          return { body: { kind: 'saved', preset: saved } };
        } });
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
        await act(async () => screen.pressByTestId('managed-config.create'));
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(1));
        const created = readCreatedPreset(harness.requestsFor('/v1/machines/presets/create')[0]?.input);
        expect(created).toMatchObject({ owner: { kind: 'team', teamId: team.id }, controllerPoolId: poolId,
          simultaneousLimit: { maximum: 2 }, launch: { choices: { cpu: 4, image: 'linux' } } });
        expect(created).not.toHaveProperty('controller');
        await waitForHomeGovernance(() => expect(route.replace).toHaveBeenLastCalledWith(
          `/settings/machines/presets/${created.id}?serverId=${encodeURIComponent(scopeId)}`,
        ));
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
        expect(harness.requestsFor('/v1/machines/pools/resolve')).toEqual([]);
        expectNoNativePresetReads();
      } finally {
        await screen.unmount();
      }
    },
  );

  it('preserves an edited launch after rejection and revision conflict, then saves through normal approval', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    await harness.requireUiApproval(serverId, 'machines.presets.update');
    const modalHost = await renderSettingsView(<ModalProvider />);
    const screen = await renderSettingsView(
      <ManagedMachineConfigurationView
        serverId={scopeId}
        provisioner={buildQualifiedPluginContributionKey(
          preset.launch.provider,
        )}
        presetId={preset.id}
        presetOnly
      />,
    );
    await editPresetCpu(screen);
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(
        false,
      ),
    );
    expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(1);
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
      expect(harness.artifacts(serverId).list()).toEqual([]);
    expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
    expect(harness.requestsFor('/v1/machines/presets/get'), 'Save admission reads the incumbent once').toHaveLength(2);
    expect(modalHost.getTextContent()).toContain(preset.name);
    const { publishHomeAccountChange } =
      await import('@/sync/runtime/orchestration/homeAccountChange');
    await act(async () => publishHomeAccountChange(scopeId));
    await flushHookEffects();
    expect(harness.requestsFor('/v1/machines/presets/get'), 'The mounted editor refreshes once on the Home wake').toHaveLength(3);
    expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull();
    await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-reject');
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.error')).not.toBeNull(),
    );
    expect(screen.findByTestId('managed-config.field:cpu')?.props.value).toBe('4');
    expect(route.replace).not.toHaveBeenCalled();
    harness.answer(serverId, '/v1/machines/presets/update', {
      body: { kind: 'conflict', currentRevision: 4 },
    });
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
      expect(harness.artifacts(serverId).list()).toEqual([]);
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture({ ...preset, revision: 4 }) },
    });
    await act(async () =>
      publishHomeAccountChange(scopeId, [preset.id], {
        changeKinds: ['artifact', 'account'],
      }),
    );
    await flushHookEffects();
    expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull();
    expect(screen.findByTestId('managed-config.field:cpu')?.props.value).toBe('4');
    await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-approve');
    await waitForHomeGovernance(() =>
      expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(
        1,
      ),
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(
        false,
      ),
    );
    expect(screen.findByTestId('managed-config.field:cpu')?.props.value).toBe('4');
    expect(route.replace).not.toHaveBeenCalled();
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture({ ...preset, revision: 4 }) },
    });
    const readsBeforeReview = harness.requestsFor('/v1/machines/presets/get').length;
    await act(async () => screen.pressByTestId('managed-config.error-action'));
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(readsBeforeReview + 1));
    expect(screen.findByTestId('managed-config.field:cpu')?.props.value).toBe('4');
    harness.answer(serverId, '/v1/machines/presets/update', {
      body: {
        kind: 'saved',
        preset: createPlainManagedMachinePresetFixture({
          ...preset,
          revision: 5,
          launch: { ...preset.launch, choices: { cpu: 4 } },
        }),
      },
    });
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
      expect(harness.artifacts(serverId).list()).toEqual([]);
    await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-approve');
    await waitForHomeGovernance(() =>
      expect(route.replace).toHaveBeenLastCalledWith(
        `/settings/machines/presets/preset?serverId=${encodeURIComponent(scopeId)}`,
      ),
    );
    expect(
      harness
        .requestsFor('/v1/machines/presets/update')
        .map((request) => readUpdatedPreset(request.input)),
    ).toEqual([
      expect.objectContaining({
        homeId: preset.homeId,
        id: preset.id,
        expectedRevision: 3,
        patch: expect.objectContaining({
          launch: { ...preset.launch, choices: { cpu: 4 } },
          controller: preset.controller,
        }),
      }),
      expect.objectContaining({
        homeId: preset.homeId,
        id: preset.id,
        expectedRevision: 4,
        patch: expect.objectContaining({
          launch: { ...preset.launch, choices: { cpu: 4 } },
        }),
      }),
    ]);
    expect(harness.requestsFor('/v1/machines/presets/create')).toEqual([]);
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual(
      [],
    );
    expectNoNativePresetReads();
  });

  it('saves a preset copy with its explicit Keep and wake choices without allocating or editing the original', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    const policy = {
      retention: { kind: 'unused', afterMs: 7_200_000, effect: 'delete' },
      wakeOnAcceptedMessage: false,
    } as const;
    const original = {
      ...preset,
      launch: { ...preset.launch, credentials: [savedCredential] },
      ...policy,
    } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(original) },
    });
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', {
      select: (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        return {
          body: {
            v: 1,
            actionId: 'machines.provisioners.list',
            requestId: request.requestId,
            execution: {
              ok: true,
              result: {
                controller: preset.controller,
                provisioners: [
                  {
                    ...provisioner,
                    credentialPurposes: [
                      {
                        purpose: savedCredential.purpose,
                        options: [
                          {
                            value: savedCredential.account,
                            label: 'Saved native account',
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        };
      },
    });
    harness.answer(serverId, '/v1/machines/presets/create', {
      select: (input) => {
        const id = ManagedMachinePresetCreateInputV1Schema.parse(input).id;
        return {
          body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture({ ...original, id, revision: 1 }) },
        };
      },
    });
    const screen = await renderSettingsView(
      <ManagedMachineConfigurationView
        serverId={scopeId}
        provisioner={buildQualifiedPluginContributionKey(
          preset.launch.provider,
        )}
        presetId={preset.id}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('managed-config.save-preset')?.props.disabled,
      ).toBe(false),
    );
    expect(screen.findAllByType(MachineConfigurationReceipt)[0]!.props.model.name).toBe('Custom compute');
    await act(async () => screen.pressByTestId('managed-config.save-preset'));
    await waitForHomeGovernance(() =>
      expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(
        1,
      ),
    );
    const copied = readCreatedPreset(harness.requestsFor('/v1/machines/presets/create')[0]!.input);
    expect(copied).toMatchObject({
      homeId: preset.homeId,
      launch: { ...original.launch, name: 'Custom compute' },
      controller: preset.controller,
      ...policy,
    });
    for (const actionId of [
      'machines.provisioners.check',
      'machines.provisioners.options',
    ]) {
      const requests = harness.requestsFor(`/v1/actions/${actionId}`);
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests)
        expect(
          ExternalActionRequestEnvelopeV1Schema.parse(
            ExternalActionExecutionAuthorizationRequestV1Schema.parse(request.input).envelope,
          ).input,
        ).toMatchObject({ credentials: [savedCredential] });
    }
    expect(copied).not.toMatchObject({ id: preset.id });
    expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual(
      [],
    );
  });

  it('lists accessible presets on the Presets page and opens the selected Home', async () => {
    const serverId = await seed();
    await harness.selectHomes([serverId]);
    harness.answer(serverId, '/v1/machines/presets/list', {
      body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] },
    });
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
    await setActiveServer({ serverId });
    await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, []);
    const { MachinePresetsIndex } = await import('../presets/MachinePresetsIndex');
    const screen = await renderSettingsView(<MachinePresetsIndex />);
    const rowId = `preset-table.row.preset:${scopeId}:preset`;
    await waitForHomeGovernance(() => expect(screen.findByTestId(rowId)).not.toBeNull());
    await act(async () => screen.pressByTestId(rowId));
    expect(route.push).toHaveBeenLastCalledWith(
      `/settings/machines/presets/preset?serverId=${encodeURIComponent(scopeId)}`,
    );
    // The page's header "+" is its one create entry; no row repeats it.
    await act(async () => screen.pressByTestId('machine-presets.new:header'));
    expect(route.push).toHaveBeenLastCalledWith(
      expect.stringMatching(/^\/settings\/machines\/presets\/new\?serverId=/),
    );
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual(
      [],
    );
  });

  it('duplicates an opened list preset through the row command', async () => {
    const serverId = await seed();
    await harness.selectHomes([serverId]);
    const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
    await setActiveServer({ serverId });
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    const serverIds = [scopeId];
    harness.answer(serverId, '/v1/machines/presets/list', {
      body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] },
    });
    harness.answer(serverId, '/v1/machines/presets/create', {
      select: (input) => {
        const { id } = ManagedMachinePresetCreateInputV1Schema.parse(input);
        return { body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture({ ...preset, id, revision: 1, name: 'Build box copy' }) } };
      },
    });
    const { useMachinePresets, useMachinePresetRowCommands } = await import('./useMachinePresets');
    const { isOpenedManagedMachinePresetV1 } = await import('@/sync/ops/machines/machinePresetCollectionClient');
    const hook = await renderHook(() => ({
      inventory: useMachinePresets(serverIds),
      commands: useMachinePresetRowCommands(serverIds),
    }));
    try {
      const row = () => hook.getCurrent().inventory.presetsByServerId[scopeId]?.[0];
      await waitForHomeGovernance(() => expect(row()).toBeDefined());
      const opened = row();
      if (!opened || !isOpenedManagedMachinePresetV1(opened)) throw new Error('Expected an opened preset from the list');
      await act(async () => {
        const commands = hook.getCurrent().commands;
        const refused = await commands.duplicate(scopeId, opened, 'Build box copy');
        expect(refused).toMatchObject({ kind: 'failed', code: 'account_availability_not_loaded' });
        expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(0);

        await seedPresetDeclaration(serverId);
        const accepted = await commands.duplicate(scopeId, opened, 'Build box copy');
        expect(accepted, JSON.stringify(accepted)).toMatchObject({ kind: 'succeeded', value: { kind: 'saved', preset: { name: 'Build box copy' } } });
      });
    } finally {
      await hook.unmount();
    }
  });

  it('offers Create machine, Duplicate and Archive in a row\'s "…" through the preset Actions', async () => {
    const serverId = await seed();
    await harness.selectHomes([serverId]);
    await seedPresetDeclaration(serverId);
    harness.answer(serverId, '/v1/machines/presets/list', {
      body: { kind: 'listed', presets: [createPlainManagedMachinePresetFixture(preset)] },
    });
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
    await setActiveServer({ serverId });
    await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, []);
    const { MachinePresetsIndex } = await import('../presets/MachinePresetsIndex');
    const screen = await renderSettingsView(<MachinePresetsIndex />);
    const readMenu = () => screen.root.findAll((node) => Array.isArray(node.props.secondaryActions)
      && typeof node.props.onSecondaryAction === 'function'
      && node.props.secondaryActions.some((action: { id: string }) => action.id === 'archive'))[0];
    await waitForHomeGovernance(() => expect(readMenu()).toBeDefined());
    expect(readMenu()!.props.secondaryActions.map((action: { id: string }) => action.id))
      .toEqual(['createMachine', 'duplicate', 'archive']);

    await act(async () => readMenu()!.props.onSecondaryAction('createMachine'));
    expect(route.push).toHaveBeenLastCalledWith(expect.stringMatching(
      new RegExp(`^/settings/machines/add/[^?]+\\?serverId=${encodeURIComponent(scopeId)}&presetId=preset$`)));

    harness.answer(serverId, '/v1/machines/presets/create', {
      select: (input) => {
        const id = ManagedMachinePresetCreateInputV1Schema.parse(input).id;
        return { body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture({ ...preset, id, revision: 1, name: 'Build box copy' }) } };
      },
    });
    const { Modal } = await import('@/modal');
    const alert = vi.spyOn(Modal, 'alert');
    await act(async () => readMenu()!.props.onSecondaryAction('duplicate'));
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/create').length
      + alert.mock.calls.length).toBeGreaterThan(0));
    // A refused copy says so; this one must reach the create Action instead.
    expect(alert.mock.calls).toEqual([]);
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(1));
    const copyInput = harness.requestsFor('/v1/machines/presets/create')[0]!.input;
    expect(readCreatedPreset(copyInput)).toMatchObject({ homeId: preset.homeId, name: 'Build box copy',
      owner: preset.owner, controller: preset.controller, launch: preset.launch, simultaneousLimit: preset.simultaneousLimit });
    expect(ManagedMachinePresetCreateInputV1Schema.parse(copyInput).id).not.toBe(preset.id);
    // The copy opens on its own page, where it can be renamed.
    await waitForHomeGovernance(() => expect(route.push).toHaveBeenLastCalledWith(
      expect.stringMatching(new RegExp(`^/settings/machines/presets/(?!preset\\?)[^?]+\\?serverId=${encodeURIComponent(scopeId)}$`))));

    const { PresetMutationResultV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachinePresetV1');
    harness.answer(serverId, '/v1/machines/presets/archive', {
      select: (input) => {
        expect(input).toMatchObject({ homeId: preset.homeId, id: preset.id, expectedRevision: preset.revision });
        return { body: PresetMutationResultV1Schema.parse({ kind: 'saved',
          preset: createPlainManagedMachinePresetFixture({ ...preset, revision: preset.revision + 1, archivedAt: 1 }) }) };
      },
    });
    await act(async () => readMenu()!.props.onSecondaryAction('archive'));
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/archive')).toHaveLength(1));
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
  });

  it('opens history and edits the future launch on the captured Home without acquiring compute', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', {
      select: (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        expect(request.target).toEqual({
          kind: 'machine',
          machineId: preset.controller.machineId,
        });
        expect(request.input).toEqual({
          homeId: preset.homeId,
          controller: preset.controller,
        });
        return {
          body: {
            v: 1,
            actionId: 'machines.provisioners.list',
            requestId: request.requestId,
            execution: {
              ok: true,
              result: {
                controller: preset.controller,
                provisioners: [provisioner],
              },
            },
          },
        };
      },
    });
    const screen = await renderSettingsView(
      <MachinePresetView serverId={serverId} presetId="preset" />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-preset.detail.machine.resource'),
      ).not.toBeNull(),
    );
    await waitForHomeGovernance(() =>
      expect(screen.getTextContent()).toContain('Custom compute'),
    );
    expect(screen.findRowByTitle('Original guest')).not.toBeNull();
    expect(screen.findRowByTitle('Original guest')?.props.subtitle).toContain(
      '1',
    );
    await act(async () =>
      screen.pressByTestId('machine-preset.detail.machine.resource'),
    );
    expect(route.push).toHaveBeenLastCalledWith(
      `/settings/machines/managed/resource?serverId=${encodeURIComponent(scopeId)}`,
    );
    await act(async () => screen.pressByTestId('machine-preset.edit'));
    const configurationPath = `/settings/machines/add/${encodeURIComponent(buildQualifiedPluginContributionKey(preset.launch.provider))}?serverId=${encodeURIComponent(scopeId)}&presetId=preset`;
    expect(route.push).toHaveBeenLastCalledWith(
      `${configurationPath}&presetOnly=true`,
    );
    await act(async () =>
      screen.pressByTestId('machine-preset.detail.createOne'),
    );
    expect(route.push).toHaveBeenLastCalledWith(configurationPath);
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual(
      [],
    );
  });

  it('Project files: one How files get in select and its option group save through the one editor draft, and Prepare ahead keeps them', async () => {
    const serverId = await seed();
    await seedConfiguration(serverId);
    let stored = createPlainManagedMachinePresetFixture({ ...preset, preparation: { enabled: true },
      projectFiles: { kind: 'sync', mode: 'keep_both_in_sync' } });
    harness.answer(serverId, '/v1/machines/presets/get', { select: () => ({ body: { kind: 'found', preset: stored } }) });
    harness.answer(serverId, '/v1/machines/presets/update', { select: body => {
      const input = body as { patch: { content?: { t: string; v: { preparation?: unknown; projectFiles?: unknown } } } };
      stored = createPlainManagedMachinePresetFixture({ ...preset, revision: stored.revision + 1,
        preparation: input.patch.content?.v.preparation as { enabled: boolean },
        projectFiles: input.patch.content?.v.projectFiles as Parameters<typeof createPlainManagedMachinePresetFixture>[0]['projectFiles'] });
      return { body: { kind: 'saved', preset: stored } };
    } });
    const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId={preset.id} />);
    const saved = () => harness.requestsFor('/v1/machines/presets/update')
      .map(request => (request.input as { patch: { content?: { v: { preparation?: unknown; projectFiles?: { kind: string; mode?: string; contentPolicy?: { selection: string } } } } } }).patch.content?.v);
    const field = (testID: string) => screen.findAllByType(DropdownMenu)
      .find(menu => menu.props.itemTrigger?.itemProps?.testID === testID);
    try {
      await waitForHomeGovernance(() => expect(field('machine-preset.project-files.how')?.props.itemTrigger?.itemProps?.disabled).toBe(false));
      expect(field('machine-preset.project-files.how')?.props.selectedId).toBe('keep_both_in_sync');
      // Two-way sync says the one thing it adds, and its group carries the conflict rule before the content rows.
      expect(screen.findByTestId('machine-preset.project-files.deletions')).not.toBeNull();
      expect(screen.findByTestId('machine-preset.project-files.conflict')).not.toBeNull();
      // The option list marks Copy once Default and Two-way Advanced; Git clone is chosen from the folder (4bffe89568e).
      const items = field('machine-preset.project-files.how')!.props.items as ReadonlyArray<{ id: string; disabled?: boolean; rightElement?: unknown }>;
      expect(items.map(item => item.id)).toEqual(['copy_once', 'git_clone', 'keep_synced', 'keep_both_in_sync']);
      expect(items.find(item => item.id === 'git_clone')?.disabled).toBeUndefined();
      expect(items.filter(item => item.rightElement).map(item => item.id)).toEqual(['copy_once', 'keep_both_in_sync']);
      // A Prepare ahead edit keeps the preset's Project files.
      await act(async () => {
        (screen.tree.findByProps({ testID: 'machine-preset.prepare.updates', testIDPrefix: 'machine-preset.prepare.updates' }).props as
          { onChange: (next: string) => void }).onChange('rebuild-automatically');
      });
      await waitForHomeGovernance(() => expect(saved()).toHaveLength(1));
      expect(saved()[0]).toMatchObject({ preparation: { enabled: true, whenHappierUpdates: 'rebuild-automatically' },
        projectFiles: { kind: 'sync', mode: 'keep_both_in_sync' } });
      await waitForHomeGovernance(() => expect(stored.revision).toBe(preset.revision + 1));
      // Choosing Copy once stores it and keeps Prepare ahead.
      await act(async () => field('machine-preset.project-files.how')!.props.onSelect('copy_once'));
      await waitForHomeGovernance(() => expect(saved()).toHaveLength(2));
      expect(saved()[1]).toMatchObject({ projectFiles: { kind: 'copy_once' },
        preparation: { enabled: true, whenHappierUpdates: 'rebuild-automatically' } });
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.project-files.deletions')).toBeNull());
      // The option group's shipped content rows edit its content policy.
      await waitForHomeGovernance(() => expect(field('machine-preset.project-files.content-content-selection-trigger')).toBeDefined());
      await act(async () => field('machine-preset.project-files.content-content-selection-trigger')!.props.onSelect('all_files'));
      await waitForHomeGovernance(() => expect(saved()).toHaveLength(3));
      expect(saved()[2]).toMatchObject({ projectFiles: { kind: 'copy_once', contentPolicy: { selection: 'all_files' } } });
      await waitForHomeGovernance(() => expect(stored.revision).toBe(preset.revision + 3));
      // Git clone stores the folder-derived intent: repository and branch come from the session's folder.
      await act(async () => field('machine-preset.project-files.how')!.props.onSelect('git_clone'));
      await waitForHomeGovernance(() => expect(saved()).toHaveLength(4));
      expect(saved()[3]?.projectFiles).toEqual({ kind: 'git_clone' });
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.project-files.repository')).not.toBeNull());
    } finally { await screen.unmount(); }
  });

  it('a local sandbox preset leaves out the cloud-only sections, and Archive is a row with its own button (lab decision 3)', async () => {
    const serverId = await seed();
    await seedConfiguration(serverId, false, { enrollmentRole: 'sandbox', billing: { location: 'local', stoppedBilling: 'not-billed' } });
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(preset) } });
    const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId={preset.id} />);
    const model = () => screen.tree.findByType(MachinePresetDetail).props.model as MachinePresetDetailModel;
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.project-files')).not.toBeNull());
      // Who can use it, Running at once and Create one belong to presets that make machines for others.
      await waitForHomeGovernance(() => {
        expect(model().audience).toBeUndefined();
        expect(model().limit).toBeUndefined();
        expect(model().onCreateOne).toBeUndefined();
      });
      expect(screen.findByTestId('machine-preset.detail.createOne')).toBeNull();
      // "Archive preset" is a row: its consequence beneath, a quiet Archive button beside.
      const archiveRow = screen.findRowByTitle(t('machinePresets.archive'));
      expect(archiveRow?.props.subtitle).toBeTruthy();
      expect(screen.findByTestId('machine-preset.detail.archive')).not.toBeNull();
    } finally { await screen.unmount(); }
  });

  it('says how much storage the ready prepared image keeps', async () => {
    const serverId = await seed();
    const { replaceManagedMachinePresetPreparationV1 } = await import('@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
    const { formatMachineBytes } = await import('@/components/machines/vitals/machineVitalsPresentation');
    const stored = createPlainManagedMachinePresetFixture({ ...preset, preparation: { enabled: true } });
    const ready = (artifactSizeBytes?: number) => replaceManagedMachinePresetPreparationV1({ presetId: preset.id, mode: 'plain',
      content: stored.content, expectedOperationId: null, prepared: { operationId: 'measured-image-build', status: 'ready',
        ...(artifactSizeBytes === undefined ? {} : { artifactSizeBytes }),
        artifact: { contributionRef: preset.launch.provider, schemaVersion: preset.launch.schemaVersion, value: { image: 'measured-image' } },
        binding: { cliIdentity: 'supplier-identity', machineId: 'original-builder', credentialConfigurations: [],
          configuration: { launch: { provider: preset.launch.provider, schemaVersion: preset.launch.schemaVersion, choices: preset.launch.choices } } } } });
    const size = 1_288_490_189;
    const measured = ready(size);
    if (!measured) throw new Error('Expected a ready preparation');
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: { ...stored, content: measured.content } } });
    const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId={preset.id} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.preparation')).not.toBeNull());
      expect(screen.getTextContent()).toContain(formatMachineBytes(size, 'storage'));
    } finally { await screen.unmount(); }
  });

  it('says when the ready prepared image was built and from which revision (lab scene 5 ready)', async () => {
    const serverId = await seed();
    const { replaceManagedMachinePresetPreparationV1 } = await import('@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
    const { formatAsOfTime } = await import('@/utils/time/formatAsOfTime');
    const stored = createPlainManagedMachinePresetFixture({ ...preset, preparation: { enabled: true } });
    const builtAt = Date.UTC(2026, 10, 17, 9, 45);
    const built = replaceManagedMachinePresetPreparationV1({ presetId: preset.id, mode: 'plain',
      content: stored.content, expectedOperationId: null, prepared: { operationId: 'dated-image-build', status: 'ready',
        builtAt, builtFromRevision: 7,
        artifact: { contributionRef: preset.launch.provider, schemaVersion: preset.launch.schemaVersion, value: { image: 'dated-image' } },
        binding: { cliIdentity: 'supplier-identity', machineId: 'original-builder', credentialConfigurations: [],
          configuration: { launch: { provider: preset.launch.provider, schemaVersion: preset.launch.schemaVersion, choices: preset.launch.choices } } } } });
    if (!built) throw new Error('Expected a ready preparation');
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: { ...stored, content: built.content } } });
    const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId={preset.id} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.preparation')).not.toBeNull());
      const text = screen.getTextContent();
      expect(text).toContain(formatAsOfTime(builtAt));
      expect(text).toMatch(/\b7\b/);
      // Once the build's own operation is read back settled, the row still says the image is ready (lab
      // "Image ready"), not the operation's generic word.
      const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
      const { MACHINE_PRESET_PREPARE_ACTION_ID_V1 } = await import('@happier-dev/protocol/machines/managed/machinePresetActionsV1');
      await act(async () => actionOperationStore.mergeSnapshots({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), snapshots: [{
        version: 1, operationId: 'dated-image-build', revision: 3, actionId: MACHINE_PRESET_PREPARE_ACTION_ID_V1, state: 'succeeded',
        scope: { accountId: 'owner', machineId: 'original-builder' }, title: 'Prepare preset', createdAt: 1, startedAt: 2, settledAt: 3,
        cancellation: 'supported', progress: { kind: 'indeterminate', steps: [] } }] }));
      await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props.testID === 'machine-preset.preparation' && typeof node.props.title === 'string')[0]?.props.title)
        .toBe(t('machinePresets.prepareReady')));
    } finally { await screen.unmount(); }
  });

  it('archives and restores the preset with its reviewed revision: explains retained image cleanup after opting out of Prepare', async () => {
    const serverId = await seed();
    const { replaceManagedMachinePresetPreparationV1, replaceManagedMachinePresetAuthorContentV1 } =
  it('edits Prepare ahead in place: When Happier updates and the switch save the preset through the one editor draft', async () => {
    const serverId = await seed();
    // The launch is re-sealed with the content, so its provisioner must be declared here.
    await seedConfiguration(serverId);
    let stored = createPlainManagedMachinePresetFixture({ ...preset, preparation: { enabled: true } });
    harness.answer(serverId, '/v1/machines/presets/get', { select: () => ({ body: { kind: 'found', preset: stored } }) });
    harness.answer(serverId, '/v1/machines/presets/update', { select: body => {
      const input = body as { patch: { content?: { t: string; v: { preparation?: unknown } } } };
      stored = createPlainManagedMachinePresetFixture({ ...preset, revision: stored.revision + 1,
        preparation: input.patch.content?.v.preparation as { enabled: boolean } });
      return { body: { kind: 'saved', preset: stored } };
    } });
    const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId={preset.id} />);
    const savedPreparations = () => harness.requestsFor('/v1/machines/presets/update')
      .map(request => (request.input as { patch: { content?: { v: { preparation?: unknown; name?: string; launch?: unknown } } } }).patch.content?.v);
    try {
      const keep = () => screen.tree.findByProps({ testID: 'machine-preset.prepare.keep.switch' }).props as { disabled?: boolean; onValueChange: (next: boolean) => void };
      // Editable once the page knows this Account manages the preset.
      await waitForHomeGovernance(() => expect(keep().disabled).toBe(false));
      // The row's own choice handler: the segmented bar may fold into a field select at the test's width.
      await act(async () => {
        (screen.tree.findByProps({ testID: 'machine-preset.prepare.updates', testIDPrefix: 'machine-preset.prepare.updates' }).props as
          { onChange: (next: string) => void }).onChange('rebuild-automatically');
      });
      await waitForHomeGovernance(() => expect(savedPreparations()).toHaveLength(1));
      expect(savedPreparations()[0]).toMatchObject({ name: preset.name, launch: preset.launch,
        preparation: { enabled: true, whenHappierUpdates: 'rebuild-automatically' } });
      await waitForHomeGovernance(() => expect(stored.revision).toBe(preset.revision + 1));
      await act(async () => {
        keep().onValueChange(false);
      });
      await waitForHomeGovernance(() => expect(savedPreparations()).toHaveLength(2));
      expect(savedPreparations()[1]).toMatchObject({ preparation: { enabled: false, whenHappierUpdates: 'rebuild-automatically' } });
      // Off, the switch says it all: no image row, no update choice.
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.prepare.updates')).toBeNull());
      expect(screen.findByTestId('machine-preset.preparation')).toBeNull();
    } finally { await screen.unmount(); }
  });

      await import('@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
    const stored = createPlainManagedMachinePresetFixture({ ...preset, preparation: { enabled: true } });
    const built = replaceManagedMachinePresetPreparationV1({ presetId: preset.id, mode: 'plain', content: stored.content,
      expectedOperationId: null, prepared: { operationId: 'retained-image-build', status: 'ready',
        artifact: { contributionRef: preset.launch.provider, schemaVersion: preset.launch.schemaVersion, value: { image: 'retained-image' } },
        binding: { cliIdentity: 'supplier-identity', machineId: 'original-builder', credentialConfigurations: [],
          configuration: { launch: { provider: preset.launch.provider, schemaVersion: preset.launch.schemaVersion, choices: preset.launch.choices } } } } });
    if (!built) throw new Error('Expected a ready preparation');
    const edited = replaceManagedMachinePresetAuthorContentV1({ presetId: preset.id, mode: 'plain',
      projection: { content: built.content, recipientEnvelope: null },
      content: { v: 1, name: preset.name, launch: preset.launch, preparation: { enabled: false } } });
    if (!edited) throw new Error('Expected the authored opt-out to retain the prepared image');
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: { ...stored, content: edited.content } } });
    const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId={preset.id} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.detail.archive')).not.toBeNull());
      const model = screen.tree.findByType(MachinePresetDetail).props.model as MachinePresetDetailModel;
      expect(model.archiveHelp).toBeTruthy();
      expect(screen.findByTestId('machine-preset.preparation')).toBeNull();
    } finally { await screen.unmount(); }
  });

  it.each([false, true])('reveals an Archive refusal above the scrolled page and keeps the preset actionable (confirmation=%s)', async confirmation => {
    const serverId = await seed();
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    if (confirmation) await harness.requireUiApproval(serverId, 'machines.presets.archive');
    const { PresetMutationResultV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachinePresetV1');
    harness.answer(serverId, '/v1/machines/presets/archive', {
      status: 503, body: PresetMutationResultV1Schema.parse({ kind: 'refused', code: 'controller_unavailable' }),
    });
    const modalHost = await renderSettingsView(<ModalProvider />);
    // Browser scrolling is the boundary; retain the real ItemList/provider and reveal owner.
    let pageTop = 1200;
    const screen = await renderSettingsView(<MachinePresetView serverId={scopeId} presetId={preset.id} />, {
      createNodeMock: () => ({ scrollIntoView: () => { pageTop = 0; } }),
    });
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.detail.archive')?.props.disabled).toBe(false));
      const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
      harness.answer(serverId, '/v1/machines/presets/get', { status: 503, body: { kind: 'refused', code: 'controller_unavailable' } });
      await act(async () => publishHomeAccountChange(scopeId));
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.refresh-error')).not.toBeNull());
      await flushHookEffects();
      expect(pageTop).toBe(1200);
      harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(preset) } });
      await act(async () => publishHomeAccountChange(scopeId));
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.refresh-error')).toBeNull());
      await screen.pressByTestIdAsync('machine-preset.detail.archive');
      if (confirmation) {
        await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
        expect(harness.requestsFor('/v1/machines/presets/archive')).toEqual([]);
        expect(pageTop).toBe(1200);
        await act(async () => publishHomeAccountChange(scopeId));
        await flushHookEffects();
        await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-approve');
      }
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.mutation-error')).not.toBeNull());
      await waitForHomeGovernance(() => expect(pageTop).toBe(0));
      const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
      expect(screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'machine-preset.mutation-error')?.props.diagnosticCode)
        .toBe('controller_unavailable');
      expect(screen.findByTestId('machine-preset.archived')).toBeNull();
      expect(screen.findByTestId('machine-preset.detail.archive')?.props.disabled).toBe(false);
      expect(harness.requestsFor('/v1/machines/presets/archive')).toHaveLength(1);
      if (!confirmation) {
        pageTop = 1200;
        await screen.pressByTestIdAsync('machine-preset.detail.archive');
        await waitForHomeGovernance(() => expect(pageTop).toBe(0));
        expect(harness.requestsFor('/v1/machines/presets/archive')).toHaveLength(2);
      }
    } finally { await screen.unmount(); await modalHost.unmount(); }
  });

  it('archives and restores the preset with its reviewed revision without changing its admitted resources', async () => {
    const serverId = await seed();
    const archived = { ...preset, revision: 4, archivedAt: 1 } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    let storedPreset = createPlainManagedMachinePresetFixture(preset);
    harness.answer(serverId, '/v1/machines/presets/get', {
      select: () => ({ body: { kind: 'found', preset: storedPreset } }),
    });
    harness.answer(serverId, '/v1/machines/presets/archive', {
      select: () => {
        storedPreset = createPlainManagedMachinePresetFixture(archived);
        return { body: { kind: 'saved', preset: storedPreset } };
      },
    });
    const screen = await renderSettingsView(
      <MachinePresetView serverId={serverId} presetId="preset" />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-preset.detail.archive'),
      ).not.toBeNull(),
    );
    await act(async () =>
      screen.pressByTestId('machine-preset.detail.archive'),
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-preset.archived.action'),
      ).not.toBeNull(),
    );
    // FIX-PRESETS-BRIEF F2: one rendered explanation owns the archived state, and it carries the way back.
    expect(screen.getTextContent().split(t('machinePresets.archived')).length - 1).toBe(1);
    // FIDELITY-3: an archived preset makes nothing, so the header does not also say it can create one.
    const { PageHeader } = await import('@/components/ui/layout/PageHeader');
    expect(screen.tree.findByType(PageHeader).props.description).toBeUndefined();
    expect(screen.findByTestId('machine-preset.detail.createOne')).toBeNull();
    harness.answer(serverId, '/v1/machines/presets/restore', {
      select: () => {
        storedPreset = createPlainManagedMachinePresetFixture({ ...preset, revision: 5 });
        return { body: { kind: 'saved', preset: storedPreset } };
      },
    });
    await act(async () =>
      screen.pressByTestId('machine-preset.archived.action'),
    );
    await waitForHomeGovernance(() =>
      expect(
        harness.requestsFor('/v1/machines/presets/restore')[0]?.input,
      ).toEqual({ homeId: 'srv_history', id: 'preset', expectedRevision: 4 }),
    );
    expect(
      harness.requestsFor('/v1/machines/presets/archive')[0]?.input,
    ).toEqual({ homeId: 'srv_history', id: 'preset', expectedRevision: 3 });
    expect(
      screen.findByTestId('machine-preset.detail.machine.resource'),
    ).not.toBeNull();
    expect(
      harness.requests
        .filter((request) => request.path.includes('/managed/'))
        .every((request) => request.path.endsWith('/list')),
    ).toBe(true);
    expect(
      harness.requests
        .filter((request) => request.path.startsWith('/v1/actions/'))
        .every(
          (request) =>
            request.path === '/v1/actions/machines.provisioners.list',
        ),
    ).toBe(true);
  });

  it.each([true, false])('leaves an archived preset with its one notice naming the original image host when manual cleanup is required (listed=%s)', async listed => {
    const serverId = await seed();
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    const originalHostId = 'original-image-builder';
    const originalHostName = 'Original image builder';
    await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, [
      createMachineFixture({ id: preset.controller.machineId, installationId: preset.controller.installationId,
        metadata: { ...createMachineFixture().metadata!, displayName: 'Current controller' } }),
      ...(listed ? [createMachineFixture({ id: originalHostId,
        metadata: { ...createMachineFixture().metadata!, displayName: originalHostName } })] : []),
    ]);
    const { replaceManagedMachinePresetPreparationV1 } = await import('@happier-dev/protocol/machines/managed/managedMachinePresetContentV1');
    const stored = createPlainManagedMachinePresetFixture({ ...preset, archivedAt: 1, preparation: { enabled: true } });
    const operational = replaceManagedMachinePresetPreparationV1({ presetId: preset.id, mode: 'plain',
      content: stored.content, expectedOperationId: null, prepared: {
        operationId: 'archived-image-build', status: 'cancelled', code: 'preparation_cleanup_required',
        binding: { cliIdentity: 'supplier-identity', machineId: originalHostId, credentialConfigurations: [],
          configuration: { launch: { provider: preset.launch.provider, schemaVersion: preset.launch.schemaVersion, choices: preset.launch.choices } } },
      } });
    if (!operational) throw new Error('Expected the retained manual cleanup report');
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: { ...stored, content: operational.content } } });
    const { AttentionBanner } = await import('@/components/ui/lists/AttentionBanner');
    const screen = await renderSettingsView(<MachinePresetView serverId={scopeId} presetId={preset.id} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.archived.action')).not.toBeNull());
      const notice = screen.findAllByType(AttentionBanner).find(node => node.props.testID === 'machine-preset.archived');
      expect(notice?.props.description).toContain(listed ? originalHostName : originalHostId);
      expect(notice?.props.description).not.toContain('Current controller');
      expect(notice?.props.tone).toBe('warning');
      expect(screen.findByTestId('machine-preset.preparation')).toBeNull();
    } finally { await screen.unmount(); }
  });

  it('leaves an archived preset with its one notice when the provisioner read fails, since it makes nothing either way', async () => {
    const serverId = await seed();
    await seedConfiguration(serverId);
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture({ ...preset, archivedAt: 1 }) },
    });
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', {
      status: 503,
      body: { code: 'controller_unavailable' },
    });
    const screen = await renderSettingsView(
      <MachinePresetView serverId={serverId} presetId="preset" />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-preset.archived.action'),
      ).not.toBeNull(),
    );
    await waitForHomeGovernance(() =>
      expect(
        harness.requestsFor('/v1/actions/machines.provisioners.list').length,
      ).toBeGreaterThan(0),
    );
    // The same failure on an active preset is the creation line; here it would be a second, moot message under the notice.
    expect(screen.findByTestId('machine-preset.provider-error')).toBeNull();
    expect(screen.findByTestId('machine-preset.configuration-unavailable')).toBeNull();
  });

  it('edits Running at once and Managed from in place through the reviewed preset update Action', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    const builder = createMachineFixture({
      id: 'builder',
      installationId: 'builder-installation',
      metadata: { ...createMachineFixture().metadata!, displayName: 'Builder' },
    });
    await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, [
      createMachineFixture({ id: preset.controller.machineId, installationId: preset.controller.installationId }),
      builder,
    ]);
    await harness.requireUiApproval(serverId, 'machines.presets.update');
    const modalHost = await renderSettingsView(<ModalProvider />);
    const screen = await renderSettingsView(
      <MachinePresetView serverId={serverId} presetId="preset" />,
    );
    const field = (testID: string) =>
      screen
        .findAllByType(DropdownMenu)
        .find((menu) => menu.props.itemTrigger?.itemProps?.testID === testID);
    await waitForHomeGovernance(() =>
      expect(field('machine-preset.detail.limit')?.props.selectedId).toBe('2'),
    );
    expect(field('machine-preset.detail.controller')?.props.selectedId).toBe(
      preset.controller.machineId,
    );
    expect(
      field('machine-preset.detail.controller')?.props.items.map(
        (item: { id: string }) => item.id,
      ),
    ).toEqual(expect.arrayContaining([preset.controller.machineId, 'builder']));

    const limited = {
      ...preset,
      revision: 4,
      simultaneousLimit: { maximum: 3 },
    } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/update', {
      body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(limited) },
    });
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(limited) },
    });
    await act(async () =>
      field('machine-preset.detail.limit')!.props.onSelect('3'),
    );
    // The edit asks first, exactly like the configurator's Save; nothing is written before approval.
    await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
      expect(harness.artifacts(serverId).list()).toEqual([]);
    expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
    await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-approve');
    await waitForHomeGovernance(() =>
      expect(field('machine-preset.detail.limit')?.props.selectedId).toBe('3'),
    );

    harness.answer(serverId, '/v1/machines/presets/update', {
      body: { kind: 'conflict', currentRevision: 5 },
    });
    await act(async () =>
      field('machine-preset.detail.controller')!.props.onSelect('builder'),
    );
    await waitForHomeGovernance(() => expect(modalHost.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
      expect(harness.artifacts(serverId).list()).toEqual([]);
    await modalHost.pressByTestIdAsync('actions.confirmation-review.decision-approve');
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-preset.mutation-error'),
      ).not.toBeNull(),
    );
    expect(
      harness
        .requestsFor('/v1/machines/presets/update')
        .map((request) => request.input),
    ).toEqual([
      {
        homeId: preset.homeId,
        id: preset.id,
        expectedRevision: 3,
        patch: { simultaneousLimit: { maximum: 3 } },
      },
      {
        homeId: preset.homeId,
        id: preset.id,
        expectedRevision: 4,
        patch: {
          controller: {
            machineId: 'builder',
            installationId: 'builder-installation',
          },
          controllerPoolId: null,
        },
      },
    ]);
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual(
      [],
    );
  });

  it('names its controller apart from same-named machines, once, in its Managed from choice', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    const named = (id: string, installationId: string) => createMachineFixture({
      id, installationId, metadata: { ...createMachineFixture().metadata!, displayName: 'Builder' },
    });
    await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, [
      named(preset.controller.machineId, preset.controller.installationId), named('twin', 'twin-installation'),
    ]);
    const screen = await renderSettingsView(
      <MachinePresetView serverId={serverId} presetId="preset" />,
    );
    const field = () => screen.findAllByType(DropdownMenu)
      .find((menu) => menu.props.itemTrigger?.itemProps?.testID === 'machine-preset.detail.controller');
    await waitForHomeGovernance(() => expect(field()?.props.items).toHaveLength(2));
    const titles = field()!.props.items.map((item: { title: string }) => item.title);
    // Two machines called "Builder" read as two different choices, never the same label twice.
    expect(new Set(titles).size).toBe(2);
    const controllerTitle = field()!.props.items
      .find((item: { id: string }) => item.id === preset.controller.machineId).title as string;
    expect(controllerTitle).not.toBe('Builder');
    // The choice names it; the section's sentence and Member creation don't say it again.
    const description = String(screen.findGroup(t('managedMachines.config.managedFrom'))?.props.description).replace(/\u2060/g, '');
    expect(description).not.toContain(controllerTitle);
    await screen.unmount();
  });

  it('retains known controller subtitles across withdrawal and follows actual activity', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    // This Home publishes the authoritative presence protocol, so inactive is an immediate fact.
    await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, [createMachineFixture({
      id: preset.controller.machineId, installationId: preset.controller.installationId,
      activeAt: Date.now(), presenceProtocolVersion: 1,
    })]);
    const screen = await renderSettingsView(
      <MachinePresetView serverId={serverId} presetId="preset" />,
    );
    const model = () =>
      screen.findAllByType(MachinePresetDetail)[0]?.props.model;
    await waitForHomeGovernance(() =>
      expect(model()?.controller.row.subtitle).toBe(t('status.online')),
    );
    const {
      withdrawMachinePresenceForScope,
    } =
      await import('@/sync/domains/machines/reachability/machineReachability');
    const { storage } = await import('@/sync/domains/state/storage');
    const scope = { serverId: scopeId, accountId: 'owner' };
    const machine = storage.getState().machineListByServerId[scopeId]?.find(
      entry => entry.id === preset.controller.machineId,
    );
    if (!machine) throw new Error('Expected the seeded preset controller machine');
    await act(async () => withdrawMachinePresenceForScope(scope));
    await flushHookEffects({ cycles: 2, turns: 2 });
    expect(model()?.controller.row.subtitle).toBe(t('status.online'));
    expect(model()?.controller.row.choices[0].subtitle).toBe(t('status.online'));
    // An online controller leaves nothing to wait for, so no "needs to be online" sentence stands beside it.
    expect(model()?.controller.description).toBeUndefined();
    await act(async () => publishMachineActivityForTest([machine], { active: false, activeAt: Date.now() }));
    await waitForHomeGovernance(() => expect(model()?.controller.row.subtitle).toBe(t('status.offline')));
    expect(model()?.controller.row.choices[0].subtitle).toBe(t('status.offline'));
    expect(model()?.controller.description).toBe(t('managedMachines.controller.requiredUnnamed'));
    await act(async () => publishMachineActivityForTest([machine], { active: true, activeAt: Date.now() }));
    await waitForHomeGovernance(() =>
      expect(model()?.controller.row.subtitle).toBe(t('status.online')),
    );
    expect(model()?.controller.row.choices[0].subtitle).toBe(t('status.online'));
  });

  it('does not name a withdrawn controller offline while its provisioner catalog is unavailable', async () => {
    runtimeHost.current = 'native';
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    const { setActiveServer } = await import('@/sync/domains/server/serverRuntime');
    await setActiveServer({ serverId });
    const { useManagedControllerScope } =
      await import('./useManagedControllerScope');
    const controllerScope = await renderHook(() =>
      useManagedControllerScope({
        serverId: scopeId,
        preferred: preset.controller,
        testIDPrefix: 'withdrawn-controller',
      }),
    );
    await waitForHomeGovernance(() =>
      expect(controllerScope.getCurrent().controller).toEqual(
        preset.controller,
      ),
    );
    const { withdrawMachinePresenceForScope } =
      await import('@/sync/domains/machines/reachability/machineReachability');
    await act(async () =>
      withdrawMachinePresenceForScope({
        serverId: scopeId,
        accountId: 'owner',
      }),
    );
    expect(controllerScope.getCurrent()).toMatchObject({
      controller: preset.controller,
      machine: { id: preset.controller.machineId },
    });
    harness.answer(serverId, '/v1/actions/machines.provisioners.list', {
      status: 503,
      body: { code: 'unavailable' },
    });
    const screen = await renderSettingsView(
      <MachineProvisionerPicker
        serverId={scopeId}
      />,
    );
    const restorePopoverGlobals = withPopoverWebGlobals();
    try {
      await waitForHomeGovernance(() => expect(screen.findByTestId('managed-picker.controller.chip')).not.toBeNull());
      await screen.pressByTestIdAsync('managed-picker.controller.chip');
      await act(async () => reportPopoverContentLayout(screen.tree, { width: 400, height: 500 }));
      await waitForHomeGovernance(() => expect(screen.findByTestId(`managed-picker.controller.picker-option:${preset.controller.machineId}`), screen.getTextContent()).not.toBeNull());
      await screen.pressByTestIdAsync(`managed-picker.controller.picker-option:${preset.controller.machineId}`);
      await flushHookEffects({ cycles: 3, turns: 3 });
      expect(
        screen.findByTestId('managed-picker.unavailable'),
        screen.getTextContent(),
      ).not.toBeNull();
      expect(screen.findByTestId('managed-picker.offline')).toBeNull();
    } finally {
      await screen.unmount();
      await controllerScope.unmount();
      restorePopoverGlobals();
    }
  });

  it('marks the provisioner with its package’s contributed brand mark', async () => {
    const serverId = await seed();
    await seedConfiguration(serverId);
    const resource = {
      pluginId: preset.launch.provider.pluginId,
      localId: 'brand-icon',
    };
    const digest = `sha256:${'c'.repeat(64)}`;
    // The wrapped UI Vitest owner runs at the package root.
    const bytes = readFileSync(
      join(
        resolve(process.cwd(), '../..'),
        'packages/plugins/machine-hetzner/assets/brand.png',
      ),
    );
    seedOptionsDeclaration(
      provisioner,
      PluginJsonSchemaV2Schema.parse({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      true,
      {
        source: { kind: 'localPath', locator: '/plugins/custom-compute' },
        occurrenceId: 'package-occurrence',
        brand: {
          state: 'available',
          resource,
          digest,
          width: 256,
          height: 256,
        },
      },
    );
    const projected = boundary.rpc.getMockImplementation()!;
    // Daemon Resource transport only: brand admission and rendering stay real.
    boundary.rpc.mockImplementation(
      async (request: {
        machineId: string;
        method: string;
        payload: unknown;
      }) =>
        request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ
          ? {
              ok: true,
              resource,
              kind: 'asset',
              contentType: 'image/png',
              digest,
              bytesBase64: bytes.toString('base64'),
            }
          : projected(request),
    );
    const screen = await renderSettingsView(
      <MachinePresetView serverId={serverId} presetId="preset" />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen
          .findAllByType(HappierBrandMark)
          .some(
            (node) => node.props.brand.bytes?.byteLength === bytes.byteLength,
          ),
      ).toBe(true),
    );
  });

  it('draws a preset row with its provider’s brand mark at the row’s size (the rail and the machine picker)', async () => {
    const serverId = await seed();
    await seedConfiguration(serverId);
    const resource = {
      pluginId: preset.launch.provider.pluginId,
      localId: 'brand-icon',
    };
    const digest = `sha256:${'d'.repeat(64)}`;
    const bytes = readFileSync(
      join(
        resolve(process.cwd(), '../..'),
        'packages/plugins/machine-hetzner/assets/brand.png',
      ),
    );
    seedOptionsDeclaration(
      provisioner,
      PluginJsonSchemaV2Schema.parse({
        type: 'object',
        properties: {},
        additionalProperties: false,
      }),
      true,
      {
        source: { kind: 'localPath', locator: '/plugins/custom-compute' },
        occurrenceId: 'package-occurrence',
        brand: {
          state: 'available',
          resource,
          digest,
          width: 256,
          height: 256,
        },
      },
    );
    const projected = boundary.rpc.getMockImplementation()!;
    // Daemon Resource transport only: the launch's provider resolves through the real projection and brand owners.
    boundary.rpc.mockImplementation(
      async (request: {
        machineId: string;
        method: string;
        payload: unknown;
      }) =>
        request.method === RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_READ
          ? {
              ok: true,
              resource,
              kind: 'asset',
              contentType: 'image/png',
              digest,
              bytesBase64: bytes.toString('base64'),
            }
          : projected(request),
    );
    const { ManagedPresetMark, MANAGED_PROVISIONER_MARK_SIZE } =
      await import('./useManagedProvisionerPresentation');
    const screen = await renderSettingsView(
      <ManagedPresetMark
        serverId={serverId}
        preset={createPlainManagedMachinePresetFixture({ ...preset, teamAcquireDelegated: false }).opened}
        size={MANAGED_PROVISIONER_MARK_SIZE.rail}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen
          .findAllByType(HappierBrandMark)
          .some(
            (node) =>
              // The contributed art occupies the glyph ink inside the 15px rail mark slot.
              node.props.pixelSize === 13 &&
              node.props.brand.bytes?.byteLength === bytes.byteLength,
          ),
      ).toBe(true),
    );
  });

  it('marks a setup-only preset with the setup glyph and reads no provider projection for it', async () => {
    const serverId = await seed();
    const before = boundary.rpc.mock.calls.length;
    const {
      ManagedPresetMark,
      MANAGED_PROVISIONER_MARK_SIZE,
      MACHINE_SETUP_PRESET_GLYPH,
    } = await import('./useManagedProvisionerPresentation');
    // A setup-only preset carries no creation: no launch, no controller.
    const screen = await renderSettingsView(
      <ManagedPresetMark
        serverId={serverId}
        preset={{ launch: null, controller: null }}
        size={MANAGED_PROVISIONER_MARK_SIZE.rail}
      />,
    );
    const { Icon } = await import('@/components/ui/icons/Icon');
    expect(screen.findAllByType(Icon).map((node) => node.props.name)).toEqual([
      MACHINE_SETUP_PRESET_GLYPH,
    ]);
    expect(screen.findAllByType(HappierBrandMark)).toHaveLength(0);
    expect(boundary.rpc.mock.calls.length).toBe(before);
  });

  it('opens a setup-only preset detail with its setup and no creation reads', async () => {
    const serverId = await seed();
    const { launch: _launch, controller: _controller, simultaneousLimit: _limit, ...rest } = preset;
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture({ ...rest, name: 'Web host setup', setup: {
        items: [{ kind: 'softwareRecipe', selection: { ref: { pluginId: 'happier.machine.recipes', recipeId: 'google-chrome', revision: '1' }, inputs: {} } }],
        scripts: [{ body: 'echo ready' }] } }) },
    });
    const screen = await renderSettingsView(
      <MachinePresetView serverId={serverId} presetId="preset" />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('machine-preset.detail')).not.toBeNull(),
    );
    const text = screen.getTextContent();
    expect(text).toContain('Web host setup');
    // A setup-only preset makes nothing: no provider catalog, no create, no Managed from, no Machines made from it.
    expect(harness.requestsFor('/v1/actions/machines.provisioners.list')).toHaveLength(0);
    expect(screen.findByTestId('machine-preset.detail.createOne')).toBeNull();
    expect(text).not.toContain(t('machinePresets.madeFrom'));
    expect(text).not.toContain(t('machinePresets.archiveHelp'));
    expect(text).toContain(t('machinePresets.archiveSetupHelp'));
    // What it sets up counts its Store items too, and says each fact once (no spec line repeating the rows).
    expect(text).toContain(t('machinePresets.setup.itemCount', { count: 1 }));
    expect(text).not.toContain(t('machinePresets.setup.fact', { label: t('machinePresets.setup.setup'),
      value: t('machinePresets.setup.setupLines', { count: 1 }) }));
    await screen.unmount();
  });

  it('withdraws launch and history after the credential lifetime retires', async () => {
    const serverId = await seed();
    const screen = await renderSettingsView(
      <MachinePresetView serverId={serverId} presetId="preset" />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-preset.detail.machine.resource'),
      ).not.toBeNull(),
    );
    harness.answer(serverId, '/v1/machines/presets/get', {
      status: 403,
      body: { kind: 'refused', code: 'permission_denied' },
    });
    await act(async () => {
      await harness.switchAccount(serverId, 'other-owner');
    });
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-preset.detail.machine.resource'),
      ).toBeNull(),
    );
    expect(screen.findByTestId('machine-preset.edit')).toBeNull();
  });

  it('uses the Team capability projection for management even when the viewer role says owner', async () => {
    const serverId = await seed();
    const teamPreset = {
      ...preset,
      owner: { kind: 'team', teamId: 'team-1' },
    } as const;
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(teamPreset) },
    });
    const { bindHomeDomainActionHttpRequestV1 } =
      await import('@happier-dev/protocol/actions/homeDomainActionFamily');
    const request = bindHomeDomainActionHttpRequestV1('teams.get', {
      v: 1,
      teamId: 'team-1',
    });
    harness.answer(serverId, request.path, {
      body: teamSummaryFixture({
        name: 'Platform',
        viewerRole: 'owner',
        capabilities: teamCapabilitiesFixture({ manageSettings: false }),
      }),
    });
    const screen = await renderSettingsView(
      <MachinePresetView serverId={serverId} presetId="preset" />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findRowByTitle('Platform')).not.toBeNull(),
    );
    expect(screen.findByTestId('machine-preset.edit')).toBeNull();
    expect(screen.findByTestId('machine-preset.detail.archive')).toBeNull();
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual(
      [],
    );
  });

  it('lets a Team manager turn member creation on and off through the revisioned update, and shows it read-only to everyone else', async () => {
    const serverId = await seed();
    const teamPreset = {
      ...preset,
      owner: { kind: 'team', teamId: 'team-1' },
      teamAcquireDelegated: false,
    } as const;
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(teamPreset) },
    });
    const { bindHomeDomainActionHttpRequestV1 } =
      await import('@happier-dev/protocol/actions/homeDomainActionFamily');
    const request = bindHomeDomainActionHttpRequestV1('teams.get', {
      v: 1,
      teamId: 'team-1',
    });
    harness.answer(serverId, request.path, {
      body: teamSummaryFixture({
        name: 'Platform',
        capabilities: teamCapabilitiesFixture({ manageSettings: true }),
      }),
    });
    const screen = await renderSettingsView(
      <MachinePresetView serverId={serverId} presetId="preset" />,
    );
    const toggle = () =>
      screen.findByTestId('machine-preset.detail.memberCreate.switch');
    await waitForHomeGovernance(() =>
      expect(toggle()?.props.value).toBe(false),
    );
    expect(toggle()?.props.disabled).toBeFalsy();
    const enabled = {
      ...teamPreset,
      revision: preset.revision + 1,
      teamAcquireDelegated: true,
    } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/update', {
      body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(enabled) },
    });
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(enabled) },
    });
    await act(async () => {
      await toggle()!.props.onValueChange(true);
    });
    await waitForHomeGovernance(() => expect(toggle()?.props.value).toBe(true));
    await waitForHomeGovernance(() =>
      expect(toggle()?.props.disabled).toBeFalsy(),
    );
    const withdrawn = {
      ...enabled,
      revision: enabled.revision + 1,
      teamAcquireDelegated: false,
    } satisfies Parameters<typeof createPlainManagedMachinePresetFixture>[0];
    harness.answer(serverId, '/v1/machines/presets/update', {
      body: { kind: 'saved', preset: createPlainManagedMachinePresetFixture(withdrawn) },
    });
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(withdrawn) },
    });
    await act(async () => {
      await toggle()!.props.onValueChange(false);
    });
    await waitForHomeGovernance(() =>
      expect(toggle()?.props.value).toBe(false),
    );
    expect(
      harness
        .requestsFor('/v1/machines/presets/update')
        .map((row) => row.input),
    ).toEqual([
      {
        homeId: preset.homeId,
        id: preset.id,
        expectedRevision: preset.revision,
        patch: { teamAcquireDelegated: true },
      },
      {
        homeId: preset.homeId,
        id: preset.id,
        expectedRevision: enabled.revision,
        patch: { teamAcquireDelegated: false },
      },
    ]);
    await screen.unmount();

    harness.answer(serverId, request.path, {
      body: teamSummaryFixture({
        name: 'Platform',
        capabilities: teamCapabilitiesFixture({ manageSettings: false }),
      }),
    });
    const viewer = await renderSettingsView(
      <MachinePresetView serverId={serverId} presetId="preset" />,
    );
    await waitForHomeGovernance(() =>
      expect(
        viewer.findByTestId('machine-preset.detail.memberCreate.switch')?.props
          .disabled,
      ).toBe(true),
    );
    expect(
      viewer.findRowByTitle(t('machinePresets.memberCreateRow'))?.props
        .subtitle,
    ).toBe(t('machinePresets.memberCreateManagersOnly', { team: 'Platform' }));
    await viewer.unmount();
  });

  it.each(['memberCreate', 'limit', 'controller'] as const)('persists the latest %s choice after an in-flight preset save', async field => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, [
      createMachineFixture({ id: preset.controller.machineId, installationId: preset.controller.installationId }),
      createMachineFixture({ id: 'builder', installationId: 'builder-installation' }),
    ]);
    const initial = { ...preset, owner: { kind: 'team', teamId: 'team-1' }, teamAcquireDelegated: false } as const;
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(initial) },
    });
    const { bindHomeDomainActionHttpRequestV1 } = await import('@happier-dev/protocol/actions/homeDomainActionFamily');
    harness.answer(serverId, bindHomeDomainActionHttpRequestV1('teams.get', { v: 1, teamId: 'team-1' }).path, {
      body: teamSummaryFixture({ name: 'Platform', capabilities: teamCapabilitiesFixture({ manageSettings: true }) }),
    });
    // Delay only the HTTP boundary; the mounted editor and revisioned Action path remain real.
    let release!: () => void;
    const respondAfter = new Promise<void>(resolve => { release = resolve; });
    onTestFinished(() => release());
    const firstPatch = field === 'memberCreate' ? { teamAcquireDelegated: true }
      : field === 'limit' ? { simultaneousLimit: { maximum: 3 } }
        : { controller: { machineId: 'builder', installationId: 'builder-installation' }, controllerPoolId: null };
    const secondPatch = field === 'memberCreate' ? { teamAcquireDelegated: false }
      : field === 'limit' ? { simultaneousLimit: { maximum: 4 } }
        : { controller: preset.controller, controllerPoolId: null };
    const firstSaved = createPlainManagedMachinePresetFixture({ ...initial, ...firstPatch, controllerPoolId: undefined, revision: initial.revision + 1 });
    const finalSaved = createPlainManagedMachinePresetFixture({ ...initial, ...secondPatch, controllerPoolId: undefined, revision: initial.revision + 2 });
    let persisted = createPlainManagedMachinePresetFixture(initial);
    harness.answer(serverId, '/v1/machines/presets/update', { select: async input => {
      const request = ManagedMachinePresetUpdateInputV1Schema.parse(input);
      if (request.expectedRevision !== persisted.revision) return { body: { kind: 'conflict', preset: persisted } };
      if (persisted.revision === initial.revision) { await respondAfter; persisted = firstSaved; }
      else persisted = finalSaved;
      return { body: { kind: 'saved', preset: persisted } };
    } });
    const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId="preset" />);
    const model = () => screen.tree.findByType(MachinePresetDetail).props.model as MachinePresetDetailModel;
    await waitForHomeGovernance(() => expect(model().memberCreate?.readOnly).toBe(false));
    const change = (second: boolean) => field === 'memberCreate' ? model().memberCreate!.onChange(!second)
      : field === 'limit' ? model().limit!.row.onChange!(second ? '4' : '3')
        : model().controller!.row.onChange!(second ? preset.controller.machineId : 'builder');
    await act(async () => { change(false); });
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1));
    await act(async () => { change(true); });
    expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1);
    await act(async () => { release(); });
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update').map(row => row.input)).toEqual([
      { homeId: preset.homeId, id: preset.id, expectedRevision: initial.revision, patch: firstPatch },
      { homeId: preset.homeId, id: preset.id, expectedRevision: firstSaved.revision, patch: secondPatch },
    ]));
    expect(persisted).toEqual(finalSaved);
    await waitForHomeGovernance(() => expect(field === 'memberCreate' ? model().memberCreate!.value
      : field === 'limit' ? model().limit!.row.value : model().controller!.row.value)
      .toBe(field === 'memberCreate' ? false : field === 'limit' ? '4' : preset.controller.machineId));
    await screen.unmount();
  });

  it('rolls back queued optimistic choices when the in-flight preset save is refused', async () => {
    const serverId = await seed();
    const initial = { ...preset, owner: { kind: 'team', teamId: 'team-1' }, teamAcquireDelegated: true } as const;
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: createPlainManagedMachinePresetFixture(initial) },
    });
    const { bindHomeDomainActionHttpRequestV1 } = await import('@happier-dev/protocol/actions/homeDomainActionFamily');
    harness.answer(serverId, bindHomeDomainActionHttpRequestV1('teams.get', { v: 1, teamId: 'team-1' }).path, {
      body: teamSummaryFixture({ name: 'Platform', capabilities: teamCapabilitiesFixture({ manageSettings: true }) }),
    });
    let release!: () => void;
    const respondAfter = new Promise<void>(resolve => { release = resolve; });
    onTestFinished(() => release());
    harness.answer(serverId, '/v1/machines/presets/update', { respondAfter,
      status: 400, body: { kind: 'refused', code: 'account_mode_mismatch' } });
    const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId="preset" />);
    const toggle = () => screen.findByTestId('machine-preset.detail.memberCreate.switch');
    await waitForHomeGovernance(() => expect(toggle()?.props.value).toBe(true));
    await act(async () => { toggle()!.props.onValueChange(false); });
    await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1));
    await act(async () => { toggle()!.props.onValueChange(false); });
    expect(toggle()?.props.value).toBe(false);
    await act(async () => { release(); });
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-preset.mutation-error')).not.toBeNull());
    await waitForHomeGovernance(() => expect(toggle()?.props.value).toBe(true));
    expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(1);
    await screen.unmount();
  });

  it('offers no member-creation control on a personal preset', async () => {
    const serverId = await seed();
    const screen = await renderSettingsView(
      <MachinePresetView serverId={serverId} presetId="preset" />,
    );
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('machine-preset.detail.limit')).not.toBeNull(),
    );
    expect(
      screen.findByTestId('machine-preset.detail.memberCreate.switch'),
    ).toBeNull();
    await screen.unmount();
  });
});
