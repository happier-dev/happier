import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFailed, onTestFinished, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema,
  ExternalActionExecutionAuthorizationRequestV1Schema, bindExternalActionExecutionAuthorizationHttpPathV1,
  projectExternalActionDeploymentPreparationEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
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
import { openManagedMachinePresetRecipientProjectionV1, projectManagedMachinePresetForRecipientV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { ManagedMachinePresetV1Schema } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { projectManagedOpaqueSetupSourcesV1 } from '@happier-dev/cli-common/machines/managed';
import type { MachineSetupSourceV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import type { MachineSetupPlanResultV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { getMachineSetupDesiredV1 } from '@happier-dev/protocol/machines/setup/machineSetupSourcesV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import sodium from '@/encryption/libsodium.lib';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createPlainManagedMachinePresetFixture } from '@/dev/testkit/fixtures/machineProvisionerFixtures';
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
import type { Machine } from '@/sync/domains/state/storageTypes';

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
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ renderCustomModals: true }).module;
  },
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
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const router = createExpoRouterMock();
    routerHandle.current = router;
    return router.module;
  },
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

it('retains the plan Action refusal on open and reapply review instead of turning it into an approval failure', async () => {
  const home = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example',
    serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
  const serverId = resolveServerProfileScopeIdForIdentifier(home);
  await publishManagedDevbox(serverId);
  harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
  const failure = { ok: false as const, errorCode: 'invalid_encrypted_envelope', error: 'invalid_encrypted_envelope' };
  harness.answer(home, '/v1/actions/machines.setup.plan', { select: input => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
    return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.setup.plan',
      requestId: envelope.requestId, execution: failure }) };
  } });
  const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
  const { useMachineSetup } = await import('./useMachineSetup');
  const { presentActionFailureOutcome } = await import('@/components/tools/shell/approvals/approvalFailureOutcome');
  const hook = await renderHook(() => useMachineSetup({ serverId, machineId: 'devbox', active: true, online: true, canCheck: true }));
  onTestFinished(() => hook.unmount());
  await waitForHomeGovernance(() => expect(hook.getCurrent().failure?.during).toBe('check'));
  expect(hook.getCurrent().failure?.failure).toMatchObject(failure);
  const outcome = presentActionFailureOutcome(hook.getCurrent().failure!.failure!);
  expect(outcome).toMatchObject({ code: failure.errorCode, message: null });
  expect(outcome.reason).toEqual(expect.any(String));
  expect(outcome.reason).not.toContain(failure.errorCode);
  await act(async () => { await hook.getCurrent().prepare({ kind: 'reapply' }); });
  expect(hook.getCurrent().failure).toMatchObject({ during: 'review', code: failure.errorCode, failure });
  expect(harness.requests.some(request => request.path === '/v1/actions/machines.setup.apply')).toBe(false);
});

it('explains the saved App address prerequisite before Apply and reveals the declared key in Details', async () => {
  const home = await harness.addHome({ name: 'Build', serverUrl: 'https://preset-address.example',
    serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
  const serverId = resolveServerProfileScopeIdForIdentifier(home);
  await publishManagedDevbox(serverId);
  harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
  const key = 'SERVICE_URL_REDISINSIGHT_5540';
  // Home HTTP is the boundary: retain the canonical Plan refusal, real Action
  // executor, setup hook and mounted existing failure/Details presentation.
  const failure = { ok: false as const, effectAttempted: false, errorCode: 'template_domain_required',
    error: `template_domain_required: ${JSON.stringify(key)}`, details: { key } };
  harness.answer(home, '/v1/actions/machines.setup.plan', { select: input => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
    return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.setup.plan',
      requestId: envelope.requestId, execution: failure }) };
  } });
  const { MachineSetupTab } = await import('./MachineSetupTab');
  const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
  const screen = await renderScreen(<MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online
    params={{ id: 'setup' }} setParams={vi.fn()} />);
  await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-error')).not.toBeNull());
  expect(screen.getTextContent()).toContain(readDeploymentRefusalRecoveryV1(failure.errorCode, failure.details)!.remedy);
  expect(screen.getTextContent()).not.toContain(key);
  await screen.pressByTestIdAsync('machine-setup-error-details-toggle');
  expect(screen.getTextContent()).toContain(key);
  expect(screen.findByTestId('machine-setup-apply')).toBeNull();
  expect(harness.requests.some(request => request.path === '/v1/actions/machines.setup.apply')).toBe(false);
});

it('leads a missing App address to the attached preset\'s setup editor instead of only retrying the check', async () => {
  const home = await harness.addHome({ name: 'Build', serverUrl: 'https://preset-address-editor.example',
    serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
  const serverId = resolveServerProfileScopeIdForIdentifier(home);
  const key = 'SERVICE_URL_REDISINSIGHT_5540';
  const templateRef = { sourceId: 'apps', itemId: 'redisinsight', version: '1', ref: { kind: 'content' as const, digest: `sha256:${'a'.repeat(64)}` } };
  const app = (name: string, domainBindings?: readonly { templateDomainId: string; hostname: string }[]) => ({ kind: 'app' as const, definition: {
    name, project: { kind: 'create' as const }, definition: { from: 'catalogApp' as const, templateRef }, bindings: [],
    ...(domainBindings ? { domainBindings } : {}) } });
  // The daemon's published attachment list names the attached presets; the Account catalog holds their saved Apps.
  const bound = { ...preset('bound', 'Bound tools'), setup: { items: [app('Bound', [{ templateDomainId: key, hostname: 'redis.example.com' }])] } };
  const missing = { ...preset('redis-tools', 'Redis tools'), setup: { items: [app('RedisInsight')] } };
  await publishManagedDevbox(serverId, undefined, { setup: { version: 1, desiredRevision: 3, status: 'drifted', recipes: [],
    attachedPresets: [bound, missing].map(entry => ({ kind: 'accountPreset' as const, presetId: entry.id, presetRevision: entry.revision })) } });
  harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
  harness.answer(home, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [presetWire(bound), presetWire(missing)] } });
  const failure = { ok: false as const, effectAttempted: false, errorCode: 'template_domain_required',
    error: `template_domain_required: ${JSON.stringify(key)}`, details: { key } };
  harness.answer(home, '/v1/actions/machines.setup.plan', { select: input => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
    return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.setup.plan',
      requestId: envelope.requestId, execution: failure }) };
  } });
  const { MachineSetupTab } = await import('./MachineSetupTab');
  const { t } = await import('@/text');
  const screen = await renderScreen(<MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online
    params={{ id: 'setup' }} setParams={vi.fn()} />);
  onTestFinished(() => screen.unmount());
  await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props?.testID === 'machine-setup-error'
    && node.props.action?.label === t('machinePresets.editSetup')).length).toBeGreaterThan(0));
  const plansBefore = harness.requests.filter(request => request.path === '/v1/actions/machines.setup.plan').length;
  const card = screen.tree.findAll(node => node.props?.testID === 'machine-setup-error' && node.props.action)[0]!;
  await act(async () => { await card.props.action.onPress(); });
  expect(routerHandle.current?.spies.push.mock.calls.at(-1)?.[0])
    .toBe(`/settings/machines/presets/redis-tools?serverId=${encodeURIComponent(serverId)}&edit=true`);
  expect(harness.requests.filter(request => request.path === '/v1/actions/machines.setup.plan')).toHaveLength(plansBefore);
});

it('opens an opaque saved setup source from the exact plan projection without fetching a current preset', async () => {
  const home = await harness.addHome({ name: 'Opaque setup', serverUrl: 'https://opaque-setup.example',
    serverIdentityId: 'srv_opaque_setup', accountId: 'owner', currentAccount: true });
  const serverId = resolveServerProfileScopeIdForIdentifier(home);
  const machine = await publishManagedDevbox(serverId);
  const setup = { scripts: [{ body: 'echo historical setup' }] };
  const plan = MachineSetupPlanResultV1Schema.parse({
    desiredRevision: 4,
    exclusions: [],
    support: [],
    sources: [
      { kind: 'accountPresetOpaque', presetId: 'historical-preset', presetRevision: 3, contentEncryptionMode: 'plain' },
      { kind: 'direct', setup: {} },
    ],
    resolvedSources: [
      { kind: 'accountPresetOpaque', presetId: 'historical-preset', presetRevision: 3, contentEncryptionMode: 'plain',
        presetContent: { content: { t: 'plain', v: { v: 1, name: 'Historical preset', setup } }, recipientEnvelope: null } },
      { kind: 'direct', setup: {} },
    ],
  });
  // Account-action admission reads the existing machine before dispatching
  // Plan; keep that real boundary separate from the retained preset carrier.
  harness.answer(home, '/v1/machines/devbox', {
    body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner', machine }) },
  });
  harness.answer(home, '/v1/actions/machines.setup.plan', { select: input => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
    return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'machines.setup.plan',
      requestId: envelope.requestId, execution: { ok: true, result: plan } }) };
  } });
  const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
  const { useMachineSetup } = await import('./useMachineSetup');
  const hook = await renderHook(() => useMachineSetup({ serverId, machineId: 'devbox', active: true, online: true, canCheck: true }));
  onTestFinished(() => hook.unmount());

  await waitForHomeGovernance(() => {
    expect(hook.getCurrent().failure).toBeNull();
    expect(hook.getCurrent().plan?.resolvedSources).toEqual(plan.resolvedSources);
    expect(hook.getCurrent().sourcePresentations?.[0]).toMatchObject({
      kind: 'opened', presetName: 'Historical preset', source: { kind: 'accountPreset', presetId: 'historical-preset', setup },
    });
  });
  expect(harness.requests.some(request => request.path.startsWith('/v1/machines/presets/'))).toBe(false);
});
it('reads bodyless setup notices and preserves the attached copy until candidate Review', async () => {
  const home = await harness.addHome({ name: 'Preset headers', serverUrl: 'https://preset-headers.example',
    serverIdentityId: 'srv_preset_headers', accountId: 'owner', currentAccount: true });
  const serverId = resolveServerProfileScopeIdForIdentifier(home);
  const ids = ['changed', 'renamed', 'archived', 'missing'];
  const machine = await publishManagedDevbox(serverId, undefined, { setup: { version: 1, desiredRevision: 3,
    status: 'satisfied', recipes: [], attachedPresets: ids.map(presetId => ({ kind: 'accountPreset' as const,
      presetId, presetRevision: 2, setupRevision: 1 })) } });
  harness.answer(home, '/v1/machines/devbox', {
    body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner', machine }) },
  });
  const plan = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 3, exclusions: [], support: [],
    sources: [...ids.map(presetId => ({ kind: 'accountPresetOpaque', presetId, presetRevision: 2,
      setupRevision: 1, contentEncryptionMode: 'plain' })), { kind: 'direct', setup: {} }] });
  harness.answer(home, '/v1/actions/machines.setup.plan', { select: input => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
    const request = MachineSetupPlanInputV1Schema.parse(envelope.input);
    const reviewed = request.candidatePreset ? MachineSetupPlanResultV1Schema.parse({ ...plan, recipePlans: [],
      sources: plan.sources.map(source => source.kind === 'accountPresetOpaque' && source.presetId === 'changed'
        ? { ...source, presetRevision: 5, setupRevision: 2 } : source) }) : plan;
    return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId,
      execution: { ok: true, result: reviewed } } };
  } });
  const reads: unknown[] = [];
  harness.answer(home, '/v1/machines/presets/list', { select: input => {
    reads.push(input);
    return { body: { kind: 'revisions', presets: [
      { id: 'changed', homeId: 'srv_preset_headers', revision: 5, setupRevision: 2 },
      { id: 'renamed', homeId: 'srv_preset_headers', revision: 8, setupRevision: 1 },
      { id: 'archived', homeId: 'srv_preset_headers', revision: 3, setupRevision: 1, archivedAt: 1 },
    ] } };
  } });
  const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
  const { useMachineSetup } = await import('./useMachineSetup');
  const hook = await renderHook(() => useMachineSetup({ serverId, machineId: 'devbox', active: true, online: true, canCheck: true }));
  onTestFinished(() => hook.unmount());
  // The existing Plan path must work before exercising the new header consumer.
  await waitForHomeGovernance(() => expect(hook.getCurrent().plan).toEqual(plan));
  await waitForHomeGovernance(() => expect(reads).toHaveLength(1));
  const { readMachinePresetRevisionsSnapshot } = await import('@/sync/engine/machines/machinePresetsResource');
  const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
  expect(getServerProfileById(serverId)?.serverIdentityId).toBe('srv_preset_headers');
  await waitForHomeGovernance(() => expect(readMachinePresetRevisionsSnapshot(serverId, 'srv_preset_headers'))
    .toMatchObject({ loading: false, error: null }));
  await waitForHomeGovernance(() => expect(readMachinePresetRevisionsSnapshot(serverId, 'srv_preset_headers', 'owner'))
    .toMatchObject({ loading: false, error: null }));
  await waitForHomeGovernance(() => expect(hook.getCurrent().presetUpdates).toEqual([
    { kind: 'changed', presetId: 'changed', presetRevision: 5, setupRevision: 2 },
    { kind: 'unavailable', presetId: 'archived', reason: 'preset_archived' },
    { kind: 'unavailable', presetId: 'missing', reason: 'preset_not_found' },
  ]));
  expect(reads).toEqual([{ homeId: 'srv_preset_headers', projection: 'revisions', includeArchived: true }]);
  const notices = hook.getCurrent().presetUpdates;
  const { invalidateMachinePresets } = await import('@/sync/engine/machines/machinePresetsResource');
  await act(async () => { invalidateMachinePresets(serverId); });
  await waitForHomeGovernance(() => expect(reads).toHaveLength(2));
  expect(hook.getCurrent().presetUpdates).toBe(notices);
  expect(hook.getCurrent().plan).toEqual(plan);
  expect(harness.requests.some(request => request.path === '/v1/actions/machines.setup.apply'
    || request.path === '/v1/machines/presets/get')).toBe(false);
  const plansBeforeReview = harness.requests.filter(request => request.path === '/v1/actions/machines.setup.plan').length;
  await act(async () => { await hook.getCurrent().prepare({ kind: 'presetUpdate', presetId: 'changed',
    presetRevision: 5, setupRevision: 2 }); });
  expect(hook.getCurrent().failure).toBeNull();
  expect(hook.getCurrent().review?.prepared).toMatchObject({ ok: true, input: { targets: [{ sources: [
    { kind: 'accountPresetOpaque', presetId: 'changed', presetRevision: 5, setupRevision: 2 },
    ...plan.sources.slice(1),
  ] }] } });
  expect(harness.requests.filter(request => request.path === '/v1/actions/machines.setup.plan'))
    .toHaveLength(plansBeforeReview + 1);
  await act(async () => { hook.getCurrent().cancelReview(); });
  expect(hook.getCurrent().plan).toEqual(plan);
  expect(harness.requests.some(request => request.path === '/v1/actions/machines.setup.apply')).toBe(false);
});
it('keeps the retained recipe rows across a Home-free Check after the preset is archived', async () => {
  const home = await harness.addHome({ name: 'Retained setup', serverUrl: 'https://retained-setup.example',
    serverIdentityId: 'srv_retained_setup', accountId: 'owner', currentAccount: true });
  const serverId = resolveServerProfileScopeIdForIdentifier(home);
  const item = { kind: 'softwareRecipe' as const, selection: {
    ref: { pluginId: 'example.setup', recipeId: 'runtime', revision: '1' }, inputs: {},
  } };
  const sources: MachineSetupSourceV1 = [{ kind: 'accountPreset', presetId: 'archived-preset', presetRevision: 2,
    setupRevision: 1, contentEncryptionMode: 'plain', setup: { items: [item] } }, { kind: 'direct', setup: {} }];
  const desired = { version: 1 as const, revision: 3, sources, exclusions: [] };
  const original = await publishManagedDevbox(serverId, undefined, { setup: { version: 1, desiredRevision: 3,
    status: 'satisfied', recipes: [], attachedPresets: [{ kind: 'accountPreset', presetId: 'archived-preset',
      presetRevision: 2, setupRevision: 1 }] } });
  const machine = { ...original, metadata: { ...original.metadata!, setup: desired } };
  const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
  await act(async () => { await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [machine]); });
  harness.answer(home, '/v1/machines/devbox', {
    body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner', machine }) },
  });
  harness.answer(home, '/v1/machines/presets/list', { body: { kind: 'revisions', presets: [{
    id: 'archived-preset', homeId: 'srv_retained_setup', revision: 4, setupRevision: 2, archivedAt: 1,
  }] } });
  const { PluginProjectedMachineRecipeEntryV1Schema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
  const recipe = PluginProjectedMachineRecipeEntryV1Schema.parse({ id: 'example.setup/runtime', pluginId: 'example.setup', pluginVersion: '1',
    definition: { id: 'runtime', revision: '1', title: 'Retained runtime', software: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      steps: [{ id: 'install', kind: 'command', executable: 'install', args: ['runtime'],
        check: { executable: 'test', args: ['-e', 'runtime'], unsatisfiedExitCodes: [1] } }],
    } });
  const current = await getMachineSetupDesiredV1({
    read: async () => ({ status: 'ready', metadataVersion: 3, metadata: machine.metadata }),
    compareAndSwap: async () => { throw new Error('Check cannot mutate retained Setup'); },
  });
  harness.answer(home, '/v1/actions/machines.setup.plan', { select: async input => {
    const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
    const local = await prepareMachineSetupPlanV1({ input: MachineSetupPlanInputV1Schema.parse(envelope.input), current,
      readRecipes: async () => [recipe], runNative: async command => {
        expect(command.executable).toBe('test');
        return { code: 0, stdout: '', stderr: '' };
      } });
    if ('errorCode' in local) throw new Error(local.errorCode);
    return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId,
      execution: { ok: true, result: { ...local, sources: projectManagedOpaqueSetupSourcesV1(local.sources) } } } };
  } });
  const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
  const { useMachineSetup, readOpenedMachineSetupSources, readMachineSetupRecipes } = await import('./useMachineSetup');
  const hook = await renderHook(() => useMachineSetup({ serverId, machineId: 'devbox', active: true, online: true, canCheck: true }));
  onTestFinished(() => hook.unmount());
  await waitForHomeGovernance(() => expect(hook.getCurrent().plan?.desiredRevision).toBe(3));
  await waitForHomeGovernance(() => expect(readMachineSetupRecipes(hook.getCurrent().plan,
    readOpenedMachineSetupSources(hook.getCurrent().sourcePresentations), hook.getCurrent().observation))
    .toMatchObject([{ ref: item.selection.ref, fromPreset: true }]));
  expect(readOpenedMachineSetupSources(hook.getCurrent().sourcePresentations)[0]?.source).toEqual(sources[0]);
  expect(harness.requests.some(request => request.path.startsWith('/v1/machines/presets/')
    && request.path !== '/v1/machines/presets/list')).toBe(false);
  expect(hook.getCurrent().plan).not.toHaveProperty('resolvedSources');
});
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
  // Retire the credential lifetime after failure diagnostics, before the next device reset.
  onTestFinished(() => harness.reset());
});
afterEach(() => standardCleanup());

// The Machine page owns this already-hydrated inventory before rendering a tab.
async function publishManagedDevbox(serverId: string, role?: 'use', daemonState?: Machine['daemonState']) {
  const { storage } = await import('@/sync/domains/state/storage');
  const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
  const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
  const scope = { serverId, accountId: 'owner' };
  const machine = createMachineFixture({ id: 'devbox', isShared: role !== undefined, activeAt: Date.now(), ...(daemonState ? { daemonState } : {}),
    ...(role ? { access: { role, resourceMode: 'plain' as const, accessState: 'ready' as const, custodian: { accountId: 'owner', displayName: 'Owner' } } } : {}) });
  await act(async () => {
    storage.setState({ settingsScope: scope });
    await publishMachineInventoryForTest(scope, [machine]);
  });
  return machine;
}

const preset = (id: string, name: string, creation = false) => createPlainManagedMachinePresetFixture({
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
}).opened;

/** HTTP fixtures use the same explicit persisted envelope as the preset writer. */
function presetWire(opened: ReturnType<typeof preset>) {
  const { v: _version, contentEncryptionMode: _mode, recipientProjection: _projection, ...draft } = opened;
  return createPlainManagedMachinePresetFixture(draft);
}

/** A remote Plan carries exact opaque identities beside independently opened presentation copies. */
function setupPlanFromOpened(input: Omit<MachineSetupPlanResultV1, 'sources' | 'resolvedSources'> & { sources: MachineSetupSourceV1 }) {
  const opened = input.sources.map(source => source.kind === 'accountPreset'
    ? { ...source, contentEncryptionMode: 'plain' as const } : source);
  const sources = projectManagedOpaqueSetupSourcesV1(opened);
  const resolvedSources = sources.map((source, index) => {
    if (source.kind !== 'accountPresetOpaque') return source;
    const local = opened[index]!;
    const saved = presetWire({ ...preset(source.presetId, source.presetId), revision: source.presetRevision, setup: local.setup });
    return { ...source, presetContent: projectManagedMachinePresetForRecipientV1({ ...saved, recipientAccountId: 'owner' }) };
  });
  return MachineSetupPlanResultV1Schema.parse({ ...input, sources, resolvedSources });
}

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
    const prepared = await prepareMachineSetupPresetApplyInput({ executeAction: executor.execute, context: { surface: 'ui' },
      homeId: 'srv_build', machineId: 'devbox', preset: { kind: 'bundledPreset', ref, setup }, isCurrent: () => true });
    expect(prepared).toMatchObject({
      ok: true, input: { targets: [{ sources: [{ kind: 'bundledPreset', ref, setup }, { kind: 'direct', setup: {} }] }] },
    });
    if (!prepared?.ok) throw new Error('Bundled preset preparation failed');
    expect(prepared.input.targets[0]?.preset).toBeUndefined();
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
    const selected = { kind: 'bundledPreset' as const, ref: { pluginId: 'example.setup', localId: 'build', revision: '2' }, setup: { scripts: [{ body: 'echo updated' }] } };
    const current = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 3, sources: [
      { kind: 'bundledPreset', ref: { ...selected.ref, revision: '1' }, setup: { items: [item] } },
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
          selected,
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
    const attached = { kind: 'accountPresetOpaque' as const, presetId: 'web', presetRevision: 1, contentEncryptionMode: 'plain' as const };
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
      { kind: 'accountPresetOpaque', presetId: 'build', presetRevision: 2, contentEncryptionMode: 'plain' },
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
    const sources = [{ kind: 'accountPresetOpaque', presetId: selected.id, presetRevision: selected.revision,
      contentEncryptionMode: 'plain' }, ...current.sources];
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
    expect(prepared).toEqual({ sourcePresentations: [{ homeId: 'srv_build', machineId: 'devbox',
      sources: sources.map(source => source.kind === 'accountPresetOpaque' ? { kind: 'unavailable', source } : { kind: 'opened', source }) }], ok: true, review: { machineId: 'workflow-host', machines: [{ machineId: 'workflow-host', online: true }] },
      facts: [{ homeId: 'srv_build', machineId: 'devbox', support: targetSupport, review: targetReview }],
      input: { homeId: 'srv_build', machineId: 'workflow-host', targets: [
      { homeId: 'srv_build', machineId: 'devbox', sources, desiredRevision: 7, recipePlans: [], exclusions: [],
        preset: { id: selected.id, revision: selected.revision, name: selected.name }, appChildren },
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
          source.kind === 'accountPresetOpaque' ? { ...source, presetRevision: source.presetRevision + 1 } : source) };
        return planInput.mode === 'effects' ? { ...current, sources: planInput.sources!, recipePlans: [] } : current;
      },
    }));
    const context = { surface: 'ui' as const };
    const selected = preset('build', 'Build box');
    const params = { executeAction: executor.execute, context, homeId: 'srv_build', machineId: 'devbox',
      preset: selected, isCurrent: () => true };
    const prepared = await prepareMachineSetupPresetApplyInput(params);
    const sources = [{ kind: 'accountPresetOpaque', presetId: selected.id, presetRevision: selected.revision,
      contentEncryptionMode: 'plain' }, ...current.sources];
    expect(plans).toEqual([{ homeId: 'srv_build', machineId: 'devbox' },
      { homeId: 'srv_build', machineId: 'devbox', mode: 'effects', sources }]);
    // A Plan without review facts stays unknown: no review is invented.
    expect(prepared).toEqual({ sourcePresentations: [{ homeId: 'srv_build', machineId: 'devbox',
      sources: sources.map(source => source.kind === 'accountPresetOpaque' ? { kind: 'unavailable', source } : { kind: 'opened', source }) }], ok: true, facts: [{ homeId: 'srv_build', machineId: 'devbox', support: [] }],
      input: { homeId: 'srv_build', machineId: 'devbox', targets: [
      { homeId: 'srv_build', machineId: 'devbox', sources, desiredRevision: 7, recipePlans: [], exclusions: [],
        preset: { id: selected.id, revision: selected.revision, name: selected.name } },
    ] } });
    changed = true;
    expect(await prepareMachineSetupPresetApplyInput(params)).toMatchObject({ ok: false, errorCode: 'plan_changed' });
  });
});

describe('Machine → Setup tab (P-M1)', () => {
  it.each(['succeeded', 'failed'] as const)('follows native child rows from the combined Apply receipt while the root retains settlement (%s)', async outcome => {
    const home = await harness.addHome({ name: 'Build', serverUrl: 'https://combined-setup.example',
      serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    await publishManagedDevbox(serverId);
    const installationKey = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(19));
    harness.answer(home, '/v1/machines/devbox', { body: { machine: {
      ...createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }),
      installationPublicKey: encodeBase64(installationKey.publicKey, 'base64'),
    } } });
    const scripts = [{ body: 'printf FIRST', affects: 'none' as const }, { body: 'printf SECOND', affects: 'none' as const }];
    const plan = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 0, sources: [{ kind: 'direct', setup: { scripts } }],
      exclusions: [], support: [], recipePlans: [] });
    let holdPlan: Promise<void> | null = null;
    let refusePlans = false;
    harness.answer(home, '/v1/actions/machines.setup.plan', { select: async input => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
      const refused = refusePlans;
      await holdPlan;
      return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: refused
        ? { ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }
        : { ok: true, result: plan } } };
    } });
    const [{ actionOperationStore }, { createSetupOperationSnapshot }, { createWorkflowRunSummaryFixture }] = await Promise.all([
      import('@/sync/domains/actionOperations/actionOperationStore'),
      import('../../../../../cli/src/machines/setup/setupOperationSnapshot'),
      import('@/dev/testkit/fixtures/workflowRunFixtures'),
    ]);
    const runtime = createHostActionOperationRuntime({ machineId: 'devbox', serverId,
      resolveAccountId: async () => 'owner', publishSnapshot: snapshot => {
        actionOperationStore.mergeSnapshots({ serverId, snapshots: [snapshot] });
      } });
    let finishNative: (() => void) | undefined;
    let finishRoot!: () => void;
    const rootEffect = new Promise<void>(resolve => { finishRoot = resolve; });
    let nativeEffect: Promise<unknown> | undefined;
    const combined = createCombinedMachineSetupActionDeps({ readDeps: () => ({}),
      targetPlan: async () => plan, orchestrationDirectory: '/setup',
      readHostFacts: async () => ({ machines: [{ machineId: 'devbox', online: true }] }),
      // Workflow transport is the boundary. Its native operation and row
      // producer remain real and publish through the normal host sink.
      startCombined: async request => {
        nativeEffect = runtime.runActionOperation({ actionId: 'machines.setup.apply', input: request.parent.input,
          context: { surface: 'agent', runtimeAccountId: 'owner', actionRequestId: 'native-setup',
            executionRunWorkflowRunId: request.start.runId,
            actionCaller: { kind: 'workflowRun', runId: request.start.runId,
              authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } } },
          execute: async context => {
            if (!context.operationAcceptance || !context.operationOwnerUpdate) throw new Error('Native owner not admitted');
            const snapshot = createSetupOperationSnapshot({ kind: 'machineSetup', serverId: 'srv_build', machineId: 'devbox',
              preset: { id: 'build', revision: 2, name: 'Build box' } },
              [], context.operationOwnerUpdate.update, scripts);
            const nativeResult = { operationId: context.operationAcceptance.operationId, terminalId: 'native-output' };
            context.operationAcceptance.accept(nativeResult);
            snapshot.emit({ type: 'machine.setup.progress', stepId: 'script:0', data: { planIndex: 0, status: 'started' } });
            snapshot.update({ domainRef: { kind: 'machineSetup', serverId: 'srv_build', machineId: 'devbox', terminalId: 'native-output' } });
            await new Promise<void>(resolve => { finishNative = resolve; });
            if (outcome === 'failed') {
              snapshot.emit({ type: 'machine.setup.result', stepId: 'script:0', data: { status: 'failed', stepId: 'script:0', reason: 'Native step failed' } });
              return { ok: false, errorCode: 'native_step_failed', error: 'Native step failed' };
            }
            for (const stepId of ['script:0', 'script:1']) snapshot.emit({ type: 'machine.setup.progress', stepId,
              data: { planIndex: 0, status: 'satisfied' } });
            return { ok: true, result: nativeResult };
          } });
        return { admission: 'created', run: createWorkflowRunSummaryFixture({ id: request.start.runId,
          machineId: 'devbox', ownerAccountId: 'owner', origin: { kind: 'direct' } }) };
      },
      readInvocations: async () => ({ invocations: [], invocationDetails: [], parentRevision: 1 }),
      waitForRun: async request => {
        await nativeEffect;
        await rootEffect;
        return { run: createWorkflowRunSummaryFixture({ id: request.start.runId, machineId: 'devbox', ownerAccountId: 'owner',
          origin: { kind: 'direct' }, state: outcome, workflowCustodyState: 'settled' }) };
      },
    });
    const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
    const { readOriginalAccountActionAuthentication } = await import('@/sync/api/externalActionAccountTransport');
    const account = await captureLazyActionAccountContext(home);
    onTestFinished(() => account.dispose());
    harness.answer(home, bindExternalActionExecutionAuthorizationHttpPathV1('machines.setup.apply'), { select: input => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(input);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.envelope);
      const authentication = readOriginalAccountActionAuthentication(account.credentials.token);
      if (!authentication || envelope.target?.kind !== 'machine') throw new Error('Expected an Account Machine invocation');
      return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'combined-setup-authorization', binding: {
        accountId: 'owner', authentication, serverIdentityId: 'srv_build', machineId: 'devbox',
        custodianAccountId: 'owner', installationId: 'test-installation', actionId: 'machines.setup.apply',
        accountEncryptionMode: 'plain', requestId: envelope.requestId, target: envelope.target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        deploymentPreparationAdmission: projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({
          actionId: 'machines.setup.apply', envelope,
        }),
      } }) };
    } });
    harness.answer(home, '/v1/actions/machines.setup.apply', { select: async input => {
      const request = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(input);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.success ? request.data.envelope : input);
      const parsed = MachineSetupApplyInputV1Schema.parse(envelope.input);
      const execution = await runtime.runActionOperation({ actionId: 'machines.setup.apply', input: parsed,
        context: { surface: 'ui', serverId, runtimeAccountId: 'owner', actionRequestId: envelope.requestId,
          actionCaller: { kind: 'host' } }, execute: async context => {
          const result = await combined.machineSetupApply!({ input: parsed, context });
          const failure = ActionExecuteFailureSchema.safeParse(result);
          return failure.success ? failure.data : { ok: true, result };
        } });
      return { body: { v: 1, actionId: 'machines.setup.apply', requestId: envelope.requestId, execution } };
    } });
    const [{ renderHook }, { useMachineSetup }] = await Promise.all([
      import('@/dev/testkit/hooks/renderHook'), import('./useMachineSetup'),
    ]);
    let hook = await renderHook(() => useMachineSetup({ serverId, machineId: 'devbox', active: true, online: true, canCheck: true }));
    onTestFinished(async () => { finishNative?.(); finishRoot(); await hook.unmount(); });
    await waitForHomeGovernance(() => expect({ plan: hook.getCurrent().plan !== null, failure: hook.getCurrent().failure })
      .toEqual({ plan: true, failure: null }));
    await act(async () => { await hook.getCurrent().prepare({ kind: 'reapply' }); });
    await act(async () => { await hook.getCurrent().apply(); });
    expect(hook.getCurrent().failure).toBeNull();
    expect(hook.getCurrent().operationId).toEqual(expect.any(String));
    expect(nativeEffect).toBeDefined();
    await waitForHomeGovernance(() => expect(hook.getCurrent().progressOperation?.snapshot.domainRef).toMatchObject({
      kind: 'machineSetup', steps: [{ stepId: 'script:0', state: 'running', terminalId: 'native-output' },
        { stepId: 'script:1', state: 'pending' }],
    }));
    expect(hook.getCurrent().operation?.snapshot).toMatchObject({ state: 'running' });
    expect(hook.getCurrent().operation?.snapshot.domainRef).toBeUndefined();
    const rootId = hook.getCurrent().operationId;
    expect(hook.getCurrent().progressOperation?.snapshot.operationId).not.toBe(rootId);
    await hook.unmount();
    hook = await renderHook(() => useMachineSetup({ serverId, machineId: 'devbox', active: true, online: true, canCheck: true }));
    await waitForHomeGovernance(() => expect(hook.getCurrent().operationId).toBe(rootId));
    expect(hook.getCurrent().progressOperation?.snapshot.domainRef).toMatchObject({ kind: 'machineSetup',
      steps: [{ state: 'running' }, { state: 'pending' }] });
    const [{ MachineSetupTab }, { AccountNoticeInvestigationBoundary }, { ItemList }] = await Promise.all([
      import('./MachineSetupTab'), import('@/hooks/inbox/AccountNoticeInvestigationProvider'),
      import('@/components/ui/lists/ItemList'),
    ]);
    const screen = await renderScreen(<AccountNoticeInvestigationBoundary>
      <ItemList>
        <MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online
          params={{ id: 'setup' }} setParams={() => {}} />
      </ItemList>
    </AccountNoticeInvestigationBoundary>);
    onTestFinished(() => screen.unmount());
    const { t } = await import('@/text');
    // Where the run is, under its row: the step that runs, then the step it stopped at (lab L7).
    const runLine = (text: string) => screen.tree.findAll((node) => node.props?.subtitle === text).length > 0;
    // A Machine with a setup run is not "nothing set up": the empty intro would be a false status.
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-operation')).not.toBeNull());
    const emptyIntro = t('machinePresets.setup.tab.ledeEmpty', { machine: 'devbox' });
    expect(screen.tree.findAll((node) => node.props?.description === emptyIntro)).toHaveLength(0);
    await waitForHomeGovernance(() => expect(runLine(t('machinePresets.setup.tab.stepOf', { current: 1, total: 2, machine: 'devbox' })))
      .toBe(true));
    if (outcome === 'succeeded') {
      const { reconcileActionOperationsOnce } = await import('@/sync/domains/actionOperations/actionOperationRuntime');
      const scope = { serverId, machineId: 'devbox', accountId: 'owner' };
      const stepRow = () => screen.findByTestId('machine-setup-steps-row-0:script:0');
      expect(stepRow()?.props.accessibilityState.busy).toBe(true);
      await act(async () => {
        await reconcileActionOperationsOnce({ scope, list: async () => ({ items: [] }) });
      });
      expect(hook.getCurrent().progressOperation).toMatchObject({ observation: 'unavailable' });
      expect(stepRow()?.props.accessibilityState.busy).toBe(false);
      expect(screen.getTextContent()).toContain(t('inbox.actionOperations.observation.unavailable'));
      expect(screen.findByTestId('machine-setup-progress')).toBeNull();
    }
    await act(async () => { finishNative!(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().progressOperation?.snapshot.state).toBe(outcome));
    if (outcome === 'failed') {
      await waitForHomeGovernance(() => expect(runLine(t('machinePresets.setup.tab.stoppedAtStepOf', { current: 1, total: 2, machine: 'devbox' })))
        .toBe(true));
      // The failed step opens its output; why it stopped is said once, at the head.
      expect(screen.findByTestId('machine-setup-steps-row-0:script:0-subtitle')?.props.children)
        .toBe(`› ${t('projects.scripts.output.title')}`);
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-stopped')).not.toBeNull());
      expect(screen.findByTestId('machine-setup-stopped.action')).toBeNull();
      expect(screen.findByTestId('machine-setup-apply')).toBeNull();
    }
    expect(hook.getCurrent().operation?.snapshot.state).toBe('running');
    // A read that started before settlement cannot produce the post-run check fact.
    let releasePlan!: () => void;
    holdPlan = new Promise<void>(resolve => { releasePlan = resolve; });
    onTestFinished(() => releasePlan());
    const plansBefore = harness.requests.filter(request => request.path === '/v1/actions/machines.setup.plan').length;
    let checking!: Promise<void>;
    await act(async () => { checking = hook.getCurrent().check(); });
    await waitForHomeGovernance(() => expect(harness.requests.filter(request => request.path === '/v1/actions/machines.setup.plan'))
      .toHaveLength(plansBefore + 1));
    // Both mounted consumers must see the refusal when their post-run read starts.
    // The already-started read captured success before this boundary changed.
    refusePlans = outcome === 'succeeded';
    await act(async () => { finishRoot(); });
    await waitForHomeGovernance(() => expect(hook.getCurrent().operation?.snapshot.state).toBe(outcome));
    expect(hook.getCurrent().checkedAfterOperationId).toBeNull();
    holdPlan = null;
    await act(async () => { releasePlan(); await checking; });
    if (outcome === 'succeeded') {
      await waitForHomeGovernance(() => expect(hook.getCurrent().failure?.during).toBe('check'));
      expect(hook.getCurrent().checkedAfterOperationId).toBeNull();
      const [{ formatHappierAsOfTime }, { getPreferredLanguage }] = await Promise.all([
        import('@happier-dev/plugin-ui/presentation'), import('@/text'),
      ]);
      expect(runLine(t('machinePresets.setup.tab.finishedAt', {
        time: formatHappierAsOfTime(hook.getCurrent().progressOperation!.snapshot.settledAt!, Date.now(), getPreferredLanguage()),
      }))).toBe(true);
      refusePlans = false;
      await act(async () => { await hook.getCurrent().check(); });
      await screen.pressByTestIdAsync('machine-setup-check-again');
    }
    await waitForHomeGovernance(() => expect(hook.getCurrent().checkedAfterOperationId).toBe(rootId));
    if (outcome === 'succeeded') {
      const [{ formatHappierAsOfTime }, { getPreferredLanguage }] = await Promise.all([
        import('@happier-dev/plugin-ui/presentation'), import('@/text'),
      ]);
      const settledAt = hook.getCurrent().progressOperation!.snapshot.settledAt!;
      await waitForHomeGovernance(() => expect(runLine(t('machinePresets.setup.tab.finishedAndChecked', {
        time: formatHappierAsOfTime(settledAt, Date.now(), getPreferredLanguage()),
      }))).toBe(true));
    }
    if (outcome === 'failed') {
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-stopped.action')).not.toBeNull());
    }
    expect(hook.getCurrent().operationId).toBe(rootId);
  });

  it('reviews prerequisite recipe sources alongside the Machine sources before any Apply', async () => {
    const home = await harness.addHome({ name: 'Build', serverUrl: 'https://prerequisite-setup.example',
      serverIdentityId: 'srv_prerequisite_setup', accountId: 'owner', currentAccount: true });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    await publishManagedDevbox(serverId);
    harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
    const retained = { kind: 'bundledPreset' as const, ref: { pluginId: 'example.setup', localId: 'existing', revision: '1' }, setup: {} };
    const script = { body: 'echo user setup' };
    const item = { kind: 'softwareRecipe' as const, selection: {
      ref: { pluginId: 'example.setup', recipeId: 'runtime', revision: '1' }, inputs: {},
    } };
    const { PluginProjectedMachineRecipeEntryV1Schema } = await import('@happier-dev/protocol/daemon/contributionRegistryProjection');
    const recipe = PluginProjectedMachineRecipeEntryV1Schema.parse({ id: 'example.setup/runtime', pluginId: 'example.setup', pluginVersion: '1',
      definition: { id: 'runtime', revision: '1', title: 'Runtime', software: true,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        steps: [{ id: 'install', kind: 'command', executable: 'install', args: ['runtime'],
          check: { executable: 'test', args: ['-e', 'runtime'], unsatisfiedExitCodes: [1] } }],
      } });
    const current = await getMachineSetupDesiredV1({
      read: async () => ({ status: 'ready', metadataVersion: 4, metadata: {
        setup: { version: 1, revision: 4, sources: [retained, { kind: 'direct', setup: { scripts: [script] } }], exclusions: [] },
      } }),
      compareAndSwap: async () => { throw new Error('Review cannot change desired Setup'); },
    });
    harness.answer(home, '/v1/actions/machines.setup.plan', { select: async input => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
      const request = MachineSetupPlanInputV1Schema.parse(envelope.input);
      return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: { ok: true,
        result: await prepareMachineSetupPlanV1({ input: request, current, readRecipes: async () => [recipe],
          runNative: async command => {
            if (command.executable !== 'test') throw new Error('Review attempted a native effect');
            return { code: 1, stdout: '', stderr: '' };
          } }),
      } } };
    } });
    const { renderHook } = await import('@/dev/testkit/hooks/renderHook');
    const { useMachineSetup } = await import('./useMachineSetup');
    const hook = await renderHook(() => useMachineSetup({ serverId, machineId: 'devbox', active: true, online: true, canCheck: true }));
    onTestFinished(() => hook.unmount());
    await waitForHomeGovernance(() => expect(hook.getCurrent().plan?.desiredRevision).toBe(4));
    await act(async () => { await hook.getCurrent().prepare({ kind: 'sources', sources: [{ kind: 'direct', setup: { items: [item] } }] }); });
    expect(hook.getCurrent().failure).toBeNull();
    expect(MachineSetupApplyInputV1Schema.parse(hook.getCurrent().review?.prepared?.input).targets[0]).toMatchObject({ desiredRevision: 4,
      sources: [retained, { kind: 'direct', setup: { scripts: [script], items: [item] } }],
      recipePlans: [{ sourceIndex: 1, itemIndex: 0, plan: { steps: [{ id: 'install' }] } }],
    });
    expect(harness.requests.some(request => request.path === '/v1/actions/machines.setup.apply')).toBe(false);
    expect(hook.getCurrent().approvalId).toBeNull();
  });
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
  it.each(['unverifiable', 'unavailable', 'unsupported'] as const)('names %s recipes and offers the owner’s recovery action', async (status) => {
    const home = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example',
      serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    await publishManagedDevbox(serverId);
    harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
    harness.answer(home, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
    const { DOCKER_ENGINE_RECIPE_REF_V1: ref } = await import('@happier-dev/protocol/machines/setup/machineRecipeReferenceV1');
    const { PLUGIN_MANIFEST } = await import('../../../../../../packages/plugins/machine-recipes/src/manifest');
    const { PluginAccountAvailabilityIntentReadResponseV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { replacePluginAccountAvailabilityProjection } = await import('@/sync/domains/plugins/availability/projection');
    // Supply the real declaration at the Account availability boundary; no Machine support or internal resolver is mocked.
    const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
      availabilityCursor: 1, hostingCapability: { enabled: false },
      intent: { pluginId: PLUGIN_MANIFEST.id, desiredVersion: PLUGIN_MANIFEST.version, enabled: true,
        offlineUiHosting: 'disabled', writableCollections: [], revision: 'intent-1' },
      release: { ref: { pluginId: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
        archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: PLUGIN_MANIFEST,
        collectionContracts: [], uiSlots: [],
        packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
      packageAssets: [], uiArtifacts: [],
    });
    replacePluginAccountAvailabilityProjection({ scope: { serverId, accountId: 'owner' },
      snapshot: { availabilityCursor: 1, intentReads: [{ pluginId: PLUGIN_MANIFEST.id, response }], materializations: [], snapshots: [] } });
    let current = MachineSetupPlanResultV1Schema.parse({ desiredRevision: 1, exclusions: [],
      sources: [{ kind: 'direct', setup: { items: [{ kind: 'softwareRecipe', selection: { ref, inputs: {} } }] } }],
      support: [{ sourceIndex: 0, itemIndex: 0, status,
        reason: status === 'unsupported' ? 'private_scope_unenforceable' : 'required_fact_unavailable',
        ...(status === 'unavailable' ? { requiredFact: 'packageManager' } : {}) }],
    });
    harness.answer(home, '/v1/actions/machines.setup.plan', { select: input => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
      return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: { ok: true, result: current } } };
    } });
    const { MachineSetupTab } = await import('./MachineSetupTab');
    const screen = await renderScreen(<MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online
      params={{ id: 'setup' }} setParams={vi.fn()} />);
    await waitForHomeGovernance(() => {
      const row = screen.tree.findAll(node => node.props?.testID === 'machine-setup-recipe:0.0' && node.props.title !== undefined)[0];
      expect(row?.props.title).toBe('Docker Engine');
      expect(row?.props.subtitle).toContain(status === 'unsupported' ? 'Not supported on this machine' : 'Couldn’t be checked');
      if (status === 'unavailable') expect(row?.props.subtitle).toContain('packageManager');
    });
    if (status === 'unsupported') {
      expect(screen.findByTestId('machine-setup-recipe-remove:0.0')).not.toBeNull();
      expect(screen.findByTestId('machine-setup-recipe-retry:0.0')).toBeNull();
      // A retained desktop/phone Setup body must drop Docker Remove as soon as access becomes Use.
      await publishManagedDevbox(serverId, 'use');
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-read-only')).not.toBeNull());
      expect(screen.findByTestId('machine-setup-recipe-remove:0.0')).toBeNull();
      expect(screen.findByTestId('machine-setup-recipe-more:0.0')).toBeNull();
    } else {
      expect(screen.findByTestId('machine-setup-recipe-remove:0.0')).toBeNull();
      expect(screen.findByTestId('machine-setup-recipe-more:0.0')).toBeNull();
      expect(screen.findByTestId('machine-setup-recipe-retry:0.0')).not.toBeNull();
      current = MachineSetupPlanResultV1Schema.parse({ ...current,
        support: [{ sourceIndex: 0, itemIndex: 0, status: 'satisfied' }] });
      await screen.pressByTestIdAsync('machine-setup-recipe-retry:0.0');
      await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-recipe-retry:0.0')).toBeNull());
      expect(harness.requests.some(request => request.path === '/v1/actions/machines.setup.apply')).toBe(false);
    }
    await screen.unmount();
  });
  it('lists bundled setup presets beside saved presets and reviews their exact source through the existing tab', async () => {
    const home = await harness.addHome({ name: 'Build', serverUrl: 'https://build.example',
      serverIdentityId: 'srv_build', accountId: 'owner', currentAccount: true });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    await publishManagedDevbox(serverId);
    await harness.requireUiApproval(home, 'machines.presets.list');
    harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
    harness.answer(home, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [presetWire(preset('web', 'Web box'))] } });
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
    const [{ AppShellPluginUiProjectionValueProvider }, { EMPTY_PLUGIN_UI_PROJECTION }, { MachineSetupTab }, { ModalProvider }] = await Promise.all([
      import('@/components/appShell/plugins/AppShellPluginUiProjection'),
      import('@/sync/domains/plugins/ui/projection'),
      import('./MachineSetupTab'),
      import('@/modal'),
    ]);
    const projection = { ...EMPTY_PLUGIN_UI_PROJECTION, machineSetupPresetsById: {
      'example.setup/secure': { id: 'example.setup/secure', pluginId: 'example.setup', pluginVersion: '1', occurrenceId: 'example',
        definition: { id: 'secure', revision: '2', title: 'Secure', description: 'Security setup', setup } },
    } };
    const screen = await renderScreen(<AppShellPluginUiProjectionValueProvider value={{ pluginUiProjection: projection,
      pluginBrowserProjection: null, phase: 'current', interactionEnabled: true, machineId: null, serverId,
      platform: 'web', accountLifetime: null, clientExecutableActivation: { status: 'ready' },
      reloadClientExecutables() {}, reloadConnectedAccountProjection() {} }}>
      <>
        <MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online params={{ id: 'setup' }} setParams={vi.fn()} />
        <ModalProvider />
      </>
    </AppShellPluginUiProjectionValueProvider>);
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-preset-review:example.setup/secure')).not.toBeNull());
    await waitForHomeGovernance(() => expect(screen.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
    expect(harness.artifacts(home).list()).toEqual([]);
    expect(harness.requests.filter(request => request.path === '/v1/machines/presets/list')).toHaveLength(0);
    await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-preset-review:web')).not.toBeNull());
    expect(harness.requests.filter(request => request.path === '/v1/machines/presets/list')).toHaveLength(1);
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
    const plans: unknown[] = [];
    const planExecutions: unknown[] = [];
    let sourceBuildVisible = false;
    let sourceBuildAgainVisible = false;
    onTestFailed(async () => {
      const { readMachinePresetsSnapshot } = await import('@/sync/engine/machines/machinePresetsResource');
      console.error('Machine setup acceptance phase:', phase, {
        presetsState: readMachinePresetsSnapshot(serverId, 'srv_build', 'owner'),
        requests: harness.requests.map(request => request.path),
        error: sheetError,
        approvals: approvalStates(),
        planInputs: plans,
        planExecutions,
        sourceBuildVisible,
        sourceBuildAgainVisible,
      });
    });
    const home = await harness.addHome({
      name: 'Build',
      serverUrl: 'https://build.example',
      serverIdentityId: 'srv_build',
      accountId: 'owner',
      currentAccount: true,
    });
    const approvalArtifacts = harness.artifacts(home);
    approvalStates = () => approvalArtifacts.list().map(artifact => {
      const request = StoredApprovalRequestSchema.parse(JSON.parse(approvalArtifacts.readPlainBody(artifact.id)!));
      return { status: request.status, execution: request.execution };
    });
    const serverId = resolveServerProfileScopeIdForIdentifier(home);
    // The Machine's published setup names what is attached and at which setup revision.
    await publishManagedDevbox(serverId, undefined, { setup: { version: 1, desiredRevision: 7, status: 'satisfied', recipes: [],
      attachedPresets: [{ kind: 'accountPreset', presetId: 'other', presetRevision: 3, setupRevision: 1 },
        { kind: 'accountPreset', presetId: 'build', presetRevision: 1, setupRevision: 1 }] } });
    phase = 'require saved preset read and setup Apply approval';
    await harness.requireUiApproval(home, ['machines.presets.list', 'machines.setup.apply']);
    harness.answer(home, '/v1/machines/devbox', {
      body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) },
    });
    harness.answer(home, '/v1/machines/presets/list', { select: input => (input as { projection?: string }).projection === 'revisions'
      // Bodyless headers: Build box's setup changed (setupRevision 2); Other box did not.
      ? { body: { kind: 'revisions', presets: [{ id: 'build', homeId: 'srv_build', revision: 2, setupRevision: 2 },
        { id: 'other', homeId: 'srv_build', revision: 3, setupRevision: 1 }] } }
      : { body: { kind: 'listed', presets: [presetWire({ ...preset('web', 'Web box', creation), setupRevision: 1 }),
        presetWire({ ...preset('build', 'Build box', creation), setupRevision: 2 }),
        presetWire({ ...preset('other', 'Other box', creation), revision: 3, setupRevision: 1 })] } } });
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
    let currentPlan = setupPlanFromOpened({ desiredRevision: 7, exclusions: [], support: [], sources: [
      { kind: 'accountPreset', presetId: 'other', presetRevision: 3, setup: { scripts: [{ body: '\r\necho other\r\n' }] } },
      { kind: 'accountPreset', presetId: 'build', presetRevision: 1, setupRevision: 1, setup: { scripts: [{ body: 'old build' }] } },
      { kind: 'direct', setup: { scripts: [{ body: '\r\necho direct\r\n' }] } },
    ], sourceFacts: { 'account:build': { firstPresence: { retained: 'absent' } } } });
    // The reviewed change replaces only Build box's reference with the candidate the owner named.
    const proposedSources = () => currentPlan.sources.map(source => source.kind === 'accountPresetOpaque' && source.presetId === 'build'
      ? { ...source, presetRevision: 2, setupRevision: 2 } : source);
    const expectedInput = () => MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_build', machineId: 'devbox',
      targets: [{ homeId: 'srv_build', machineId: 'devbox', sources: proposedSources(),
        desiredRevision: currentPlan.desiredRevision, recipePlans: [], exclusions: [] }],
    });
    // The remote process is represented by its real policy/approval executor. Only
    // its OS setup operation and HTTP/RPC transport are substituted here.
    const nativeDeps = {
      // This is the receiving process's captured metadata read boundary; the
      // UI still reaches it through the real Plan Action and exact-Home HTTP.
      machineSetupPlan: async ({ input }) => {
        plans.push(input);
        const planInput = MachineSetupPlanInputV1Schema.parse(input);
        // A candidate replaces only that attached copy, as the receiving Plan owner does for a named preset revision.
        const candidate = planInput.candidatePreset;
        const planSources = planInput.sources ?? (candidate ? proposedSources() : currentPlan.sources);
        return planInput.mode === 'effects'
          ? { ...currentPlan, sources: planSources, resolvedSources: planSources.map(source => source.kind === 'accountPresetOpaque'
            ? { ...source, presetContent: source.presetId === 'build' ? projectManagedMachinePresetForRecipientV1({ ...presetWire(preset('build', 'Build box', creation)), recipientAccountId: 'owner' })
              : currentPlan.resolvedSources!.find((resolved): resolved is Extract<typeof resolved, { kind: 'accountPresetOpaque' }> => resolved?.kind === 'accountPresetOpaque' && resolved.presetId === source.presetId)!.presetContent } : source), recipePlans: [] } : currentPlan;
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
      planExecutions.push(execution);
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
          deploymentPreparationAdmission: projectExternalActionDeploymentPreparationEnvelopeAdmissionV1({
            actionId: 'machines.setup.apply', envelope,
          }),
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
    const [{ MachineSetupTab }, { ModalProvider }] = await Promise.all([
      import('./MachineSetupTab'),
      import('@/modal'),
    ]);
    // The Action front door resolves exact target rows through the real batch
    // transport. A list response cannot stand in for that authority.
    const frontDoorReads = () =>
      harness.requests.filter((request) => request.path === '/v1/machines/read-batch');
    phase = 'open the Setup tab';
    screen = await renderScreen(
      <>
        <MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online
          params={{ id: 'setup' }} setParams={vi.fn()} />
        <ModalProvider />
      </>,
    );
    const mounted = screen;
    const pressable = (testID: string) => mounted.tree.findAll(
      (node) => node.props?.testID === testID && typeof node.props.onPress === 'function')[0];
    // Opening the tab obtains both the Plan and its saved-preset revision once.
    phase = 'check on open';
    await waitForHomeGovernance(() => expect(mounted.findByTestId('machine-setup-source:account:build')).not.toBeNull());
    sourceBuildVisible = true;
    phase = 'approve the saved preset read';
    await waitForHomeGovernance(() => expect(mounted.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
    expect(harness.artifacts(home).list()).toEqual([]);
    expect(harness.requests.filter(request => request.path === '/v1/machines/presets/list')).toHaveLength(0);
    await mounted.pressByTestIdAsync('actions.confirmation-review.decision-approve');
    await waitForHomeGovernance(() => expect(harness.requests.filter(request => request.path === '/v1/machines/presets/list')).toHaveLength(1));
    phase = 'load the current preset revision';
    await waitForHomeGovernance(() => expect(pressable('machine-setup-source-again:account:build')).toBeDefined());
    sourceBuildAgainVisible = true;
    expect(harness.requests.filter(request => request.path === '/v1/machines/presets/list')).toHaveLength(1);
    expect(plans).toEqual([{ homeId: 'srv_build', machineId: 'devbox', mode: 'check' }]);
    expect(frontDoorReads().length).toBeGreaterThan(0);
    // Review changes → Build box's changed setup reviews in place under the name its row shows; nothing runs before Apply.
    phase = 'review Build box in place';
    const rowName = mounted.tree.findAll(node => node.props?.testID === 'machine-setup-source:account:build'
      && typeof node.props.title === 'string')[0]!.props.title as string;
    await act(async () => pressable('machine-setup-source-again:account:build')!.props.onPress());
    const { t } = await import('@/text');
    const answer = (testID: string) => mounted.tree.findAll(node => node.props?.testID === testID
      && typeof node.props.title === 'string')[0]?.props.subtitle as string | undefined;
    await waitForHomeGovernance(() => expect(answer('machine-setup-plan-review.administrator')).toContain(t('machinePresets.setup.review.unknown')));
    expect(answer('machine-setup-plan-review.downtime')).toContain(t('machinePresets.setup.review.unknown'));
    expect(mounted.findByTestId('machine-setup-review')).not.toBeNull();
    // The review names what gets applied and where.
    expect(mounted.getTextContent()).toContain(t('machinePresets.setup.tab.reviewApplyPreset', { preset: rowName, machine: 'devbox' }));
    expect(applied).toEqual([]);
    expect(harness.artifacts(home).list()).toEqual([]);
    expect(harness.requests.some(request => request.path === '/v1/actions/machines.setup.apply')).toBe(false);
    phase = 'apply the exact in-place review';
    // Apply is this flow's designed confirmation, including under Settings Ask.
    // The receiver prepares the same effects once before accepting the operation.
    await act(async () => pressable('machine-setup-apply')!.props.onPress());
    await waitForHomeGovernance(() => expect(applied).toEqual([expectedInput()]));
    expect(mounted.findByTestId('actions.confirmation-review.decision-approve')).toBeNull();
    expect(mounted.tree.findAll(node => typeof node.props?.diagnosticCode === 'string')).toEqual([]);
    expect(harness.requests.filter(request => request.path === '/v1/actions/machines.setup.apply')).toHaveLength(1);
    // Review uses the held baseline; Apply prepares its effects once. A single
    // plain check after settlement establishes the finished run's observation.
    const candidatePreset = { presetId: 'build', presetRevision: 2 };
    expect(plans).toEqual([
      { homeId: 'srv_build', machineId: 'devbox', mode: 'check' },
      { homeId: 'srv_build', machineId: 'devbox', mode: 'effects', candidatePreset },
      { homeId: 'srv_build', machineId: 'devbox', mode: 'effects', sources: proposedSources(), exclusions: [] },
      { homeId: 'srv_build', machineId: 'devbox', mode: 'check' },
    ]);
    const artifacts = harness.artifacts(home);
    expect(artifacts.list()).toHaveLength(0);
    expect(mounted.findByTestId('machine-setup-approval')).toBeNull();
    const received = await operations.handlers.listV2({});
    expect(received.items).toHaveLength(1);
    const operationId = received.items[0]!.operationId;
    expect(await operations.handlers.getV2({ operationId, waitForTerminal: true }))
      .toMatchObject({ kind: 'found', operation: { state: 'succeeded' } });
    // The review becomes the Apply's own operation, followed by its read-only check.
    phase = 'operation rows in place';
    await waitForHomeGovernance(() => expect(mounted.findByTestId('machine-setup-operation')).not.toBeNull());
    expect(mounted.findByTestId('machine-setup-review')).toBeNull();
    expect(plans).toHaveLength(4);
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
    await publishManagedDevbox(serverId, undefined, { setup: { version: 1, desiredRevision: 4, status: 'satisfied', recipes: [],
      attachedPresets: [{ kind: 'accountPreset', presetId: 'other', presetRevision: 3, setupRevision: 1 },
        { kind: 'accountPreset', presetId: 'build', presetRevision: 1, setupRevision: 1 }] } });
    await harness.requireUiApproval(home, 'machines.presets.list');
    harness.answer(home, '/v1/machines/devbox', { body: { machine: createPlainMachineRowFixture({ id: 'devbox', accountId: 'owner' }) } });
    harness.answer(home, '/v1/machines/presets/list', { select: input => (input as { projection?: string }).projection === 'revisions'
      // Build box's setup changed since this Machine took it; Other box only got a new title.
      ? { body: { kind: 'revisions', presets: [{ id: 'build', homeId: 'srv_build', revision: 2, setupRevision: 2 },
        { id: 'other', homeId: 'srv_build', revision: 4, setupRevision: 1 }] } }
      : { body: { kind: 'listed', presets: [
        presetWire({ ...preset('web', 'Web box'), setupRevision: 1 }), presetWire({ ...preset('build', 'Build box'), setupRevision: 2 }),
        presetWire({ ...preset('other', 'Other box'), revision: 4, setupRevision: 1 }),
      ] } } });
    const fonts = { kind: 'softwareRecipe' as const, selection: { ref: { pluginId: 'com.example.machine-tools', recipeId: 'fonts', revision: '1' }, inputs: {} } };
    const ssh = { kind: 'setupRecipe' as const, selection: { ref: { pluginId: 'com.example.machine-tools', recipeId: 'ssh-hardening', revision: '1' }, inputs: {} } };
    const other = { kind: 'accountPreset' as const, presetId: 'other', presetRevision: 3, setup: { scripts: [{ body: 'echo other' }] } };
    const localSources: MachineSetupSourceV1 = [
      other,
      { kind: 'accountPreset', presetId: 'build', presetRevision: 1, setupRevision: 1, setup: { items: [fonts, ssh] } },
      { kind: 'direct', setup: {} },
    ];
    const current = setupPlanFromOpened({ desiredRevision: 4, exclusions: [], support: [], sources: localSources });
    const plans: unknown[] = [];
    // The receiving Machine's Plan is the transport boundary; the tab, its hook and the shared preparation stay real.
    harness.answer(home, '/v1/actions/machines.setup.plan', { select: async input => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
      const request = MachineSetupPlanInputV1Schema.parse(envelope.input);
      plans.push(request);
      let result: unknown = current;
      if (request.mode === 'effects') {
        // A named candidate replaces only that attached copy, as the receiving Plan owner does.
        const candidate = request.candidatePreset;
        const wireSources = request.sources ?? current.sources.map(source => candidate && source.kind === 'accountPresetOpaque'
          && source.presetId === candidate.presetId ? { ...source, presetRevision: candidate.presetRevision, setupRevision: 2 } : source);
        const proposed = wireSources.map(source => source.kind === 'accountPresetOpaque'
          ? { kind: 'accountPreset' as const, presetId: source.presetId, presetRevision: source.presetRevision, contentEncryptionMode: 'plain' as const,
            setup: source.presetId === 'build' ? preset('build', 'Build box').setup : other.setup } : source);
        const change = reviewMachineSetupSourceChangeV1({ currentSources: localSources, proposedSources: proposed });
        if (!change.ok) throw new Error(change.error);
        const { prepareMachineSetupRemovalsV1 } = await import('../../../../../cli/src/machines/setup/prepareMachineSetupRemovals');
        const removals = await prepareMachineSetupRemovalsV1({ machineId: 'devbox', desiredRevision: current.desiredRevision, detached: change.detached, recipes: [],
          backend: { observe: async () => { throw new Error('Unknown origin never observes native removal'); } } });
        if (!removals.ok) throw new Error(removals.error);
        result = { ...setupPlanFromOpened({ ...current, sources: proposed }), sources: wireSources, recipePlans: [],
          removalOffers: removals.removalOffers, removalPlans: removals.removalPlans };
      }
      return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: { ok: true, result } } };
    } });
    const [{ MachineSetupTab }, { ModalProvider }] = await Promise.all([
      import('./MachineSetupTab'),
      import('@/modal'),
    ]);
    // The Machine page is a page presentation; section actions (Attach a preset) render only there.
    const { ItemList } = await import('@/components/ui/lists/ItemList');
    const screen = await renderScreen(<>
      <ItemList><MachineSetupTab serverId={serverId} machineId="devbox" machineName="devbox" online
        params={{ id: 'setup' }} setParams={vi.fn()} /></ItemList>
      <ModalProvider />
    </>);
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
    // Attach lists only setup presets that aren't attached yet.
    await waitForHomeGovernance(() => expect(screen.findByTestId('actions.confirmation-review.decision-approve')).not.toBeNull());
    expect(harness.artifacts(home).list()).toEqual([]);
    expect(harness.requests.filter(request => request.path === '/v1/machines/presets/list')).toHaveLength(0);
    await screen.pressByTestIdAsync('actions.confirmation-review.decision-approve');
    await waitForHomeGovernance(() => expect(withProp('machine-setup-attach-menu', 'items')).toBeDefined());
    expect(harness.requests.filter(request => request.path === '/v1/machines/presets/list')).toHaveLength(1);
    expect((withProp('machine-setup-attach-menu', 'items')!.props.items as { id: string }[]).map(item => item.id)).toEqual(['web']);
    // Only the preset whose setup changed since this Machine took it offers Review changes; a title-only revision doesn't.
    await waitForHomeGovernance(() => expect(withProp('machine-setup-source-again:account:build', 'onPress')).toBeDefined());
    expect(withProp('machine-setup-source-again:account:other', 'onPress')).toBeUndefined();
    // Review changes plans the named candidate in place of the old copy, keeping the order; nothing else is re-read.
    await act(async () => withProp('machine-setup-source-again:account:build', 'onPress')!.props.onPress());
    await waitForHomeGovernance(() => expect(screen.findByTestId('machine-setup-review')).not.toBeNull());
    expect(plans.at(-1)).toEqual({ homeId: 'srv_build', machineId: 'devbox', mode: 'effects',
      candidatePreset: { presetId: 'build', presetRevision: 2 } });
    await act(async () => withProp('machine-setup-review-cancel', 'onPress')!.props.onPress());
    // Stop using proposes the sources without it; what it set up stays on the Machine unless the review removes it.
    await waitForHomeGovernance(() => expect(withProp('machine-setup-source-menu:account:build', 'onSelect')).toBeDefined());
    await act(async () => withProp('machine-setup-source-menu:account:build', 'onSelect')!.props.onSelect('stop'));
    await waitForHomeGovernance(() => expect(withProp('machine-setup-apply', 'onPress')?.props.disabled).toBe(false));
    expect(plans.at(-1)).toEqual({ homeId: 'srv_build', machineId: 'devbox', mode: 'effects', sources: [current.sources[0], { kind: 'direct', setup: {} }] });
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
    // The page header already says it is offline: the tab says what that means in the page's one offline notice.
    const { MachineOfflineNotice } = await import('@/components/machines/page/MachineOfflineNotice');
    const { t } = await import('@/text');
    expect(screen.findAllByType(MachineOfflineNotice)).toHaveLength(1);
    expect(screen.getTextContent()).not.toContain(t('machinePresets.setup.tab.offline', { machine: 'devbox' }));
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
    harness.answer(home, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [presetWire(preset('web', 'Web server'))] } });
    const docker = MachinePresetItemV1Schema.parse({ kind: 'softwareRecipe', selection: { ref: { pluginId: 'tools.example', recipeId: 'docker', revision: '1' }, inputs: {} } });
    const firewall = MachinePresetItemV1Schema.parse({ kind: 'setupRecipe', selection: { ref: { pluginId: 'tools.example', recipeId: 'firewall', revision: '1' }, inputs: {} } });
    const keep = MachinePresetItemV1Schema.parse({ kind: 'softwareRecipe', selection: { ref: { pluginId: 'tools.example', recipeId: 'node', revision: '1' }, inputs: {} } });
    harness.answer(home, '/v1/actions/machines.setup.plan', { select: async input => {
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(input);
      return { body: { v: 1, actionId: 'machines.setup.plan', requestId: envelope.requestId, execution: { ok: true,
        result: setupPlanFromOpened({ desiredRevision: 2, exclusions: [], support: [], sources: [
          { kind: 'accountPreset', presetId: 'web', presetRevision: 2, setup: { items: [firewall, docker] } },
          { kind: 'direct', setup: { items: [keep] } },
        ] }) } } };
    } });
    harness.answer(home, '/v1/machines/presets/recipient-census', {
      body: { kind: 'ready', contentEncryptionMode: 'plain', recipients: [] },
    });
    let created: { id: string; name: string; setup: { items?: unknown[] } } | undefined;
    harness.answer(home, '/v1/machines/presets/create', { select: input => {
      const wire = ManagedMachinePresetV1Schema.parse({ ...(input as object), revision: 1 });
      const opened = openManagedMachinePresetRecipientProjectionV1({ presetId: wire.id, mode: 'plain',
        projection: projectManagedMachinePresetForRecipientV1({ ...wire, recipientAccountId: 'owner' }) });
      if (!opened) throw new Error('Expected explicit Plain preset content');
      created = { ...wire, ...opened, setup: opened.setup ?? {} };
      expect(input).not.toHaveProperty('name');
      expect(input).not.toHaveProperty('setup');
      return { body: { kind: 'saved', preset: wire } };
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
      text: screen.findByTestId('machine-setup-save-preset') ? '' : screen.getTextContent(),
    }).toEqual({ door: true, failures: [], text: '' }));
    const setupActions = () => harness.requests.filter(request => request.path.startsWith('/v1/actions/machines.setup.')).map(request => request.path);
    const planned = setupActions();
    expect(planned).toEqual(['/v1/actions/machines.setup.plan']);
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
    expect(harness.requestsFor('/v1/actions/machines.setup.apply')).toHaveLength(0);
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
