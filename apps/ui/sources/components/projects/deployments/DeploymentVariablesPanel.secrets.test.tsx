// @vitest-environment jsdom
import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1, createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { resetSavedSecretCatalogEngineForTests, refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { applySavedSecretCatalogPage, resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { resetTeamActionClientForTests } from '@/sync/ops/teams/teamActionClient';
import { settingsParse } from '@/sync/domains/settings/settings';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { machinePageHref } from '@/components/machines/page/machinePageHref';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
const routing = await vi.hoisted(async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock());
vi.mock('expo-router', () => routing.module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ renderCustomModals: true }).module);
// Test Renderer paints the real menu inline at the external DOM renderer boundary.
vi.mock('@/utils/web/reactDomCjs', async () => (await import('@/dev/testkit/mocks/reactDomCjs')).createReactDomCjsRendererMock());
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();

let home: Awaited<ReturnType<typeof createSecretSettingsTestHarness>> | null = null;
beforeEach(() => {
  resetSavedSecretCatalogEngineForTests();
  resetSavedSecretCatalogSnapshotsForTests();
  resetTeamActionClientForTests();
  routing.spies.push.mockClear();
});
afterEach(async () => {
  await standardCleanup();
  resetSavedSecretCatalogEngineForTests();
  await home?.dispose();
  home = null;
});

async function mount(phone = true, readRunningBindings?: (bindings: readonly unknown[]) => Promise<unknown>,
  referenceTargets?: readonly unknown[]) {
  home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }),
    handleRequest: async path => path === '/v1/account/saved-secrets/resources/activity'
      ? Response.json({ historyEntryId: 'disclosure-entry' }) : null });
  const { entry } = await home.addOwnerResource();
  const binding = createDeploymentSecretVariableBindingV1({ name: 'API_KEY', phase: 'runtime', resourceId: 'resource-a', resourceRevision: 3 });
  const base = createDeploymentEnvironmentDetailV1();
  const detail = { ...base, content: { ...base.content, bindings: [binding] } };
  const scope = home.scope;
  const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
  const { useEnvironmentSecretBindingsDraft } = await import('./useEnvironmentSecretBindingsDraft');
  const { DeploymentVariablesPanel } = await import('./DeploymentVariablesPanel');
  const { createDeploymentActions } = await import('./deploymentActions');
  const { ModalProvider } = await import('@/modal');
  const actions = createDeploymentActions(lifetime, detail.environment.projectSourceId);
  function Page() {
    const draft = useEnvironmentSecretBindingsDraft({ environmentId: detail.environment.id, lifetime,
      snapshot: { status: 'ready', value: detail, failure: null }, setBindings: actions.setBindings });
    return <DeploymentVariablesPanel draft={draft} phone={phone} environmentName={() => null} sealedOn={null}
      review={{ pendingId: null, request() {}, open() {} }} environmentId={detail.environment.id} scope={scope} lifetime={lifetime}
      machineId="machine-a" readRunningBindings={readRunningBindings as never} referenceTargets={referenceTargets as never} />;
  }
  const screen = await renderScreen(<ModalProvider><ListPresentationProvider value="page"><Page /></ListPresentationProvider></ModalProvider>, {
    // Test Renderer has no layout engine; this is the platform's measured anchor.
    createNodeMock: () => ({ offsetTop: 0, offsetHeight: 44, scrollTo() {}, getBoundingClientRect: () => new DOMRect(0, 0, 320, 44) }),
  });
  await act(async () => refreshSavedSecretCatalog(scope, { includeMaterial: false }));
  await measureMountedCollections(screen);
  return { screen, entry, scope };
}
const prefix = 'project-deployments.environment.variable.API_KEY';
function materialReads() {
  return home!.request.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/account/saved-secrets/resources/materials').length;
}

it.each([true, false])('opens disclosure without reading material, then confirms Reveal through the real Action (phone=%s)', async phone => {
  const { screen } = await mount(phone);
  expect(materialReads()).toBe(0);
  await screen.pressByTestIdAsync(`${prefix}.menu`);
  await vi.waitFor(() => expect(screen.findHostByTestId(`${prefix}.menu.reveal`)).not.toBeNull());
  await screen.pressByTestIdAsync(`${prefix}.menu.reveal`);
  await vi.waitFor(() => expect(screen.findHostByTestId(`${prefix}.value-reveal`)).not.toBeNull());
  expect(materialReads()).toBe(0);
  const { Modal } = await import('@/modal');
  vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
  await screen.pressByTestIdAsync(`${prefix}.value-reveal`);
  expect(materialReads()).toBe(0);
  vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
  await screen.pressByTestIdAsync(`${prefix}.value-reveal`);
  await vi.waitFor(() => expect(screen.findHostByTestId(`${prefix}.value-copy`)).not.toBeNull());
  expect(materialReads()).toBe(1);
  await screen.pressByTestIdAsync(`${prefix}.value.close`);
  expect(screen.findHostByTestId(`${prefix}.value-text`)).toBeNull();
});

it('links Rotate to the selected Saved secret without reading its value', async () => {
  const { screen, entry } = await mount();
  await screen.pressByTestIdAsync(`${prefix}.menu`);
  await vi.waitFor(() => expect(screen.findHostByTestId(`${prefix}.menu.rotate`)).not.toBeNull());
  await screen.pressByTestIdAsync(`${prefix}.menu.rotate`);
  await vi.waitFor(() => expect(routing.spies.push).toHaveBeenCalledWith({ pathname: SETTINGS_ROUTES.secrets, params: { secret: entry.ref } }));
  expect(materialReads()).toBe(0);
});

it.each(['access_removed', 'deleted'] as const)('keeps a withdrawn binding visible with its typed %s reason and recovery', async materialStatus => {
  const { screen, entry, scope } = await mount();
  await act(async () => applySavedSecretCatalogPage({ scope, entries: [{ ...entry, materialStatus }], observedAt: 2, includesMaterial: false }));
  await vi.waitFor(() => expect(screen.findByTestId(`${prefix}.unavailable`)).not.toBeNull());
  expect(screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === `${prefix}.unavailable`)?.props.diagnosticCode).toBe(materialStatus);
  await screen.pressByTestIdAsync(`${prefix}.unavailable.repair`);
  expect(routing.spies.push).toHaveBeenCalledWith({ pathname: SETTINGS_ROUTES.secrets, params: { secret: entry.ref } });
  expect(materialReads()).toBe(0);
});

it('takes the person to the Machine Services control owner and the existing API token grant editor', async () => {
  const { screen, scope } = await mount();
  await screen.pressByTestIdAsync('project-deployments.environment.variables.services');
  expect(routing.spies.push).toHaveBeenCalledWith(machinePageHref({ door: 'rail',
    target: { serverId: scope.serverId, machineId: 'machine-a' }, tab: { id: 'services' } }));
  await screen.pressByTestIdAsync('project-deployments.environment.variables.ci');
  expect(routing.spies.push).toHaveBeenCalledWith(SETTINGS_ROUTES.apiTokens);
  expect(materialReads()).toBe(0);
});

it('marks a secret whose saved revision the running release does not have yet, from one bindings read', async () => {
  const facts = { ok: true, environmentId: 'environment-staging', deploymentId: 'deployment-a', targetLinkId: 'target-a',
    machineId: 'machine-a', installationId: 'installation-a', references: [],
    secrets: [{ name: 'API_KEY', phase: 'runtime', status: 'redeploy_required', runningRevision: 2, currentRevision: 3 }] };
  const read = vi.fn(async (_bindings: readonly unknown[]) => facts);
  const { screen } = await mount(false, read);
  await vi.waitFor(() => expect(screen.findByTestId(`${prefix}.running`)).not.toBeNull());
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]![0]).toEqual([expect.objectContaining({ name: 'API_KEY', purpose: 'variable' })]);
  // A render that changes no bound source issues no second read.
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
});

it('shows nothing when the running release has no facts to compare', async () => {
  const read = vi.fn(async () => ({ ok: false, error: 'deployment_unavailable' }));
  const { screen } = await mount(false, read);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  expect(screen.findByTestId(`${prefix}.running`)).toBeNull();
});

it('points a new variable at another service export through the same draft and binding write', async () => {
  const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
  const { screen } = await mount(false, undefined, [{ environmentId: 'environment-data', export: 'database', service: 'db' }]);
  const menu = () => screen.findAllByType(DropdownMenu).find(node => node.props.popoverAccessibilityLabel !== undefined
    && node.props.items?.some((item: { id: string }) => item.id === 'reference'));
  expect(menu()).toBeDefined();
  await act(async () => menu()!.props.onSelect('reference'));
  await act(async () => screen.changeTextByTestId('project-deployments.environment.variables.add.name', 'database_url'));
  const target = screen.findAllByType(DropdownMenu).find(node => node.props.testID === 'project-deployments.environment.variables.add.reference')!;
  await act(async () => target.props.onSelect(JSON.stringify(['environment-data', 'database'])));
  await screen.pressByTestIdAsync('project-deployments.environment.variables.add.save');
  await vi.waitFor(() => expect(screen.findByTestId('project-deployments.environment.variable.DATABASE_URL')).not.toBeNull());
  expect(screen.findByTestId('project-deployments.environment.variables.save')).not.toBeNull();
});

it('offers no service pointer when there is no declared export to point at', async () => {
  const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
  const { screen } = await mount(false);
  expect(screen.findAllByType(DropdownMenu).some(node => node.props.items?.some((item: { id: string }) => item.id === 'reference'))).toBe(false);
});
