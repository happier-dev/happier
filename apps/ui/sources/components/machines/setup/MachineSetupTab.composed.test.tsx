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
const [{ createCliActionExecutorHarness }, { createHostActionOperationRuntime }, { createCombinedMachineSetupActionDeps }] = await Promise.all([
  import('../../../../../cli/src/session/actions/createCliActionExecutorHarness'),
  import('../../../../../cli/src/daemon/actionOperations/createHostActionOperationRuntime'),
  import('../../../../../cli/src/machines/setup/composeMachineSetup'),
]);
await sodium.ready;
beforeEach(async () => {
  nativeRpc.replay = null;
  await harness.reset();
  resetScopedHomeActionExecutorsForTests();
});
afterEach(() => standardCleanup());

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
        params={{ id: 'setup' } as never} setParams={vi.fn()} />,
    );
    const mounted = screen;
    const pressable = (testID: string) => mounted.tree.findAll(
      (node) => node.props?.testID === testID && typeof node.props.onPress === 'function')[0];
    // Opening the tab is the one check: it reads the Machine's setup once and names its preset.
    phase = 'check on open';
    await waitForHomeGovernance(() => expect(pressable('machine-setup-change-preset')).toBeDefined());
    expect(plans).toEqual([{ homeId: 'srv_build', machineId: 'devbox' }]);
    expect(frontDoorReads().length).toBeGreaterThan(0);
    // Change preset → Build box reviews in place; nothing runs before Apply.
    phase = 'review Build box in place';
    const menu = mounted.tree.findAll(node => node.props?.testID === 'machine-setup-preset-menu'
      && typeof node.props.onSelect === 'function')[0]!;
    await act(async () => menu.props.onSelect('build'));
    const { t } = await import('@/text');
    const answer = (testID: string) => mounted.tree.findAll(node => node.props?.testID === testID
      && typeof node.props.title === 'string')[0]?.props.subtitle as string | undefined;
    await waitForHomeGovernance(() => expect(answer('machine-setup-plan-review.administrator')).toContain(t('machinePresets.setup.review.unknown')));
    expect(answer('machine-setup-plan-review.downtime')).toContain(t('machinePresets.setup.review.unknown'));
    expect(mounted.findByTestId('machine-setup-review')).not.toBeNull();
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

  it('leads from no preset to making one, from the tab', async () => {
    const home = await harness.addHome({
      name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true,
    });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
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
      params={{ id: 'setup' } as never} setParams={vi.fn()} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-preset-none')).not.toBeNull());
    expect(screen.findByTestId('machine-setup-recipes-none')).not.toBeNull();
    await screen.pressByTestIdAsync('machine-setup-preset-none');
    expect(routerHandle.current?.spies.push.mock.calls.at(-1)?.[0])
      .toBe(`/settings/machines/presets/new?serverId=${encodeURIComponent(serverId)}`);
    await screen.unmount();
  });

  it('pushes Tools inside the tab and comes back to Setup', async () => {
    const home = await harness.addHome({
      name: 'Build', serverUrl: 'https://build.example', serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true,
    });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
    harness.answer(home, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
    const { MachineSetupTab } = await import('./MachineSetupTab');
    const setParams = vi.fn();
    const root = await renderScreen(<MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online={false}
      params={{ id: 'setup' } as never} setParams={setParams} />);
    await root.pressByTestIdAsync('machine-setup-tools-row');
    expect(setParams).toHaveBeenLastCalledWith({ id: 'setup', page: 'tools' });
    // Offline: no check is sent, so nothing is read from a Machine that can't answer.
    expect(harness.requestsFor('/v1/actions/machines.setup.plan')).toHaveLength(0);
    await root.unmount();
    const tools = await renderScreen(<MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online={false}
      params={{ id: 'setup', page: 'tools' } as never} setParams={setParams} />);
    expect(tools.findByTestId('machine-setup-tools')).not.toBeNull();
    await tools.pressByTestIdAsync('machine-setup-tools-back');
    expect(setParams).toHaveBeenLastCalledWith({ id: 'setup' });
    await tools.unmount();
  });
});
