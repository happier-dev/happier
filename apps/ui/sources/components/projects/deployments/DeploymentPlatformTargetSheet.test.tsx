import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createDeploymentTargetsTestPlugin, DEPLOYMENT_TARGETS_TEST_EXECUTION, DEPLOYMENT_TARGETS_TEST_SERVICE } from './deploymentPlatformTargetPlugin.testFixture';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);

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

afterEach(standardCleanup);

it('selects independent third-party targets before resolving their account, fields, options and Inspect Action', async () => {
  const pluginId = 'com.example.independent-deploy';
  const service = DEPLOYMENT_TARGETS_TEST_SERVICE;
  const execution = DEPLOYMENT_TARGETS_TEST_EXECUTION;
  const inspections: { target: string; input: JsonValue }[] = [];
  let finishInspection = () => {};
  const inspecting = new Promise<void>(resolve => { finishInspection = resolve; });
  const authored = createDeploymentTargetsTestPlugin(pluginId, async (target, input) => { inspections.push({ target, input }); await inspecting; });
  const serverId = await homes.addHome({ name: 'Independent targets', serverUrl: 'https://independent-targets.test',
    accountId: 'owner', currentAccount: true });
  const context = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
    activate: api => authored.activateAccount(api, execution.account), accountLifetime: context.accountLifetime, publishProjection: true });
  const actions = createDeploymentActions(context.accountLifetime, '');
  try {
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { id: 'environment', revision: 4, projectSourceId: '' },
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
    const field = () => screen.root.findAllByType(ActionInputFields)[0]!;
    expect(field().props.fields.map((entry: { path: string }) => entry.path)).toEqual(['beta']);
    expect(field().props.resolveFieldOptions(field().props.fields[0])).toEqual([{ value: 'beta-west', label: 'beta West' }]);
    await act(async () => field().props.onPatch({ beta: 'beta-west' }));
    await act(async () => field().props.onPatch({ providerAccountId: 'cloud' }));
    await act(async () => field().props.onPatch({ providerEnvironment: { kind: 'production' } }));
    await screen.pressByTestIdAsync('project-deployments.platform.check');
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(inspections).toMatchObject([{ target: 'beta', input: { beta: 'beta-west',
        credentialPrincipal: { purpose: { consumer: { pluginId, localId: 'inspect-beta' }, purpose: 'beta.manage' } } } }]);
    });
    expect(picker().props.itemTrigger?.itemProps?.disabled).toBe(true);
    expect(chooser().props.disabled).toBe(true);
    await act(async () => finishInspection());
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.findByTestId('project-deployments.platform.link')).not.toBeNull();
    });
    await act(async () => picker().props.onSelect(`${pluginId}/alpha`));
    expect(chooser().props.declaration.purpose).toBe('alpha.manage');
    expect(chooser().props.value).toBeNull();
    expect(screen.root.findAllByType(ActionInputFields)).toHaveLength(0);
    expect(screen.findByTestId('project-deployments.platform.check')?.props.disabled).toBe(true);
  } finally {
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
