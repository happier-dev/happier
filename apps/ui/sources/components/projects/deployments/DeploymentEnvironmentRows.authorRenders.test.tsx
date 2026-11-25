import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployments/contracts/v1';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createWorkflowDefinitionFixture, createWorkflowRunListStorageFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Instrumentation only: each Services row draws its Environment mark once per render; the real mark still renders.
const marks = vi.hoisted(() => ({ renders: 0 }));
vi.mock('./rows/DeploymentEnvironmentRow', async (importOriginal) => {
  const original = await importOriginal<typeof import('./rows/DeploymentEnvironmentRow')>();
  const Mark = original.DeploymentEnvironmentMark;
  return { ...original, DeploymentEnvironmentMark: (props: React.ComponentProps<typeof Mark>) => {
    marks.renders += 1;
    return <Mark {...props} />;
  } };
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { AllDeploymentsGroups } = await import('./AllDeploymentsScreen');
const { SERVICES_APPS_COLLECTION_ID } = await import('./DeploymentEnvironmentRows');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const declarations = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
const previous = storage.getState();
beforeEach(async () => { await homes.reset(); });
afterEach(async () => { await standardCleanup(); await homes.reset(); storage.setState(previous); marks.renders = 0; });

type EnvironmentItem = DeploymentEnvironmentCollectionV1['items'][number];

it('keeps Machine What runs here independent of the Apps column preference', async () => {
  const items: EnvironmentItem[] = [
    { environment: createDeploymentEnvironmentHeaderV1({ id: 'machine-app', serverId: 'services' }),
      title: 'Machine app', currentDeployment: createDeploymentReceiptHeaderV1({ state: 'succeeded' }) },
  ];
  const preference = settingsParse({ collectionColumnPreferencesV1: {
    [SERVICES_APPS_COLLECTION_ID]: { orderedIds: [], placements: { lastDeploy: 'hidden' } },
  } });
  storage.setState({ settings: preference });
  const subscription = vi.spyOn(storage, 'subscribe');
  try {
    const screen = await renderScreen(<AllDeploymentsGroups items={items} serverId="services" lifetime={null} hereMachine />);
    expect(screen.findByTestId('all-deployments.row.machine-app:column:lastDeploy')).not.toBeNull();
    expect(subscription.mock.calls.filter(([, scope]) => Array.isArray(scope?.settings)
      && scope.settings.includes('collectionColumnPreferencesV1'))).toHaveLength(0);

    await screen.unmount();
    const apps = await renderScreen(<AllDeploymentsGroups items={items} serverId="services" lifetime={null}
      columns={{ collectionId: SERVICES_APPS_COLLECTION_ID }} />);
    expect(apps.findByTestId('all-deployments.row.machine-app:column:lastDeploy')).toBeNull();
    expect(subscription.mock.calls.filter(([, scope]) => Array.isArray(scope?.settings)
      && scope.settings.includes('collectionColumnPreferencesV1'))).toHaveLength(1);
  } finally {
    subscription.mockRestore();
  }
});

it('subscribes to extension declarations only when the Environment rows opt in', async () => {
  const items: EnvironmentItem[] = [
    { environment: createDeploymentEnvironmentHeaderV1({ id: 'machine-app', serverId: 'services' }), title: 'Machine app' },
  ];
  const subscribe = vi.spyOn(declarations, 'useAppShellPluginUiDeclarationSources');
  try {
    const machine = await renderScreen(<AllDeploymentsGroups items={items} serverId="services" lifetime={null} hereMachine />);
    expect(machine.findByTestId('all-deployments.row.machine-app')).not.toBeNull();
    expect(subscribe).not.toHaveBeenCalled();
    await machine.unmount();

    await renderScreen(<AllDeploymentsGroups items={items} serverId="services" lifetime={null}
      columns={{ collectionId: SERVICES_APPS_COLLECTION_ID }} />);
    expect(subscribe).toHaveBeenCalled();
  } finally {
    subscribe.mockRestore();
  }
});

it.each([4, 40])('a Workflow name arriving for one latest deploy redraws that row only (%i rows)', async (count) => {
  const serverId = await homes.addHome({ name: 'Services', serverUrl: 'https://services-authors.test', accountId: 'viewer' });
  const scope = { serverId, accountId: 'viewer' };
  storage.setState({ profileScope: scope, users: {}, workflowRunsById: {}, sessionListRowsByServerId: {} });
  homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
  const runs = Array.from({ length: count }, (_, index) => createWorkflowRunSummaryFixture({ id: `run-${index}`, ownerAccountId: 'viewer' }));
  homes.answer(serverId, '/v3/automations/runs/workflow-storage', { body: await createWorkflowRunListStorageFixture({ runs,
    definition: createWorkflowDefinitionFixture({
    blocks: [{ kind: 'wait', id: 'approve', document: { text: 'Approve deploy', references: [], attachments: [] } }] }), metadata: { title: 'Nightly deploy' } }) });
  const items: EnvironmentItem[] = runs.map((run, index) => ({
    environment: createDeploymentEnvironmentHeaderV1({ id: `environment-${index}`, serverId, projectSourceId: 'storefront' }),
    title: `Environment ${index}`,
    projectSourceName: 'Storefront',
    currentDeployment: { ...createDeploymentReceiptHeaderV1({ state: 'succeeded' }), actor: { actorKind: 'workflow', runId: run.id } },
  }));
  function Rows() {
    const lifetime = useServerCredentialAccountScopeBindings([serverId]).get(serverId) ?? null;
    return lifetime ? <AllDeploymentsGroups items={items} serverId={serverId} lifetime={lifetime} /> : null;
  }
  const screen = await renderScreen(<Rows />);
  await vi.waitFor(() => expect(screen.getTextContent()).toContain('Nightly deploy'), { timeout: 15_000 });
  marks.renders = 0;

  await act(async () => storage.getState().upsertWorkflowRuns([
    workflowRunRowFromSummary({ ...runs[0]!, revision: 2 }, { kind: 'available', value: { title: 'Renamed deploy' } }),
  ], scope));

  expect(screen.getTextContent()).toContain('Renamed deploy');
  expect(marks.renders).toBe(1);
});

it.each([4, 40])('one Environment health arrival redraws that row only (%i rows)', async (count) => {
  const items: EnvironmentItem[] = Array.from({ length: count }, (_, index) => ({
    environment: createDeploymentEnvironmentHeaderV1({ id: `environment-${index}`, serverId: 'services', projectSourceId: 'storefront' }),
    title: `Environment ${index}`,
    projectSourceName: 'Storefront',
  }));
  const tree = (rows: readonly EnvironmentItem[]) => <AllDeploymentsGroups items={rows} serverId="services" lifetime={null} />;
  const screen = await renderScreen(tree(items));
  const first = items[0]!;
  const changed: EnvironmentItem = { ...first, healthAggregate: {
    v: 1, environmentId: first.environment.id, targetLinkId: 'runtime-link', protection: first.environment.protection,
    status: 'down', n: 1, down: 1, degraded: 0, unknown: 0, members: [], affectedMachineIds: ['machine-0'],
    edgeUnreachable: false, authoritativeRecovery: false,
  } };
  expect(marks.renders).toBeGreaterThan(1);
  marks.renders = 0;

  await screen.update(tree([changed, ...items.slice(1)]));

  expect(screen.findByTestId('all-deployments.row.environment-0')?.props.accessibilityLabel).toContain('Down');
  expect(marks.renders).toBe(1);
});
