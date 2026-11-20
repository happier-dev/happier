import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginTestkit, createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildQualifiedPluginContributionKey, qualifyPluginContributionReferenceV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentTargetLinkInputV1Schema, DeploymentTargetLinkCreateIntentInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createDeploymentTargetsTestPlugin, DEPLOYMENT_TARGETS_TEST_EXECUTION, DEPLOYMENT_TARGETS_TEST_SERVICE, answerDeploymentTargetInspectForHome } from './deploymentPlatformTargetPlugin.testFixture';
import { act, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
const receiverRpc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
  (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(receiverRpc.call));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
const { createDeploymentActions } = await import('./deploymentActions');
const { showDeploymentPlatformTargetSheet, useDeploymentPlatformTargets } = await import('./DeploymentPlatformTargetSheet');
const { ModalProvider, Modal } = await import('@/modal');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
const { Item } = await import('@/components/ui/lists/Item');

afterEach(async () => {
  await act(async () => Modal.hideAll());
  standardCleanup();
});

it('settles when Account availability arrives between the first read and its result', async () => {
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Target availability', serverUrl: 'https://target-availability.test',
    serverIdentityId: 'srv_target_availability', accountId: 'owner', currentAccount: true });
  const context = await captureLazyActionAccountContext(serverId);
  const { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } =
    await import('@/sync/domains/plugins/availability/projection');
  clearPluginAccountAvailabilityProjection();
  const hook = await renderHook(() => {
    // This effect queues publication before the picker reads. The microtask runs after that read and before its result
    // handler. The projection publishes only once, so another update cannot wake a late subscriber.
    React.useEffect(() => {
      queueMicrotask(() => replacePluginAccountAvailabilityProjection({ scope: context.accountLifetime.scope,
        snapshot: { availabilityCursor: 1, intentReads: [], materializations: [], snapshots: [] } }));
    }, []);
    return useDeploymentPlatformTargets(context.accountLifetime);
  });
  try {
    await vi.waitFor(() => expect(hook.getCurrent().state.status).toBe('ready'));
  } finally {
    await hook.unmount();
    clearPluginAccountAvailabilityProjection();
    context.dispose();
  }
});

it.each([false, true, 'git-grant', 'branch-set', 'branch-kept', 'branch-unconfirmed'] as const)('finishes an acknowledged created resource by exact association without creating it again; ambiguous create stays uncertain (%s)', async ambiguous => {
  const pluginId = 'com.example.create-cloud';
  const providerUrl = 'https://console.provider.test/exact-created-beta';
  const browserOpen = vi.fn();
  vi.stubGlobal('open', browserOpen);
  const authored = createDeploymentTargetsTestPlugin(pluginId, undefined, { create: true, upload: true });
  const serverId = await homes.addHome({ name: 'Create cloud', serverUrl: 'https://create-cloud.test',
    serverIdentityId: `srv_${'c'.repeat(32)}`, accountId: 'owner', currentAccount: true });
  const context = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
    activate: api => authored.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account), accountLifetime: context.accountLifetime, publishProjection: true });
  try {
    const environment = createDeploymentEnvironmentHeaderV1({ id: 'create-environment', revision: 4, projectSourceId: 'source-app',
      serverId: context.serverIdentityId ?? serverId, controllerMachineId: 'controller', owner: { kind: 'account', accountId: 'owner' } });
    homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, { body: { ok: true, environment, targetLinks: [] } });
    homes.answer(serverId, 'POST /v1/deployments/targets/list', { body: { ok: true, items: [], nextCursor: null, coverage: 'complete' } });
    homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
      id: 'source-app', revision: 1, name: 'App', owner: { kind: 'account', accountId: 'owner' }, audience: [], createdByAccountId: 'owner',
    } } });
    const creates: unknown[] = [];
    const associations: unknown[] = [];
    await answerExternalActionAccountForHome(homes, serverId, { actionId: 'deployments.targets.link',
      machineId: environment.controllerMachineId, installationId: 'controller-installation', tokenEpoch: 0,
      execute: raw => {
        if (raw !== null && typeof raw === 'object' && 'providerCreate' in raw) {
          const input = DeploymentTargetLinkCreateIntentInputV1Schema.parse(raw);
          creates.push(input);
          if (ambiguous === 'git-grant') return { ok: false, error: 'needsGitAccess', details: { phase: 'link',
            reason: 'vercel_github_app_required', grantUrl: 'https://github.com/apps/vercel/installations/new' } };
          if (typeof ambiguous === 'string' && ambiguous.startsWith('branch-')) return { ok: true,
            environmentId: environment.id, revision: 5, targetLinkId: 'created-link', targetLinkRevision: 1,
            productionBranchOutcome: ambiguous === 'branch-set' ? { status: 'set', branch: 'release' }
              : { status: ambiguous === 'branch-kept' ? 'defaultKept' : 'unconfirmed',
                ...(ambiguous === 'branch-kept' ? { branch: 'main' } : { previousBranch: 'main' }), requestedBranch: 'release',
                failureCause: { phase: 'deployment.provider.branch', errorClass: 'Error', errorCode: 'branch_missing', httpStatus: 400 } } };
          if (ambiguous) return { ok: false, error: 'action_outcome_unknown' };
          const { providerCreate, ...intent } = input;
          return { ok: false, error: 'deployment_link_incomplete', recovery: { ...intent, provisioned: true,
            provider: { credentialPrincipal: providerCreate.credentialPrincipal,
              providerIdentity: { providerAccountId: providerCreate.providerAccountId, providerResourceId: 'created-beta', providerEnvironment: 'production' },
              providerEnvironment: { kind: 'production' }, providerUrl } } };
        }
        const input = DeploymentTargetLinkInputV1Schema.parse(raw);
        associations.push(input);
        if (associations.length === 1) return { ok: false, error: 'action_outcome_unknown' };
        return { ok: true, environmentId: environment.id, revision: 5, targetLinkId: 'created-link', targetLinkRevision: 1 };
      },
      failure: result => result !== null && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
        ? { errorCode: result.error, error: result.error, details: 'details' in result ? result.details : result, effectAttempted: true } : null,
    });
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment, ownerAccountId: 'owner',
      lifetime: context.accountLifetime, actions: createDeploymentActions(context.accountLifetime, environment.projectSourceId), onApproval: () => {},
      initialTargetKey: `${pluginId}/beta` }));
    const mode = () => screen.root.findAllByType(SegmentedChoiceItem).find(node => node.props.testID === 'project-deployments.platform.mode');
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(mode()).toBeDefined(); });
    const chooser = () => screen.root.findByType(ConnectedAccountPurposeTargetChooser);
    const selection = { kind: 'account', account: { service: DEPLOYMENT_TARGETS_TEST_SERVICE, accountId: 'cloud-account' } } as const;
    expect(mode()!.props.value).toBe('existing');
    await act(async () => chooser().props.onChange(selection, null));
    await act(async () => mode()!.props.onChange('create'));
    expect(chooser().props.value).toEqual(selection);
    expect(screen.root.findAllByType(SegmentedChoiceItem).some(node => node.props.testID === 'project-deployments.platform.sourceMethod')).toBe(false);
    const patch = async (value: Record<string, unknown>) => act(async () => screen.root.findAllByType(ActionInputFields)[0]!.props.onPatch(value));
    await patch({ providerAccountId: 'organization' });
    await patch({ resourceName: 'new-project' });
    await patch({ providerEnvironment: { kind: 'production' } });
    const disclosed = screen.findAllByType(Item);
    expect({ mode: mode()!.props.value, controller: disclosed.find(node => node.props.testID === 'project-deployments.platform.controller')?.props.detail,
      createAvailable: screen.findByTestId('project-deployments.platform.create') !== null }).toEqual({ mode: 'create', controller: environment.controllerMachineId, createAvailable: true });
    expect(disclosed.find(node => node.props.testID === 'project-deployments.platform.access.principal')?.props.detail).toBeTruthy();
    await screen.pressByTestIdAsync('project-deployments.platform.create');
    if (ambiguous === 'git-grant') {
      await waitForHomeGovernance(async () => { await act(async () => {});
        expect(screen.findByTestId('project-deployments.platform.needsGitAccess')).not.toBeNull(); });
      const card = screen.root.findAllByType(SurfaceStateCard)
        .find(node => node.props.testID === 'project-deployments.platform.needsGitAccess');
      await act(async () => { await surfaceAction(card).onPress(); });
      expect(browserOpen.mock.calls.map(call => call[0])).toEqual(['https://github.com/apps/vercel/installations/new']);
      expect(associations).toHaveLength(0);
      return;
    }
    if (typeof ambiguous === 'string' && ambiguous.startsWith('branch-')) {
      await waitForHomeGovernance(async () => { await act(async () => {});
        const card = screen.root.findAllByType(SurfaceStateCard)
          .find(node => node.props.testID === 'project-deployments.platform.productionBranch');
        expect(card).toBeDefined();
        expect(card?.props.kind).toBe(ambiguous === 'branch-set' ? 'success' : 'warning');
        expect(card?.props.reason).toContain(ambiguous === 'branch-kept' ? 'main' : 'release');
      });
      expect(creates).toHaveLength(1);
      expect(screen.findByTestId('project-deployments.platform.create')).toBeNull();
      expect(screen.findByTestId('project-deployments.platform.done')).not.toBeNull();
      const { ActionOperationSnapshotV1Schema } = await import('@happier-dev/protocol/actions/operations/v1');
      const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
      const branchOutcome = ambiguous === 'branch-set' ? { status: 'set', branch: 'release' }
        : { status: ambiguous === 'branch-kept' ? 'defaultKept' : 'unconfirmed',
          ...(ambiguous === 'branch-kept' ? { branch: 'main' } : { previousBranch: 'main' }), requestedBranch: 'release',
          failureCause: { phase: 'deployment.provider.branch', errorClass: 'Error', errorCode: 'branch_missing', httpStatus: 400 } };
      await act(async () => actionOperationStore.mergeSnapshots({ serverId, snapshots: [ActionOperationSnapshotV1Schema.parse({
        version: 1, operationId: `branch-result-${ambiguous}`, requestId: `branch-request-${ambiguous}`, revision: 2,
        actionId: 'deployments.targets.link', state: 'succeeded', title: 'Create runtime target',
        scope: { accountId: 'owner', machineId: environment.controllerMachineId }, createdAt: 1, startedAt: 2, settledAt: 3,
        cancellation: 'unsupported', domainRef: { kind: 'deploymentTargetLink', serverId, environmentId: environment.id,
          requestKey: DeploymentTargetLinkCreateIntentInputV1Schema.parse(creates[0]).requestKey, purpose: 'create' },
        result: { ok: true, environmentId: environment.id, revision: 5, targetLinkId: 'created-link', targetLinkRevision: 1,
          productionBranchOutcome: branchOutcome },
      })] }));
      await waitForHomeGovernance(async () => { await act(async () => {});
        expect(screen.findByTestId('project-deployments.platform.productionBranch')).not.toBeNull();
        expect(screen.findByTestId('project-deployments.platform.create')).toBeNull(); });
      await screen.pressByTestIdAsync('project-deployments.platform.done');
      expect(screen.findByTestId('project-deployments.platform')).toBeNull();
      await act(async () => actionOperationStore.reset());
      return;
    }
    const recovery = () => screen.root.findAllByType(SurfaceStateCard).find(node => node.props.testID === (ambiguous
      ? 'project-deployments.platform.outcomeUnknown' : 'project-deployments.platform.provisioned'));
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(recovery()).toBeDefined(); });
    expect(creates).toHaveLength(1);
    expect(mode()!.props.disabled).toBe(true);
    expect(DeploymentTargetLinkCreateIntentInputV1Schema.parse(creates[0]).providerCreate.sourceMethod).toBe('upload');
    expect(screen.findByTestId('project-deployments.platform.create')).toBeNull();
    if (ambiguous) {
      await act(async () => mode()!.props.onChange('existing'));
      await act(async () => mode()!.props.onChange('create'));
      expect(screen.findByTestId('project-deployments.platform.create')).toBeNull();
      expect(associations).toHaveLength(0);
      return;
    }
    await homes.setActionPolicy(serverId, 'links.openExternal', 'ui', 'off');
    await screen.pressByTestIdAsync('project-deployments.platform.openProvider');
    expect(browserOpen).not.toHaveBeenCalled();
    await homes.setActionPolicy(serverId, 'links.openExternal', 'ui', 'allowed');
    await screen.pressByTestIdAsync('project-deployments.platform.openProvider');
    expect(browserOpen.mock.calls.map(call => call[0])).toEqual([providerUrl]);
    await act(async () => { await surfaceAction(recovery()).onPress(); });
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(associations).toHaveLength(1); });
    expect(creates).toHaveLength(1);
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(recovery()).toBeDefined();
      expect(screen.findByTestId('project-deployments.platform.outcomeUnknown')).toBeNull();
      const refusal = screen.root.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'project-deployments.platform.linkRefused');
      expect(refusal?.props.diagnosticCode).toBe('action_outcome_unknown');
    });
    await act(async () => { await surfaceAction(recovery()).onPress(); });
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(associations).toHaveLength(2); });
    expect(creates).toHaveLength(1);
    expect(associations.map(value => DeploymentTargetLinkInputV1Schema.parse(value).requestKey)).toEqual([
      (creates[0] as { requestKey: string }).requestKey, (creates[0] as { requestKey: string }).requestKey,
    ]);
    const associated = DeploymentTargetLinkInputV1Schema.parse(associations[1]);
    expect(associated).toMatchObject({ provisioned: true,
      requestKey: (creates[0] as { requestKey: string }).requestKey });
    const artifact = await context.readArtifactContent(associated.contentArtifactId);
    if (!artifact || typeof artifact.body !== 'string') throw new Error('Expected the associated target artifact as text');
    expect(JSON.parse(artifact.body)).toMatchObject({ providerIdentity: { providerResourceId: 'created-beta' } });
  } finally { await installed.dispose(); context.dispose(); }
});

it.each(['provisioned', 'unknown', 'unavailable', 'missingPlugin', 'staleRevision', 'branchResult', 'branchResultAdvanced'] as const)('recovers the latest dismissed link operation on cold return without repeating native create (%s)', async outcome => {
  const ambiguous = outcome === 'unknown';
  const unavailable = outcome === 'unavailable';
  const missingPlugin = outcome === 'missingPlugin';
  const branchResult = outcome === 'branchResult' || outcome === 'branchResultAdvanced';
  const branchResultAdvanced = outcome === 'branchResultAdvanced';
  const staleRevision = outcome === 'staleRevision';
  const pluginId = 'com.example.cold-create-cloud';
  const authored = createDeploymentTargetsTestPlugin(pluginId, undefined, { create: true });
  const serverId = await homes.addHome({ name: 'Cold create cloud', serverUrl: 'https://cold-create-cloud.test',
    serverIdentityId: `srv_${'b'.repeat(32)}`, accountId: 'owner', currentAccount: true });
  const context = await captureLazyActionAccountContext(serverId);
  const installed = missingPlugin ? null : await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
    activate: api => authored.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account), accountLifetime: context.accountLifetime, publishProjection: true });
  const { ActionOperationSnapshotV1Schema, ACTION_OPERATION_RPC_METHODS_V2, projectActionOperationListSnapshotV1 } = await import('@happier-dev/protocol/actions/operations/v1');
  const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
  try {
    // After Unlink, the same Environment has advanced and no runtime target; Add must offer a fresh choice.
    const environment = createDeploymentEnvironmentHeaderV1({ id: 'cold-create-environment', revision: branchResultAdvanced ? 6 : branchResult || staleRevision ? 5 : 4, projectSourceId: 'source-app',
      serverId: context.serverIdentityId ?? serverId, controllerMachineId: 'current-controller', owner: { kind: 'account', accountId: 'owner' } });
    homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, { body: { ok: true, environment, targetLinks: [] } });
    homes.answer(serverId, 'POST /v1/deployments/targets/list', { body: { ok: true, items: [], nextCursor: null, coverage: 'complete' } });
    homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
      id: 'source-app', revision: 1, name: 'App', owner: { kind: 'account', accountId: 'owner' }, audience: [], createdByAccountId: 'owner',
    } } });
    const recovery = { serverId, environmentId: environment.id, expectedRevision: 4, requestKey: 'retained-create-key',
      targetId: 'beta', role: 'runtime', targetKind: 'beta', machines: [], provisioned: true,
      source: { kind: 'plugin', contribution: { pluginId, localId: 'beta' } },
      provider: { credentialPrincipal: { kind: 'account', accountId: 'owner',
        purpose: { consumer: { pluginId, localId: 'create-beta' }, purpose: 'beta.manage' },
        target: { kind: 'account', account: { service: DEPLOYMENT_TARGETS_TEST_SERVICE, accountId: 'cloud-account' } } },
      providerIdentity: { providerAccountId: 'organization', providerResourceId: 'cold-created-beta', providerEnvironment: 'production' },
      providerEnvironment: { kind: 'production' } } };
    const result = branchResult ? { ok: true, environmentId: environment.id, revision: 5,
      targetLinkId: 'cold-link', targetLinkRevision: 1, productionBranchOutcome: { status: 'defaultKept', branch: 'main', requestedBranch: 'release',
        failureCause: { phase: 'deployment.provider.branch', errorClass: 'Error', errorCode: 'branch_missing', httpStatus: 400 } } }
      : ambiguous ? { ok: false, error: 'outcome_unknown' }
      : { ok: false, error: 'deployment_link_incomplete', recovery };
    const full = ActionOperationSnapshotV1Schema.parse({ version: 1, operationId: 'cold-created-operation', revision: 2,
      actionId: 'deployments.targets.link', state: branchResult ? 'succeeded' : 'failed', scope: { accountId: 'owner', machineId: 'cold-controller' },
      title: 'Create runtime target', requestId: 'cold-created-request', createdAt: 1, startedAt: 2, settledAt: 3,
      cancellation: 'unsupported', domainRef: { kind: 'deploymentTargetLink', serverId, environmentId: environment.id, purpose: 'create', requestKey: recovery.requestKey },
      result: ambiguous ? undefined : result, error: branchResult ? undefined : { errorCode: result.error, error: result.error, effectAttempted: true } });
    actionOperationStore.mergeSnapshots({ serverId, snapshots: [projectActionOperationListSnapshotV1(full)] });
    actionOperationStore.dismissOperation({ serverId, operationId: full.operationId });
    const unrelated = ActionOperationSnapshotV1Schema.parse({ ...full, operationId: 'unrelated-linked-operation', requestId: 'unrelated-linked-request',
      state: 'succeeded', createdAt: 4, startedAt: 5, settledAt: 6, error: undefined,
      domainRef: { ...full.domainRef, purpose: 'associate', requestKey: 'another-create-key' },
      result: { ok: true, environmentId: environment.id, revision: 5, targetLinkId: 'another-link', targetLinkRevision: 1 } });
    const failedAssociation = ActionOperationSnapshotV1Schema.parse({ ...full, operationId: 'failed-association-operation', requestId: 'failed-association-request',
      state: 'failed', createdAt: 7, startedAt: 8, settledAt: 9, domainRef: { ...full.domainRef, purpose: 'associate' },
      result: undefined, error: { errorCode: 'deployment_conflict', error: 'deployment_conflict' } });
    actionOperationStore.mergeSnapshots({ serverId, snapshots: branchResult ? [] : [unrelated, failedAssociation], snapshotComplete: true });
    let resolveRead: ((value: unknown) => void) | undefined;
    const ownerRead = new Promise(resolve => { resolveRead = resolve; });
    receiverRpc.call.mockClear();
    receiverRpc.call.mockImplementation(async () => await ownerRead);
    const associations: unknown[] = [];
    await answerExternalActionAccountForHome(homes, serverId, { actionId: 'deployments.targets.link',
      machineId: 'current-controller', installationId: 'current-controller-installation', tokenEpoch: 0,
      execute: raw => {
        // A repeated create cannot satisfy this assertion or be silently treated as recovery.
        const associated = DeploymentTargetLinkInputV1Schema.parse(raw);
        associations.push(associated);
        return { ok: true, environmentId: environment.id, revision: 5, targetLinkId: 'cold-link', targetLinkRevision: 1 };
      } });
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    const open = async () => act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment, ownerAccountId: 'owner',
      lifetime: context.accountLifetime, actions: createDeploymentActions(context.accountLifetime, environment.projectSourceId), onApproval: () => {},
      initialTargetKey: `${pluginId}/beta` }));
    await open();
    const mode = () => screen.root.findAllByType(SegmentedChoiceItem).find(node => node.props.testID === 'project-deployments.platform.mode');
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(screen.findByTestId('project-deployments.platform.pending')).not.toBeNull(); });
    if (!missingPlugin) {
      await waitForHomeGovernance(async () => { await act(async () => {}); expect(mode()).toBeDefined(); });
      await act(async () => mode()!.props.onChange('create'));
    }
    expect(screen.findByTestId('project-deployments.platform.create')).toBeNull();
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(receiverRpc.call).toHaveBeenCalledWith(expect.objectContaining({ serverId, method: ACTION_OPERATION_RPC_METHODS_V2.get,
        machineId: 'cold-controller', payload: expect.objectContaining({ operationId: full.operationId, waitForTerminal: true }) }));
    });
    await act(async () => resolveRead!(unavailable ? { error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' } : { kind: 'found', operation: full }));
    if (staleRevision || branchResultAdvanced) {
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        expect(screen.findByTestId('project-deployments.platform.create')).not.toBeNull();
      });
      expect(screen.findByTestId('project-deployments.platform.provisioned')).toBeNull();
      expect(screen.findByTestId('project-deployments.platform.productionBranch')).toBeNull();
      expect(screen.findByTestId('project-deployments.platform.linkRefused')).toBeNull();
      expect(associations).toHaveLength(0);
      return;
    }
    if (branchResult) {
      await waitForHomeGovernance(async () => { await act(async () => {});
        expect(screen.findByTestId('project-deployments.platform.productionBranch')).not.toBeNull();
        expect(screen.findByTestId('project-deployments.platform.done')).not.toBeNull();
        expect(screen.findByTestId('project-deployments.platform.create')).toBeNull(); });
      expect(associations).toHaveLength(0);
      await screen.pressByTestIdAsync('project-deployments.platform.done');
      expect(screen.findByTestId('project-deployments.platform')).toBeNull();
      return;
    }
    const card = () => screen.root.findAllByType(SurfaceStateCard).find(node => node.props.testID === (unavailable
      ? 'project-deployments.platform.recoveryUnavailable' : ambiguous
        ? 'project-deployments.platform.outcomeUnknown' : 'project-deployments.platform.provisioned'));
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(card()).toBeDefined(); });
    expect(screen.findByTestId('project-deployments.platform.create')).toBeNull();
    expect(screen.findByTestId('project-deployments.platform.openProvider')).toBeNull();
    if (!ambiguous && !unavailable) {
      const previousFailure = screen.root.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'project-deployments.platform.linkRefused');
      expect(previousFailure?.props.diagnosticCode).toBe('deployment_conflict');
    }
    if (unavailable) {
      expect(card()!.props.diagnosticCode).toBe('RPC_FORBIDDEN');
      expect(screen.findByTestId('project-deployments.platform.pending')).toBeNull();
      expect(associations).toHaveLength(0);
      return;
    }
    if (ambiguous) { expect(associations).toHaveLength(0); return; }
    await act(async () => { await surfaceAction(card()).onPress(); });
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(associations).toHaveLength(1); });
    expect(associations[0]).toMatchObject({ provisioned: true, requestKey: recovery.requestKey, expectedRevision: recovery.expectedRevision });
    const later = ActionOperationSnapshotV1Schema.parse({ ...full, operationId: 'cold-linked-operation', requestId: 'cold-linked-request',
      state: 'succeeded', scope: { accountId: 'owner', machineId: 'current-controller' }, createdAt: 10, startedAt: 11, settledAt: 12, error: undefined,
      domainRef: { ...full.domainRef, purpose: 'associate' },
      result: { ok: true, environmentId: environment.id, revision: 5, targetLinkId: 'cold-link', targetLinkRevision: 1 } });
    await act(async () => actionOperationStore.mergeSnapshots({ serverId, snapshots: [later], snapshotComplete: true }));
    await open();
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(screen.findByTestId('project-deployments.platform.provisioned')).toBeNull(); });
  } finally {
    await act(async () => actionOperationStore.reset());
    await installed?.dispose();
    context.dispose();
  }
});

/** The action a rendered state card offers; a missing card or action fails the step. */
function surfaceAction(card: { props: React.ComponentProps<typeof SurfaceStateCard> } | undefined) {
  const action = card?.props.action;
  if (!action) throw new Error('Expected the state card to offer an action');
  return action;
}

it('keeps a settled empty required choice visible with a typed reason and Retry', async () => {
  const pluginId = 'com.example.empty-deploy';
  const authored = createDeploymentTargetsTestPlugin(pluginId, undefined, { emptyChoices: true });
  const serverId = await homes.addHome({ name: 'Empty choices', serverUrl: 'https://empty-choices.test',
    serverIdentityId: `srv_${'e'.repeat(32)}`, accountId: 'owner', currentAccount: true });
  const context = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
    activate: api => authored.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account), accountLifetime: context.accountLifetime, publishProjection: true });
  const producer = await createPluginTestkit({ manifest: authored.manifest, module: authored });
  try {
  const definition = authored.manifest.contributes.inputTypes?.[0];
  if (!definition) throw new Error('Expected the declared input type');
  const typeRef = { pluginId, localId: definition.id };
  const resourceRef = qualifyPluginContributionReferenceV1(definition.options!.resource, pluginId);
  const resource = authored.manifest.contributes.resources?.find(entry => entry.id === resourceRef.localId);
  if (resource?.source !== 'dynamic') throw new Error('Expected the declared dynamic options Resource');
  const runtime = producer.registration('resources', resource.id);
  if (!runtime) throw new Error('Expected the authored options Resource registration');
  const machineId = 'empty-options-controller';
  // The remote daemon publishes these admitted declarations. UI routing and input normalization stay real.
  const receiverProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
    familiesById: { inputTypes: { family: 'inputTypes', entriesById: {
      [buildQualifiedPluginContributionKey(typeRef)]: { id: buildQualifiedPluginContributionKey(typeRef), pluginId,
        pluginVersion: authored.manifest.version, definition },
    } } }, resourcesById: { [buildQualifiedPluginContributionKey(resourceRef)]: {
      pluginId, id: resource.id, resourceKind: resource.kind, scope: resource.scope,
      execution: resource.execution, accountRuntimeDeclared: true,
    } } });
  receiverRpc.call.mockImplementation(async request => {
    expect(request.method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
    return { protocolVersion: 1, projection: receiverProjection };
  });
  await publishMachineInventoryForTest(context, [createMachineFixture({ id: machineId, activeAt: Date.now(), access: {
    custodian: { accountId: context.accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready',
  } })]);
  let optionReads = 0;
  await answerExternalActionAccountForHome(homes, serverId, { actionId: 'action.options.resolve', machineId,
    installationId: 'empty-options-installation', tokenEpoch: 0, execute: async raw => {
      const input = getActionSpec('action.options.resolve').inputSchema.parse(raw);
      const bytes = await runtime.read(createTestResourceInvocationContext());
      optionReads++;
      const page: unknown = JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes));
      return getActionSpec('action.options.resolve').outputSchema!.parse({ actionId: input.actionId ?? null,
        fieldPath: input.fieldPath ?? null, optionsSourceId: input.optionsSourceId ?? null,
        ...(page !== null && typeof page === 'object' ? page : {}) });
    } });
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { id: 'environment', revision: 4, projectSourceId: '' },
      ownerAccountId: 'owner', lifetime: context.accountLifetime, actions: createDeploymentActions(context.accountLifetime, ''), onApproval: () => {},
      initialTargetKey: `${pluginId}/beta` }));
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(screen.root.findAllByType(ConnectedAccountPurposeTargetChooser)).toHaveLength(1); });
    await act(async () => screen.root.findByType(ConnectedAccountPurposeTargetChooser).props.onChange({ kind: 'account',
      account: { service: DEPLOYMENT_TARGETS_TEST_SERVICE, accountId: 'cloud-account' } }, null));
    const failure = () => screen.root.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'project-deployments.platform.choicesFailed');
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(failure()?.props.diagnosticCode).toBe('provider_options_empty'); });
    expect(screen.findByTestId('project-deployments.platform.check')?.props.disabled).toBe(true);
    const readsBeforeRetry = optionReads;
    await act(async () => { await surfaceAction(failure()).onPress(); });
    await waitForHomeGovernance(async () => { await act(async () => {});
      expect(optionReads).toBeGreaterThan(readsBeforeRetry);
      expect(failure()?.props.diagnosticCode).toBe('provider_options_empty'); });
  } finally {
    await producer.dispose();
    await installed.dispose();
    context.dispose();
  }
});

it('selects independent third-party targets before resolving their account, fields, options and Inspect Action', async () => {
  const pluginId = 'com.example.independent-deploy';
  const projectSourceId = 'source-independent-deploy';
  const service = DEPLOYMENT_TARGETS_TEST_SERVICE;
  const execution = DEPLOYMENT_TARGETS_TEST_EXECUTION;
  const inspections: { target: string; input: JsonValue }[] = [];
  let finishInspection = () => {};
  const inspecting = new Promise<void>(resolve => { finishInspection = resolve; });
  const authored = createDeploymentTargetsTestPlugin(pluginId, async (target, input) => { inspections.push({ target, input }); await inspecting; }, { upload: true });
  const serverId = await homes.addHome({ name: 'Independent targets', serverUrl: 'https://independent-targets.test',
    serverIdentityId: `srv_${'5'.repeat(32)}`, accountId: 'owner', currentAccount: true });
  const context = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
    activate: api => authored.activateAccount(api, execution.account), accountLifetime: context.accountLifetime, publishProjection: true });
  const actions = createDeploymentActions(context.accountLifetime, projectSourceId);
  const receiver = await answerDeploymentTargetInspectForHome({ homes, serverId, accountId: 'owner', machineId: 'runtime', plugin: authored });
  try {
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { id: 'environment', revision: 4, projectSourceId, controllerMachineId: 'runtime' },
      ownerAccountId: 'owner', lifetime: context.accountLifetime, actions, onApproval: () => {} }));
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.root.findAllByType(DropdownMenu).some(node => node.props.testID === 'project-deployments.platform.choice')).toBe(true);
    });
    const picker = () => screen.root.findAllByType(DropdownMenu).find(node => node.props.testID === 'project-deployments.platform.choice')!;
    expect(picker().props.items.filter((item: { id: string }) => item.id.startsWith(pluginId)).map((item: { id: string }) => item.id))
      .toEqual([`${pluginId}/alpha`, `${pluginId}/beta`]);
    await act(async () => picker().props.onSelect(`${pluginId}/beta`));
    const chooser = () => screen.root.findByType(ConnectedAccountPurposeTargetChooser);
    expect(chooser().props.declaration).toMatchObject({ purpose: 'beta.manage', service });
    await act(async () => chooser().props.onChange({ kind: 'account', account: { service, accountId: 'cloud-account' } }, null));
    const method = () => screen.root.findAllByType(SegmentedChoiceItem).find(node => node.props.testID === 'project-deployments.platform.sourceMethod')!;
    expect(method().props.options.map((option: { id: string }) => option.id)).toEqual(['gitIntegration', 'upload']);
    expect(method().props.value).toBe('gitIntegration');
    await act(async () => method().props.onChange('upload'));
    const field = () => screen.root.findAllByType(ActionInputFields)[0]!;
    expect(field().props.fields.map((entry: { path: string }) => entry.path)).toEqual(['beta']);
    expect(field().props.resolveFieldOptions(field().props.fields[0])).toEqual([{ value: 'beta-west', label: 'beta West' }]);
    await act(async () => field().props.onPatch({ beta: 'beta-west' }));
    await act(async () => field().props.onPatch({ providerAccountId: 'cloud' }));
    await act(async () => field().props.onPatch({ providerEnvironment: { kind: 'production' } }));
    await screen.pressByTestIdAsync('project-deployments.platform.check');
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(inspections).toMatchObject([{ target: 'beta', input: { beta: 'beta-west', sourceMethod: 'upload',
        credentialPrincipal: { purpose: { consumer: { pluginId, localId: 'inspect-beta' }, purpose: 'beta.manage' } } } }]);
    });
    expect(picker().props.itemTrigger?.itemProps?.disabled).toBe(true);
    expect(chooser().props.disabled).toBe(true);
    await act(async () => finishInspection());
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.findByTestId('project-deployments.platform.link')).not.toBeNull();
    });
    await act(async () => method().props.onChange('gitIntegration'));
    expect(screen.findByTestId('project-deployments.platform.link')).toBeNull();
    await screen.pressByTestIdAsync('project-deployments.platform.check');
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(inspections[1]).toMatchObject({ target: 'beta', input: { sourceMethod: 'gitIntegration', beta: 'beta-west' } });
      expect(screen.findByTestId('project-deployments.platform.link')).not.toBeNull();
    });
    await act(async () => picker().props.onSelect(`${pluginId}/alpha`));
    expect(chooser().props.declaration.purpose).toBe('alpha.manage');
    expect(chooser().props.value).toBeNull();
    expect(screen.root.findAllByType(SegmentedChoiceItem).some(node => node.props.testID === 'project-deployments.platform.sourceMethod')).toBe(false);
    expect(screen.root.findAllByType(ActionInputFields)).toHaveLength(0);
    expect(screen.findByTestId('project-deployments.platform.check')?.props.disabled).toBe(true);
    // The actual selected resource label becomes the private Link Artifact's title.
    // The declaration title and the provider's opaque resource id are different facts.
    await act(async () => picker().props.onSelect(`${pluginId}/beta`));
    await act(async () => chooser().props.onChange({ kind: 'account', account: { service, accountId: 'cloud-account' } }, null));
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(field()).toBeDefined(); });
    await act(async () => field().props.onPatch({ beta: 'beta-west' }));
    await act(async () => field().props.onPatch({ providerAccountId: 'cloud' }));
    await act(async () => field().props.onPatch({ providerEnvironment: { kind: 'production' } }));
    await screen.pressByTestIdAsync('project-deployments.platform.check');
    await waitForHomeGovernance(async () => { await act(async () => {});
      expect(screen.findByTestId('project-deployments.platform.link')).not.toBeNull(); });
    const environment = createDeploymentEnvironmentHeaderV1({ id: 'environment', revision: 4, projectSourceId,
      serverId: context.serverIdentityId ?? serverId, controllerMachineId: 'runtime', owner: { kind: 'account', accountId: 'owner' } });
    homes.answer(serverId, 'GET /v1/deployments/environments/environment', { body: { ok: true, environment, targetLinks: [] } });
    homes.answer(serverId, 'POST /v1/deployments/targets/list', { body: { ok: true, items: [], nextCursor: null, coverage: 'complete' } });
    let linkedArtifactId = '';
    await answerExternalActionAccountForHome(homes, serverId, { machineId: environment.controllerMachineId, installationId: 'runtime-installation',
      actionId: 'deployments.targets.link', tokenEpoch: 0, execute: raw => {
        const linked = DeploymentTargetLinkInputV1Schema.parse(raw);
        linkedArtifactId = linked.contentArtifactId;
        return { ok: true, environmentId: environment.id, revision: 5, targetLinkId: 'platform-link', targetLinkRevision: 1 };
      } });
    await screen.pressByTestIdAsync('project-deployments.platform.link');
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(linkedArtifactId).not.toBe(''); });
    expect(await context.readArtifactContent(linkedArtifactId)).toMatchObject({ header: { title: 'beta West' } });
  } finally {
    await receiver.dispose();
    await installed.dispose();
    context.dispose();
  }
});

it('opens on the platform the person already chose in the draft', async () => {
  const pluginId = 'com.example.preselected-deploy';
  const authored = createDeploymentTargetsTestPlugin(pluginId);
  const serverId = await homes.addHome({ name: 'Chosen target', serverUrl: 'https://chosen-target.test', accountId: 'owner', currentAccount: true });
  const context = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
    activate: api => authored.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account), accountLifetime: context.accountLifetime, publishProjection: true });
  try {
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { id: 'environment', revision: 4, projectSourceId: '' },
      ownerAccountId: 'owner', lifetime: context.accountLifetime, actions: createDeploymentActions(context.accountLifetime, ''), onApproval: () => {},
      initialTargetKey: `${pluginId}/beta` }));
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.root.findAllByType(ConnectedAccountPurposeTargetChooser)).toHaveLength(1);
    });
    expect(screen.root.findByType(ConnectedAccountPurposeTargetChooser).props.declaration.purpose).toBe('beta.manage');
  } finally {
    await installed.dispose();
    context.dispose();
  }
});

it('welcomes an Account with no platform account to add a token in place, then continues with that account', async () => {
  const pluginId = 'com.example.connect-deploy';
  const service = DEPLOYMENT_TARGETS_TEST_SERVICE;
  const authored = createDeploymentTargetsTestPlugin(pluginId);
  const serverId = await homes.addHome({ name: 'Connect target', serverUrl: 'https://connect-target.test', accountId: 'owner', currentAccount: true });
  const context = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
    activate: api => authored.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account), accountLifetime: context.accountLifetime, publishProjection: true });
  const { storage } = await import('@/sync/domains/state/storageStore');
  const { ConnectSheetContent } = await import('@/components/settings/connectedServices/setup/ConnectSheetContent');
  const previous = storage.getState().profile;
  try {
    // The Account's own inventory has no account for this platform's service.
    storage.setState({ profile: { ...previous, id: 'owner', connectedAccountsV4: [] } });
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { id: 'environment', revision: 4, projectSourceId: '' },
      ownerAccountId: 'owner', lifetime: context.accountLifetime, actions: createDeploymentActions(context.accountLifetime, ''), onApproval: () => {},
      initialTargetKey: `${pluginId}/beta` }));
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.findByTestId('project-deployments.platform.connect')).not.toBeNull();
    });
    expect(screen.root.findAllByType(ConnectedAccountPurposeTargetChooser)).toHaveLength(0);
    // Nothing that needs the account stands before it: no Check, no project mode, no source method (DESIGN-ACCEPT C1).
    expect(screen.findByTestId('project-deployments.platform.check')).toBeNull();
    expect(screen.findByTestId('project-deployments.platform.mode')).toBeNull();
    expect(screen.findByTestId('project-deployments.platform.sourceMethod')).toBeNull();
    // Add a token opens the one shared connect flow for this service, never a deployment-local form.
    await screen.pressByTestIdAsync('project-deployments.platform.connect.add');
    const sheet = () => screen.root.findAllByType(ConnectSheetContent)[0];
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(sheet()).toBeDefined(); });
    expect(sheet()!.props.request).toMatchObject({ service, intent: 'add' });
    await act(async () => sheet()!.props.onResult({ kind: 'connected', account: { service, accountId: 'new-token' } }));
    // The new account is chosen; the platform's own choices and its Check (the permission probe) follow.
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.root.findByType(ConnectedAccountPurposeTargetChooser).props.value)
        .toEqual({ kind: 'account', account: { service, accountId: 'new-token' } });
    });
    expect(screen.findByTestId('project-deployments.platform.connect')).toBeNull();
    expect(screen.findByTestId('project-deployments.platform.check')).not.toBeNull();
  } finally {
    storage.setState({ profile: previous });
    await installed.dispose();
    context.dispose();
  }
});

it('says a repository refusal with the shared remedy after another target was inspected in this module', async () => {
  const pluginId = 'com.example.repository-deploy';
  const service = DEPLOYMENT_TARGETS_TEST_SERVICE;
  const { PluginError } = await import('@happier-dev/plugin-sdk');
  const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
  const inspections: string[] = [];
  let refuse = () => {};
  const refused = new Promise<void>(resolve => { refuse = resolve; });
  const authored = createDeploymentTargetsTestPlugin(pluginId, async target => {
    inspections.push(target);
    await refused;
    throw new PluginError({ code: 'repository_required' });
  });
  const serverId = await homes.addHome({ name: 'Repository target', serverUrl: 'https://repository-target.test',
    serverIdentityId: `srv_${'6'.repeat(32)}`, accountId: 'owner', currentAccount: true });
  const context = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
    activate: api => authored.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account), accountLifetime: context.accountLifetime, publishProjection: true });
  const opened: string[] = [];
  const receiver = await answerDeploymentTargetInspectForHome({ homes, serverId, accountId: 'owner', machineId: 'runtime', plugin: authored });
  try {
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { id: 'environment', revision: 4, projectSourceId: '', controllerMachineId: 'runtime' },
      ownerAccountId: 'owner', lifetime: context.accountLifetime, actions: createDeploymentActions(context.accountLifetime, ''), onApproval: () => {},
      initialTargetKey: `${pluginId}/beta`, onOpenRecoveryDestination: destination => opened.push(destination) }));
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.root.findAllByType(ConnectedAccountPurposeTargetChooser)).toHaveLength(1);
    });
    await act(async () => screen.root.findByType(ConnectedAccountPurposeTargetChooser).props.onChange({ kind: 'account', account: { service, accountId: 'cloud-account' } }, null));
    const field = () => screen.root.findAllByType(ActionInputFields)[0]!;
    await act(async () => field().props.onPatch({ beta: 'beta-west' }));
    await act(async () => field().props.onPatch({ providerAccountId: 'cloud' }));
    await act(async () => field().props.onPatch({ providerEnvironment: { kind: 'production' } }));
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.findByTestId('project-deployments.platform.check')?.props.disabled).toBe(false);
    });
    await screen.pressByTestIdAsync('project-deployments.platform.check');
    const recovery = readDeploymentRefusalRecoveryV1('repository_required')!;
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(inspections, screen.getTextContent()).toEqual(['beta']);
    });
    await act(async () => refuse());
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.findByTestId('project-deployments.platform.refused.next')).not.toBeNull();
    });
    expect(screen.getTextContent()).toContain(recovery.remedy);
    expect(screen.getTextContent()).toContain(recovery.nextAction.label);
    await screen.pressByTestIdAsync('project-deployments.platform.refused.next');
    expect(opened).toEqual([recovery.nextAction.destination]);
  } finally {
    await receiver.dispose();
    await installed.dispose();
    context.dispose();
  }
});

it('keeps loading until the Account\'s plugin availability first arrives, and never calls that a failure', async () => {
  const pluginId = 'com.example.late-deploy';
  const authored = createDeploymentTargetsTestPlugin(pluginId);
  const serverId = await homes.addHome({ name: 'Late targets', serverUrl: 'https://late-targets.test', accountId: 'owner', currentAccount: true });
  const context = await captureLazyActionAccountContext(serverId);
  let installed: Awaited<ReturnType<typeof installPortableAccountPluginReleaseForTest>> | null = null;
  try {
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    // The sheet opens before this Account's availability has loaded.
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { id: 'environment', revision: 4, projectSourceId: '' },
      ownerAccountId: 'owner', lifetime: context.accountLifetime, actions: createDeploymentActions(context.accountLifetime, ''), onApproval: () => {} }));
    await act(async () => {});
    expect(screen.findByTestId('project-deployments.platform.failed')).toBeNull();
    expect(screen.findByTestId('project-deployments.platform.loading')).not.toBeNull();
    installed = await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
      activate: api => authored.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account), accountLifetime: context.accountLifetime, publishProjection: true });
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.root.findAllByType(DropdownMenu).some(node => node.props.testID === 'project-deployments.platform.choice')).toBe(true);
    });
    expect(screen.findByTestId('project-deployments.platform.failed')).toBeNull();
  } finally {
    await installed?.dispose();
    context.dispose();
  }
});

it.each([
  { target: 'vercel', load: () => import('../../../../../../packages/plugins/deploy-vercel/src/manifest') },
  { target: 'cloudflare-pages', load: () => import('../../../../../../packages/plugins/deploy-cloudflare/src/manifest') },
])('renders the $target Create environment as its typed Production option without a Machine', async ({ target, load }) => {
  const { manifest } = await load();
  const { drawPlatformFields, readDeploymentPlatformTargets } = await import('./platformTargetLink');
  const { useInputFieldOptions } = await import('@/components/sessions/actions/useInputFieldOptions');
  const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
  const { resolveEffectiveActionInputFields } = await import('@happier-dev/protocol/actions/actionInputHintsRuntime');
  const { seedInputByFieldHints } = await import('@happier-dev/protocol/inputs/inputFieldRuntime');
  const release = PluginPortableReleaseManifestV1Schema.parse(manifest);
  const create = readDeploymentPlatformTargets([{ manifest: release }]).find(entry => entry.targetKind === target)?.create;
  if (!create) throw new Error('Expected the provider Create Action');
  const action = { inputHints: { fields: [...create.fields] } };
  const input = seedInputByFieldHints(action, {});
  const fields = resolveEffectiveActionInputFields(action, input).filter(field =>
    field.path === 'providerEnvironment' || field.path.startsWith('providerEnvironment.'));
  const requests = fields.map(field => ({ field, actionId: create.inspectActionId, draftInput: input }));
  const observedOptions = vi.fn<(states: ReturnType<typeof useInputFieldOptions>['snapshot']) => void>();
  function ProductionField() {
    const options = useInputFieldOptions({ requests, enabled: true });
    const drawn = drawPlatformFields(fields, input, options.state, () => false);
    observedOptions(options.snapshot);
    return <ActionInputFields fields={drawn.fields} input={input} editable busy={false}
      resolveFieldOptions={options.resolveOptions} onPatch={() => {}} />;
  }
  const screen = await renderScreen(<ProductionField />);
  expect(observedOptions).toHaveBeenLastCalledWith([]);
  expect(screen.getTextContent()).toContain('Production');
  expect(fields[0]?.options?.map(option => option.value)).toEqual(['production']);
  expect(input.providerEnvironment).toEqual({ kind: 'production' });
});
