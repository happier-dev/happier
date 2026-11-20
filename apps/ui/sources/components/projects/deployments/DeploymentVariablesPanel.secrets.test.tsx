// @vitest-environment jsdom
import * as React from 'react';
import { createDeploymentReadControllerV1, type DeploymentReadTransportV1 } from '@happier-dev/deployments';
import type { EnvironmentSecretBindingV1 } from '@happier-dev/deployments/contracts/v1';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import { createDeploymentSecretVariableBindingV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture, createMachineMetadataFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { measureMountedCollections } from '@/dev/testkit/render/renderInCollectionLayout';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { resetSavedSecretCatalogEngineForTests, refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { applySavedSecretCatalogPage, resetSavedSecretCatalogSnapshotsForTests } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { resetTeamActionClientForTests } from '@/sync/ops/teams/teamActionClient';
import { settingsParse } from '@/sync/domains/settings/settings';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { t } from '@/text';
import type { VariableReferenceEnvironments } from './DeploymentVariablesPanel';
import type { EnvironmentBindingsCommit } from './useEnvironmentSecretBindingsDraft';

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

async function mount(phone = true, referenceTargets?: readonly unknown[],
  rotation?: Readonly<{ secretRevisions: readonly unknown[]; onDeploy?: () => void; bindingRevision?: number;
    additionalBindings?: readonly EnvironmentSecretBindingV1[] }>, referenceEnvironments?: VariableReferenceEnvironments,
  reference?: Readonly<{ readEnvironment: DeploymentReadTransportV1['readEnvironment']; setBindings: EnvironmentBindingsCommit }>) {
  home = await createSecretSettingsTestHarness({ settings: settingsParse({ secrets: [] }),
    handleRequest: async path => path === '/v1/account/saved-secrets/resources/activity'
      ? Response.json({ historyEntryId: 'disclosure-entry' }) : null });
  const { entry } = await home.addOwnerResource();
  const binding = createDeploymentSecretVariableBindingV1({ name: 'API_KEY', phase: 'runtime', resourceId: 'resource-a',
    resourceRevision: rotation?.bindingRevision ?? 3 });
  const base = createDeploymentEnvironmentDetailV1();
  const detail = { ...base, content: { ...base.content, bindings: [binding, ...(rotation?.additionalBindings ?? [])] } };
  const scope = home.scope;
  const controller = reference ? createDeploymentReadControllerV1({ scope, transport: {
    readEnvironment: reference.readEnvironment,
    listEnvironments: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
    listHistory: async () => ({ ok: true, value: { ok: true, items: [], nextCursor: null } }),
    readReceipt: async () => ({ ok: false, failure: { code: 'not_found', retryable: false } }),
  } }) : null;
  const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
  const { useEnvironmentSecretBindingsDraft } = await import('./useEnvironmentSecretBindingsDraft');
  const { DeploymentVariablesPanel } = await import('./DeploymentVariablesPanel');
  const { createDeploymentActions } = await import('./deploymentActions');
  const { ModalProvider } = await import('@/modal');
  const actions = createDeploymentActions(lifetime, detail.environment.projectSourceId);
  let readBindings: () => readonly EnvironmentSecretBindingV1[] = () => detail.content.bindings;
  function Page() {
    const draft = useEnvironmentSecretBindingsDraft({ environmentId: detail.environment.id, lifetime,
      snapshot: { status: 'ready', value: detail, failure: null }, setBindings: reference?.setBindings ?? actions.setBindings });
    readBindings = () => draft.editor.rows.map(row => row.binding);
    return <DeploymentVariablesPanel draft={draft} phone={phone} environmentName={() => null} sealedOn={null}
      review={{ pendingId: null, request() {}, open() {} }} environmentId={detail.environment.id} scope={scope} lifetime={lifetime}
      referenceTargets={referenceTargets as never}
      referenceEnvironments={referenceEnvironments}
      domainRead={controller ? { controller, demand: { mounted: true, visible: true, focused: true } } : undefined}
      secretRevisions={rotation?.secretRevisions as never} onDeploy={rotation?.onDeploy} />;
  }
  const screen = await renderScreen(<ModalProvider><ListPresentationProvider value="page"><Page /></ListPresentationProvider></ModalProvider>, {
    // Test Renderer has no layout engine; this is the platform's measured anchor.
    createNodeMock: element => element.type === 'div' ? document.createElement('div')
      : ({ offsetTop: 0, offsetHeight: 44, scrollTo() {}, getBoundingClientRect: () => new DOMRect(0, 0, 320, 44) }),
  });
  await act(async () => refreshSavedSecretCatalog(scope, { includeMaterial: false }));
  await measureMountedCollections(screen);
  return { screen, entry, scope, readBindings: () => readBindings(), controller, environmentId: detail.environment.id };
}
const prefix = 'project-deployments.environment.variable.API_KEY';

it('authors a deployment fact in the shared Variables draft without reading secret material', async () => {
  const { screen, readBindings } = await mount();
  await screen.pressByTestIdAsync('project-deployments.environment.variables.add');
  await vi.waitFor(() => expect(screen.findHostByTestId('project-deployments.environment.variables.add.fact')).not.toBeNull());
  const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
  const menu = screen.findAllByType(DropdownMenu).find(node => node.props.items?.some((item: { id: string }) => item.id === 'fact'))!;
  await act(async () => menu.props.onSelect('fact'));
  await act(async () => screen.changeTextByTestId('project-deployments.environment.variables.add.name', 'PREVIEW_URL'));
  await screen.pressByTestIdAsync('project-deployments.environment.variables.add.save');
  await measureMountedCollections(screen);
  expect(screen.findByTestId('project-deployments.environment.variable.PREVIEW_URL')).not.toBeNull();
  expect(readBindings()).toContainEqual({ purpose: 'variable', name: 'PREVIEW_URL', phase: 'runtime',
    source: { kind: 'deploymentFact', fact: 'primaryUrl' }, grantRef: expect.any(String) });
  expect(materialReads()).toBe(0);
  await screen.unmount();
});
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

it('keeps the Variables page to variables: no Machine services or API token rows under the table', async () => {
  const { screen } = await mount();
  expect(screen.findByTestId('project-deployments.environment.variables.services')).toBeNull();
  expect(screen.findByTestId('project-deployments.environment.variables.ci')).toBeNull();
});

it('points a new variable at another service export through the same draft and binding write', async () => {
  const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
  const { screen } = await mount(false, [{ environmentId: 'environment-data', export: 'database', service: 'db' }]);
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

it('asks for the Environment first, this one leading, when the Project has others to point into (R7-D1)', async () => {
  const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
  const base = createDeploymentEnvironmentDetailV1();
  const { screen } = await mount(false, [], undefined,
    new Map([['environment-data', { name: 'Data', machineIds: [] }],
      [base.environment.id, { name: 'Production', machineIds: [] }]]));
  const menu = () => screen.findAllByType(DropdownMenu).find(node => node.props.popoverAccessibilityLabel !== undefined
    && node.props.items?.some((item: { id: string }) => item.id === 'reference'));
  // Another Environment can share a service, so the pointer is offered although this one shares none.
  expect(menu()).toBeDefined();
  await act(async () => menu()!.props.onSelect('reference'));
  const environments = screen.findAllByType(DropdownMenu)
    .find(node => node.props.testID === 'project-deployments.environment.variables.add.referenceEnvironment')!;
  expect(environments.props.items.map((item: { id: string }) => item.id)).toEqual([base.environment.id, 'environment-data']);
  // This Environment shares nothing: the step says where to share one instead of an empty menu.
  expect(screen.findByTestId('project-deployments.environment.variables.add.referenceNone')).not.toBeNull();
});

it('opens Variables with no private reads and resolves only the other Environment the person chooses', async () => {
  const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
  const base = createDeploymentEnvironmentDetailV1();
  const database = { key: 'database', service: 'db', containerPort: 5432,
    scheme: 'postgres', exposure: 'loopback' as const, transport: { kind: 'iroh' as const } };
  const readEnvironment = vi.fn<DeploymentReadTransportV1['readEnvironment']>(async (scope, environmentId) => ({
    ok: true, value: {
      ...base, environment: { ...base.environment, serverId: scope.serverId, id: environmentId }, targetLinks: [],
      content: { ...base.content, ownServer: { rollout: 'recreate', autoRestorePreviousRelease: false,
        serviceExports: [
          { key: 'unshared', service: 'redis', containerPort: 6379, scheme: 'redis', exposure: 'loopback' },
          ...(environmentId === 'environment-data' ? [database] : []),
        ] } },
    },
  }));
  // The write transport acknowledges one revision. The real form and the draft owner construct its patch.
  const setBindings = vi.fn<EnvironmentBindingsCommit>(async input => ({
    ok: true, environmentId: input.environmentId, revision: input.expectedRevision + 1,
  }));
  const { screen, readBindings, controller, environmentId, scope } = await mount(false, [], undefined, new Map([
    ['environment-data', { name: 'Data', machineIds: ['data-machine'] }],
    ['environment-empty', { name: 'Empty', machineIds: [] }],
    [base.environment.id, { name: 'Current app', machineIds: [] }],
  ]), { readEnvironment, setBindings });
  await act(() => publishMachineInventoryForTest(scope, [createMachineFixture({ id: 'data-machine',
    metadata: createMachineMetadataFixture({ displayName: 'Database host' }),
  })]));
  const prefix = 'project-deployments.environment.variables.add';
  const choice = (suffix: string) => screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${prefix}.${suffix}`);
  const open = async () => {
    const menu = screen.findAllByType(DropdownMenu).find(node => node.props.items?.some((item: { id: string }) => item.id === 'reference'));
    expect(menu).toBeDefined();
    await act(async () => menu?.props.onSelect('reference'));
  };
  try {
    expect(readEnvironment).not.toHaveBeenCalled();
    await open();
    expect(readEnvironment).not.toHaveBeenCalled();
    expect(choice('referenceEnvironment')?.props.selectedId).toBe(environmentId);
    expect(choice('referenceEnvironment')?.props.items.map((item: { id: string }) => item.id))
      .toEqual([environmentId, 'environment-data', 'environment-empty']);

    await act(async () => choice('referenceEnvironment')?.props.onSelect('environment-empty'));
    await vi.waitFor(() => {
      expect(screen.findByTestId(`${prefix}.referenceLoading`)).toBeNull();
      expect(choice('reference')?.props.items ?? []).toEqual([]);
      expect(screen.findByTestId(`${prefix}.referenceNone`)).not.toBeNull();
    });
    expect(readEnvironment.mock.calls.map(([, id]) => id)).toEqual(['environment-empty']);

    expect(choice('referenceEnvironment')?.props.items).toContainEqual(expect.objectContaining({
      id: 'environment-data', title: 'Data', subtitle: 'Database host',
    }));
    await act(async () => choice('referenceEnvironment')?.props.onSelect('environment-data'));
    await vi.waitFor(() => expect(choice('reference')?.props.items.map((item: { id: string }) => item.id)).toEqual([JSON.stringify(['environment-data', 'database'])]));
    expect(readEnvironment.mock.calls.map(([, id]) => id)).toEqual(['environment-empty', 'environment-data']);
    expect(choice('reference')?.props.items[0].subtitle).toBe(t('projects.deployments.settingsSections.privateSharingHappierNetwork'));
    await act(async () => choice('reference')?.props.onSelect(JSON.stringify(['environment-data', 'database'])));
    await act(async () => screen.changeTextByTestId(`${prefix}.name`, 'database_url'));
    await screen.pressByTestIdAsync(`${prefix}.save`);
    const binding = {
      purpose: 'variable', name: 'DATABASE_URL', phase: 'runtime',
      source: { kind: 'reference', environmentId: 'environment-data', export: 'database', via: 'auto' },
    };
    expect(readBindings()).toContainEqual(expect.objectContaining(binding));
    expect(choice('reference')).toBeUndefined();
    await screen.pressByTestIdAsync('project-deployments.environment.variables.save');
    await vi.waitFor(() => expect(setBindings.mock.calls.map(([write]) => ({ environmentId: write.environmentId, set: write.set })))
      .toEqual([{ environmentId, set: [expect.objectContaining(binding)] }]));
    await open();
    expect(choice('referenceEnvironment')?.props.selectedId).toBe(environmentId);
    expect(readEnvironment.mock.calls.map(([, id]) => id)).toEqual(['environment-empty', 'environment-data']);
  } finally {
    await screen.unmount();
    controller?.retire();
  }
});

it('offers no service pointer when there is no declared export to point at', async () => {
  const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
  const { screen } = await mount(false);
  expect(screen.findAllByType(DropdownMenu).some(node => node.props.items?.some((item: { id: string }) => item.id === 'reference'))).toBe(false);
});

function rotatedFact(currentRevision: number) {
  return [{ machineId: 'machine-a', installationId: 'installation-a', facts: [{ name: 'API_KEY', phase: 'runtime',
    ref: formatSharedSavedSecretRefV1('resource-a'), runningRevision: 3, currentRevision, status: 'redeploy_required' }] }];
}

it('names a rotated secret from the controller facts and re-binds the newest revision in the draft before Save', async () => {
  const onDeploy = vi.fn();
  const { screen } = await mount(false, undefined, { secretRevisions: rotatedFact(4), onDeploy });
  expect(screen.findByTestId(`${prefix}.rotated`)).not.toBeNull();
  // Bound to revision 3 while 4 is saved: the primary control re-binds first; Deploy is not offered yet.
  await screen.pressByTestIdAsync('project-deployments.environment.variables.rotated.action');
  await vi.waitFor(() => expect(screen.findByTestId('project-deployments.environment.variables.save')).not.toBeNull());
  expect(onDeploy).not.toHaveBeenCalled();
});

it('updates every stale variable sharing a saved secret in one revision edit', async () => {
  const second = createDeploymentSecretVariableBindingV1({ name: 'SECOND_KEY', phase: 'runtime',
    resourceId: 'resource-a', resourceRevision: 3 });
  const revisions = rotatedFact(4).map(row => ({ ...row,
    facts: [...row.facts, { ...row.facts[0]!, name: 'SECOND_KEY' }] }));
  const { screen, readBindings } = await mount(false, undefined, {
    secretRevisions: revisions, additionalBindings: [second],
  });
  await screen.pressByTestIdAsync('project-deployments.environment.variables.rotated.action');
  expect(readBindings().map(binding => binding.source)).toEqual([
    { kind: 'secret', ref: formatSharedSavedSecretRefV1('resource-a'), resourceRevision: 4 },
    { kind: 'secret', ref: formatSharedSavedSecretRefV1('resource-a'), resourceRevision: 4 },
  ]);
  expect(materialReads()).toBe(0);
});

it('offers Deploy once the binding already names the newest revision', async () => {
  const onDeploy = vi.fn();
  const { screen } = await mount(false, undefined, { secretRevisions: rotatedFact(4), onDeploy, bindingRevision: 4 });
  expect(screen.findByTestId(`${prefix}.rotated`)).not.toBeNull();
  await screen.pressByTestIdAsync('project-deployments.environment.variables.rotated.action');
  expect(onDeploy).toHaveBeenCalledTimes(1);
});

it('stays quiet when every running revision is current', async () => {
  const unchanged = [{ machineId: 'machine-a', installationId: 'installation-a', facts: [{ name: 'API_KEY', phase: 'runtime',
    ref: formatSharedSavedSecretRefV1('resource-a'), runningRevision: 3, currentRevision: 3, status: 'unchanged' }] }];
  const { screen } = await mount(false, undefined, { secretRevisions: unchanged });
  expect(screen.findByTestId(`${prefix}.rotated`)).toBeNull();
  expect(screen.findByTestId('project-deployments.environment.variables.rotated')).toBeNull();
});
