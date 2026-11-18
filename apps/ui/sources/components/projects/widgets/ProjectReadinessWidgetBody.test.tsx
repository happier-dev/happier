// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ProjectSourceV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { ProjectReadinessReadInputV1Schema } from '@happier-dev/protocol/projects/readinessV1';
import type { ProjectReadinessFactV1 } from '@happier-dev/protocol/projects/readinessV1';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { createHealthCheckSourceInstanceIdV1 } from '@happier-dev/protocol/deployments/healthCheckSubjectV1';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: navigation }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { createPluginSurfaceDestinationNavigationBinding, PluginSurfaceDestinationNavigationBindingProvider } = await import('@/components/plugins/surfaces/pluginSurfaceDestinationNavigation');
const { SelectionListFilterChip } = await import('@/components/ui/selectionList/SelectionListFilterChips');
const { TriggerPopover } = await import('@/components/workflows/triggers/TriggerPopover');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');
const { AccountNoticeInvestigationBoundary } = await import('@/hooks/inbox/AccountNoticeInvestigationProvider');
const { ProjectReadinessWidgetBody } = await import('./ProjectReadinessWidgetBody');
let portal: ReturnType<typeof installReactDomPortalBoundaryForTests> | undefined;
beforeEach(() => { portal = installReactDomPortalBoundaryForTests(); });
afterEach(async () => {
  await standardCleanup();
  portal?.restore();
  const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
  await disconnectActiveServerConnection();
  navigation.push.mockClear();
});

async function readinessScreen(facts: readonly ProjectReadinessFactV1[], wrap: (children: React.ReactNode) => React.ReactNode = children => children,
  failure?: () => Readonly<{ errorCode: string; error: string }> | null) {
  await homes.reset();
  const identity = `srv_${'8'.repeat(32)}`;
  const serverId = await homes.addHome({ name: 'Readiness', serverUrl: 'https://readiness-render.test',
    serverIdentityId: identity, accountId: 'alice', currentAccount: true });
  await loadSyncSingletonForTests();
  const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
  await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://readiness-render.test')!.token! });
  const initial = createDeploymentEnvironmentDetailV1();
  const environment = { ...initial.environment, serverId: identity, id: 'staging', projectSourceId: 'project',
    controllerMachineId: 'controller', revision: 8 };
  const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
  const account = await captureLazyActionAccountContext(serverId);
  try {
    await publishMachineInventoryForTest(account.accountLifetime.scope,
      [createMachineFixture({ id: 'controller', activeAt: Date.now() })]);
  } finally { account.dispose(); }
  homes.artifacts(serverId).replaceStoredRow(createPlainArtifactHttpFixture({ id: environment.contentArtifactId,
    isDecrypted: true, title: 'Staging', header: { kind: 'deployment-environment.v1', title: 'Staging' },
    body: JSON.stringify({ ...initial.content, name: 'Staging' }), headerVersion: environment.contentHeaderVersion,
    bodyVersion: environment.contentBodyVersion, seq: 1, createdAt: 1, updatedAt: 1 }, 'alice'));
  homes.answer(serverId, '/v1/deployments/environments', { body: { ok: true, items: [environment], nextCursor: null } });
  const reads: unknown[] = [];
  await answerExternalActionAccountForHome(homes, serverId, { machineId: 'controller', actionId: 'projects.readiness.read',
    requesterInvocation: 'none', tokenEpoch: 0, failure, execute: raw => {
      const input = ProjectReadinessReadInputV1Schema.parse(raw);
      reads.push(input);
      return { serverId: identity, projectId: 'project', status: 'actionNeeded', facts };
    } });
  const target = { kind: 'project' as const, projectKey: 'project', source: { serverId,
    source: ProjectSourceV1Schema.parse({ id: 'project', revision: 1, name: 'App', audience: [], createdByAccountId: 'alice' }) } };
  const screen = await renderScreen(<AccountNoticeInvestigationBoundary>{wrap(
    <ProjectReadinessWidgetBody target={target} testID="readiness" />
  )}</AccountNoticeInvestigationBoundary>);
  expect(reads).toEqual([]);
  await vi.waitFor(() => expect(screen.findByType(SelectionListFilterChip).props.filter.options, JSON.stringify({
    requests: homes.requests.map(request => ({ method: request.method, path: request.path })),
    states: screen.findAllByType(SurfaceStateCard).map(card => ({ kind: card.props.kind, diagnosticCode: card.props.diagnosticCode })),
  })).toHaveLength(1));
  await act(async () => screen.pressByTestId('readiness.environment'));
  await vi.waitFor(() => expect(screen.findByTestId('readiness.environment:staging')).toBeTruthy());
  await act(async () => screen.pressByTestId('readiness.environment:staging'));
  await vi.waitFor(() => expect(reads, JSON.stringify({
    current: captureActiveServerAccountScopeLifetime()?.isCurrent(),
    selected: screen.findByType(SelectionListFilterChip).props.filter.selectedId,
    requests: homes.requests.map(request => ({ method: request.method, path: request.path })),
    states: screen.findAllByType(SurfaceStateCard).map(card => ({ kind: card.props.kind, title: card.props.title,
      diagnosticCode: card.props.diagnosticCode })),
  })).toHaveLength(1));
  return { screen, reads, identity, target };
}

it('selects the saved Environment and renders its source evidence without a Session', async () => {
  const { screen, reads, identity } = await readinessScreen([
    { kind: 'health', owner: 'healthChecks', environmentId: 'staging', status: 'ready', reason: 'health_checks_configured',
      healthCoverage: { sourceRevision: 'saved-source:4', observerMachineId: 'controller', checkCount: 1,
        domains: [{ domainId: 'domain', domainRevision: 2, facts: { availability: 'observed', unavailableReason: null,
          observedAt: 1_800_000_000_000, vantage: 'sameMachine', certificate: { state: 'not_checked', expiresAt: null }, needsYou: null } }] } },
    { kind: 'secrets', owner: 'environmentSecrets', environmentId: 'staging', status: 'actionNeeded', reason: 'secret_grants_missing',
      secretScope: { requiredGrantCount: 3, missingGrantCount: 1 } },
    { kind: 'alerts', owner: 'alertSources', environmentId: 'staging', status: 'ready', reason: 'health_alerts_configured',
      alertWiring: { sourceRevision: 'saved-source:4', observerMachineId: 'controller', controllerMachineId: 'controller',
        channelIds: ['channel.email'], phases: ['open', 'recovered'] } },
  ]);
  try {
    await vi.waitFor(() => expect(screen.findByTestId('readiness.ready.header')).toBeTruthy());
    expect(screen.findHostByTestId('readiness.health')).toBeFalsy();
    await act(async () => screen.pressByTestId('readiness.ready.header'));
    await vi.waitFor(() => expect(screen.findByTestId('readiness.health')).toBeTruthy());
    expect(reads).toEqual([{ serverId: identity, machineId: 'controller', projectId: 'project',
      environments: [{ environmentId: 'staging', expectedRevision: 8 }] }]);
    expect(screen.findHostByTestId('readiness.health.evidence')?.children.join('')).toContain('saved-source:4');
    expect(screen.findHostByTestId('readiness.health.evidence')?.children.join('')).toContain(formatAsOfTime(1_800_000_000_000));
    expect(screen.findHostByTestId('readiness.secrets.evidence')?.children.join('')).toContain('3');
    expect(screen.findHostByTestId('readiness.secrets.evidence')?.children.join('')).toContain('1');
    expect(screen.findHostByTestId('readiness.alerts.evidence')?.children.join('')).toContain('saved-source:4');
    expect(homes.requests.filter(request => request.method === 'POST' && new URL(request.path, 'https://home.test').pathname === '/v1/sessions')).toEqual([]);
  } finally { await screen.unmount(); }
});

it('opens the selected Environment backup setup without a Session', async () => {
  const { screen } = await readinessScreen([{ kind: 'backups', owner: 'deploymentBackups', environmentId: 'staging',
    status: 'actionNeeded', reason: 'backup_configuration_required' }]);
  try {
    await vi.waitFor(() => expect(screen.findByTestId('readiness.backups.fix')).toBeTruthy());
    await act(async () => screen.pressByTestId('readiness.backups.fix'));
    expect(navigation.push).toHaveBeenCalledWith(expect.objectContaining({ pathname: '/deployments/[projectSourceId]',
      params: expect.objectContaining({ projectSourceId: 'project', deploymentEnvironment: 'staging', deploymentSetup: 'backups' }) }));
    expect(homes.requests.filter(request => request.method === 'POST' && new URL(request.path, 'https://home.test').pathname === '/v1/sessions')).toEqual([]);
  } finally { await screen.unmount(); }
});

it('keeps the chosen Environment when the person comes back from a Fix', async () => {
  const { screen, target } = await readinessScreen([{ kind: 'backups', owner: 'deploymentBackups', environmentId: 'staging',
    status: 'actionNeeded', reason: 'backup_configuration_required' }]);
  await vi.waitFor(() => expect(screen.findByTestId('readiness.backups.fix')).toBeTruthy());
  await act(async () => screen.pressByTestId('readiness.backups.fix'));
  expect(navigation.push).toHaveBeenCalled();
  // Fix leaves the Project page; Back mounts its widget again.
  await screen.unmount();
  const back = await renderScreen(<AccountNoticeInvestigationBoundary>
    <ProjectReadinessWidgetBody target={target} testID="readiness" />
  </AccountNoticeInvestigationBoundary>);
  try {
    await vi.waitFor(() => expect(back.findByType(SelectionListFilterChip).props.filter.selectedId).toBe('staging'));
    await vi.waitFor(() => expect(back.findByTestId('readiness.backups.fix')).toBeTruthy());
  } finally { await back.unmount(); }
});

it('shows the owner refusal and recovers through explicit Refresh', async () => {
  let unavailable = true;
  const { screen } = await readinessScreen([{ kind: 'secrets', owner: 'environmentSecrets', environmentId: 'staging',
    status: 'ready', reason: 'secret_scope_current', secretScope: { requiredGrantCount: 0, missingGrantCount: 0 } }], undefined,
  () => unavailable ? { errorCode: 'machine_unavailable', error: 'The selected controller is unavailable.' } : null);
  try {
    await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard)
      .some(card => card.props.diagnosticCode === 'machine_unavailable')).toBe(true));
    unavailable = false;
    await act(async () => screen.pressByTestId('readiness.refresh'));
    await vi.waitFor(() => expect(screen.findByTestId('readiness.ready.header')).toBeTruthy());
    await act(async () => screen.pressByTestId('readiness.ready.header'));
    expect(screen.findByTestId('readiness.secrets')).toBeTruthy();
    expect(screen.findAllByType(SurfaceStateCard).some(card => card.props.diagnosticCode === 'machine_unavailable')).toBe(false);
  } finally { await screen.unmount(); }
});

it('opens the saved Source editor when the Project has no repository selection', async () => {
  const { screen } = await readinessScreen([{ kind: 'ci', owner: 'forgeCI', status: 'actionNeeded', reason: 'project_repository_required' }]);
  try {
    await vi.waitFor(() => expect(screen.findByTestId('readiness.ci.fix')).toBeTruthy());
    await act(async () => screen.pressByTestId('readiness.ci.fix'));
    expect(navigation.push).toHaveBeenCalledWith('/projects/sources?source=project');
    expect(homes.requests.filter(request => request.method === 'POST' && new URL(request.path, 'https://home.test').pathname === '/v1/sessions')).toEqual([]);
  } finally { await screen.unmount(); }
});

it('opens the provider native surface in the current Project navigation scope without starting a Session', async () => {
  const setupSurface = { pluginId: 'example.repository', localId: 'checks' };
  const binding = normalizePluginUiDestinationBindingV1({ pluginId: setupSurface.pluginId,
    destinationId: setupSurface.localId, rendererId: 'checks-renderer', container: 'appPage', target: { kind: 'project' } });
  if (!binding) throw new Error('Expected an admitted Project page binding');
  const placement: PluginUiSurfacePlacementProjection = { id: 'project-checks', pluginId: setupSurface.pluginId,
    occurrenceId: 'installed-checks', contributionKind: 'surfacePlacement', descriptorId: setupSurface.localId,
    binding, target: binding.target, renderer: { kind: 'reactNative', contributionId: 'checks-renderer' },
    display: { developerFallback: 'Checks' }, availability: { state: 'available', reason: 'available', diagnostics: [] }, headerActions: [] };
  const opened: unknown[] = [];
  const { screen } = await readinessScreen([{ kind: 'ci', owner: 'forgeCI', status: 'actionNeeded', reason: 'ci_source_required', setupSurface }], children => {
    const navigation = createPluginSurfaceDestinationNavigationBinding({ placements: [placement], targetKind: 'project',
      accountLifetime: captureActiveServerAccountScopeLifetime() });
    // The native page owner is the UI platform boundary; admission/navigation remain real.
    navigation.registerOwner({ container: 'appPage', handler: resolution => { opened.push(resolution.request); return { ok: true }; } });
    return <PluginSurfaceDestinationNavigationBindingProvider binding={navigation}>{children}</PluginSurfaceDestinationNavigationBindingProvider>;
  });
  try {
    await vi.waitFor(() => expect(screen.findByTestId('readiness.ci.fix')).toBeTruthy());
    await act(async () => screen.pressByTestId('readiness.ci.fix'));
    await vi.waitFor(() => expect(opened).toEqual([{ destination: setupSurface }]));
    expect(homes.requests.filter(request => request.method === 'POST' && new URL(request.path, 'https://home.test').pathname === '/v1/sessions')).toEqual([]);
  } finally { await screen.unmount(); }
});

it('opens the existing Health Event editor for the exact source and controller before any write', async () => {
  const { screen } = await readinessScreen([{ kind: 'alerts', owner: 'alertSources', environmentId: 'staging',
    status: 'actionNeeded', reason: 'health_alerts_required' }]);
  try {
    await vi.waitFor(() => expect(screen.findByTestId('readiness.alerts.fix')).toBeTruthy());
    await act(async () => screen.pressByTestId('readiness.alerts.fix'));
    await vi.waitFor(() => expect(screen.findByType(TriggerPopover).props).toMatchObject({ machineId: 'controller',
      initialEventSeed: { sourceInstanceId: createHealthCheckSourceInstanceIdV1({ kind: 'environment', environmentId: 'staging' }),
        monitoringMachineId: 'controller', setupInput: { v: 1, subject: { kind: 'environment', environmentId: 'staging' } } } }));
    await act(async () => screen.findByType(TriggerPopover).props.onRequestClose());
    expect(screen.findAllByType(TriggerPopover)).toEqual([]);
    expect(homes.requests.filter(request => (request.method === 'POST' && new URL(request.path, 'https://home.test').pathname === '/v1/sessions') || request.path.includes('/v1/actions/workflow.trigger.add'))).toEqual([]);
  } finally { await screen.unmount(); }
});

it('says the Environments could not be read, never also that there are none', async () => {
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Readiness', serverUrl: 'https://readiness-unread.test',
    serverIdentityId: `srv_${'9'.repeat(32)}`, accountId: 'alice', currentAccount: true });
  await loadSyncSingletonForTests();
  const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
  await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://readiness-unread.test')!.token! });
  homes.answer(serverId, '/v1/deployments/environments', { status: 503, body: { ok: false, error: 'deployment_store_unavailable' } });
  const target = { kind: 'project' as const, projectKey: 'project', source: { serverId,
    source: ProjectSourceV1Schema.parse({ id: 'project', revision: 1, name: 'App', audience: [], createdByAccountId: 'alice' }) } };
  const screen = await renderScreen(<AccountNoticeInvestigationBoundary>
    <ProjectReadinessWidgetBody target={target} testID="readiness" />
  </AccountNoticeInvestigationBoundary>);
  await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard).map(card => card.props.kind)).toContain('unavailable'), { timeout: 20000 });
  expect(screen.findAllByType(SurfaceStateCard).map(card => card.props.kind)).toEqual(['unavailable']);
});


it('says a Project with no Environments in one line with Add, never a chooser above it (phone-lists P1)', async () => {
  await homes.reset();
  const serverId = await homes.addHome({ name: 'Readiness', serverUrl: 'https://readiness-empty.test',
    serverIdentityId: `srv_${'7'.repeat(32)}`, accountId: 'alice', currentAccount: true });
  await loadSyncSingletonForTests();
  const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
  await restoreConnectionToActiveServer({ token: homes.findByServerUrl('https://readiness-empty.test')!.token! });
  homes.answer(serverId, '/v1/deployments/environments', { body: { ok: true, items: [], nextCursor: null } });
  const target = { kind: 'project' as const, projectKey: 'project', source: { serverId,
    source: ProjectSourceV1Schema.parse({ id: 'project', revision: 1, name: 'App', audience: [], createdByAccountId: 'alice' }) } };
  const screen = await renderScreen(<AccountNoticeInvestigationBoundary>
    <ProjectReadinessWidgetBody target={target} testID="readiness" />
  </AccountNoticeInvestigationBoundary>);
  await vi.waitFor(() => expect(screen.findAllByType(SurfaceStateCard).map(card => card.props.kind)).toEqual(['empty']), { timeout: 20000 });
  expect(screen.findAllByType(SelectionListFilterChip)).toHaveLength(0);
  expect(screen.findAllByType(SurfaceStateCard)[0]!.props.action).toMatchObject({ testID: 'readiness.add' });
});

it('keeps unavailable facts visible while ready facts fold without another read or write', async () => {
  const { screen, reads } = await readinessScreen([
    { kind: 'ci', owner: 'forgeCI', status: 'ready', reason: 'ci_source_present' },
    { kind: 'security', owner: 'forgeSecurity', status: 'unavailable', reason: 'source_transport_unavailable' },
  ]);
  try {
    await vi.waitFor(() => expect(screen.findByTestId('readiness.security')).toBeTruthy());
    expect(screen.findHostByTestId('readiness.ci')).toBeFalsy();
    await act(async () => screen.pressByTestId('readiness.ready.header'));
    await vi.waitFor(() => expect(screen.findByTestId('readiness.ci')).toBeTruthy());
    expect(screen.findByTestId('readiness.security')).toBeTruthy();
    expect(reads).toHaveLength(1);
    expect(homes.requests.filter(request => request.method === 'POST'
      && (new URL(request.path, 'https://home.test').pathname === '/v1/sessions'
        || request.path.includes('/v1/actions/workflow.trigger.add')))).toEqual([]);
  } finally { await screen.unmount(); }
});
