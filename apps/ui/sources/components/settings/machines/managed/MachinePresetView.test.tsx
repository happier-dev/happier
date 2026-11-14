import {
  createManagedCpuOptionsFixture,
  createMachineProvisionerOptionsFixture,
  createDelegatedManagedPresetFixture,
} from '@/dev/testkit/fixtures/machineProvisionerFixtures';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
  createHomeGovernanceHarness,
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
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
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
import { ManagedMachinePresetCreateInputV1Schema, ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';

const route = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), params: {} as Record<string, string | string[] | undefined> }));
const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
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
const { resolveServerProfileScopeIdForIdentifier } =
  await import('@/sync/domains/server/serverProfiles');
const { clearDaemonMergedProjectionCacheForTests } =
  await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { resetMachineProjectionReadsForTests } =
  await import('@/sync/ops/machineContributionRegistryProjection');
beforeEach(async () => {
  await harness.reset();
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

async function seedConfiguration(serverId: string) {
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
      { controller: preset.controller, provisioners: [provisioner] },
    ],
    ['machines.provisioners.check', { available: true }],
    [
      'machines.provisioners.options',
      createManagedCpuOptionsFixture([
        { id: 'saved', title: 'Saved size' },
        { id: 'large', title: 'Larger size', cpu: 4 },
      ]),
    ],
  ] as const)
    harness.answer(serverId, `/v1/actions/${actionId}`, {
      select: (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        // The picker also asks the Account catalog for controller-free offers.
        if (actionId === 'machines.provisioners.list' && request.target?.kind !== 'machine') return {
          body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true, result: { provisioners: [] } } },
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
  return scopeId;
}

describe('reachable preset detail', () => {
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

      const changed = { ...preset, revision: preset.revision + 1, name: 'Updated preset' };
      harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: changed } });
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
    const setupOnly = ManagedMachinePresetV1Schema.parse({
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
        .toBe(setupOnly.name));
      await flushHookEffects({ cycles: 30 });
      expect(screen.findByTestId('machine-preset.read-state')).toBeNull();
      expect(screen.tree.findByType(MachinePresetDetail).props.model.onCreateOne).toBeUndefined();
      expect(harness.requests.filter(request => request.path.includes('machines.provisioners.'))).toEqual([]);
      expect(harness.requests.filter(request => /\/(?:connect|connected-services|account\/profile)(?:\/|$)/.test(request.path))).toEqual([]);
      expect(boundary.rpc).not.toHaveBeenCalled();
    } finally { await screen.unmount(); }
  });

  it('opens a setup-only Preset editor without making controller readiness a dependency of its Preset read', async () => {
    const serverId = await seed();
    await seedConfiguration(serverId);
    const setupOnly = ManagedMachinePresetV1Schema.parse({
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
    const archived = { ...preset, archivedAt: 1, launch: { ...preset.launch, provider } };
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: archived } });
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

  it('keeps the running limit billing warning off a preset that runs on its controller and bills nobody', async () => {
    const serverId = await seed();
    const local = { ...preset, launch: { ...preset.launch, provider: { pluginId: 'happier.machine.cua', localId: 'local-sandbox' } } };
    harness.answer(serverId, '/v1/machines/presets/get', { body: { kind: 'found', preset: local } });
    const screen = await renderSettingsView(<MachinePresetView serverId={serverId} presetId={preset.id} />);
    await waitForHomeGovernance(() => expect(screen.tree.findByType(MachineConfigurationReceipt).props.model.cost?.kind).toBe('local'));
    expect(screen.getTextContent()).not.toContain(t('machinePresets.limitHelp'));
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

  it.each(['detail', 'editor'] as const)('reads no private creation data for an unknown Preset (%s)', async surface => {
    const serverId = await seed();
    await seedConfiguration(serverId);
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'refused', code: 'preset_not_found' },
    });
    const screen = await renderSettingsView(surface === 'detail'
      ? <MachinePresetView serverId={serverId} presetId="missing-preset" />
      : <ManagedMachineConfigurationView serverId={serverId} presetId="missing-preset"
          provisioner={buildQualifiedPluginContributionKey(preset.launch.provider)} presetOnly />);
    try {
      await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(1));
      await flushHookEffects({ cycles: 30 });
      expect(harness.requests.filter(request => request.path.includes('machines.provisioners.'))).toEqual([]);
      expect(boundary.rpc).not.toHaveBeenCalled();
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
    await waitForHomeGovernance(() => expect(sizeControl(screen)?.props.sizes.some((size: { id: string }) => size.id === 'large')).toBe(true));
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
    };
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: teamPreset },
    });
    await harness.requireUiApproval(serverId, 'machines.presets.update');
    const { useMachinePresetDetail } = await import('./useMachinePresets');
    const { useActionApprovalContinuation } =
      await import('@/components/approvals/useActionApprovalContinuation');
    const registrations: string[] = [];
    const hook = await renderHook(() => {
      const detail = useMachinePresetDetail(scopeId, preset.id, (value) => {
        registrations.push(
          typeof value === 'string' ? value : value.artifactId,
        );
        approval.requestApproval(value);
      });
      const approval = useActionApprovalContinuation({
        scopeKey: 'team-spending',
        serverId: scopeId,
        onExecuted: detail.refresh,
      });
      return detail;
    });
    await waitForHomeGovernance(() =>
      expect(hook.getCurrent().state.value?.preset.id).toBe(preset.id),
    );
    try {
      await act(async () => {
        await hook.getCurrent().update({ teamAcquireDelegated: true });
      });
      await waitForHomeGovernance(() => expect(registrations).toHaveLength(1));
      expect(harness.requestsFor('/v1/machines/presets/update')).toHaveLength(
        0,
      );
      const delegated = {
        ...teamPreset,
        revision: preset.revision + 1,
        teamAcquireDelegated: true,
      };
      harness.answer(serverId, '/v1/machines/presets/update', {
        body: { kind: 'saved', preset: delegated },
      });
      harness.answer(serverId, '/v1/machines/presets/get', {
        body: { kind: 'found', preset: delegated },
      });
      await act(async () => {
        await expect(
          decideApprovalAsInbox(scopeId, registrations[0]!, 'approve'),
        ).resolves.toMatchObject({ ok: true });
      });
      await waitForHomeGovernance(() =>
        expect(hook.getCurrent().state.value?.preset.teamAcquireDelegated).toBe(
          true,
        ),
      );
      await act(async () => {
        await hook.getCurrent().update({ teamAcquireDelegated: false });
      });
      await waitForHomeGovernance(() => expect(registrations).toHaveLength(2));
      harness.answer(serverId, '/v1/machines/presets/update', {
        status: 403,
        body: { kind: 'refused', code: 'permission_denied' },
      });
      await act(async () => {
        await expect(
          decideApprovalAsInbox(scopeId, registrations[1]!, 'approve'),
        ).resolves.toMatchObject({ ok: true });
      });
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
    }
  });
  it.each([
    ['fixed', 'https://cloud-images.ubuntu.com/releases/resolute/release-20260927/ubuntu-26.04-server-cloudimg-amd64.img'],
    ['failing', 'template:fixture-missing-g1-options-1111'],
  ] as const)('keeps saved Lima launch facts in the expanded Summary before and after a typed use failure (%s)', async (_kind, image) => {
    const viewport = vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 1, fontScale: 1 });
    const { Modal, ModalProvider } = await import('@/modal');
    try {
      const serverId = await seed(true, true);
      const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
      const { BUNDLED_MACHINE_PROVISIONER_DECLARATIONS } = await import('@/agents/registry/generatedBundledPluginEntries');
      const lima = BUNDLED_MACHINE_PROVISIONER_DECLARATIONS['happier.machine.lima/lima'];
      if (!lima) throw new Error('Expected the bundled Lima declaration');
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
      await act(async () => screen.pressByTestId('managed-config.summary'));
      await waitForHomeGovernance(() => expect(screen.tree.findAllByType(MachineConfigurationReceipt)).toHaveLength(1));
      const expectSavedSummary = (rendered = screen) => {
        const receipt = rendered.tree.findByType(MachineConfigurationReceipt).props.model;
        expect(receipt.facts).toEqual(expect.arrayContaining([
          expect.objectContaining({ label: 'Image', value: image }),
          expect.objectContaining({ label: 'Store', value: choices.store }),
          expect.objectContaining({ label: expect.stringMatching(/cpu/i), value: '4' }),
          expect.objectContaining({ label: expect.stringMatching(/memory/i), value: '4' }),
          expect.objectContaining({ label: expect.stringMatching(/disk/i), value: '100' }),
        ]));
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
      harness.answer(serverId, `/v1/actions/machines.provisioners.${role}`, {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
          const nativeCause = {
            httpStatusClass: '4xx',
            code: 'forbidden',
          } as const;
          return {
            body: {
              v: 1,
              actionId: `machines.provisioners.${role}`,
              requestId: request.requestId,
              execution: {
                ok: true,
                result:
                  role === 'check'
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
                      },
              },
            },
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
      await waitForHomeGovernance(() =>
        expect(
          sizeControl(screen)?.props.sizes.some(
            (size: { id: string }) => size.id === 'large',
          ),
          JSON.stringify({ text: screen.getTextContent(), requests: harness.requests.map(request => request.path) }),
        ).toBe(true),
      );
      await act(async () => sizeControl(screen)?.props.onChange('large'));
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
        expect(sizeControl(screen)?.props.value).toBe('large');
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
      body: { kind: 'listed', presets: [preset] },
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
        screen.root
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
    harness.answer(serverId, '/v1/actions/machines.provisioners.options', {
      status: 503,
      body: { code: 'controller_unavailable' },
    });
    const screen = await renderSettingsView(
      <MachinePresetView serverId={scopeId} presetId="preset" />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-preset.configuration-unavailable'),
      ).not.toBeNull(),
    );
    await flushHookEffects();
    // A form that cannot succeed is never offered: the line above says why, and its Retry is the way on.
    expect(screen.findByTestId('machine-preset.detail.createOne')).toBeNull();
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
    expect(listFailed.findByTestId('machine-preset.detail.createOne')).toBeNull();
    await listFailed.unmount();
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
    expect(model.controller?.row.title).toBe(t('managedMachines.receipt.managingComputer'));
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
    };
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: teamPreset },
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
      };
      harness.answer(serverId, '/v1/machines/presets/get', {
        body: { kind: 'found', preset: { ...preset, setup } },
      });
      await harness.requireUiApproval(serverId, 'machines.presets.update');
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
      await act(async () => sizeControl(screen)?.props.onChange('large'));
      await waitForHomeGovernance(() =>
        expect(
          screen.findByTestId('managed-config.create')?.props.disabled,
        ).toBe(false),
      );
      await act(async () => screen.pressByTestId('managed-config.create'));
      await waitForHomeGovernance(() =>
        expect(harness.artifacts(serverId).list()).toHaveLength(1),
      );
      const pendingId = harness.artifacts(serverId).list()[0]!.id;
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
      ).toHaveLength(2);
      if (code === 'permission_denied') {
        expect(
          screen.findByTestId('managed-config.setup.setup.input'),
        ).toBeNull();
        expect(
          screen.findByTestId('managed-config.setup.secret:TOKEN'),
        ).toBeNull();
        expect(sizeControl(screen)).toBeUndefined();
        expect(screen.findByTestId('managed-config.receipt')).toBeNull();
        expect(screen.findByTestId('managed-config.create')).toBeNull();
      } else {
        expect(
          screen.findByTestId('managed-config.setup.setup.input')?.props.value,
        ).toBe('echo unsaved setup');
        expect(sizeControl(screen)?.props.value).toBe('large');
      }
      harness.answer(serverId, '/v1/machines/presets/update', {
        body: { kind: 'saved', preset: { ...preset, revision: 4 } },
      });
      await expect(
        decideApprovalAsInbox(scopeId, pendingId, 'approve'),
      ).resolves.toMatchObject({ ok: true });
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
      };
      harness.answer(serverId, '/v1/machines/presets/get', {
        body: { kind: 'found', preset: saved },
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
      harness.answer(serverId, '/v1/actions/machines.provisioners.options', {
        select: (value) => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
          expect(request.target).toEqual({
            kind: 'machine',
            machineId: preset.controller.machineId,
          });
          const reviewed =
            request.input !== null &&
            typeof request.input === 'object' &&
            'selectors' in request.input &&
            pluginJsonValuesEqual(request.input.selectors, selectors);
          return {
            body: {
              v: 1,
              actionId: 'machines.provisioners.options',
              requestId: request.requestId,
              execution: {
                ok: true,
                result: createMachineProvisionerOptionsFixture({
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
                }),
              },
            },
          };
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
          harness.requestsFor('/v1/actions/machines.provisioners.options')[0]!
            .input,
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
    };
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: saved },
    });
    harness.answer(serverId, '/v1/actions/machines.provisioners.options', {
      select: (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
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
            actionId: 'machines.provisioners.options',
            requestId: request.requestId,
            execution: {
              ok: true,
              result: createMachineProvisionerOptionsFixture(
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
              ),
            },
          },
        };
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
        harness.requestsFor(`/v1/actions/${actionId}`)[0]!.input,
      );
      expect(envelope.input).toMatchObject({ credentials: [savedCredential] });
    }
    await waitForHomeGovernance(() =>
      expect(screen.getTextContent()).toContain('Four cores'),
    );
    expect(screen.getTextContent()).toContain('Linux guest');
    expect(screen.getTextContent()).toContain('West coast');
    expect(screen.getTextContent()).toContain('Native quote');
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
    harness.answer(serverId, '/v1/actions/machines.provisioners.options', {
      select: (value) => {
        const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
        return {
          body: {
            v: 1,
            actionId: 'machines.provisioners.options',
            requestId: request.requestId,
            execution: {
              ok: true,
              result: createMachineProvisionerOptionsFixture({
                base: {
                  launch: { cpu: 8 },
                  nativeFacts: { size: { id: 'other', title: 'Other size' } },
                },
              }),
            },
          },
        };
      },
    });
    await act(async () => publishHomeAccountChange(scopeId));
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-preset.configuration-unavailable'),
      ).not.toBeNull(),
    );
    expect(screen.getTextContent()).toContain('Four cores');
    expect(screen.getTextContent()).toContain('Native quote');
    expect(screen.getTextContent()).not.toContain('Other size');
    expect(configurationReads()).toEqual(initialReads.map(count => count + 1));
    harness.answer(serverId, '/v1/actions/machines.provisioners.options', {
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
    expect(screen.getTextContent()).toContain('Native quote');
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
          value: t('common.unknown'),
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

  it('opens New preset through the exact controller picker and saves a launch without acquiring', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    const picker = await renderSettingsView(
      <MachineProvisionerPicker serverId={scopeId} presetOnly />,
    );
    // The Home's one controller is preselected, so its catalog is the first frame.
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
      machineId: preset.controller.machineId,
      installationId: preset.controller.installationId,
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
    await waitForHomeGovernance(() =>
      expect(
        sizeControl(screen)?.props.sizes.some(
          (size: { id: string }) => size.id === 'large',
        ),
      ).toBe(true),
    );
    await act(async () => sizeControl(screen)?.props.onChange('large'));
    expect(
      screen.findByTestId('managed-config.receipt:keep:choice:deadline'),
    ).toBeNull();
    harness.answer(serverId, '/v1/machines/presets/create', {
      select: (input) => {
        expect(input).toMatchObject({
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
        const id =
          input && typeof input === 'object' && 'id' in input ? input.id : null;
        expect(typeof id).toBe('string');
        return {
          body: {
            kind: 'saved',
            preset: {
              ...preset,
              id,
              revision: 1,
              name: 'Custom compute',
              launch: {
                ...preset.launch,
                name: 'Custom compute',
                choices: { cpu: 4 },
              },
            },
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
    await waitForHomeGovernance(() =>
      expect(
        sizeControl(screen)?.props.sizes.some(
          (size: { id: string }) => size.id === 'large',
        ),
      ).toBe(true),
    );
    await act(async () => sizeControl(screen)?.props.onChange('large'));
    await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
    const poolId = '6be84651-2df7-4125-aac4-0d093217b198';
    if (target === 'pool') {
      const pool = { id: poolId, name: 'Build controllers', description: null, revision: 1, createdAt: 1, updatedAt: 1, members: [] };
      harness.answer(serverId, '/v1/machines/pools/list', { body: { pools: [
        { pool, availability: { state: 'known', connectedCount: 0, enabledCount: 0 }, access: { canManage: true, canResolve: true, canViewMembers: true } },
        { pool: { ...pool, id: '6be84651-2df7-4125-aac4-0d093217b199', name: 'Shared view only' },
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
        expect(input).toMatchObject({
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
        const id =
          input && typeof input === 'object' && 'id' in input ? input.id : null;
        expect(typeof id).toBe('string');
        if (target === 'pool') expect(input).not.toHaveProperty('controller');
        return {
          body: {
            kind: 'saved',
            preset: {
              ...preset,
              id,
              revision: 1,
              name: 'Custom compute',
              launch: {
                ...preset.launch,
                name: 'Custom compute',
                choices: { cpu: 4 },
              },
            },
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
  });

  it.each(['before options arrive', 'after exact choices are ready'] as const)(
    'authors a new Team pool preset with editable native choices %s', async timing => {
      const serverId = await seed(true, true);
      const scopeId = await seedConfiguration(serverId);
      await publishMachineInventoryForTest({ serverId: scopeId, accountId: 'owner' }, [
        createMachineFixture({ id: preset.controller.machineId, installationId: preset.controller.installationId, activeAt: Date.now() }),
        createMachineFixture({ id: 'offline-controller', installationId: 'offline-installation', active: false, activeAt: 1 }),
      ]);
      const editableProvisioner: MachineProvisionersListResultV1['provisioners'][number] = {
        ...provisioner,
        descriptor: { ...provisioner.descriptor, launchSchema: PluginJsonSchemaV2Schema.parse({
          type: 'object', properties: { cpu: { type: 'integer', minimum: 1 }, image: { type: 'string' } },
          required: ['cpu', 'image'], additionalProperties: false,
        }) },
      };
      seedOptionsDeclaration(editableProvisioner, PluginJsonSchemaV2Schema.parse({ type: 'object', properties: {}, additionalProperties: false }));
      const options = createMachineProvisionerOptionsFixture({ base: { launch: {} }, dimensions: {
        size: [
          { id: 'small', title: 'Small', assignments: [{ path: 'cpu', value: 2 }] },
          { id: 'large', title: 'Large', assignments: [{ path: 'cpu', value: 4 }] },
        ],
        image: [
          { id: 'base', title: 'Base image', assignments: [{ path: 'image', value: 'base' }] },
          { id: 'linux', title: 'Linux guest', assignments: [{ path: 'image', value: 'linux' }] },
        ], location: [], network: [], duration: [],
      } });
      let releaseOptions: () => void = () => {};
      const optionsGate = timing === 'before options arrive'
        ? new Promise<void>(resolve => { releaseOptions = resolve; }) : Promise.resolve();
      for (const actionId of ['machines.provisioners.list', 'machines.provisioners.options'] as const) {
        harness.answer(serverId, `/v1/actions/${actionId}`, { select: async value => {
          const request = ExternalActionRequestEnvelopeV1Schema.parse(value);
          if (actionId === 'machines.provisioners.options') await optionsGate;
          return { body: { v: 1, actionId, requestId: request.requestId, execution: { ok: true,
            result: actionId === 'machines.provisioners.options' ? options : request.target?.kind === 'machine'
              ? { controller: preset.controller, provisioners: [editableProvisioner] } : { provisioners: [] },
          } } };
        } });
      }
      const team = teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageSettings: true }) });
      harness.answer(serverId, '/v1/teams/list', { body: { items: [team], nextCursor: null } });
      const { bindHomeDomainActionHttpRequestV1 } = await import('@happier-dev/protocol/actions/homeDomainActionFamily');
      harness.answer(serverId, bindHomeDomainActionHttpRequestV1('teams.get', { v: 1, teamId: team.id }).path, { body: team });
      const poolId = '6be84651-2df7-4125-aac4-0d093217b198';
      harness.answer(serverId, '/v1/machines/pools/list', { body: { pools: [{
        pool: { id: poolId, name: 'Team builders', description: null, revision: 1, createdAt: 1, updatedAt: 1,
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
        if (timing === 'after exact choices are ready') {
          await waitForHomeGovernance(() => expect(sizeControl(screen)?.props.sizes.some((size: { id: string }) => size.id === 'large')).toBe(true));
        } else {
          await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/actions/machines.provisioners.options').length).toBeGreaterThan(0));
          expect(sizeControl(screen)).toBeUndefined();
        }
        const targetControl = () => screen.tree.findAllByType(SegmentedChoiceItem).find(row => row.props.testIDPrefix === 'managed-config.controller-target');
        await waitForHomeGovernance(() => expect(targetControl()?.props.disabled).toBe(false));
        await act(async () => screen.pressByTestId('managed-config.controller-target:pool'));
        expect(targetControl()?.props.value).toBe('pool');
        await waitForHomeGovernance(() => expect(field('managed-config.controller-pool')?.props.row.choices).toEqual([{ id: poolId, title: 'Team builders' }]));
        expect(field('managed-config.controller-pool')?.props.row.disabled).toBe(false);
        await act(async () => field('managed-config.controller-pool')?.props.row.onChange(poolId));
        await act(async () => releaseOptions());
        await waitForHomeGovernance(() => expect(sizeControl(screen)?.props.sizes.find((size: { id: string }) => size.id === 'large')?.selectable).toBe(true));
        await act(async () => sizeControl(screen)?.props.onChange('large'));
        expect(sizeControl(screen)?.props.value).toBe('large');
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.images:linux')?.props.disabled).toBe(false));
        await act(async () => screen.pressByTestId('managed-config.images:linux'));
        harness.answer(serverId, '/v1/machines/presets/create', { select: input => {
          const saved = ManagedMachinePresetV1Schema.parse({ ...preset, ...ManagedMachinePresetCreateInputV1Schema.parse(input), revision: 1, controller: undefined });
          return { body: { kind: 'saved', preset: saved } };
        } });
        await waitForHomeGovernance(() => expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(false));
        await act(async () => screen.pressByTestId('managed-config.create'));
        await waitForHomeGovernance(() => expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(1));
        const created = ManagedMachinePresetCreateInputV1Schema.parse(harness.requestsFor('/v1/machines/presets/create')[0]?.input);
        expect(created).toMatchObject({ owner: { kind: 'team', teamId: team.id }, controllerPoolId: poolId,
          simultaneousLimit: { maximum: 2 }, launch: { choices: { cpu: 4, image: 'linux' } } });
        expect(created).not.toHaveProperty('controller');
        await waitForHomeGovernance(() => expect(route.replace).toHaveBeenLastCalledWith(
          `/settings/machines/presets/${created.id}?serverId=${encodeURIComponent(scopeId)}`,
        ));
        expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual([]);
        expect(harness.requestsFor('/v1/machines/pools/resolve')).toEqual([]);
      } finally {
        releaseOptions();
        await screen.unmount();
      }
    },
  );

  it('preserves an edited launch after rejection and revision conflict, then saves through normal approval', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
    await harness.requireUiApproval(serverId, 'machines.presets.update');
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
        sizeControl(screen)?.props.sizes.some(
          (size: { id: string }) => size.id === 'large',
        ),
      ).toBe(true),
    );
    await act(async () => sizeControl(screen)?.props.onChange('large'));
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.create')?.props.disabled).toBe(
        false,
      ),
    );
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() =>
      expect(harness.artifacts(serverId).list()).toHaveLength(1),
    );
    expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
    const rejectedId = harness.artifacts(serverId).list()[0]!.id;
    const { publishHomeAccountChange } =
      await import('@/sync/runtime/orchestration/homeAccountChange');
    await act(async () => publishHomeAccountChange(scopeId));
    await flushHookEffects();
    expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(2);
    expect(screen.findByTestId('managed-config.approval')).not.toBeNull();
    await expect(
      decideApprovalAsInbox(scopeId, rejectedId, 'reject'),
    ).resolves.toMatchObject({ ok: true });
    await waitForHomeGovernance(() =>
      expect(screen.findByTestId('managed-config.error')).not.toBeNull(),
    );
    expect(sizeControl(screen)?.props.value).toBe('large');
    expect(route.replace).not.toHaveBeenCalled();
    harness.answer(serverId, '/v1/machines/presets/update', {
      body: { kind: 'conflict', currentRevision: 4 },
    });
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() =>
      expect(harness.artifacts(serverId).list()).toHaveLength(2),
    );
    const conflictId = harness.artifacts(serverId).list()[1]!.id;
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: { ...preset, revision: 4 } },
    });
    await act(async () =>
      publishHomeAccountChange(scopeId, [preset.id], {
        changeKinds: ['artifact', 'account'],
      }),
    );
    await flushHookEffects();
    expect(screen.findByTestId('managed-config.approval')).not.toBeNull();
    expect(sizeControl(screen)?.props.value).toBe('large');
    await expect(
      decideApprovalAsInbox(scopeId, conflictId, 'approve'),
    ).resolves.toMatchObject({ ok: true });
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
    expect(sizeControl(screen)?.props.value).toBe('large');
    expect(route.replace).not.toHaveBeenCalled();
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: { ...preset, revision: 4 } },
    });
    await act(async () => screen.pressByTestId('managed-config.error-action'));
    await flushHookEffects();
    expect(harness.requestsFor('/v1/machines/presets/get')).toHaveLength(4);
    expect(sizeControl(screen)?.props.value).toBe('large');
    harness.answer(serverId, '/v1/machines/presets/update', {
      body: {
        kind: 'saved',
        preset: {
          ...preset,
          revision: 5,
          launch: { ...preset.launch, choices: { cpu: 4 } },
        },
      },
    });
    await act(async () => screen.pressByTestId('managed-config.create'));
    await waitForHomeGovernance(() =>
      expect(harness.artifacts(serverId).list()).toHaveLength(3),
    );
    const savedId = harness.artifacts(serverId).list()[2]!.id;
    await expect(
      decideApprovalAsInbox(scopeId, savedId, 'approve'),
    ).resolves.toMatchObject({ ok: true });
    await waitForHomeGovernance(() =>
      expect(route.replace).toHaveBeenLastCalledWith(
        `/settings/machines/presets/preset?serverId=${encodeURIComponent(scopeId)}`,
      ),
    );
    expect(
      harness
        .requestsFor('/v1/machines/presets/update')
        .map((request) => request.input),
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
    };
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: original },
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
        const id =
          input && typeof input === 'object' && 'id' in input ? input.id : null;
        return {
          body: { kind: 'saved', preset: { ...original, id, revision: 1 } },
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
    await act(async () => screen.pressByTestId('managed-config.save-preset'));
    await waitForHomeGovernance(() =>
      expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(
        1,
      ),
    );
    const copied = harness.requestsFor('/v1/machines/presets/create')[0]!.input;
    expect(copied).toMatchObject({
      homeId: preset.homeId,
      launch: original.launch,
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
          ExternalActionRequestEnvelopeV1Schema.parse(request.input).input,
        ).toMatchObject({ credentials: [savedCredential] });
    }
    expect(copied).not.toMatchObject({ id: preset.id });
    expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual(
      [],
    );
  });

  it('mounts accessible presets in the Machines collection and opens the selected Home', async () => {
    const serverId = await seed();
    await harness.selectHomes([serverId]);
    harness.answer(serverId, '/v1/machines/presets/list', {
      body: { kind: 'listed', presets: [preset] },
    });
    const scopeId = resolveServerProfileScopeIdForIdentifier(serverId);
    const screen = await renderSettingsView(<MachinesSettingsView />);
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId(`settings.machines.preset.${scopeId}.preset`),
      ).not.toBeNull(),
    );
    await act(async () =>
      screen.pressByTestId(`settings.machines.preset.${scopeId}.preset`),
    );
    expect(route.push).toHaveBeenLastCalledWith(
      `/settings/machines/presets/preset?serverId=${encodeURIComponent(scopeId)}`,
    );
    // The group creates a preset from its header "+"; no separate "New preset" row repeats it.
    expect(screen.getTextContent()).not.toContain(
      t('machinePresets.newPreset'),
    );
    await act(async () =>
      screen.pressByTestId(`settings.machines.presets.new.${scopeId}`),
    );
    expect(route.push).toHaveBeenLastCalledWith(
      `/settings/machines/presets/new?serverId=${encodeURIComponent(scopeId)}`,
    );
    expect(harness.requestsFor('/v1/actions/machines.managed.acquire')).toEqual(
      [],
    );
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

  it('archives and restores the preset with its reviewed revision without changing its admitted resources', async () => {
    const serverId = await seed();
    const archived = { ...preset, revision: 4, archivedAt: 1 };
    harness.answer(serverId, '/v1/machines/presets/archive', {
      body: { kind: 'saved', preset: archived },
    });
    const screen = await renderSettingsView(
      <MachinePresetView serverId={serverId} presetId="preset" />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen.findByTestId('machine-preset.detail.archive'),
      ).not.toBeNull(),
    );
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: archived },
    });
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
      body: { kind: 'saved', preset: { ...preset, revision: 5 } },
    });
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: { ...preset, revision: 5 } },
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

  it('leaves an archived preset with its one notice when the provisioner read fails, since it makes nothing either way', async () => {
    const serverId = await seed();
    await seedConfiguration(serverId);
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: { ...preset, archivedAt: 1 } },
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
    };
    harness.answer(serverId, '/v1/machines/presets/update', {
      body: { kind: 'saved', preset: limited },
    });
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: limited },
    });
    await act(async () =>
      field('machine-preset.detail.limit')!.props.onSelect('3'),
    );
    // The edit asks first, exactly like the configurator's Save; nothing is written before approval.
    await waitForHomeGovernance(() =>
      expect(harness.artifacts(serverId).list()).toHaveLength(1),
    );
    expect(harness.requestsFor('/v1/machines/presets/update')).toEqual([]);
    await expect(
      decideApprovalAsInbox(
        scopeId,
        harness.artifacts(serverId).list()[0]!.id,
        'approve',
      ),
    ).resolves.toMatchObject({ ok: true });
    await waitForHomeGovernance(() =>
      expect(field('machine-preset.detail.limit')?.props.selectedId).toBe('3'),
    );

    harness.answer(serverId, '/v1/machines/presets/update', {
      body: { kind: 'conflict', currentRevision: 5 },
    });
    await act(async () =>
      field('machine-preset.detail.controller')!.props.onSelect('builder'),
    );
    await waitForHomeGovernance(() =>
      expect(harness.artifacts(serverId).list()).toHaveLength(2),
    );
    await expect(
      decideApprovalAsInbox(
        scopeId,
        harness.artifacts(serverId).list()[1]!.id,
        'approve',
      ),
    ).resolves.toMatchObject({ ok: true });
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

  it('refreshes controller subtitles to unknown after that Home withdraws presence', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
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
    expect(model()?.controller.row.subtitle).toBe(t('common.unknown'));
    expect(model()?.controller.row.choices[0].subtitle).toBe(
      t('common.unknown'),
    );
    await act(async () => publishMachineInventoryForTest(scope, [machine]));
    await waitForHomeGovernance(() =>
      expect(model()?.controller.row.subtitle).toBe(t('status.online')),
    );
  });

  it('does not name a withdrawn controller offline while its provisioner catalog is unavailable', async () => {
    const serverId = await seed();
    const scopeId = await seedConfiguration(serverId);
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
    await flushHookEffects({ cycles: 3, turns: 3 });
    expect(
      screen.findByTestId('managed-picker.unavailable'),
      screen.getTextContent(),
    ).not.toBeNull();
    expect(screen.findByTestId('managed-picker.offline')).toBeNull();
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
        preset={preset}
        size={MANAGED_PROVISIONER_MARK_SIZE.rail}
      />,
    );
    await waitForHomeGovernance(() =>
      expect(
        screen
          .findAllByType(HappierBrandMark)
          .some(
            (node) =>
              node.props.pixelSize === MANAGED_PROVISIONER_MARK_SIZE.rail &&
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
      body: { kind: 'found', preset: { ...rest, name: 'Web host setup', setup: {
        items: [{ kind: 'softwareRecipe', selection: { ref: { pluginId: 'happier.machine.recipes', recipeId: 'google-chrome', revision: '1' }, inputs: {} } }],
        scripts: [{ body: 'echo ready' }] } } },
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
      body: { kind: 'found', preset: teamPreset },
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
      body: { kind: 'found', preset: teamPreset },
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
    };
    harness.answer(serverId, '/v1/machines/presets/update', {
      body: { kind: 'saved', preset: enabled },
    });
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: enabled },
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
    };
    harness.answer(serverId, '/v1/machines/presets/update', {
      body: { kind: 'saved', preset: withdrawn },
    });
    harness.answer(serverId, '/v1/machines/presets/get', {
      body: { kind: 'found', preset: withdrawn },
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
