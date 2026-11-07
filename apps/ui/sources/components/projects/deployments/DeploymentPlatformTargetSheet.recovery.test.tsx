import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
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
const { ConnectedAccountPurposeTargetChooser } = await import('@/components/settings/connectedServices/account/ConnectedAccountPurposeTargetChooser');
const { ActionInputFields } = await import('@/components/sessions/actions/ActionInputFields');

afterEach(standardCleanup);

// Its own file: the account plugin harness answers inspect only for the first inspecting install in a module.
it('says a repository refusal with the shared remedy and opens its next step through the page', async () => {
  const pluginId = 'com.example.repository-deploy';
  const service = DEPLOYMENT_TARGETS_TEST_SERVICE;
  const { PluginError } = await import('@happier-dev/plugin-sdk');
  const { readDeploymentRefusalRecoveryV1 } = await import('@happier-dev/protocol/deployments/deploymentFailureRecoveryV1');
  // The plugin's inspect is the boundary: the test decides when it refuses, then awaits that settlement.
  const inspections: string[] = [];
  let refuse = () => {};
  const refused = new Promise<void>(resolve => { refuse = resolve; });
  const authored = createDeploymentTargetsTestPlugin(pluginId, async target => {
    inspections.push(target);
    await refused;
    throw new PluginError({ code: 'repository_required' });
  });
  const serverId = await homes.addHome({ name: 'Repository target', serverUrl: 'https://repository-target.test', accountId: 'owner', currentAccount: true });
  const context = await captureLazyActionAccountContext(serverId);
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: authored.manifest,
    activate: api => authored.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account), accountLifetime: context.accountLifetime, publishProjection: true });
  const opened: string[] = [];
  try {
    const screen = await renderScreen(<ModalProvider>{null}</ModalProvider>);
    await act(async () => showDeploymentPlatformTargetSheet({ name: 'Site', environment: { id: 'environment', revision: 4, projectSourceId: '' },
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
    // Check runs only once the sheet admits it; press it then, never before.
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(screen.findByTestId('project-deployments.platform.check')?.props.disabled).toBe(false);
    });
    await screen.pressByTestIdAsync('project-deployments.platform.check');
    const recovery = readDeploymentRefusalRecoveryV1('repository_required')!;
    await waitForHomeGovernance(async () => {
      await act(async () => {});
      expect(inspections).toEqual(['beta']);
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
    await installed.dispose();
    context.dispose();
  }
});
