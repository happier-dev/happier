import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup, waitForTestEvent } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
const routerMock = await vi.hoisted(async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock();
});
vi.mock('expo-router', () => routerMock.module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { ProjectDeploymentsView } = await import('./ProjectDeploymentsBody');
const { createDeploymentReadControllerV1 } = await import('@happier-dev/deployments');
const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { storage } = await import('@/sync/domains/state/storageStore');
const { createDeploymentActions } = await import('./deploymentActions');
const { Modal } = await import('@/modal');

afterEach(async () => { standardCleanup(); await homes.reset(); routerMock.resetParams(); });

describe("a Project's Deployments tab with nothing deployed", () => {
  it("leads with Deploy an app, opening the one dialog with this Project's code chosen, never the draft (journey-deploy proj)", async () => {
    const serverId = await homes.addHome({ name: 'Project', serverUrl: 'https://project-deploy-app.test', accountId: 'alice', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const controller = createDeploymentReadControllerV1({ scope: { ...account.accountLifetime.scope, projectSourceId: 'source-app' },
      transport: createDeploymentReadTransport(account.accountLifetime) });
    try {
      const { ProjectSourcesReadOutputV1Schema } = await import('@happier-dev/protocol/projects/sources/projectSourceV1');
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { body: ProjectSourcesReadOutputV1Schema.parse({ ok: true, canManage: true,
        source: { id: 'source-app', revision: 1, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [], createdByAccountId: 'alice' } }) });
      homes.answer(serverId, 'GET /v1/deployments/environments', { body: { ok: true, items: [], nextCursor: null } });
      const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
      const { FeaturesResponseSchema } = await import('@happier-dev/protocol/features/payload/featuresResponseSchema');
      primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: { deployments: { enabled: true } }, capabilities: {} }) } });
      storage.getState().applySettingsLocal({ featureToggles: { ...storage.getState().settings.featureToggles, deployments: true } });
      const screen = await renderScreen(<ProjectDeploymentsView lifetime={account.accountLifetime} sourceId="source-app"
        controller={controller} demand={{ mounted: true, visible: true, focused: true }} accountId="alice" serverId={serverId}
        actions={createDeploymentActions(account.accountLifetime, 'source-app')} />);
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.empty.deployApp'), node => node !== null);
      vi.mocked(Modal.show).mockClear();
      routerMock.spies.push.mockClear();
      await screen.pressByTestIdAsync('project-deployments.empty.deployApp');
      expect(vi.mocked(Modal.show).mock.calls.map(([config]) => {
        const shown = config as { chrome?: { testID?: string }; props?: { projectSourceId?: string | null } };
        return { dialog: shown.chrome?.testID, projectSourceId: shown.props?.projectSourceId };
      })).toEqual([{ dialog: 'newApp.dialog', projectSourceId: 'source-app' }]);
      expect(routerMock.spies.push).not.toHaveBeenCalled();
      expect(screen.findByTestId('project-deployments.draft')).toBeNull();
      await screen.unmount();
    } finally { standardCleanup(); controller.retire(); account.dispose(); storage.setState(previous); }
  });
});
