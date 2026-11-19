import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';
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

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { ProjectDeploymentsView } = await import('./ProjectDeploymentsBody');
const { createDeploymentReadControllerV1 } = await import('@happier-dev/deployments');
const { createDeploymentReadTransport } = await import('./deploymentReadTransport');
const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
const { storage } = await import('@/sync/domains/state/storageStore');
const { createDeploymentActions } = await import('./deploymentActions');

afterEach(async () => { standardCleanup(); await homes.reset(); routerMock.resetParams(); });
describe('Source availability at Environment creation', () => {
  it.each([
    { available: true, populated: false, definition: null },
    { available: true, populated: true, definition: null },
    { available: false, populated: false, definition: null },
    { available: false, populated: true, definition: null },
    { available: false, populated: false, definition: 'compose' },
  ])('offers creation only for a readable Source ($available, populated=$populated, definition=$definition)', async ({ available, populated, definition }) => {
    const serverId = await homes.addHome({ name: 'Project', serverUrl: 'https://source-availability.test', accountId: 'alice', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const controller = createDeploymentReadControllerV1({ scope: { ...account.accountLifetime.scope, projectSourceId: 'source-app' },
      transport: createDeploymentReadTransport(account.accountLifetime) });
    try {
      const { ProjectSourcesReadOutputV1Schema } = await import('@happier-dev/protocol/projects/sources/projectSourceV1');
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', available ? { body: ProjectSourcesReadOutputV1Schema.parse({ ok: true, canManage: true,
        source: { id: 'source-app', revision: 1, name: 'App', owner: { kind: 'account', accountId: 'alice' }, audience: [], createdByAccountId: 'alice' } }) }
        : { status: 404, body: { ok: false, error: 'source_unavailable' } });
      const { createDeploymentEnvironmentDetailV1, createDeploymentEnvironmentHeaderV1 } = await import('@happier-dev/deployment-protocol/testing/v1');
      const { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } = await import('@happier-dev/deployment-protocol/v1');
      const detail = createDeploymentEnvironmentDetailV1();
      const environment = createDeploymentEnvironmentHeaderV1({ serverId, owner: { kind: 'account', accountId: 'alice' } });
      if (populated) {
        await account.createArtifactDocument({ artifactId: environment.contentArtifactId,
          header: { kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Staging' }, body: JSON.stringify(detail.content) });
        homes.answer(serverId, `GET /v1/deployments/environments/${environment.id}`, { body: { ok: true, environment } });
      }
      homes.answer(serverId, 'GET /v1/deployments/environments', { body: { ok: true,
        items: populated ? [environment] : [], nextCursor: null } });
      const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
      const { FeaturesResponseSchema } = await import('@happier-dev/protocol/features/payload/featuresResponseSchema');
      primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: { deployments: { enabled: true } }, capabilities: {} }) } });
      storage.getState().applySettingsLocal({ featureToggles: { ...storage.getState().settings.featureToggles, deployments: true } });
      const project = <ProjectDeploymentsView lifetime={account.accountLifetime} sourceId="source-app"
        controller={controller} demand={{ mounted: true, visible: true, focused: true }} accountId="alice" serverId={serverId}
        actions={createDeploymentActions(account.accountLifetime, 'source-app')} />;
      const body = (newDefinition: string | null) => (
        <DestinationInstanceContext.Provider value={{
          tabId: 'project-tab', focused: true, visible: true, isFocused: () => true,
          pathname: '/deployments/source-app', navigation: routerMock.module.router,
          ref: { kind: 'deployments', params: { serverId, projectSourceId: 'source-app',
            workspacePathname: '/deployments/source-app', ...(newDefinition ? { newDefinition } : {}) } },
        }}>
          {project}
        </DestinationInstanceContext.Provider>
      );
      const screen = await renderScreen(body(definition));
      if (available) {
        await waitForTestEvent(screen.subscribe, () => screen.findByTestId(populated
          ? 'project-deployments.rail.add' : 'project-deployments.empty.deployApp'), node => node !== null);
        expect(screen.findByTestId('project-deployments.sourceUnavailable')).toBeNull();
        if (!populated) {
          await screen.update(body('compose'));
          expect(screen.findByTestId('project-deployments.draft.composeDocument')).not.toBeNull();
          await screen.update(body('image'));
          expect(screen.findByTestId('project-deployments.draft.imageName')).not.toBeNull();
          expect(screen.findByTestId('project-deployments.draft.composeDocument')).toBeNull();
          await screen.update(body(null));
          expect(screen.findByTestId('project-deployments.draft')).toBeNull();
        }
      } else {
        await waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.sourceUnavailable'), node => node !== null);
        expect(screen.findByTestId('project-deployments.empty.deployApp')).toBeNull();
        expect(screen.findByTestId('project-deployments.rail.add')).toBeNull();
        expect(screen.findByTestId('project-deployments.rail.draft')).toBeNull();
        expect(screen.findByTestId('project-deployments.draft')).toBeNull();
        const { t } = await import('@/text');
        expect(screen.getTextContent()).toContain(t('projects.sources.unavailable'));
        expect(screen.getTextContent()).toContain(t('projects.open.sourceUnavailableHint'));
        expect(screen.findByTestId('project-deployments.prepare.open')).toBeNull();
        expect(screen.findByTestId('project-deployments.import.open')).toBeNull();
      }
      await screen.unmount();
    } finally { standardCleanup(); controller.retire(); account.dispose(); storage.setState(previous); }
  });
});

describe('an unreadable Source', () => {
  it('says the Source is unavailable and leads to another one, never offering Retry for a refusal', async () => {
    const serverId = await homes.addHome({ name: 'Project', serverUrl: 'https://source-refusal.test', accountId: 'dana', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const controller = createDeploymentReadControllerV1({ scope: { ...account.accountLifetime.scope, projectSourceId: 'source-app' },
      transport: createDeploymentReadTransport(account.accountLifetime) });
    try {
      // Another person's Source: the Home refuses both reads.
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', { status: 404, body: { ok: false, error: 'source_unavailable' } });
      homes.answer(serverId, 'GET /v1/deployments/environments', { status: 404, body: { ok: false, error: 'deployment_unavailable' } });
      const screen = await renderScreen(<ProjectDeploymentsView lifetime={account.accountLifetime} sourceId="source-app"
        controller={controller} demand={{ mounted: true, visible: true, focused: true }} accountId="dana" serverId={serverId}
        actions={createDeploymentActions(account.accountLifetime, 'source-app')} />);
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId('project-deployments.error'), node => node !== null);
      const { t } = await import('@/text');
      expect(screen.findByTestId('project-deployments.sourceUnavailable')).not.toBeNull();
      expect(screen.getTextContent()).not.toContain(t('projects.deployments.loadErrorTitle'));
      expect(screen.getTextContent()).not.toContain(t('common.retry'));
      await screen.unmount();
    } finally { standardCleanup(); controller.retire(); account.dispose(); storage.setState(previous); }
  });
});

describe('a Home that is not answering', () => {
  it.each([false, true])('says the Home outage once even if a direct Environment is open (selected=%s, R2-D3)', async selected => {
    const serverId = await homes.addHome({ name: 'Project', serverUrl: 'https://source-away.test', accountId: 'erin', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    const previous = storage.getState();
    const controller = createDeploymentReadControllerV1({ scope: { ...account.accountLifetime.scope, projectSourceId: 'source-app' },
      transport: createDeploymentReadTransport(account.accountLifetime) });
    try {
      const away = { select: () => { throw new TypeError('Failed to fetch'); } };
      homes.answer(serverId, 'GET /v1/projects/sources/source-app', away);
      homes.answer(serverId, 'GET /v1/deployments/environments', away);
      if (selected) homes.answer(serverId, 'GET /v1/deployments/environments/environment-staging', away);
      const screen = await renderScreen(
        <DestinationInstanceContext.Provider value={{
          tabId: 'project-tab', focused: true, visible: true, isFocused: () => true,
          pathname: '/deployments/source-app', navigation: routerMock.module.router,
          ref: { kind: 'deployments', params: { serverId, projectSourceId: 'source-app',
            workspacePathname: '/deployments/source-app', ...(selected ? { deploymentEnvironment: 'environment-staging' } : {}) } },
        }}>
          <ProjectDeploymentsView lifetime={account.accountLifetime} sourceId="source-app"
            controller={controller} demand={{ mounted: true, visible: true, focused: true }} accountId="erin" serverId={serverId}
            actions={createDeploymentActions(account.accountLifetime, 'source-app')} />
        </DestinationInstanceContext.Provider>,
      );
      const state = selected ? 'project-deployments.environment.state' : 'project-deployments.error';
      await waitForTestEvent(screen.subscribe, () => screen.findByTestId(state), node => node !== null);
      const { t } = await import('@/text');
      expect(screen.findByTestId('project-deployments.sourceUnavailable')).toBeNull();
      expect(screen.getTextContent()).not.toContain(t('projects.sources.unavailable'));
      expect(screen.getTextContent().split(t('projects.deployments.unavailableTitle'))).toHaveLength(2);
      expect(screen.getTextContent()).not.toContain(t('projects.deployments.loadErrorTitle'));
      await screen.unmount();
    } finally { standardCleanup(); controller.retire(); account.dispose(); storage.setState(previous); }
  });
});
