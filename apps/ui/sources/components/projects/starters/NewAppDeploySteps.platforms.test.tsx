import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMachineFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
  waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal));

const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { NewAppDeploySteps } = await import('./NewAppDeploySteps');
const { captureLazyActionAccountContext } =
  await import('@/sync/ops/actions/actionAccountContext');
const { publishMachineInventoryForTest } =
  await import('@/dev/testkit/harness/machinePresence');
const { storage } = await import('@/sync/domains/state/storageStore');
const { createDeploymentTargetsTestPlugin, DEPLOYMENT_TARGETS_TEST_EXECUTION } =
  await import('@/components/projects/deployments/deploymentPlatformTargetPlugin.testFixture');
const { installPortableAccountPluginReleaseForTest } =
  await import('@/dev/testkit/harness/portableAccountPlugin');
await import('@/sync/ops/actions/defaultActionExecutor');

describe('Deploy an app reads the platforms for every source (journey-deploy whereM, catWhere)', () => {
  beforeEach(async () => {
    await homes.reset();
  });
  afterEach(() => {
    standardCleanup();
  });

  it('a stored Compose definition sees the declared platforms, listed as unable to run it', async () => {
    const serverId = await homes.addHome({
      name: 'Deploy',
      serverUrl: 'https://deploy-steps-platforms.test',
      accountId: 'alice',
      serverIdentityId: `srv_${'d'.repeat(32)}`,
      currentAccount: true,
    });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const pluginId = 'com.example.steps-platforms';
    const authoredPlugin = createDeploymentTargetsTestPlugin(pluginId);
    const installed = await installPortableAccountPluginReleaseForTest({
      manifest: authoredPlugin.manifest,
      activate: (api) =>
        authoredPlugin.activateAccount(
          api,
          DEPLOYMENT_TARGETS_TEST_EXECUTION.account,
        ),
      accountLifetime: account.accountLifetime,
      publishProjection: true,
    });
    try {
      homes.answer(serverId, 'GET /v1/projects/sources', {
        body: {
          ok: true,
          sources: [],
          coverage: { complete: true, nextCursor: null },
        },
      });
      await publishMachineInventoryForTest(account.accountLifetime.scope, [
        createMachineFixture({
          id: 'runtime',
          installationId: 'runtime-installation',
          activeAt: Date.now(),
        }),
      ]);
      const steps = { onFrame: () => {}, onExit: () => {} };
      const screen = await renderScreen(
        <NewAppDeploySteps
          serverId={serverId}
          source={{ kind: 'definition', definitionKind: 'compose' }}
          machineId={null}
          phone={false}
          steps={steps}
          onLeave={() => {}}
        />,
      );
      await waitForHomeGovernance(() =>
        expect(
          screen.findHostByTestId('project-deployments.draft.target:own-server'),
          'the hosted draft shows Where',
        ).not.toBeNull(),
      );
      await waitForHomeGovernance(() =>
        expect(
          screen.findHostByTestId('project-deployments.draft.cantRun'),
          'the declared platforms are read, and listed as unable to run a stored Compose definition',
        ).not.toBeNull(),
      );
      await screen.unmount();
    } finally {
      await installed.dispose();
      account.dispose();
      storage.setState(previous);
    }
  });

  it('a platform card carries its declared plan facts, and the Machine stays in the Machine card when a platform is chosen (journey-deploy where)', async () => {
    const serverId = await homes.addHome({ name: 'Deploy plans', serverUrl: 'https://deploy-steps-plans.test', accountId: 'alice',
      serverIdentityId: `srv_${'p'.repeat(32)}`, currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const pluginId = 'com.example.steps-plans';
    const authoredPlugin = createDeploymentTargetsTestPlugin(pluginId, undefined, { plans: true });
    const installed = await installPortableAccountPluginReleaseForTest({ manifest: authoredPlugin.manifest,
      activate: (api) => authoredPlugin.activateAccount(api, DEPLOYMENT_TARGETS_TEST_EXECUTION.account),
      accountLifetime: account.accountLifetime, publishProjection: true });
    const { ProjectSourceRepositorySelectorV1Schema } = await import('@happier-dev/protocol/projects/sources/projectSourceV1');
    const repository = ProjectSourceRepositorySelectorV1Schema.parse({
      provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'alice/app', cloneUrl: 'https://github.com/alice/app.git' }, protocol: 'https' });
    try {
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: { ok: true, canManage: true, source: {
        id: 'source-app', revision: 3, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [],
        createdByAccountId: 'alice', repository, defaultRef: 'main' } } });
      await publishMachineInventoryForTest(account.accountLifetime.scope,
        [createMachineFixture({ id: 'runtime', installationId: 'runtime-installation', activeAt: Date.now() })]);
      const screen = await renderScreen(<NewAppDeploySteps serverId={serverId}
        source={{ kind: 'repository', projectSourceId: 'source-app' }}
        machineId={null} phone={false} steps={{ onFrame: () => {}, onExit: () => {} }} onLeave={() => {}} />);
      const alpha = `project-deployments.draft.target:${pluginId}/alpha`;
      const textOf = (testID: string) => {
        const node = screen.findHostByTestId(testID);
        return node ? node.findAll(() => true).flatMap(child => child.children.filter(value => typeof value === 'string')).join(' ') : null;
      };
      const hasMachineField = (testID: string) => (screen.findHostByTestId(testID)
        ?.findAll(child => child.props?.testID === 'project-deployments.draft.machine').length ?? 0) > 0;
      await waitForHomeGovernance(() => expect(screen.findHostByTestId(`${alpha}:footer`), 'the platform card shows its plans').not.toBeNull());
      expect(textOf(`${alpha}:description`), 'the card carries the declared description').toContain('Hosting for web apps');
      expect(textOf(`${alpha}:footer`)).toContain('$0.00 a month');
      expect(textOf(`${alpha}:footer`), 'the facts say where they come from').toContain('alpha.example');
      // What's included (journey-deploy wherePeek): the plans side by side, a fact a plan doesn't declare left empty.
      expect(screen.findHostByTestId(`${alpha}:compare`)).toBeNull();
      await screen.pressByTestIdAsync(`${alpha}:included`);
      await waitForHomeGovernance(() => expect(screen.findHostByTestId(`${alpha}:compare`)).not.toBeNull());
      const comparison = textOf(`${alpha}:compare`)!;
      for (const expected of ['Free', 'Pro', 'Credit', '$20.00 a month', '—', 'Automatic HTTPS', 'Preview deployments', 'alpha.example'])
        expect(comparison, expected).toContain(expected);
      await screen.pressByTestIdAsync(alpha);
      await waitForHomeGovernance(() => expect(hasMachineField('project-deployments.draft.target:own-server:footer'),
        'the Machine stays in the Machine card').toBe(true));
      expect(hasMachineField(`${alpha}:footer`), 'a chosen platform card shows its plans, not a Machine picker').toBe(false);
      await screen.unmount();
    } finally {
      await installed.dispose();
      account.dispose();
      storage.setState(previous);
    }
  });
});
