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
import { DeploymentTargetLinkInputV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createDeploymentTargetsTestPlugin, DEPLOYMENT_TARGETS_TEST_EXECUTION, DEPLOYMENT_TARGETS_TEST_SERVICE, answerDeploymentTargetInspectForHome } from './deploymentPlatformTargetPlugin.testFixture';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
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
const { showDeploymentPlatformTargetSheet } = await import('./DeploymentPlatformTargetSheet');
const { ModalProvider } = await import('@/modal');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');

afterEach(standardCleanup);

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
  const definition = authored.manifest.contributes.inputTypes[0]!;
  const typeRef = { pluginId, localId: definition.id };
  const resourceRef = qualifyPluginContributionReferenceV1(definition.options!.resource, pluginId);
  const resource = authored.manifest.contributes.resources.find(entry => entry.id === resourceRef.localId)!;
  if (resource.source !== 'dynamic') throw new Error('Expected the declared dynamic options Resource');
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
    await act(async () => failure()!.props.action.onPress());
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
