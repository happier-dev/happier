import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema,
  ExternalActionExecutionAuthorizationRequestV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import {
  computeExternalActionRequestEnvelopeDigestV1,
  signExternalActionApprovalInputV1,
  verifyExternalActionApprovalInputV1,
} from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { MachineSetupAppChildV1Schema, MachineSetupApplyInputV1Schema, MachineSetupPlanInputV1Schema, MachineSetupPlanResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { MachinePresetItemV1Schema } from '@happier-dev/protocol/machines/managed/machineSetupV1';
import { getMachineSetupDesiredV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import sodium from 'libsodium-wrappers';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

// Metro's lazy module loader is the boundary here; the real Action front door still executes.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
const nativeRpc = vi.hoisted(() => ({
  replay: null as ((artifactId: string) => Promise<unknown>) | null,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
  const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
  return createServerScopedMachineRpcBoundaryMock(async (request) => {
    if (request.method !== RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED || !nativeRpc.replay) {
      throw new Error(`Unexpected native RPC: ${request.method}`);
    }
    expect(request.machineId).toBe('devbox');
    const payload = request.payload as { artifactId: string };
    return await nativeRpc.replay(payload.artifactId);
  });
});
const routerHandle = vi.hoisted(() => ({ current: null as null | { spies: { push: { mock: { calls: unknown[][] } } } } }));
installApprovalCommonModuleMocks({
  text: async () => vi.importActual<typeof import('@/text')>('@/text'),
  reactNative: async () => {
    const [{ createCapturingFlatListMock }, { createReactNativeWebMock, createMeasuredViewMock }] = await Promise.all([
      import('@/dev/testkit/mocks/virtualizedList'),
      import('@/dev/testkit/mocks/reactNative'),
    ]);
    // Render native list cells so the Store's real review targets remain observable.
    return createReactNativeWebMock({
      ...createCapturingFlatListMock({ renderItems: true }).module,
      View: createMeasuredViewMock({ width: 960, height: 600 }, testID => testID.endsWith(':stage')),
    });
  },
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true }).module;
  },
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const router = createExpoRouterMock();
    routerHandle.current = router;
    return router.module;
  },
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { resetScopedHomeActionExecutorsForTests } =
  await import('@/sync/ops/actions/scopedHomeActionExecutor');
// Load the real app singleton after its transport boundaries, outside each
// test's lifecycle deadline, as in the adjacent ConfigurationView harness.
await loadSyncSingletonForTests();
// Module and crypto initialization are harness setup, not a person's Apply lifetime.
const [{ createCliActionExecutorHarness }, { createHostActionOperationRuntime }, { createCombinedMachineSetupActionDeps }, { prepareMachineSetupPlanV1 }] = await Promise.all([
  import('../../../../../cli/src/session/actions/createCliActionExecutorHarness'),
  import('../../../../../cli/src/daemon/actionOperations/createHostActionOperationRuntime'),
  import('../../../../../cli/src/machines/setup/composeMachineSetup'),
  import('../../../../../cli/src/machines/setup/prepareMachineSetupPlan'),
]);
await sodium.ready;
beforeEach(async () => {
  nativeRpc.replay = null;
  await harness.reset();
  resetScopedHomeActionExecutorsForTests();
});
afterEach(() => standardCleanup());

// The Machine page owns this already-hydrated inventory before rendering a tab.
async function publishManagedDevbox(serverId: string, role?: 'use') {
  const { storage } = await import('@/sync/domains/state/storage');
  const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
  const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
  const scope = { serverId, accountId: 'owner' };
  const machine = createMachineFixture({ id: 'devbox', isShared: role !== undefined, activeAt: Date.now(),
    ...(role ? { access: { role, resourceMode: 'plain' as const, accessState: 'ready' as const, custodian: { accountId: 'owner', displayName: 'Owner' } } } : {}) });
  await act(async () => {
    storage.setState({ settingsScope: scope });
    await publishMachineInventoryForTest(scope, [machine]);
  });
  return machine;
}

const preset = (id: string, name: string, creation = false) => ({
  id,
  homeId: 'srv_build',
  revision: 2,
  name,
  owner: { kind: 'account', accountId: 'owner' },
  ...(creation ? {
    launch: { provider: { pluginId: 'custom.compute', localId: 'native' }, schemaVersion: 1, name: 'Future guest', choices: {} },
    controller: { machineId: 'controller', installationId: 'installation' },
  } : {}),
  setup: {
    toolchain: { adapterId: 'mise', config: '[tools]' },
    scripts: [{ body: 'npm ci\nnpm run build' }],
  },
});

describe('Machine setup preparation', () => {
  it('attaches a bundled preset through the existing Plan and Apply source program without changing recipe order or inputs', async () => {
    const { prepareMachineSetupPresetApplyInput } = await import('@/components/settings/machines/managed/machineSetupApply');
    const ref = { pluginId: 'example.setup', localId: 'secure', revision: '1' };
    const setup = { items: ['firewall', 'ssh'].map(recipeId => ({ kind: 'setupRecipe' as const,
      selection: { ref: { pluginId: ref.pluginId, recipeId, revision: '1' }, inputs: {} } })) };
    const current = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 0, sources: [{ kind: 'direct', setup: {} }], exclusions: [], support: [] });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineSetupPlan: async ({ input }) => {
      const request = MachineSetupPlanInputV1Schema.parse(input);
      return request.mode ? { ...current, sources: request.sources, recipePlans: [] } : current;
    } }));
    expect(await prepareMachineSetupPresetApplyInput({ executeAction: executor.execute, context: { surface: 'ui' },
      homeId: 'srv_build', machineId: 'devbox', preset: { kind: 'bundledPreset', ref, setup }, isCurrent: () => true })).toMatchObject({
      ok: true, input: { targets: [{ sources: [{ kind: 'bundledPreset', ref, setup }, { kind: 'direct', setup: {} }] }] },
    });
  });
  it.each([false, true])('retains reviewed removals through Plan and Apply, rejecting a substituted selection (combined=%s)', async combined => {
    const { prepareMachineSetupSourcesApplyInput } = await import('@/components/settings/machines/managed/machineSetupReview');
    const sources = [{ kind: 'direct' as const, setup: {} }];
    const removalPlans = [{ itemKey: 'removed-tool', plan: { v: 1 as const,
      basis: { kind: 'setup' as const, machineId: 'devbox', desiredRevision: 3 },
      steps: [], nativeFacts: [], planDigest: 'a'.repeat(64) } }];
    const recipeTitles = [{ ref: { pluginId: 'com.example.machine-tools', recipeId: 'fonts', revision: '1' }, title: 'Fonts' }];
    const plans: unknown[] = [];
    let substituted = false;
    // The remote Plan response is the transport boundary; Action admission,
    // strict schemas and the UI's preparation logic remain real.
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineSetupPlan: async ({ input }) => {
      plans.push(input);
      const plan = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 3, sources, exclusions: [], support: [],
        recipePlans: [], removeItemKeys: [substituted ? 'different-tool' : 'removed-tool'], removalPlans, recipeTitles });
      return combined ? { targets: [{ homeId: 'srv_build', machineId: 'devbox', plan }],
        review: { machineId: 'devbox', machines: [{ machineId: 'devbox', online: true }] } } : plan;
    } }));
    const target = { homeId: 'srv_build', machineId: 'devbox', desiredRevision: 3, sources, removeItemKeys: ['removed-tool'] };
    const params = { executeAction: executor.execute, context: { surface: 'ui' as const },
      homeId: 'srv_build', machineId: 'devbox', combined, isCurrent: () => true, targets: [target] };
    expect(await prepareMachineSetupSourcesApplyInput(params)).toMatchObject({ ok: true, facts: [{ recipeTitles }], input: { targets: [
      { removeItemKeys: ['removed-tool'], removalPlans },
    ] } });
    expect(plans).toEqual([combined ? { homeId: 'srv_build', machineId: 'devbox', targets: [
      { homeId: 'srv_build', machineId: 'devbox', sources, mode: 'effects', removeItemKeys: ['removed-tool'] },
    ] } : { homeId: 'srv_build', machineId: 'devbox', sources, mode: 'effects', removeItemKeys: ['removed-tool'] }]);
    substituted = true;
    expect(await prepareMachineSetupSourcesApplyInput(params)).toMatchObject({ ok: false, errorCode: 'plan_changed' });
  });
  it('keeps detached preset recipes installed by default while preparing the updated copy', async () => {
    const { prepareMachineSetupPresetApplyInput } = await import('@/components/settings/machines/managed/machineSetupApply');
    const { reviewMachineSetupSourceChangeV1 } = await import('@happier-dev/protocol/machines/setup/machineSetupSourcesV1');
    const ref = { pluginId: 'com.example.machine-tools', recipeId: 'fonts', revision: '1' };
    const item = { kind: 'softwareRecipe' as const, selection: { ref, inputs: {} } };
    const selected = { ...preset('build', 'Build box'), setup: { scripts: [{ body: 'echo updated' }] } };
    const current = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 3, sources: [
      { kind: 'accountPreset', presetId: selected.id, presetRevision: 1, setup: { items: [item] } },
      { kind: 'direct', setup: {} },
    ], exclusions: [], support: [] });
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineSetupPlan: async ({ input }) => {
      const request = MachineSetupPlanInputV1Schema.parse(input);
      if (!request.mode) return current;
      const change = reviewMachineSetupSourceChangeV1({ currentSources: current.sources,
        proposedSources: request.sources!, ...(request.removeItemKeys === undefined ? {} : { removeItemKeys: request.removeItemKeys }) });
      if (!change.ok) return change;
      return { ...current, sources: change.sources, recipePlans: [] };
    } }));
    expect(await prepareMachineSetupPresetApplyInput({ executeAction: executor.execute, context: { surface: 'ui' },
      homeId: 'srv_build', machineId: 'devbox', preset: selected, isCurrent: () => true })).toMatchObject({
        ok: true, input: { targets: [{ sources: [
          { kind: 'accountPreset', presetId: selected.id, presetRevision: 2, setup: selected.setup },
          { kind: 'direct', setup: { items: [item] } },
        ] }] },
      });
  });
  it('retains native unavailable dispositions beside the reachable reviewed Apply targets', async () => {
    const { prepareMachineSetupSourcesApplyInput } = await import('@/components/settings/machines/managed/machineSetupReview');
    const sources = [{ kind: 'direct' as const, setup: {} }];
    const unavailable = { homeId: 'srv_build', machineId: 'offline', status: 'unavailable',
      reason: 'offline', errorCode: 'machine_offline' };
    const ready = { homeId: 'srv_build', machineId: 'devbox', plan: MachineSetupPlanResultV1Schema.parse({
      desiredRevision: 0, sources, exclusions: [], support: [], recipePlans: [],
    }) };
    let allOffline = false;
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineSetupPlan: async () => ({
      targets: [unavailable, allOffline ? { ...unavailable, machineId: 'devbox' } : ready],
      review: { machineId: allOffline ? null : 'devbox', machines: [{ machineId: 'devbox', online: !allOffline }] },
    }) }));
    expect(await prepareMachineSetupSourcesApplyInput({ executeAction: executor.execute, context: { surface: 'ui' },
      homeId: 'srv_build', machineId: 'devbox', combined: true, isCurrent: () => true,
      targets: ['offline', 'devbox'].map(machineId => ({ homeId: 'srv_build', machineId, desiredRevision: 0, sources })),
    })).toMatchObject({ ok: true, unavailableTargets: [unavailable], input: { targets: [
      { homeId: 'srv_build', machineId: 'devbox' },
    ] } });
    allOffline = true;
    expect(await prepareMachineSetupSourcesApplyInput({ executeAction: executor.execute, context: { surface: 'ui' },
      homeId: 'srv_build', machineId: 'devbox', combined: true, isCurrent: () => true,
      targets: ['offline', 'devbox'].map(machineId => ({ homeId: 'srv_build', machineId, desiredRevision: 0, sources })),
    })).toMatchObject({ ok: false, errorCode: 'machine_offline', details: { targets: [unavailable,
      { ...unavailable, machineId: 'devbox' },
    ] } });
  });
  it('attaches a new preset last, before the direct source, and never plans a source list without one', async () => {
    const { prepareMachineSetupPresetApplyInput } = await import('@/components/settings/machines/managed/machineSetupApply');
    const attached = { kind: 'accountPreset' as const, presetId: 'web', presetRevision: 1, setup: {} };
    const selected = { ...preset('build', 'Build box'), setup: { scripts: [{ body: 'echo build' }] } };
    let planned: unknown[] = [attached, { kind: 'direct', setup: {} }];
    const proposed: unknown[] = [];
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineSetupPlan: async ({ input }) => {
      const request = MachineSetupPlanInputV1Schema.parse(input);
      if (request.mode) proposed.push(request.sources);
      return { desiredRevision: 3, sources: request.mode ? request.sources : planned, exclusions: [], support: [], recipePlans: [] };
    } }));
    const params = { executeAction: executor.execute, context: { surface: 'ui' as const },
      homeId: 'srv_build', machineId: 'devbox', preset: selected, isCurrent: () => true };
    expect(await prepareMachineSetupPresetApplyInput(params)).toMatchObject({ ok: true });
    expect(proposed).toEqual([[attached,
      { kind: 'accountPreset', presetId: 'build', presetRevision: 2, setup: selected.setup },
      { kind: 'direct', setup: {} }]]);
    // A plan without its direct source fails the strict plan schema before any splice can misplace the preset.
    planned = [attached];
    expect(await prepareMachineSetupPresetApplyInput(params)).toMatchObject({ ok: false });
    expect(proposed).toHaveLength(1);
  });
  it('carries reviewed recipe exclusions to Apply instead of silently reinstating an excluded recipe', async () => {
    const { prepareMachineSetupSourcesApplyInput } = await import('@/components/settings/machines/managed/machineSetupReview');
    const ref = { pluginId: 'com.example.machine-tools', recipeId: 'unavailable', revision: '1' };
    const sources = [{ kind: 'direct' as const, setup: { items: [{ kind: 'softwareRecipe' as const, selection: { ref, inputs: {} } }] } }];
    const exclusions = [{ ref, reason: 'not_selected' as const }];
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineSetupPlan: async () =>
      MachineSetupPlanResultV1Schema.parse({ desiredRevision: 3, sources, exclusions, support: [], recipePlans: [] }),
    }));
    expect(await prepareMachineSetupSourcesApplyInput({ executeAction: executor.execute, context: { surface: 'ui' },
      homeId: 'srv_build', machineId: 'devbox', combined: false, isCurrent: () => true,
      targets: [{ homeId: 'srv_build', machineId: 'devbox', desiredRevision: 3, sources }],
    })).toMatchObject({ ok: true, input: { targets: [{ exclusions }] } });
  });
  it('prepares app operands through combined Plan and carries only its admitted children to Apply', async () => {
    const { prepareMachineSetupPresetApplyInput } = await import('@/components/settings/machines/managed/machineSetupApply');
    // These are opened P40 receipt references at the remote transport boundary,
    // not a replacement for native preparation or receiver receipt validation.
    const appChildren = [MachineSetupAppChildV1Schema.parse({ sourceIndex: 0, itemIndex: 0,
      actionId: 'deployments.deploy', input: { serverId: 'srv_build', environmentId: 'staging', expectedRevision: 1,
        targetLinkId: 'runtime-link', expectedTargetLinkRevision: 1, requestKey: 'deploy-reviewed',
        contentArtifactId: 'private-content', contentHeaderVersion: 1, contentBodyVersion: 1 } })];
    const selected = { ...preset('build', 'Build box'), setup: { items: [{ kind: 'app' as const, definition: {
      name: 'Stored app', project: { kind: 'existing' as const, projectSourceId: 'source-app' },
      definition: { from: 'compose' as const, document: 'services:\n  app:\n    image: example/app:1\n',
        profiles: [], services: ['app'] }, bindings: [],
    } }] } };
    const current = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 7,
      sources: [{ kind: 'direct', setup: {} }], exclusions: [], support: [] });
    const sources = [{ kind: 'accountPreset', presetId: selected.id, presetRevision: selected.revision,
      setup: selected.setup }, ...current.sources];
    // The review facts each target's Plan reports reach the review presenter unchanged.
    const targetSupport = [{ sourceIndex: 0, itemIndex: 0, status: 'unsupported' as const }];
    const targetReview = { target: { homeId: 'srv_build', machineId: 'devbox' }, administratorRequired: true, downtime: 'possible' as const };
    const plans: unknown[] = [];
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({ machineSetupPlan: async ({ input }) => {
      plans.push(input);
      return 'targets' in input ? { targets: [{ homeId: 'srv_build', machineId: 'devbox', appChildren,
        plan: { ...current, sources, recipePlans: [], support: targetSupport, review: targetReview } }],
        review: { machineId: 'workflow-host', machines: [{ machineId: 'workflow-host', online: true }] } }
        : input.mode === 'effects' ? { ...current, sources, recipePlans: [] } : current;
    } }));
    const params = { executeAction: executor.execute, context: { surface: 'ui' as const },
      homeId: 'srv_build', machineId: 'devbox', preset: selected, appChildren, selectedMachineId: 'workflow-host', isCurrent: () => true };
    const prepared = await prepareMachineSetupPresetApplyInput(params);
    expect(plans).toEqual([{ homeId: 'srv_build', machineId: 'devbox' },
      { homeId: 'srv_build', machineId: 'devbox', selectedMachineId: 'workflow-host', targets: [
        { homeId: 'srv_build', machineId: 'devbox', sources, mode: 'effects', appChildren },
      ] }]);
    expect(prepared).toEqual({ ok: true, review: { machineId: 'workflow-host', machines: [{ machineId: 'workflow-host', online: true }] },
      facts: [{ homeId: 'srv_build', machineId: 'devbox', support: targetSupport, review: targetReview }],
      input: { homeId: 'srv_build', machineId: 'workflow-host', targets: [
      { homeId: 'srv_build', machineId: 'devbox', sources, desiredRevision: 7, recipePlans: [], exclusions: [], appChildren },
    ] } });
  });
  it('requires an exact effects Plan before preparing public Apply and settles changed plans without mutation', async () => {
    const { prepareMachineSetupPresetApplyInput } = await import('@/components/settings/machines/managed/machineSetupApply');
    const plans: unknown[] = [];
    const current = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 7, sources: [
      { kind: 'direct', setup: {} },
    ], exclusions: [], support: [] });
    let changed = false;
    // This is the target-daemon transport boundary. Policy, Action admission,
    // schemas and the UI's source-copy preparation remain real.
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({
      machineSetupPlan: async ({ input }) => {
        plans.push(input);
        const planInput = MachineSetupPlanInputV1Schema.parse(input);
        if (planInput.mode === 'effects' && changed) return { ...current, recipePlans: [], sources: planInput.sources!.map(source =>
          source.kind === 'accountPreset' ? { ...source, setup: { scripts: [{ body: 'echo substituted' }] } } : source) };
        return planInput.mode === 'effects' ? { ...current, sources: planInput.sources!, recipePlans: [] } : current;
      },
    }));
    const context = { surface: 'ui' as const };
    const selected = preset('build', 'Build box');
    const params = { executeAction: executor.execute, context, homeId: 'srv_build', machineId: 'devbox',
      preset: selected, isCurrent: () => true };
    const prepared = await prepareMachineSetupPresetApplyInput(params);
    const sources = [{ kind: 'accountPreset', presetId: selected.id, presetRevision: selected.revision,
      setup: selected.setup }, ...current.sources];
    expect(plans).toEqual([{ homeId: 'srv_build', machineId: 'devbox' },
      { homeId: 'srv_build', machineId: 'devbox', mode: 'effects', sources }]);
    // A Plan without review facts stays unknown: no review is invented.
    expect(prepared).toEqual({ ok: true, facts: [{ homeId: 'srv_build', machineId: 'devbox', support: [] }],
      input: { homeId: 'srv_build', machineId: 'devbox', targets: [
      { homeId: 'srv_build', machineId: 'devbox', sources, desiredRevision: 7, recipePlans: [], exclusions: [] },
    ] } });
    changed = true;
    expect(await prepareMachineSetupPresetApplyInput(params)).toMatchObject({ ok: false, errorCode: 'plan_changed' });
  });
});

describe('Machine → Setup tab (P-M1)', () => {
  it('uses a bundled Store preset through the existing enrolled-machine picker and review without applying during selection', async () => {
    const home = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example',
      serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    await publishManagedDevbox(serverId);
    harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
    harness.answer(home, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
    const setup = { scripts: [{ body: 'echo bundled' }] };
    const plans: unknown[] = [];
    const current = await getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadata: {}, metadataVersion: 0 }),
      compareAndSwap: async () => { throw new Error('Planning cannot publish setup'); },
    });
    // The HTTP response comes from the receiving planner, including exact removal-review operands.
    harness.answer(home, '/v1/actions/machines.setup.plan', { select: async input => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
      const request = MachineSetupPlanInputV1Schema.parse(envelope.input);
      plans.push(request);
      return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: { ok: true,
        result: await prepareMachineSetupPlanV1({ input: request, current }) } } };
    } });
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    const { StorePresetsShelf } = await import('@/components/store/presets/StorePresetsShelf');
    const { ModalProvider } = await import('@/modal');
    const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, machineSetupPresetsById: {
      'example.setup/secure': { id: 'example.setup/secure', pluginId: 'example.setup', pluginVersion: '1', occurrenceId: 'example',
        definition: { id: 'secure', revision: '2', title: 'Secure', description: 'Security setup', setup } },
    } };
    const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: projection,
      pluginBrowserProjection: null, phase: 'current', interactionEnabled: true, machineId: null, serverId,
      platform: 'web', accountLifetime: null, clientExecutableActivation: { status: 'ready' },
      reloadClientExecutables() {}, reloadConnectedAccountProjection() {} }}>
      <StorePresetsShelf presented query="" /><ModalProvider />
    </AppShellPluginUiProjectionValueProvider>);
    const rowId = `store.kind.software.row.preset:${serverId}:example.setup/secure`;
    await waitForHomeGovernance(() => expect(screen.findByTestId(rowId)).not.toBeNull());
    expect(plans).toHaveLength(0);
    await screen.pressByTestIdAsync(rowId);
    const pickerOf = () => screen.tree.findAll(node => node.props?.testID === 'store.software.review.machine'
      && typeof node.props.onSelect === 'function')[0];
    await waitForHomeGovernance(() => expect(pickerOf()?.props.machines.targets).toHaveLength(1));
    const picker = pickerOf()!;
    expect(plans).toHaveLength(0);
    await act(async () => { picker.props.onSelect(picker.props.machines.targets[0]); });
    await waitForHomeGovernance(() => expect({
      error: screen.tree.findAll(node => node.props?.testID === 'store.software.review.error'
        && typeof node.props.diagnosticCode === 'string')[0]?.props.diagnosticCode ?? null,
      plans,
      reviewFound: screen.findByTestId('store.software.review.target.devbox') !== null,
    }).toMatchObject({ error: null, plans: expect.arrayContaining([expect.objectContaining({ mode: 'effects' })]), reviewFound: true }));
    expect(plans.at(-1)).toMatchObject({ machineId: 'devbox', mode: 'effects', sources: [
      { kind: 'bundledPreset', ref: { pluginId: 'example.setup', localId: 'secure', revision: '2' }, setup }, { kind: 'direct' },
    ] });
    expect(harness.requests.some(request => request.path === '/v1/actions/machines.setup.apply')).toBe(false);
    await screen.pressByTestIdAsync('store.software.review.cancel');
    await screen.unmount();
  });
  it('lists bundled setup presets beside saved presets and reviews their exact source through the existing tab', async () => {
    const home = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example',
      serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    await publishManagedDevbox(serverId);
    harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
    harness.answer(home, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset('web', 'Web box')] } });
    const setup = { scripts: [{ body: 'echo bundled' }] };
    const current = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 0, exclusions: [], support: [], sources: [{ kind: 'direct', setup: {} }] });
    const plans: unknown[] = [];
    harness.answer(home, '/v1/actions/machines.setup.plan', { select: input => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
      const request = MachineSetupPlanInputV1Schema.parse(envelope.input);
      plans.push(request);
      return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: { ok: true,
        result: request.mode === 'effects' ? { ...current, sources: request.sources, recipePlans: [] } : current } } };
    } });
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    const { MachineSetupTab } = await import('./MachineSetupTab');
    const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, machineSetupPresetsById: {
      'example.setup/secure': { id: 'example.setup/secure', pluginId: 'example.setup', pluginVersion: '1', occurrenceId: 'example',
        definition: { id: 'secure', revision: '2', title: 'Secure', description: 'Security setup', setup } },
    } };
    const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: projection,
      pluginBrowserProjection: null, phase: 'current', interactionEnabled: true, machineId: null, serverId,
      platform: 'web', accountLifetime: null, clientExecutableActivation: { status: 'ready' },
      reloadClientExecutables() {}, reloadConnectedAccountProjection() {} }}>
      <MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online params={{ id: 'setup' }} setParams={vi.fn()} />
    </AppShellPluginUiProjectionValueProvider>);
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-preset-review:example.setup/secure')).not.toBeNull());
    expect(screen.findByTestId('machine-setup-preset-review:web')).not.toBeNull();
    await screen.pressByTestIdAsync('machine-setup-preset-review:example.setup/secure');
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-review')).not.toBeNull());
    expect(plans.at(-1)).toMatchObject({ mode: 'effects', sources: [
      { kind: 'bundledPreset', ref: { pluginId: 'example.setup', localId: 'secure', revision: '2' }, setup }, { kind: 'direct', setup: {} },
    ] });
    await screen.unmount();
  });
  it.each([{ kind: 'creation-bearing', creation: true }, { kind: 'setup-only', creation: false }])(
    'changes to a $kind Preset from the tab: one check on open, review in place, Apply as operation rows', async ({ creation }) => {
    let phase = 'save Home';
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    let sheetError: unknown;
    let approvalStates = (): unknown => [];
    onTestFailed(() => {
      console.error('Machine setup acceptance phase:', phase, {
        requests: harness.requests.map(request => request.path),
        error: sheetError,
        approvals: approvalStates(),
      });
    });
    const home = await harness.addHome({
      name: 'Build',
      serverUrl: 'https://build.example',
      serverIdentityId: 'srv_build',
      accountId: 'owner',
      currentAccount: true,
    });
    approvalStates = () => harness.artifacts(home).list().map(artifact => {
      const request = StoredApprovalRequestSchema.parse(JSON.parse(harness.artifacts(home).readPlainBody(artifact.id)!));
      return { status: request.status, execution: request.execution };
    });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    await publishManagedDevbox(serverId);
    phase = 'use the default setup approval policy';
    harness.answer(home, '/v1/machines/devbox', {
      body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) },
    });
    harness.answer(home, '/v1/machines/presets/list', {
      body: {
        kind: 'listed',
        presets: [preset('web', 'Web box', creation), preset('build', 'Build box', creation)],
      },
    });
    phase = 'load native policy and Artifact owners';
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { isApprovalExecutionOriginCurrentForAccountContext } = await import('@/sync/ops/actions/defaultActionExecutor');
    const { writeApprovalRequestArtifact } = await import('@/sync/ops/actions/approvalArtifactWriter');
    const { readOriginalAccountActionAuthentication } = await import('@/sync/api/externalActionAccountTransport');
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    phase = 'capture native Account';
    const account = await captureLazyActionAccountContext(home);
    onTestFinished(() => account.dispose());
    phase = 'initialize installation signer';
    const installationKey = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(12));
    harness.answer(home, '/v1/machines/devbox', { body: { machine: {
      ...createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }),
      installationPublicKey: encodeBase64(installationKey.publicKey, 'base64'),
    } } });
    const applied: unknown[] = [];
    let currentPlan = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 7, exclusions: [], support: [], sources: [
      { kind: 'accountPreset', presetId: 'other', presetRevision: 3, setup: { scripts: [{ body: '\r\necho other\r\n' }] } },
      { kind: 'accountPreset', presetId: 'build', presetRevision: 1, setup: { scripts: [{ body: 'old build' }] } },
      { kind: 'direct', setup: { scripts: [{ body: '\r\necho direct\r\n' }] } },
    ], sourceFacts: { 'account:build': { firstPresence: { retained: 'absent' } } } });
    const proposedSources = () => currentPlan.sources.map(source => source.kind === 'accountPreset' && source.presetId === 'build'
      ? { ...source, presetRevision: 2, setup: preset('build', 'Build box', creation).setup } : source);
    const expectedInput = () => MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_build', machineId: 'devbox',
      targets: [{ homeId: 'srv_build', machineId: 'devbox', sources: proposedSources(),
        desiredRevision: currentPlan.desiredRevision, recipePlans: [], exclusions: [] }],
    });
    const plans: unknown[] = [];
    // The remote process is represented by its real policy/approval executor. Only
    // its OS setup operation and HTTP/RPC transport are substituted here.
    const nativeDeps = {
      // This is the receiving process's captured metadata read boundary; the
      // UI still reaches it through the real Plan Action and exact-Home HTTP.
      machineSetupPlan: async ({ input }) => {
        plans.push(input);
        const planInput = MachineSetupPlanInputV1Schema.parse(input);
        return planInput.mode === 'effects'
          ? { ...currentPlan, sources: planInput.sources!, recipePlans: [] } : currentPlan;
      },
      machineSetupApply: async ({ input, context }) => {
        if (!context.operationAcceptance) throw new Error('The receiving operation must own native effect acceptance');
        const output = { operationId: context.operationAcceptance.operationId, terminalId: 'environment-output' };
        applied.push(input);
        context.operationAcceptance.accept(output);
        return output;
      },
      approvalsCreate: async ({ request }) => ({
        artifactId: await account.createArtifact(buildApprovalRequestArtifactHeaderV1(request), JSON.stringify(request)),
      }),
      approvalsGet: async ({ artifactId }) => {
        const artifact = await account.fetchArtifact(artifactId);
        if (!artifact?.header || typeof artifact.body !== 'string') return null;
        const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header, artifact.body);
        return parsed?.family === 'built_in' ? parsed.request : null;
      },
      approvalsUpdate: async ({ artifactId, request }) => {
        const result = await writeApprovalRequestArtifact({
          artifactId, request, read: account.fetchArtifact,
          write: (basis, header, body) => account.updateArtifact(artifactId, header, body, basis),
        });
        if (result.ok) publishHomeAccountChange(serverId, [artifactId]);
        return result;
      },
      isApprovalExecutionOriginCurrent: async ({ origin, request }) => {
        account.assertCurrent();
        const authorization = origin.externalActionExecutionAuthorization;
        return isApprovalExecutionOriginCurrentForAccountContext({ origin, accountServerId: home, accountId: account.accountId })
          && origin.machineId === 'devbox'
          && authorization?.binding.installationId === 'test-installation'
          && Boolean(origin.externalActionInputSignature && origin.target && verifyExternalActionApprovalInputV1({
            authorizationToken: authorization.token, actionId: 'machines.setup.apply', input: request.actionArgs,
            target: origin.target, publicKey: installationKey.publicKey, signature: origin.externalActionInputSignature,
          }));
      },
    } satisfies Partial<ActionExecutorDeps>;
    const receiverDeps = createActionExecutorBoundaryFixture(nativeDeps);
    const operations = createHostActionOperationRuntime({ machineId: 'devbox',
      custodyBinding: { serverId: home, installationId: 'test-installation' }, resolveAccountId: async () => 'owner' });
    const preparation = createCombinedMachineSetupActionDeps({ readDeps: () => receiverDeps,
      targetPlan: receiverDeps.machineSetupPlan!, orchestrationDirectory: process.cwd(),
      readHostFacts: async () => ({ machines: [{ machineId: 'devbox', online: true }] }),
      startCombined: async () => { throw new Error('The remote OS effect boundary must not start a local Workflow'); },
      waitForRun: async () => { throw new Error('The remote OS effect boundary must not observe a local Workflow'); },
    });
    const nativeExecutor = createCliActionExecutorHarness({ token: account.credentials.token,
      credentials: { token: account.credentials.token, encryption: null }, sessionId: '', mode: 'plain', ctx: null,
      serverId: home, serverIdentityId: 'srv_build', serverHttpBaseUrl: account.endpointUrl,
    }, { ...receiverDeps, prepareMachineSetupApply: preparation.prepareMachineSetupApply,
      runActionOperation: operations.runActionOperation }).executor;
    nativeRpc.replay = artifactId => nativeExecutor.replayApprovedApprovalRequest({ artifactId, callerAuthority: 'present_user' });
    harness.answer(home, '/v1/actions/machines.setup.plan', { select: async input => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
      const execution = await nativeExecutor.execute('machines.setup.plan', envelope.input, {
        surface: 'ui', authority: 'present_user', serverId: home, serverIdentityId: 'srv_build', runtimeAccountId: 'owner',
      });
      return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution } };
    } });
    // Ordinary Account approval now returns through the same Home-to-Machine
    // HTTP front door as its originating Action; the native executor stays real.
    harness.answer(home, '/v1/actions/approval.request.decide', { select: async input => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
      const execution = await nativeExecutor.execute('approval.request.decide', envelope.input, {
        surface: 'ui', authority: 'present_user', serverId: home, runtimeAccountId: 'owner',
      });
      return { body: ExternalActionResponseEnvelopeV1Schema.parse({
        v: 1, actionId: 'approval.request.decide', requestId: envelope.requestId, execution,
      }) };
    } });
    const authorizeApply = (envelope: ReturnType<typeof ExternalActionRequestEnvelopeV1Schema.parse>) => {
        const authentication = readOriginalAccountActionAuthentication(account.credentials.token);
        if (!authentication || envelope.target?.kind !== 'machine') throw new Error('Expected an ordinary Account machine invocation');
        return ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'native-environment-authorization', binding: {
          accountId: 'owner', authentication, serverIdentityId: 'srv_build', machineId: 'devbox',
          custodianAccountId: 'owner', installationId: 'test-installation', actionId: 'machines.setup.apply' as const,
          accountEncryptionMode: 'plain',
          requestId: envelope.requestId, target: envelope.target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } });
    };
    harness.answer(home, bindExternalActionExecutionAuthorizationHttpPathV1('machines.setup.apply'), { select: input => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(input);
      return { body: authorizeApply(ExternalActionRequestEnvelopeV1Schema.parse(request.envelope)) };
    } });
    harness.answer(home, '/v1/actions/machines.setup.apply', {
      select: async (input) => {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(input);
        const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.success ? request.data.envelope : input);
        const authorization = request.success ? request.data.executionAuthorization! : authorizeApply(envelope);
        const requester = openExternalActionRequesterAccountContextV1({ authorization, purpose: { kind: 'external_action' },
          machineId: 'devbox', installationId: 'test-installation', serverIdentityId: 'srv_build',
          installationPrivateKey: installationKey.privateKey, includeInvocation: true });
        const execution = await nativeExecutor.execute('machines.setup.apply', envelope.input, {
          surface: 'ui', authority: 'present_user', serverId: home, serverIdentityId: 'srv_build', runtimeAccountId: 'owner',
          actionCaller: requester?.invocation?.caller ?? { kind: 'host' },
          ...(requester?.invocation?.presentUserConfirmation ? { presentUserConfirmation: requester.invocation.presentUserConfirmation } : {}),
          actionsSettings: (await account.readSettings()).actionsSettingsV1,
          actionRequestId: envelope.requestId, externalActionTarget: envelope.target,
          externalActionExecutionAuthorization: authorization,
          signExternalActionApprovalInput: ({ actionId, input, target, authorization }) => signExternalActionApprovalInputV1({
            actionId, input, target, authorizationToken: authorization.token, privateKey: installationKey.privateKey,
          }),
        });
        return { body: { v: 1, requestId: envelope.requestId, actionId: 'machines.setup.apply', execution } };
      },
    });
    phase = 'load Setup tab';
    const { MachineSetupTab } = await import('./MachineSetupTab');
    // The Action front door resolves exact target rows through the real batch
    // transport. A list response cannot stand in for that authority.
    const frontDoorReads = () =>
      harness.requests.filter((request) => request.path === '/v1/machines/read-batch');
    phase = 'open the Setup tab';
    screen = await renderScreen(
      <MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online
        params={{ id: 'setup' }} setParams={vi.fn()} />,
    );
    const mounted = screen;
    const pressable = (testID: string) => mounted.tree.findAll(
      (node) => node.props?.testID === testID && typeof node.props.onPress === 'function')[0];
    // Opening the tab is the one check: it reads the Machine's setup once and names its preset.
    phase = 'check on open';
    await waitForHomeGovernance(() => expect(pressable('machine-setup-source-again:account:build')).toBeDefined());
    expect(plans).toEqual([{ homeId: 'srv_build', machineId: 'devbox' }]);
    expect(frontDoorReads().length).toBeGreaterThan(0);
    // Apply again → Build box's newer revision reviews in place; nothing runs before Apply.
    phase = 'review Build box in place';
    await act(async () => pressable('machine-setup-source-again:account:build')!.props.onPress());
    const { t } = await import('@/text');
    const answer = (testID: string) => mounted.tree.findAll(node => node.props?.testID === testID
      && typeof node.props.title === 'string')[0]?.props.subtitle as string | undefined;
    await waitForHomeGovernance(() => expect(answer('machine-setup-plan-review.administrator')).toContain(t('machinePresets.setup.review.unknown')));
    expect(answer('machine-setup-plan-review.downtime')).toContain(t('machinePresets.setup.review.unknown'));
    expect(mounted.findByTestId('machine-setup-review')).not.toBeNull();
    // The review names what gets applied and where.
    expect(mounted.getTextContent()).toContain(t('machinePresets.setup.tab.reviewApplyPreset', { preset: 'Build box', machine: 'devbox' }));
    expect(applied).toEqual([]);
    phase = 'apply';
    await act(async () => pressable('machine-setup-apply')!.props.onPress());
    await waitForHomeGovernance(() => expect(applied).toEqual([expectedInput()]));
    expect(plans).toEqual([
      { homeId: 'srv_build', machineId: 'devbox' },
      { homeId: 'srv_build', machineId: 'devbox' },
      { homeId: 'srv_build', machineId: 'devbox', mode: 'effects', sources: proposedSources() },
    ]);
    const artifacts = harness.artifacts(home);
    expect(artifacts.list()).toHaveLength(0);
    expect(mounted.findByTestId('machine-setup-approval')).toBeNull();
    const received = await operations.handlers.listV2({});
    expect(received.items).toHaveLength(1);
    const operationId = received.items[0]!.operationId;
    expect(await operations.handlers.getV2({ operationId, waitForTerminal: true }))
      .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
    // The review becomes the Apply's own operation, in place; nothing else is planned or applied.
    phase = 'operation rows in place';
    await waitForHomeGovernance(() => expect(mounted.findByTestId('machine-setup-operation')).not.toBeNull());
    expect(mounted.findByTestId('machine-setup-review')).toBeNull();
    expect(plans).toHaveLength(3);
    expect(applied).toHaveLength(1);
    expect(harness.requests.some(request => request.path.includes('/actions/machines.provisioners.'))).toBe(false);
    await mounted.unmount();
  });

  it('lists every attached preset in order, applies a changed one again, and stops using one without removing what it set up', async () => {
    const { reviewMachineSetupSourceChangeV1 } = await import('@happier-dev/protocol/machines/setup/machineSetupSourcesV1');
    const home = await harness.addHome({
      name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true,
    });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    await publishManagedDevbox(serverId);
    harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
    harness.answer(home, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [
      preset('web', 'Web box'), preset('build', 'Build box'), { ...preset('other', 'Other box'), revision: 3 },
    ] } });
    const fonts = { kind: 'softwareRecipe' as const, selection: { ref: { pluginId: 'com.example.machine-tools', recipeId: 'fonts', revision: '1' }, inputs: {} } };
    const ssh = { kind: 'setupRecipe' as const, selection: { ref: { pluginId: 'com.example.machine-tools', recipeId: 'ssh-hardening', revision: '1' }, inputs: {} } };
    const other = { kind: 'accountPreset' as const, presetId: 'other', presetRevision: 3, setup: { scripts: [{ body: 'echo other' }] } };
    const current = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 4, exclusions: [], support: [], sources: [
      other,
      { kind: 'accountPreset', presetId: 'build', presetRevision: 1, setup: { items: [fonts, ssh] } },
      { kind: 'direct', setup: {} },
    ] });
    const plans: unknown[] = [];
    // The receiving Machine's Plan is the transport boundary; the tab, its hook and the shared preparation stay real.
    harness.answer(home, '/v1/actions/machines.setup.plan', { select: async input => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
      const request = MachineSetupPlanInputV1Schema.parse(envelope.input);
      plans.push(request);
      let result: unknown = current;
      if (request.mode === 'effects') {
        const change = reviewMachineSetupSourceChangeV1({ currentSources: current.sources, proposedSources: request.sources! });
        if (!change.ok) throw new Error(change.error);
        result = { ...current, sources: change.sources, recipePlans: [] };
      }
      return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: { ok: true, result } } };
    } });
    const { MachineSetupTab } = await import('./MachineSetupTab');
    // The Machine page is a page presentation; section actions (Attach a preset) render only there.
    const { ItemList } = await import('@/components/ui/lists/ItemList');
    const screen = await renderScreen(<ItemList><MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online
      params={{ id: 'setup' }} setParams={vi.fn()} /></ItemList>);
    const withProp = (testID: string, prop: string) => screen.tree.findAll(node => node.props?.testID === testID && node.props[prop] !== undefined)[0];
    await waitForHomeGovernance(() => expect(withProp('machine-setup-source:account:build', 'title')).toBeDefined());
    const order = screen.tree.findAll(node => typeof node.props?.testID === 'string' && node.props.testID.startsWith('machine-setup-source:')
      && typeof node.props.title === 'string').map(node => node.props.testID as string);
    expect([...new Set(order)]).toEqual(['machine-setup-source:account:other', 'machine-setup-source:account:build']);
    // What they set up is grouped by kind: each recipe sits under its own kind's section.
    const inGroup = (group: string, row: string) => screen.tree.findAll(node => node.props?.testID === group)
      .some(node => node.findAll(child => child.props?.testID === row).length > 0);
    expect([inGroup('machine-setup-recipes-software', 'machine-setup-recipe:1.0'), inGroup('machine-setup-recipes-setup', 'machine-setup-recipe:1.1'),
      inGroup('machine-setup-recipes-software', 'machine-setup-recipe:1.1')]).toEqual([true, true, false]);
    // Only the preset whose newer revision this Machine hasn't taken offers Apply again.
    expect(withProp('machine-setup-source-again:account:other', 'onPress')).toBeUndefined();
    // Attach lists only setup presets that aren't attached yet.
    expect((withProp('machine-setup-attach-menu', 'items')!.props.items as { id: string }[]).map(item => item.id)).toEqual(['web']);
    // Apply again reviews the newer copy in place of the old one, keeping the order.
    await act(async () => withProp('machine-setup-source-again:account:build', 'onPress')!.props.onPress());
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-review')).not.toBeNull());
    expect(plans.at(-1)).toEqual({ homeId: 'srv_build', machineId: 'devbox', mode: 'effects', sources: [
      other, { kind: 'accountPreset', presetId: 'build', presetRevision: 2, setup: preset('build', 'Build box').setup }, { kind: 'direct', setup: {} },
    ] });
    await act(async () => withProp('machine-setup-review-cancel', 'onPress')!.props.onPress());
    // Stop using proposes the sources without it; what it set up stays on the Machine unless the review removes it.
    await waitForHomeGovernance(() => expect(withProp('machine-setup-source-menu:account:build', 'onSelect')).toBeDefined());
    await act(async () => withProp('machine-setup-source-menu:account:build', 'onSelect')!.props.onSelect('stop'));
    await waitForHomeGovernance(() => expect(withProp('machine-setup-apply', 'onPress')?.props.disabled).toBe(false));
    expect(plans.at(-1)).toEqual({ homeId: 'srv_build', machineId: 'devbox', mode: 'effects', sources: [other, { kind: 'direct', setup: {} }] });
    expect(screen.findByTestId('machine-setup-review')).not.toBeNull();
    await screen.unmount();
  });

  it('tells a Can use person who changes setup, without running a check the Machine would refuse', async () => {
    const home = await harness.addHome({
      name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true,
    });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    const machine = await publishManagedDevbox(serverId, 'use');
    harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner', machine }) } });
    harness.answer(home, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
    const plans: unknown[] = [];
    harness.answer(home, '/v1/actions/machines.setup.plan', { select: async input => {
      plans.push(input);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
      return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId,
        execution: { ok: false, errorCode: 'setup_manage_required', error: 'setup_manage_required' } } };
    } });
    const { MachineSetupTab } = await import('./MachineSetupTab');
    const screen = await renderScreen(<MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online
      params={{ id: 'setup' }} setParams={vi.fn()} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-read-only')).not.toBeNull());
    expect(plans).toHaveLength(0);
    for (const absent of ['machine-setup-error', 'machine-setup-check-again', 'machine-setup-loading', 'machine-setup-recipes-none']) {
      expect(screen.findByTestId(absent), absent).toBeNull();
    }
    expect(screen.findByTestId('machine-setup-tools-section')).not.toBeNull();
    await screen.unmount();
  });

  it('says an offline Machine cannot be checked instead of loading forever', async () => {
    const home = await harness.addHome({
      name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true,
    });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    await publishManagedDevbox(serverId);
    harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
    harness.answer(home, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
    const { MachineSetupTab } = await import('./MachineSetupTab');
    const screen = await renderScreen(<MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online={false}
      params={{ id: 'setup' }} setParams={vi.fn()} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-offline')).not.toBeNull());
    expect(screen.findByTestId('machine-setup-loading')).toBeNull();
    expect(screen.findByTestId('machine-setup-recipes-none')).toBeNull();
    await screen.unmount();
  });

  it('leads from no preset to making one, from the tab', async () => {
    const home = await harness.addHome({
      name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true,
    });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    await publishManagedDevbox(serverId);
    harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
    harness.answer(home, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
    harness.answer(home, '/v1/actions/machines.setup.plan', { select: async input => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
      return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: { ok: true,
        result: MachineSetupPlanResultV1Schema.parse({ desiredRevision: 0, exclusions: [], support: [],
          sources: [{ kind: 'direct', setup: {} }] }) } } };
    } });
    const { MachineSetupTab } = await import('./MachineSetupTab');
    const screen = await renderScreen(<MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online
      params={{ id: 'setup' }} setParams={vi.fn()} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-preset-none')).not.toBeNull());
    expect(screen.findByTestId('machine-setup-recipes-none')).not.toBeNull();
    await screen.pressByTestIdAsync('machine-setup-preset-none');
    expect(routerHandle.current?.spies.push.mock.calls.at(-1)?.[0])
      .toBe(`/settings/machines/presets/new?serverId=${encodeURIComponent(serverId)}`);
    await screen.unmount();
  });

  it('saves this Machine as an inert preset: one create, no plan or apply, then the editor', async () => {
    const home = await harness.addHome({
      name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true,
    });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    await publishManagedDevbox(serverId);
    harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
    harness.answer(home, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [preset('web', 'Web server')] } });
    const docker = MachinePresetItemV1Schema.parse({ kind: 'softwareRecipe', selection: { ref: { pluginId: 'tools.example', recipeId: 'docker', revision: '1' }, inputs: {} } });
    const firewall = MachinePresetItemV1Schema.parse({ kind: 'setupRecipe', selection: { ref: { pluginId: 'tools.example', recipeId: 'firewall', revision: '1' }, inputs: {} } });
    const keep = MachinePresetItemV1Schema.parse({ kind: 'softwareRecipe', selection: { ref: { pluginId: 'tools.example', recipeId: 'node', revision: '1' }, inputs: {} } });
    harness.answer(home, '/v1/actions/machines.setup.plan', { select: async input => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
      return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: { ok: true,
        result: MachineSetupPlanResultV1Schema.parse({ desiredRevision: 2, exclusions: [], support: [], sources: [
          { kind: 'accountPreset', presetId: 'web', presetRevision: 2, setup: { items: [firewall, docker] } },
          { kind: 'direct', setup: { items: [keep] } },
        ] }) } } };
    } });
    let created: { id: string; name: string; setup: { items?: unknown[] } } | undefined;
    harness.answer(home, '/v1/machines/presets/create', { select: input => {
      created = input as NonNullable<typeof created>;
      return { body: { kind: 'saved', preset: { ...(input as object), revision: 1 } } };
    } });
    const { Modal } = await import('@/modal');
    const show = vi.mocked(Modal.show);
    show.mockClear();
    const { MachineSetupTab } = await import('./MachineSetupTab');
    const screen = await renderScreen(<MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online
      params={{ id: 'setup' }} setParams={vi.fn()} />);
    await waitForHomeGovernance(() => expect({
      door: screen.findByTestId('machine-setup-save-preset') !== null,
      failures: screen.tree.findAll(node => typeof node.props?.diagnosticCode === 'string').map(node => node.props.diagnosticCode),
    }).toEqual({ door: true, failures: [] }));
    const setupActions = () => harness.requests.filter(request => request.path.startsWith('/v1/actions/machines.setup.')).map(request => request.path);
    const planned = setupActions();
    await screen.pressByTestIdAsync('machine-setup-save-preset');
    const shown = show.mock.calls.at(-1)![0] as unknown as Readonly<{ component: React.ComponentType<Record<string, unknown>>; props: Record<string, unknown> }>;
    const setChrome = vi.fn();
    const onClose = vi.fn();
    const modal = await renderScreen(<shown.component {...shown.props} setChrome={setChrome} onClose={onClose} />);
    await waitForHomeGovernance(() => expect(modal.findByTestId('machine-save-preset.item:0.0')).not.toBeNull());
    // Unticking drops one item from the copy; the Machine's own setup is not edited.
    await modal.pressByTestIdAsync('machine-save-preset.item:0.0');
    const save = () => (setChrome.mock.calls.at(-1)![0] as { footer: React.ReactElement<{ primary: { onPress(): void } }> }).footer.props.primary;
    await act(async () => save().onPress());
    await waitForHomeGovernance(() => expect(created).toBeDefined());
    expect(created!.setup.items).toEqual([docker, keep]);
    expect(created!.name).toContain('devbox');
    expect(created).not.toHaveProperty('launch');
    expect(created).not.toHaveProperty('controller');
    expect(harness.requestsFor('/v1/machines/presets/create')).toHaveLength(1);
    expect(setupActions()).toEqual(planned);
    await waitForHomeGovernance(() => expect(routerHandle.current?.spies.push.mock.calls.at(-1)?.[0])
      .toBe(`/settings/machines/presets/${encodeURIComponent(created!.id)}?serverId=${encodeURIComponent(serverId)}`));
    expect(onClose).toHaveBeenCalled();
    await modal.unmount();
    await screen.unmount();
  });

  it('omits the provenance choice when no preset is attached and leaves preset items out when asked', async () => {
    const { projectMachineSetupCapture } = await import('./machineSetupCapture');
    const docker = MachinePresetItemV1Schema.parse({ kind: 'softwareRecipe', selection: { ref: { pluginId: 'tools.example', recipeId: 'docker', revision: '1' }, inputs: {} } });
    const sources = [
      { kind: 'accountPreset' as const, presetId: 'web', presetRevision: 2, setup: { items: [docker] } },
      { kind: 'direct' as const, setup: {} },
    ];
    expect(projectMachineSetupCapture(sources, 'everything', new Set()).sources).toHaveLength(2);
    expect(projectMachineSetupCapture(sources, 'own', new Set()).sources).toEqual([{ kind: 'direct', setup: {} }]);
    expect(projectMachineSetupCapture(sources, 'own', new Set()).leftOut.map(entry => entry.kind)).toEqual(['accountPreset']);
  });

  it('pushes Tools inside the tab and comes back to Setup', async () => {
    const home = await harness.addHome({
      name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true,
    });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    await publishManagedDevbox(serverId);
    harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
    harness.answer(home, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
    const { MachineSetupTab } = await import('./MachineSetupTab');
    const setParams = vi.fn();
    const root = await renderScreen(<MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online={false}
      params={{ id: 'setup' }} setParams={setParams} />);
    await root.pressByTestIdAsync('machine-setup-tools-row');
    expect(setParams).toHaveBeenLastCalledWith({ id: 'setup', page: 'tools' });
    // Offline: no check is sent, so nothing is read from a Machine that can't answer.
    expect(harness.requestsFor('/v1/actions/machines.setup.plan')).toHaveLength(0);
    await root.unmount();
    const tools = await renderScreen(<MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online={false}
      params={{ id: 'setup', page: 'tools' }} setParams={setParams} />);
    expect(tools.findByTestId('machine-setup-tools')).not.toBeNull();
    await tools.pressByTestIdAsync('machine-setup-tools-back');
    expect(setParams).toHaveBeenLastCalledWith({ id: 'setup' });
    await tools.unmount();
  });
});
