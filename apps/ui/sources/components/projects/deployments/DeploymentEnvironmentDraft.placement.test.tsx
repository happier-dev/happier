import * as React from 'react';
import { expect, it, vi } from 'vitest';
import { act, createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { installPortableAccountPluginReleaseForTest } from '@/dev/testkit/harness/portableAccountPlugin';
import { createDeploymentTargetsTestPlugin, DEPLOYMENT_TARGETS_TEST_EXECUTION } from './deploymentPlatformTargetPlugin.testFixture';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
const router = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => router.module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { DeploymentEnvironmentDraft } = await import('./DeploymentEnvironmentDraft');
type DeploymentDraftFrame = import('./DeploymentEnvironmentDraft').DeploymentDraftFrame;
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { storage } = await import('@/sync/domains/state/storageStore');
const { SessionMachineField } = await import('@/components/sessions/new/placement/SessionPlacementChips');
const { SelectionTiles } = await import('@/components/ui/forms/SelectionTiles');
const { DeploymentPlatformTargetEditor } = await import('./DeploymentPlatformTargetSheet');
const { createDeploymentActions } = await import('./deploymentActions');

// COR6-164/ui-23-workers.png: the platform is selected, but the only controller
// picker belongs to the unselected own-server card. The review then used d227
// despite the checkout being on 6440 (ui-38-deploy-fail-details.txt).
it.each(['project', 'dialog'] as const)('lets the %s platform draft select its controller through the shared Machine field', async surface => {
  const serverId = await homes.addHome({ name: 'Platform placement', serverUrl: `https://placement-${surface}.test`,
    accountId: 'alice', serverIdentityId: `srv_${'9'.repeat(32)}`, currentAccount: true });
  const account = await captureLazyActionAccountContext(serverId);
  const previous = storage.getState();
  const plugin = createDeploymentTargetsTestPlugin('com.example.controller-placement');
  const installed = await installPortableAccountPluginReleaseForTest({ manifest: plugin.manifest,
    activate: api => plugin.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account),
    accountLifetime: account.accountLifetime, publishProjection: true });
  const targetKey = `${plugin.manifest.id}/beta`;
  try {
    homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
      id: 'source-app', revision: 3, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [],
      createdByAccountId: 'alice', repository: {
        provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'alice/app', cloneUrl: 'https://github.com/alice/app.git' }, protocol: 'https' },
      defaultRef: 'main' } } });
    await publishMachineInventoryForTest(account.accountLifetime.scope, [
      createMachineFixture({ id: 'd227', installationId: 'd227-installation', activeAt: Date.now() }),
      createMachineFixture({ id: '6440', installationId: '6440-installation', activeAt: Date.now() }),
    ]);
    const frames: DeploymentDraftFrame[] = [];
    const screen = await renderScreen(<DeploymentEnvironmentDraft lifetime={account.accountLifetime} sourceId="source-app"
      phone={false} platformAvailable initialTargetKey={targetKey} initialMachineId="d227"
      actions={createDeploymentActions(account.accountLifetime, 'source-app')}
      {...(surface === 'dialog' ? { steps: { onFrame: frame => { frames.push(frame); }, onExit: () => {} } } : {})}
      onApprovalRequested={() => {}} onSaved={() => {}} onDiscard={() => {}} />);
    try {
      await waitForHomeGovernance(() => expect(screen.findAllByType(SelectionTiles)
        .find(node => node.props.testIdPrefix === 'project-deployments.draft.target')?.props.value).toBe(targetKey));
      await waitForHomeGovernance(() => expect(screen.findHostByTestId(`project-deployments.draft.target:${targetKey}`)).not.toBeNull());
      const field = () => screen.findAllByType(SessionMachineField)
        .find(node => node.props.testID === 'project-deployments.draft.machine');
      if (surface === 'dialog') {
        await waitForHomeGovernance(() => expect(frames.at(-1)?.primary.disabled).toBe(false));
        await act(async () => frames.at(-1)!.press());
        await waitForHomeGovernance(() => expect(frames.at(-1)?.step).toBe('configure'));
      }
      await waitForHomeGovernance(() => expect(field()?.props.machineId).toBe('d227'));
      await act(async () => field()!.props.onSelectMachine({ id: '6440' }));
      expect(field()?.props.machineId).toBe('6440');
      await waitForHomeGovernance(() => expect(screen.findAllByType(DeploymentPlatformTargetEditor)[0]?.props.environment.controllerMachineId).toBe('6440'));
    } finally { await screen.unmount(); }
  } finally { await installed.dispose(); standardCleanup(); account.dispose(); storage.setState(previous); }
});
