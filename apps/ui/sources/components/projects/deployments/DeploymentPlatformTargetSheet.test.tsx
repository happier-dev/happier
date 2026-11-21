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
import { DeploymentTargetLinkProviderIntentInputV1Schema, DeploymentTargetLinkCreateIntentInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
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

it.each(['Vercel', 'Cloudflare'])('renders the personal %s connection and its owner separately', async platform => {
  const { DeploymentPlatformCredentialPrincipal } = await import('./DeploymentPlatformCredentialDisclosure');
  const screen = await renderScreen(<DeploymentPlatformCredentialPrincipal
    principal={{ kind: 'account', accountId: 'owner',
      purpose: { consumer: { pluginId: 'com.example.deploy', localId: 'deploy' }, purpose: 'deploy.manage' },
      target: { kind: 'account', account: { service: DEPLOYMENT_TARGETS_TEST_SERVICE, accountId: 'token' } } }}
    scope={null} lifetime={null} serverId="deployment-home" platform={platform} />);
  const row = screen.findByType(Item);
  expect(row.props.detail).toBeTruthy();
  expect(row.props.title).toBe(`Deploys use this ${platform} connection`);
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
              providerEnvironment: { kind: 'native', selection: { kind: 'production' } }, providerUrl } } };
        }
        const input = DeploymentTargetLinkProviderIntentInputV1Schema.parse(raw);
        associations.push(input);
        if (associations.length === 1) return { ok: false, error: 'action_outcome_unknown' };
        return { ok: true, environmentId: environment.id, revision: 5, targetLinkId: 'created-link', targetLinkRevision: 1 };
      },
      failure: result => result !== null && typeof result === 'object' && 'error' in result && typeof result.error === 'string'
        ? { errorCode: result.error, error: result.error, details: 'details' in result ? result.details : result, effectAttempted: true } : null,
    });
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { ...environment, definition: { kind: 'repository' } }, ownerAccountId: 'owner',
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
    await patch({ providerEnvironment: { kind: 'native', selection: { kind: 'production' } } });
    const disclosed = screen.findAllByType(Item);
    expect({ mode: mode()!.props.value, controller: disclosed.find(node => node.props.testID === 'project-deployments.platform.controller')?.props.detail,
      createAvailable: screen.findByTestId('project-deployments.platform.create') !== null }).toEqual({ mode: 'create', controller: environment.controllerMachineId, createAvailable: true });
    // The connection's caveat is said once, as the Connection row's description, not as a row of its own (PAGE-ACCEPT-176 R8-D4).
    expect({ principalRow: disclosed.some(node => node.props.testID === 'project-deployments.platform.access.principal'),
      connectionCaveat: chooser().props.description }).toEqual({ principalRow: false,
      connectionCaveat: 'Yours · deploys stop if you remove it or lose access' });
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
    expect(associations.map(value => DeploymentTargetLinkProviderIntentInputV1Schema.parse(value).requestKey)).toEqual([
      (creates[0] as { requestKey: string }).requestKey, (creates[0] as { requestKey: string }).requestKey,
    ]);
    const associated = DeploymentTargetLinkProviderIntentInputV1Schema.parse(associations[1]);
    expect(associated).toMatchObject({
      provisioned: true,
      requestKey: (creates[0] as { requestKey: string }).requestKey,
      provider: { providerIdentity: { providerResourceId: 'created-beta' } },
    });
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
      providerEnvironment: { kind: 'native', selection: { kind: 'production' } } } };
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
        const associated = DeploymentTargetLinkProviderIntentInputV1Schema.parse(raw);
        associations.push(associated);
        return { ok: true, environmentId: environment.id, revision: 5, targetLinkId: 'cold-link', targetLinkRevision: 1 };
      } });
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    const open = async () => act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { ...environment, definition: { kind: 'repository' } }, ownerAccountId: 'owner',
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
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { id: 'environment', revision: 4, definition: { kind: 'repository' }, projectSourceId: '' },
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
    homes.answer(serverId, `GET /v1/projects/sources/${projectSourceId}`, { body: { ok: true, canManage: true, source: {
      id: projectSourceId, revision: 1, name: 'App', owner: { kind: 'account', accountId: 'owner' },
      audience: [], createdByAccountId: 'owner',
    } } });
    homes.answer(serverId, 'POST /v1/deployments/targets/list', { body: { ok: true, items: [], nextCursor: null, coverage: 'complete' } });
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { id: 'environment', revision: 4, definition: { kind: 'repository' }, projectSourceId, controllerMachineId: 'runtime' },
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
    await act(async () => field().props.onPatch({ providerEnvironment: { kind: 'native', selection: { kind: 'production' } } }));
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
    await act(async () => field().props.onPatch({ providerEnvironment: { kind: 'native', selection: { kind: 'production' } } }));
    await screen.pressByTestIdAsync('project-deployments.platform.check');
    await waitForHomeGovernance(async () => { await act(async () => {});
      expect(screen.findByTestId('project-deployments.platform.link')).not.toBeNull(); });
    const environment = createDeploymentEnvironmentHeaderV1({ id: 'environment', revision: 4, projectSourceId,
      serverId: context.serverIdentityId ?? serverId, controllerMachineId: 'runtime', owner: { kind: 'account', accountId: 'owner' } });
    homes.answer(serverId, 'GET /v1/deployments/environments/environment', { body: { ok: true, environment, targetLinks: [] } });
    let linkedResourceTitle: string | undefined;
    await answerExternalActionAccountForHome(homes, serverId, { machineId: environment.controllerMachineId, installationId: 'runtime-installation',
      actionId: 'deployments.targets.link', tokenEpoch: 0, execute: raw => {
        const linked = DeploymentTargetLinkProviderIntentInputV1Schema.parse(raw);
        linkedResourceTitle = linked.title;
        return { ok: true, environmentId: environment.id, revision: 5, targetLinkId: 'platform-link', targetLinkRevision: 1 };
      } });
    await screen.pressByTestIdAsync('project-deployments.platform.link');
    await waitForHomeGovernance(async () => { await act(async () => {}); expect(linkedResourceTitle).toBe('beta West'); });
  } finally {
    await receiver.dispose();
    await installed.dispose();
    context.dispose();
  }
});

it('shows the existing association when Check finds the same provider scope in another Environment', async () => {
  const pluginId = 'com.example.duplicate-platform';
  const projectSourceId = 'source-duplicate-platform';
  const owner = { kind: 'account', accountId: 'owner' } as const;
  const plugin = createDeploymentTargetsTestPlugin(pluginId);
  const serverId = await homes.addHome({ name: 'Duplicate platform', serverUrl: 'https://duplicate-platform.test',
    serverIdentityId: `srv_${'e'.repeat(32)}`, accountId: owner.accountId, currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const execution = DEPLOYMENT_TARGETS_TEST_EXECUTION.account;
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
    activate: api => plugin.activateAccount(api, execution), accountLifetime: account.accountLifetime, publishProjection: true });
  const receiver = await answerDeploymentTargetInspectForHome({ homes, serverId, accountId: owner.accountId, machineId: 'runtime', plugin });
  try {
    const { createDeploymentTargetLinkHeaderV1 } = await import('@happier-dev/deployments/testing/v1');
    const { DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1 } = await import('@happier-dev/deployment-protocol');
    const artifact = await account.createArtifactDocument({
      header: { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'Beta West' },
      body: JSON.stringify({ providerIdentity: { providerAccountId: 'cloud', providerResourceId: 'beta-west', providerEnvironment: 'production' } }),
    });
    const environment = createDeploymentEnvironmentHeaderV1({ id: 'linked-environment', projectSourceId, owner,
      serverId: account.serverIdentityId ?? serverId, controllerMachineId: 'runtime' });
    const targetLink = createDeploymentTargetLinkHeaderV1({ id: 'platform-link', environmentId: environment.id,
      machines: [], members: [], targetKind: 'beta', source: { kind: 'plugin', contribution: { pluginId, localId: 'beta' } },
      contentArtifactId: artifact.artifactId, contentHeaderVersion: artifact.revision.headerVersion, contentBodyVersion: artifact.revision.bodyVersion });
    homes.answer(serverId, `GET /v1/projects/sources/${projectSourceId}`, { body: { ok: true, canManage: true, source: {
      id: projectSourceId, revision: 1, name: 'App', owner, audience: [], createdByAccountId: owner.accountId,
    } } });
    homes.answer(serverId, 'POST /v1/deployments/targets/list', { body: {
      ok: true, items: [{ environment, targetLink }], nextCursor: null, coverage: 'complete',
    } });
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    try {
      await act(async () => showDeploymentPlatformTargetSheet({ name: 'Another site',
        environment: { id: 'another-environment', revision: 1, definition: { kind: 'repository' }, projectSourceId, controllerMachineId: 'runtime' },
        ownerAccountId: owner.accountId, lifetime: account.accountLifetime,
        actions: createDeploymentActions(account.accountLifetime, projectSourceId), onApproval: () => {}, initialTargetKey: `${pluginId}/beta` }));
      const chooser = () => screen.root.findByType(ConnectedAccountPurposeTargetChooser);
      await waitForHomeGovernance(() => expect(chooser()).toBeDefined());
      await act(async () => chooser().props.onChange({ kind: 'account', account: { service: DEPLOYMENT_TARGETS_TEST_SERVICE, accountId: 'cloud-account' } }, null));
      const field = () => screen.root.findAllByType(ActionInputFields)[0]!;
      await act(async () => field().props.onPatch({ beta: 'beta-west' }));
      await act(async () => field().props.onPatch({ providerAccountId: 'cloud' }));
      await act(async () => field().props.onPatch({ providerEnvironment: { kind: 'native', selection: { kind: 'production' } } }));
      await screen.pressByTestIdAsync('project-deployments.platform.check');
      await waitForHomeGovernance(() => expect(screen.findByTestId('project-deployments.platform.duplicate')
        ?? screen.findByTestId('project-deployments.platform.link')).not.toBeNull());
      expect(screen.findByTestId('project-deployments.platform.duplicate')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.platform.link')).toBeNull();
    } finally { await screen.unmount(); }
  } finally { await receiver.dispose(); await installed.dispose(); account.dispose(); }
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
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { id: 'environment', revision: 4, definition: { kind: 'repository' }, projectSourceId: '' },
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

it.each(['push', 'retry'] as const)('continues with an acknowledged platform token after profile %s', async delivery => {
  const pluginId = 'com.example.connect-deploy';
  const service = DEPLOYMENT_TARGETS_TEST_SERVICE;
  const authored = createDeploymentTargetsTestPlugin(pluginId);
  const serverId = await homes.addHome({ name: 'Connect target', serverUrl: 'https://connect-target.test', accountId: 'owner', currentAccount: true });
  const context = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
    activate: api => authored.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account), accountLifetime: context.accountLifetime, publishProjection: true });
  const { storage } = await import('@/sync/domains/state/storageStore');
  const { AccountProfileSchema } = await import('@happier-dev/protocol/account/profile');
  const { ConnectSheetContent } = await import('@/components/settings/connectedServices/setup/ConnectSheetContent');
  const { profile: previous, profileScope: previousScope } = storage.getState();
  try {
    // The Account's own inventory has no account for this platform's service.
    storage.setState({ profile: { ...previous, id: 'owner', connectedAccountsV4: [] }, profileScope: context.accountLifetime.scope });
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { id: 'environment', revision: 4, definition: { kind: 'repository' }, projectSourceId: '' },
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
    const ref = { service, accountId: 'new-token' };
    await act(async () => sheet()!.props.onResult({ kind: 'connected', account: ref }));
    expect(screen.findByTestId('project-deployments.platform.connect')).toBeNull();
    expect(screen.findByTestId('project-deployments.platform.check')).toBeNull();
    const profile = AccountProfileSchema.parse({ id: 'owner', connectedAccountsV4: [{
      ref, status: 'connected', authenticationModeId: 'token', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa', configurationReady: true, configurationRevision: null,
      displayName: 'New cloud connection', scopes: [],
    }] });
    if (delivery === 'push') {
      await act(async () => storage.setState({ profile }));
    } else {
      await waitForHomeGovernance(async () => {
        await act(async () => {});
        expect(screen.findByTestId('project-deployments.platform.connectionPending')).toBeNull();
        expect(screen.findByTestId('project-deployments.platform.connectionRetry')).not.toBeNull();
      });
      homes.answer(serverId, '/v1/account/profile', { body: profile });
      await screen.pressByTestIdAsync('project-deployments.platform.connectionRetry');
    }
    // The new account is chosen; the platform's own choices and its Check (the permission probe) follow.
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.root.findByType(ConnectedAccountPurposeTargetChooser).props.value)
        .toEqual({ kind: 'account', account: ref });
    });
    expect(screen.findByTestId('project-deployments.platform.connect')).toBeNull();
    expect(screen.findByTestId('project-deployments.platform.check')).not.toBeNull();
  } finally {
    storage.setState({ profile: previous, profileScope: previousScope });
    await installed.dispose();
    context.dispose();
  }
});

it('uses the sole Pages account and prepares one repository branch and normalized project name', async () => {
  const accountId = 'pages-owner';
  const serverId = await homes.addHome({ name: 'Pages target', serverUrl: 'https://pages-preselection.test',
    serverIdentityId: `srv_${'c'.repeat(32)}`, accountId, currentAccount: true });
  const { manifest, activateAccount } = await import('../../../../../../packages/plugins/deploy-cloudflare/src/index');
  const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
  const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
  const { AccountProfileSchema } = await import('@happier-dev/protocol/account/profile');
  const { storage } = await import('@/sync/domains/state/storageStore');
  const { BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS } = await import('@/agents/registry/generatedBundledPluginEntries');
  const cloudflare = BUNDLED_ACCOUNT_CONNECTED_SERVICE_DECLARATIONS['happier.deploy.cloudflare/cloudflare'];
  if (!cloudflare) throw new Error('Expected the Cloudflare connection declaration');
  const features = createRootLayoutFeaturesResponse({
    capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } },
  });
  for (const path of ['/v1/features', '/v1/features/authenticated']) homes.answer(serverId, path, { body: features });
  primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
  const context = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest, activate: activateAccount,
    accountLifetime: context.accountLifetime, publishProjection: true });
  const { DeploymentPlatformTargetEditor } = await import('./DeploymentPlatformTargetSheet');
  const previous = storage.getState();
  const ref = { service: cloudflare.service, accountId: 'pages-token' };
  const machineId = 'pages-options-controller';
  const projectSourceId = 'pages-source';
  homes.answer(serverId, `GET /v1/projects/sources/${projectSourceId}`, { body: { ok: true, canManage: true, source: {
    id: projectSourceId, revision: 1, name: 'Display title', owner: { kind: 'account', accountId },
    audience: [], createdByAccountId: accountId, defaultRef: 'master',
    repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' }, protocol: 'https',
      repository: { nameWithOwner: 'octocat/Rye_Orders', cloneUrl: 'https://github.com/octocat/Rye_Orders.git' } },
  } } });
  const prepared = vi.fn();
  const qualified = (localId: string) => buildQualifiedPluginContributionKey({ pluginId: manifest.id, localId });
  const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
    familiesById: { inputTypes: { family: 'inputTypes', entriesById: Object.fromEntries(
      (manifest.contributes.inputTypes ?? []).map(definition => [qualified(definition.id), {
        id: qualified(definition.id), pluginId: manifest.id, pluginVersion: manifest.version, definition,
      }]),
    ) } },
    resourcesById: Object.fromEntries((manifest.contributes.resources ?? [])
      .filter(resource => resource.source === 'dynamic')
      .map(resource => [qualified(resource.id), { pluginId: manifest.id, id: resource.id, resourceKind: resource.kind,
        scope: resource.scope, execution: resource.execution, accountRuntimeDeclared: true }])),
  });
  receiverRpc.call.mockImplementation(async request => {
    expect(request.method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
    return { protocolVersion: 1, projection };
  });
  try {
    await publishMachineInventoryForTest(context, [createMachineFixture({ id: machineId, installationId: 'pages-options-installation', activeAt: Date.now(), access: {
      custodian: { accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready',
    } })]);
    await answerExternalActionAccountForHome(homes, serverId, { actionId: 'action.options.resolve', machineId,
      installationId: 'pages-options-installation', tokenEpoch: 0, execute: async raw => {
        const input = getActionSpec('action.options.resolve').inputSchema.parse(raw);
        return getActionSpec('action.options.resolve').outputSchema!.parse({
          actionId: input.actionId ?? null, fieldPath: input.fieldPath ?? null, optionsSourceId: input.optionsSourceId ?? null,
          options: input.fieldPath === 'providerAccountId' ? [{ value: 'provider-pages', label: 'Pages Account' }] : [],
        });
      } });
    storage.setState({ profileScope: context.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: '' }) });
    const draftEnvironment = { projectSourceId, definition: { kind: 'repository' as const },
      controllerMachineId: machineId, repositoryBranch: 'master' };
    const screen = await renderScreen(<ModalProvider><DeploymentPlatformTargetEditor
      name="Site" environment={draftEnvironment} ownerAccountId={accountId}
      lifetime={context.accountLifetime} actions={createDeploymentActions(context.accountLifetime, projectSourceId)}
      initialTargetKey={`${manifest.id}/pages`} onClose={() => {}} onApproval={() => {}} onPrepared={prepared} /></ModalProvider>);
    const chooser = () => screen.root.findByType(ConnectedAccountPurposeTargetChooser);
    await waitForHomeGovernance(() => expect(chooser().props.value).toBeNull());
    await act(async () => {
      storage.setState({ profile: AccountProfileSchema.parse({ id: accountId, connectedAccountsV4: [{ ref,
        status: 'connected', authenticationModeId: cloudflare.descriptor.authentication.defaultModeId,
        revisionSemantics: 'revisioned', credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
        configurationReady: true, configurationRevision: null, displayName: 'Pages connection', scopes: [],
      }] }) });
    });
    await waitForHomeGovernance(() => expect(chooser().props.value).toEqual({ kind: 'account', account: ref }));
    const expectProviderAccount = () => {
      const field = screen.root.findAllByType(ActionInputFields)
        .find(node => node.props.fields[0]?.path === 'providerAccountId');
      expect(field?.props.resolveFieldOptions.state?.(field.props.fields[0])).toMatchObject({
        status: 'ready', options: [{ value: 'provider-pages', label: 'Pages Account' }],
      });
      expect(field?.props.input.providerAccountId).toBe('provider-pages');
      expect(screen.getTextContent()).toContain('Pages Account');
    };
    const mode = screen.root.findAllByType(SegmentedChoiceItem)
      .find(node => node.props.testID === 'project-deployments.platform.mode');
    expect(mode?.props.value).toBe('existing');
    await waitForHomeGovernance(expectProviderAccount);
    await act(async () => mode?.props.onChange('create'));
    expect(chooser().props.value).toEqual({ kind: 'account', account: ref });
    await waitForHomeGovernance(expectProviderAccount);
    await waitForHomeGovernance(() => {
      expect(screen.root.findAllByType(ActionInputFields)
        .some(node => node.props.fields.some(field => field.path === 'productionBranch'))).toBe(false);
      expect(prepared).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'create', providerCreate: expect.objectContaining({
        productionBranch: 'master', resourceName: 'rye-orders',
      }) }));
    });
    const nameField = screen.root.findAllByType(ActionInputFields)
      .find(node => node.props.fields[0]?.path === 'resourceName');
    if (!nameField) throw new Error('Expected the editable Pages project name');
    await act(async () => nameField.props.onPatch({ ...nameField.props.input, resourceName: '' }));
    expect(prepared).toHaveBeenLastCalledWith(null);
    expect(screen.getTextContent()).toMatch(/project name.*review/i);
  } finally {
    storage.setState({ profile: previous.profile, profileScope: previous.profileScope });
    await installed.dispose();
    context.dispose();
  }
});

it.each(['vercel', 'pages'] as const)('opens the %s existing-project choices through its mounted Resource and read Action', async provider => {
  await homes.reset();
  const isVercel = provider === 'vercel';
  const plugin = isVercel ? await import('../../../../../../packages/plugins/deploy-vercel/src/index')
    : await import('../../../../../../packages/plugins/deploy-cloudflare/src/index');
  const { formatQualifiedPluginActionId } = await import('@happier-dev/protocol/plugins/actions/qualifiedActionId');
  const { createPluginHttpFixture } = await import('@happier-dev/plugin-sdk/testing');
  const { isPluginError } = await import('@happier-dev/plugin-sdk/errors');
  const accountId = 'options-owner';
  const providerAccountId = isVercel ? 'team_captured' : 'pages-account';
  const account = { service: isVercel ? { pluginId: 'happier.machine.vercel', localId: 'vercel-account' }
    : { pluginId: plugin.manifest.id, localId: 'cloudflare' }, accountId: 'connected-profile' };
  const installationId = 'project-options-installation';
  const projectField = isVercel ? 'projectId' : 'preparedNative.projectName';
  const target = plugin.manifest.contributes.deploymentTargets?.find(entry => entry.id === (isVercel ? 'runtime' : 'pages'));
  if (!target || target.role !== 'runtime') throw new Error('Expected the runtime target declaration');
  // Vercel names are from the successful Action capture. Vendor envelopes use the provider test fixtures' shapes.
  const projects = (isVercel ? ['qa-sweep-177-traffic-1118', 'qa-sweep-176-r4-observe-1118', 'qa-fid-1115-acme-site',
    'happier-qa-deploy', 'v0-react-native-design'] : ['saved-pages']).map((name, index) => ({ id: `project-${index}`, name }));
  const httpReads: URL[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    const url = new URL(request.url);
    httpReads.push(url);
    const team = { id: providerAccountId, name: 'Selected connection', slug: 'selected-connection' };
    const body = isVercel ? (url.pathname === `/v2/teams/${providerAccountId}` ? team
      : { projects: projects.map(project => ({ ...project, accountId: providerAccountId })), pagination: { next: null } })
      : { success: true, result: url.pathname.endsWith('/accounts') ? [team] : projects, result_info: { page: 1, total_pages: 1 } };
    return { status: 200, finalUrl: request.url, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
  } });
  let redactResult = (value: JsonValue): JsonValue => value;
  if (isVercel) {
    const { vercelOAuthMode } = await import('../../../../../../packages/plugins/machine-vercel/src/oauth');
    const { manifest } = await import('../../../../../../packages/plugins/machine-vercel/src/index');
    const { createConnectedAccountCredentialRedaction } = await import('../../../../../../packages/cli-common/src/connectedAccounts/credentialRedaction');
    const { redactPluginInvocationResultData } = await import('@happier-dev/cli-common/plugins/registration');
    const descriptor = manifest.contributes.connectedAccountDescriptors?.find(entry => entry.id === account.service.localId);
    const mode = descriptor?.authentication.modes.find(entry => entry.id === 'oauth');
    if (!mode) throw new Error('Expected the Vercel OAuth mode declaration');
    const signal = new AbortController().signal;
    const values = { teamId: providerAccountId };
    // The person is at the optional project prompt and chooses to skip it.
    const staged = new Map([['token', 'oauth-fixture-access-token'], ['subject', 'provider-user'],
      ['expiresAtMs', String(Date.now() + 60_000)], ['projectChoiceTeamId', providerAccountId]]);
    const attempt = { kind: 'connect' as const, attemptId: 'vercel-sign-in' };
    expect(await vercelOAuthMode.reconcile!({
      plugin: { id: account.service.pluginId, version: manifest.version },
      contribution: { id: account.service.localId, qualifiedId: `${account.service.pluginId}/${account.service.localId}` },
      service: account.service, surface: 'background', invokedAtMs: Date.now(), attempt, signal,
      services: { http } as Parameters<NonNullable<typeof vercelOAuthMode.reconcile>>[0]['services'],
      configuration: { target: { kind: 'attempt', attemptId: attempt.attemptId, service: account.service, modeId: 'oauth' },
        revision: 'selected-team', values, async getSecret() { return null; } },
      attemptCredentials: { async get(key) { return staged.get(key) ?? null; },
        async set(key, value) { staged.set(key, value); }, async delete(key) { staged.delete(key); } },
    })).toMatchObject({ status: 'connected' });
    const custody = createConnectedAccountCredentialRedaction({ mode, configuration: values,
      credential: { v: 1, values: Object.fromEntries(staged) } });
    // Mimic the host boundary's exact redaction of the materialized Team ID.
    if (!custody.readPublicValues().includes(providerAccountId)) {
      redactResult = result => redactPluginInvocationResultData(result, value => value === providerAccountId ? '[REDACTED]' : value);
    }
  }
  const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { http,
    connectedAccounts: {
      async getBinding(purpose) { return { purpose, service: account.service, account,
        target: { kind: 'account', displayName: 'Selected connection' } }; },
      async materialize() { return { kind: 'environment', env: { VERCEL_TEAM_ID: providerAccountId } }; },
    },
  } });
  const serverId = await homes.addHome({ name: provider, serverUrl: `https://${provider}-project-options.test`,
    serverIdentityId: `srv_${(isVercel ? 'e' : 'f').repeat(32)}`, accountId, currentAccount: true });
  const context = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
    activate: plugin.activateAccount, accountLifetime: context.accountLifetime, publishProjection: true });
  const qualified = (localId: string) => buildQualifiedPluginContributionKey({ pluginId: plugin.manifest.id, localId });
  const receiverProjection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
    familiesById: { inputTypes: { family: 'inputTypes', entriesById: Object.fromEntries(
      (plugin.manifest.contributes.inputTypes ?? []).map(definition => [qualified(definition.id), {
        id: qualified(definition.id), pluginId: plugin.manifest.id, pluginVersion: plugin.manifest.version, definition,
      }]),
    ) } },
    resourcesById: Object.fromEntries((plugin.manifest.contributes.resources ?? [])
      .filter(resource => resource.source === 'dynamic')
      .map(resource => [qualified(resource.id), { pluginId: plugin.manifest.id, id: resource.id, resourceKind: resource.kind,
        scope: resource.scope, execution: resource.execution, accountRuntimeDeclared: true }])),
  });
  receiverRpc.call.mockImplementation(async request => {
    expect(request.method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
    return { protocolVersion: 1, projection: receiverProjection };
  });
  const machineId = 'project-options-controller';
  const projectRequests: unknown[] = [];
  try {
    await publishMachineInventoryForTest(context, [createMachineFixture({ id: machineId, installationId, activeAt: Date.now(), access: {
      custodian: { accountId, displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready',
    } })]);
    await answerExternalActionAccountForHome(homes, serverId, { actionId: 'action.options.resolve', machineId,
      installationId, tokenEpoch: 0,
      failure: result => isPluginError(result) ? { errorCode: result.code, error: result.message } : null,
      execute: async raw => {
        const input = getActionSpec('action.options.resolve').inputSchema.parse(raw);
        if (input.fieldPath === projectField) projectRequests.push(input);
        const runtime = kit.registration('resources', isVercel ? 'target-options' : 'pages-target-options');
        if (!runtime) throw new Error('Expected the declared project options Resource');
        try {
          const bytes = await runtime.read(createTestResourceInvocationContext({
            query: input, readAction: async (ref, payload) => {
              try { return { ok: true, result: redactResult(await kit.invokeAction(ref.localId, payload)) }; }
              catch (error) {
                if (isPluginError(error)) return { ok: false, errorCode: error.code, error: error.message };
                throw error;
              }
            },
          }));
          return getActionSpec('action.options.resolve').outputSchema!.parse({
            actionId: input.actionId ?? null, fieldPath: input.fieldPath ?? null, optionsSourceId: input.optionsSourceId ?? null,
            ...JSON.parse(typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)),
          });
        } catch (error) {
          if (isPluginError(error)) return error;
          throw error;
        }
      } });
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { definition: { kind: 'repository' }, projectSourceId: '' },
      ownerAccountId: accountId, lifetime: context.accountLifetime, actions: createDeploymentActions(context.accountLifetime, ''), onApproval: () => {},
      initialTargetKey: qualified(target.id) }));
    await waitForHomeGovernance(() => expect(screen.root.findAllByType(ConnectedAccountPurposeTargetChooser)).toHaveLength(1));
    await act(async () => screen.root.findByType(ConnectedAccountPurposeTargetChooser).props.onChange({ kind: 'account', account }, null));
    await waitForHomeGovernance(() => {
      const row = screen.root.findAllByType(ActionInputFields).find(node => node.props.fields[0]?.path === projectField);
      expect(row?.props.resolveFieldOptions.state?.(row.props.fields[0]), screen.getTextContent()).toMatchObject({ status: 'ready',
        options: projects.map(project => ({ value: isVercel ? project.id : project.name, label: project.name })) });
    });
    expect(projectRequests).toEqual([expect.objectContaining({ actionId: formatQualifiedPluginActionId({ pluginId: plugin.manifest.id, localId: target.actions.inspect }),
      fieldPath: projectField, draftInput: expect.objectContaining({ providerAccountId, credentialRef: account,
        credentialPrincipal: expect.objectContaining({ kind: 'account', accountId, target: { kind: 'account', account } }) }) })]);
    expect(projectRequests[0]).not.toHaveProperty('cursor');
    expect(httpReads.filter(url => url.pathname.endsWith('/projects')).map(url => url.pathname + url.search)).toEqual([
      isVercel ? `/v10/projects?teamId=${providerAccountId}` : `/client/v4/accounts/${providerAccountId}/pages/projects`,
    ]);
  } finally {
    await installed.dispose();
    await kit.dispose();
    context.dispose();
  }
});

it('explains why a stored Compose Environment under a repository Project cannot use a platform', async () => {
  const { manifest, activateAccount } = await import('../../../../../../packages/plugins/deploy-cloudflare/src/index');
  const { manifest: vercel, activateAccount: activateVercel } = await import('../../../../../../packages/plugins/deploy-vercel/src/index');
  const serverId = await homes.addHome({ name: 'Stored Compose Environment', serverUrl: 'https://stored-compose.test',
    accountId: 'owner', currentAccount: true });
  const context = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest, activate: activateAccount,
    accountLifetime: context.accountLifetime, publishProjection: true });
  const installedVercel = await installPortableAccountPluginReleaseForTest({ manifest: vercel, activate: activateVercel,
    accountLifetime: context.accountLifetime, publishProjection: true });
  const projectSourceId = 'source-with-repository';
  homes.answer(serverId, `GET /v1/projects/sources/${projectSourceId}`, { body: { ok: true, canManage: true, source: {
    id: projectSourceId, revision: 1, name: 'Repository project', owner: { kind: 'account', accountId: 'owner' },
    audience: [], createdByAccountId: 'owner', repository: {
      provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'example/site' }, protocol: 'https',
    },
  } } });
  const inspectPlatformTarget = vi.fn();
  const link = vi.fn();
  try {
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'App',
      environment: { id: 'stored-environment', revision: 1, projectSourceId, definition: { kind: 'stored' } },
      lifetime: context.accountLifetime, ownerAccountId: 'owner', actions: { inspectPlatformTarget, link }, onApproval: () => {} }));
    await waitForHomeGovernance(() =>
      expect(screen.findHostByTestId('project-deployments.platform.sourceRefused'), screen.getTextContent()).not.toBeNull());
    expect(screen.getTextContent()).toMatch(/repository.*own server/i);
    expect(screen.findHostByTestId('project-deployments.platform.choice')).toBeNull();
    expect(screen.findHostByTestId('project-deployments.platform.check')).toBeNull();
    expect(inspectPlatformTarget).not.toHaveBeenCalled();
    expect(link).not.toHaveBeenCalled();
  } finally {
    await installedVercel.dispose();
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
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { id: 'environment', revision: 4, definition: { kind: 'repository' }, projectSourceId: '', controllerMachineId: 'runtime' },
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
    await act(async () => field().props.onPatch({ providerEnvironment: { kind: 'native', selection: { kind: 'production' } } }));
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
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { id: 'environment', revision: 4, definition: { kind: 'repository' }, projectSourceId: '' },
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
  const platform = readDeploymentPlatformTargets([{ manifest: release }]).find(entry => entry.targetKind === target);
  const create = platform?.create;
  if (!create) throw new Error('Expected the provider Create Action');
  const action = { inputHints: { fields: [...create.fields] } };
  const input = seedInputByFieldHints(action, {});
  const fields = resolveEffectiveActionInputFields(action, input).filter(field =>
    field.path === 'providerEnvironment' || field.path.startsWith('providerEnvironment.'));
  const requests = fields.map(field => ({ field, actionId: create.actionId, draftInput: input }));
  const observedOptions = vi.fn<(states: ReturnType<typeof useInputFieldOptions>['snapshot']) => void>();
  function ProductionField() {
    const options = useInputFieldOptions({ requests, declaredInputTypes: platform?.declaredInputTypes, enabled: true });
    const drawn = drawPlatformFields(fields, input, options.state, () => false);
    observedOptions(options.snapshot);
    return <ActionInputFields fields={drawn.fields} input={input} editable busy={false}
      resolveFieldOptions={options.resolveOptions} onPatch={() => {}} />;
  }
  const screen = await renderScreen(<ProductionField />);
  expect(observedOptions).toHaveBeenLastCalledWith([]);
  expect(screen.getTextContent()).toContain('Production');
  const production = { kind: 'native', selection: { kind: 'production' } };
  expect(fields[0]?.options?.map(option => option.value)).toEqual([production]);
  expect(input.providerEnvironment).toEqual(production);
});
