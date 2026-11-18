import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';
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
const previous = storage.getState();
beforeEach(async () => { await homes.reset(); });
afterEach(async () => { await standardCleanup(); await homes.reset(); storage.setState(previous); marks.renders = 0; });

type EnvironmentItem = DeploymentEnvironmentCollectionV1['items'][number];

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
