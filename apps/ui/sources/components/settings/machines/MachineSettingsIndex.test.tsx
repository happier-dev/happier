import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, findAllHostTestInstances, flushHookEffects, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installMachinesSettingsCommonModuleMocks } from './machinesSettingsTestHelpers';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import { MachinePublishedResourceSummaryV1Schema } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { MachineReadBatchRequestV1Schema } from '@happier-dev/protocol/machines/machineReadBatchV1';
import type { WidgetAreaPresetV1 } from '@happier-dev/protocol/widgets';
import { recordMachineCollectionVisit } from './collection/machineCollectionVisit';
import {
  captureMachinePresenceObservation,
  clearMachineRequestReachabilityForTest,
  recordMachineRequestFailed,
  recordMachineRequestSucceeded,
  resolveMachineReachability,
  withdrawMachinePresenceForScope,
} from '@/sync/domains/machines/reachability/machineReachability';

(
  globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  }
).IS_REACT_ACT_ENVIRONMENT = true;

type Group = {
  serverId: string;
  serverName: string;
  status: 'idle' | 'loading' | 'signedOut' | 'error';
  machines: Array<ReturnType<typeof createMachineFixture>>;
};

const routerPushSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const desktopState = vi.hoisted(() => ({ value: false }));
const routeState = vi.hoisted(() => ({ pathname: '/settings/machines' }));
type InventorySeed = {
    managedByServerId?: Readonly<Record<string, readonly ManagedMachineV1[]>>;
    managedInventory?: {
      entries: Record<
        string,
        { status: 'error' | 'denied'; errorCode: string }
      >;
    };
};
const poolFeatureState = vi.hoisted(() => ({
  value: 'disabled' as 'disabled' | 'enabled',
}));
const relayDriftState = vi.hoisted(() => ({
  value: null as null | { title: string; description: string },
}));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);

installMachinesSettingsCommonModuleMocks({
  reactNative: async () => {
    const { createReactNativeWebMock } =
      await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
      View: 'View',
      Pressable: 'Pressable',
      Platform: {
        OS: 'web',
        select: (options: Record<string, unknown>) =>
          options?.web ?? options?.default,
      },
    });
  },
  router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
      router: { push: routerPushSpy, replace: routerReplaceSpy },
      pathname: () => routeState.pathname,
      params: () => routeState.pathname.endsWith('/machine-a1') ? { serverId: 'srv_a' } : {},
    }).module;
  },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/platform/desktopHost')>()),
  isDesktopHost: () => desktopState.value,
}));
vi.mock('@/components/ui/icons/Icon', () => ({
  Icon: 'Icon',
  ICON_SIZE: { xs: 12 },
}));
// The page's physical scroller is a boundary here. Like the real ItemList it supplies the page's scroll
// tracker; its viewport holds the whole page unless a test narrows it.
const pageViewport = vi.hoisted(() => ({ current: { top: 0, bottom: 1_000_000 } }));
vi.mock('@/components/ui/lists/ItemList', async () => {
  const { PluginUiScrollActivityProvider } = await import('@happier-dev/plugin-ui/advanced');
  const tracker = {
    onScroll() {}, onLayout() {}, onContentSizeChange() {}, invalidateLayout() {},
    getLayoutRevision: () => 0, subscribe: () => () => {},
    getWindow: () => pageViewport.current,
    measureSpan: async () => ({ top: 0 }),
    scrollToOffset() {},
  };
  return {
    ItemList: ({ children }: { children?: React.ReactNode }) =>
      React.createElement(PluginUiScrollActivityProvider, { tracker }, React.createElement('ItemList', null, children)),
  };
});
vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: ({
    children,
    title,
    description,
    action,
  }: {
    children?: React.ReactNode;
    title?: React.ReactNode;
    description?: React.ReactNode;
    action?: React.ReactNode;
  }) => React.createElement('Group', { title, description }, action, children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
  // The native row's subtitle contains the real summary reader and live demand.
  Item: (props: Record<string, unknown> & { subtitle?: React.ReactNode }) =>
    React.createElement('Item', props, props.subtitle),
}));
vi.mock('@/components/ui/forms/SelectionTiles', () => ({
  SelectionTiles: (props: Record<string, unknown>) =>
    React.createElement('SelectionTiles', props),
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
  DropdownMenu: (props: Record<string, unknown>) =>
    React.createElement('DropdownMenu', props),
}));
vi.mock('@/components/settings/shell/SettingsPageHeader', () => ({
  SettingsPageHeader: (props: { actions?: React.ReactNode }) =>
    React.createElement('SettingsPageHeader', props, props.actions),
}));
// Detected-CLI glyphs read the machine's capabilities over RPC; this screen only places them.
vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
  MachineCliGlyphs: () => null,
}));
// Metro's lazy module loader is the boundary; the real Action executor runs beneath it.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
  const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
  const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
  return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
vi.mock('@/components/settings/server/useRelayDriftBanner', () => ({
  useRelayDriftBanner: () => relayDriftState.value,
}));
vi.mock('@/components/settings/server/RelayDriftActionCard', () => ({
  RelayDriftActionCard: (props: Record<string, unknown>) =>
    React.createElement('RelayDriftActionCard', props),
}));
vi.mock('@/components/ui/lists/AttentionBanner', () => ({
  AttentionBanner: (props: Record<string, unknown>) =>
    React.createElement('AttentionBanner', props),
}));

// Keep cold module collection outside an individual behavior test's runtime budget.
const { AllMachinesIndex: MachinesSettingsView } =
  await import('@/components/machines/index/AllMachinesIndex');
const { MachinesRelayDriftBanner } = await import('./MachinesRelayDriftBanner');
const { storage } = await import('@/sync/domains/state/storage');
const { readMachineActivity } = await import('@/sync/domains/machines/machineActivity');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } =
  await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
const homeProfiles = new Map<string, string>();
let selectedGroups: Group[] = [];

function machine(id: string, displayName: string, host: string) {
  // `activeAt: 0` leaves presence to `active`, so a slow run cannot age the machine offline.
  return createMachineFixture({
    id,
    installationId: `${id}-installation`,
    active: true,
    activeAt: 0,
    metadata: { ...createMachineFixture().metadata!, displayName, host, platform: 'darwin' },
  });
}

async function setMachines(
  groups: Group[],
  overrides: InventorySeed = {},
) {
  await home.reset();
  resetScopedHomeActionExecutorsForTests();
  homeProfiles.clear();
  selectedGroups = groups;
  for (const [index, group] of groups.entries()) {
    const profileId = await home.addHome({ name: group.serverName, serverUrl: `https://${group.serverId}.example`,
      serverIdentityId: group.serverId, accountId: group.status === 'signedOut' ? null : 'account-a', active: index === 0 });
    homeProfiles.set(group.serverId, profileId);
    const error = overrides.managedInventory?.entries[group.serverId];
    home.answer(profileId, 'POST /v1/machines/managed/actions/list', error
      ? { status: 500, body: { code: error.errorCode } }
      : { body: { machines: (overrides.managedByServerId?.[group.serverId] ?? []).map(row => ({ ...row, homeId: group.serverId })) } });
    home.answer(profileId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] } });
    home.answer(profileId, '/v1/machines/pools/list', { body: { pools: [] } });
  }
  storage.setState({ machines: {}, machineDisplayById: {}, machinePresenceById: {}, machinePresenceByServerId: {},
    machineRecordsByServerId: {}, machineListByServerId: {}, machineListStatusByServerId: {} });
  // Real ingress publishes the same admitted Machine to active and Home-scoped
  // inventories, linking their live clock without mutating either content row.
  for (const group of groups) {
    storage.getState().applyMachines(group.machines.map(row => createMachineFixture(row)), true,
      { sourceServerId: group.serverId });
  }
  storage.setState({ machineListStatusByServerId: Object.fromEntries(groups.map(group => [group.serverId, group.status])) });
  await updateEffectiveHomeViewState(() => ({ version: 1,
    groups: [{ id: 'test-fleet', name: 'Fleet', serverIds: groups.map(group => group.serverId), presentation: 'grouped' }],
    activeTargetKind: 'group', activeTargetId: 'test-fleet' }), { scope: 'device' });
}

async function primeFeatures() {
  for (const [serverId, profileId] of homeProfiles) {
    const features = createRootLayoutFeaturesResponse({ capabilities: { serverIdentity: { serverIdentityId: serverId } } });
    const { tryWriteServerEnabledBitInPlace } = await import('@happier-dev/protocol/features/serverEnabledBit');
    expect(tryWriteServerEnabledBitInPlace(features, 'machines.pools', poolFeatureState.value === 'enabled')).toBe(true);
    home.answer(profileId, '/v1/features', { body: features });
    home.answer(profileId, '/v1/features/authenticated', { body: features });
    // Prime through the existing feature owner, as addHome does when a Home is discovered.
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
  }
}

async function renderPage() {
  await primeFeatures();
  const screen = await renderScreen(React.createElement(MachinesSettingsView));
  await waitForHomeGovernance(() => {
    for (const group of selectedGroups.filter(group => group.status !== 'signedOut')) {
      expect(home.requests.some(request => request.path === '/v1/machines/presets/list'
        && request.serverUrl === `https://${group.serverId}.example`)).toBe(true);
    }
  });
  await flushHookEffects();
  return screen.tree;
}

afterEach(async () => {
  standardCleanup();
  // Retire real Home/Account lifetimes before the global fixture erases storage.
  await home.reset();
  clearMachineRequestReachabilityForTest();
  routeState.pathname = '/settings/machines';
});

it.each(['index', 'rail'] as const)('holds the first managed answer, then keeps ready rows in a 185-Machine %s while another name is pending', async surface => {
  const fleet = Array.from({ length: 185 }, (_, index) => ({
    ...machine(`progressive-${index}`, `Studio ${index}`, `studio-${index}.local`), active: index % 2 === 0,
  }));
  fleet[184] = { ...fleet[184]!, active: false, metadata: null, availability: undefined };
  await setMachines([{ serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: fleet }]);
  await primeFeatures();
  const managed = createDeferred<void>();
  home.answer(homeProfiles.get('srv_a')!, 'POST /v1/machines/managed/actions/list', {
    body: { machines: [] }, respondAfter: managed.promise,
  });
  const { MachinesColumn } = await import('@/components/machines/collection/MachinesColumn');
  const screen = await renderScreen(surface === 'index' ? <MachinesSettingsView /> : <MachinesColumn />);
  try {
    await flushHookEffects();
    const rowId = surface === 'index' ? 'machines.index.row.machine:srv_a:progressive-0'
      : 'settings.machines.row.srv_a.progressive-0';
    const row = () => screen.tree.findAll(node => node.props.testID === rowId && typeof node.props.onPress === 'function')[0];
    // R8-4b: the initial enrolled roster cannot decide its ownership groups yet.
    expect(row()).toBeUndefined();
    await act(async () => managed.resolve());
    await waitForHomeGovernance(() => expect(row()).toBeDefined());
    // Synced roster facts contain no live samples. The online fleet admits one
    // shared summary batch (e48c310359); pending names add no hydration read.
    const summaryReads = () => home.requests.filter(request => request.path === '/v1/machines/read-batch');
    await waitForHomeGovernance(() => expect(summaryReads()).toHaveLength(1));
    expect(MachineReadBatchRequestV1Schema.parse(summaryReads()[0]!.input).machineIds.sort())
      .toEqual(fleet.filter(machine => machine.active).map(machine => machine.id).sort());
    await act(async () => storage.getState().applyMachines([{ ...fleet[0]!, metadataVersion: 2,
      metadata: { ...fleet[0]!.metadata!, displayName: 'Renamed studio' } }], false, { sourceServerId: 'srv_a' }));
    expect(row()?.props.accessibilityLabel).toContain('Renamed studio');
    expect(summaryReads()).toHaveLength(1);
  } finally {
    managed.resolve();
    await screen.unmount();
  }
});

it.each(['index', 'rail'] as const)('refreshes a retained offline %s roster row when a heartbeat restores canonical reachability', async (surface) => {
  const now = Date.now();
  const scope = { serverId: 'srv_a', accountId: 'account-a' };
  const retained = { ...machine('studio', 'Studio', 'studio.local'), activeAt: now - 80_000 };
  await setMachines([{ serverId: scope.serverId, serverName: 'Home A', status: 'idle', machines: [retained] }]);
  storage.getState().applyMachines([retained], false, { sourceServerId: scope.serverId });
  recordMachineRequestSucceeded({ ...scope, machineId: retained.id, observedAtMs: now - 2_101 });
  const { MachinesColumn } = await import('@/components/machines/collection/MachinesColumn');
  const tree = surface === 'index' ? await renderPage() : (await renderScreen(<MachinesColumn />)).tree;
  const testID = surface === 'index' ? 'machines.index.row.machine:srv_a:studio' : 'settings.machines.row.srv_a.studio';
  const row = () => tree.findAll(node => node.props.testID === testID
    && typeof node.props.onPress === 'function')[0]!;
  expect(row().props.accessibilityLabel).toContain('settingsOverview.machineOffline');
  const before = storage.getState().machineListByServerId[scope.serverId];

  await act(async () => {
    storage.getState().applyMachineActivityUpdates([{ id: retained.id, active: true, activeAt: now - 20_286 }], { sourceServerId: scope.serverId });
  });
  // Heartbeats advance the live activity owner, leaving its admitted inventory
  // content immutable. The mounted row consumes that clock in place.
  expect(before?.[0]?.activeAt).toBe(now - 80_000);
  expect(storage.getState().machineListByServerId[scope.serverId]).toBe(before);
  expect(readMachineActivity(storage.getState().machineListByServerId[scope.serverId]![0]!).activeAt).toBe(now - 20_286);
  expect(resolveMachineReachability(scope, storage.getState().machines.studio!)).toBe('reachable');
  expect(row().props.accessibilityLabel).toContain('settingsOverview.machineOnline');
  await act(async () => { recordMachineRequestFailed({ ...scope, machineId: retained.id }); });
  expect(row().props.accessibilityLabel).toContain('settingsOverview.machineUnreachableFromHome');
  await act(async () => { recordMachineRequestSucceeded({ ...scope, machineId: retained.id }); });
  expect(row().props.accessibilityLabel).toContain('settingsOverview.machineOnline');
  await act(async () => { withdrawMachinePresenceForScope(scope); });
  // Socket withdrawal supplies no new Machine fact; the last admitted answer remains.
  expect(row().props.accessibilityLabel).toContain('settingsOverview.machineOnline');
  await act(async () => { captureMachinePresenceObservation(scope)([retained.id]); });
  expect(row().props.accessibilityLabel).toContain('settingsOverview.machineOnline');
});

it('opens fleet Updates and Activity inside the Machines door from its column, so a reload stays there', async () => {
  routeState.pathname = '/machines';
  await setMachines([{ serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [machine('studio', 'Studio', 'studio.local')] }]);
  const { MachinesColumn } = await import('@/components/machines/collection/MachinesColumn');
  const { tree } = await renderScreen(<MachinesColumn />);
  const press = async (testID: string) => {
    const row = tree.findAll(node => node.props.testID === testID && typeof node.props.onPress === 'function')[0]!;
    await act(async () => { await pressTestInstanceAsync(row); });
  };
  const opened = () => [...routerPushSpy.mock.calls, ...routerReplaceSpy.mock.calls].map(call => call[0]);
  await press('settings.machines.updates');
  await press('settings.machines.activity');
  expect(opened()).toEqual(expect.arrayContaining(['/machines/updates', '/machines/activity']));
  expect(opened().some(href => typeof href === 'string' && href.startsWith('/settings/'))).toBe(false);
});

it('gives a phone index row no title meta while the machine has nothing to say there (offline), and its work when online', async () => {
  const ReactNative = await import('react-native');
  // The window is the boundary that makes this a phone.
  const dimensions = vi.spyOn(ReactNative.Dimensions, 'get').mockReturnValue({ width: 390, height: 844, scale: 3, fontScale: 1 });
  try {
    await setMachines([{ serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [
      machine('live', 'Live', 'live.local'),
      { ...machine('idle', 'Idle', 'idle.local'), active: false },
    ] }]);
    const tree = await renderPage();
    const row = (id: string) => tree.findAll(node => node.props.testID === `machines.index.row.machine:srv_a:${id}`);
    await waitForHomeGovernance(() => expect(row('idle').length).toBeGreaterThan(0));
    // The work cell is the phone row's title meta (the bundler may suffix the function's name).
    const titleMeta = (id: string) => tree.findAll(node => typeof node.type === 'function'
      && /^MachineWorkCell\d*$/u.test(node.type.name) && node.props.item?.key === `machine:srv_a:${id}`);
    expect(titleMeta('live').length).toBeGreaterThan(0);
    expect(titleMeta('idle')).toHaveLength(0);
  } finally {
    dimensions.mockRestore();
  }
});

it('keeps Collection row owners quiet across unchanged Machine publications and updates the changed row', async () => {
  const alpha = machine('a', 'Alpha', 'alpha.local');
  alpha.keyBasis = { dataEncryptionKey: alpha.dataEncryptionKey ?? null,
    metadataVersion: alpha.metadataVersion, daemonStateVersion: alpha.daemonStateVersion };
  await setMachines([{ serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [
    alpha, machine('b', 'Beta', 'beta.local'),
  ] }]);
  const tree = await renderPage();
  const owners = tree.root.findAll(node => typeof node.type === 'function' && node.type.name === 'VirtualizedListRow');
  expect(owners.length).toBeGreaterThanOrEqual(2);
  const rowType = owners[0]!.type as React.ComponentClass<{ itemKey: string }>;
  const renders: string[] = [];
  const original = rowType.prototype.render;
  // Call-through instrumentation at the real List row boundary; no domain logic is replaced.
  const spy = vi.spyOn(rowType.prototype, 'render').mockImplementation(function (this: React.Component<{ itemKey: string }>) {
    renders.push(this.props.itemKey);
    return original.call(this);
  });
  try {
    const serverId = getActiveServerSnapshot().serverId;
    let current = storage.getState().machines.a!;
    for (let tick = 1; tick <= 5; tick++) {
      current = { ...current, seq: current.seq + 1, daemonStateVersion: current.daemonStateVersion + 1,
        activeAt: Date.now(), updatedAt: Date.now(), keyBasis: { dataEncryptionKey: current.dataEncryptionKey ?? null,
          metadataVersion: current.metadataVersion, daemonStateVersion: current.daemonStateVersion + 1 } };
      await act(async () => storage.getState().applyMachines([current], false, { sourceServerId: serverId }));
      await flushHookEffects();
    }
    expect(renders.filter(key => key.startsWith('machine:'))).toEqual([]);
    await act(async () => storage.getState().applyMachines([{ ...current, metadataVersion: current.metadataVersion + 1,
      metadata: { ...current.metadata!, displayName: 'Alpha renamed' } }], false, { sourceServerId: serverId }));
    await flushHookEffects();
    expect(renders).toContain('machine:srv_a:a');
    expect(renders).not.toContain('machine:srv_a:b');
  } finally { spy.mockRestore(); }
});

it.each(['index', 'rail'] as const)('retains mounted %s rows across presentation changes and computes nothing for Session churn while hidden', async surface => {
  await setMachines([{ serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [
    machine('a', 'Alpha', 'alpha.local'), machine('b', 'Beta', 'beta.local'),
  ] }]);
  await primeFeatures();
  const { MachinesColumn } = await import('@/components/machines/collection/MachinesColumn');
  const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
  const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
  let commits = 0;
  // One stable content element, as a retained tab keeps its body: only the presentation fact changes.
  const content = <React.Profiler id="machines" onRender={() => { commits += 1; }}>
    {surface === 'index' ? <MachinesSettingsView /> : <MachinesColumn />}
  </React.Profiler>;
  const surfaceAt = (presented: boolean) => <PluginSurfaceFocusEligibilityProvider active={presented} presentationActive={presented}>{content}</PluginSurfaceFocusEligibilityProvider>;
  const screen = await renderScreen(surfaceAt(true));
  await waitForHomeGovernance(() => expect(surface === 'index' ? screen.getTextContent().includes('Beta')
    : screen.findAll(node => node.props?.title === 'Beta').length > 0).toBe(true));
  await flushHookEffects();
  const rows = () => ['a', 'b'].map(id => screen.findAll(node => typeof node.type === 'string'
    && node.props.testID === (surface === 'index' ? `machines.index.row.machine:srv_a:${id}` : `settings.machines.row.srv_a.${id}`)
    && typeof node.props.onPress === 'function')[0]);
  const retainedRows = rows();
  for (const row of retainedRows) expect(row).toBeDefined();
  await screen.update(surfaceAt(false));
  await flushHookEffects();
  await screen.update(surfaceAt(true));
  await flushHookEffects();
  // Presentation changes release and restore subscriptions (9cf24cafcc), while
  // retained row instances preserve focus and local state.
  for (const [index, row] of rows().entries()) expect(row).toBe(retainedRows[index]);
  await screen.update(surfaceAt(false));
  await flushHookEffects();
  const hiddenCommits = commits;
  const serverId = getActiveServerSnapshot().serverId;
  for (let index = 0; index < 4; index++) {
    await act(async () => storage.getState().applySessions([createSessionFixture({ id: `churn-${index}`, serverId,
      active: true, presence: 'online', thinking: true, thinkingAt: Date.now(), seq: 2, lastViewedSessionSeq: 2,
      metadata: { ...createSessionFixture().metadata!, machineId: 'a' } })]));
    await flushHookEffects();
  }
  expect(commits - hiddenCommits).toBe(0);
});

function addMenuItemIds(
  tree: Awaited<ReturnType<typeof renderPage>>,
): string[] {
  const menu = tree.findByType('DropdownMenu' as never) as unknown as {
    props: { items: Array<{ id: string }> };
  };
  return menu.props.items.map((item) => item.id);
}

describe('All machines (the Settings door index)', () => {
  beforeEach(async () => {
    routerPushSpy.mockClear();
    routerReplaceSpy.mockClear();
    desktopState.value = false;
    poolFeatureState.value = 'disabled';
    relayDriftState.value = null;
    recordMachineCollectionVisit({
      machineId: 'machine-a1',
      serverId: 'srv_a',
      query: '',
    });
    await setMachines([
      {
        serverId: 'srv_a',
        serverName: 'Home A',
        status: 'idle',
        machines: [machine('machine-a1', 'Machine A1', 'a.local')],
      },
    ]);
  });

  it('lists the machines and opens a machine in the collection, scoped to its Home', async () => {
    const tree = await renderPage();

    expect(home.requests.some(request => request.path === '/v1/machines/managed/actions/list')).toBe(true);

    const row = tree.findAll(
      (node) =>
        node.props?.testID === 'machines.index.row.machine:srv_a:machine-a1' &&
        typeof node.props?.onPress === 'function',
    )[0]!;
    expect(row.props.accessibilityLabel).toContain('Machine A1');
    await act(async () => {
      await pressTestInstanceAsync(row);
    });
    expect(routerPushSpy).toHaveBeenCalledWith(
      '/settings/machines/machine-a1?serverId=srv_a',
    );
    // No desktop-only row on the web.
    expect(
      tree.findAll(
        (node) => node.props?.testID === 'settings.machines.thisComputer',
      ),
    ).toHaveLength(0);
  });

  it('counts a Machine\'s services after its work and says how many fail, from its published summary (lab mIdx)', async () => {
    const withServices = (id: string, name: string, managedServices?: object) => ({
      ...machine(id, name, `${id}.local`),
      daemonState: { status: 'running', ...(managedServices ? { managedServices } : {}) },
    });
    await setMachines([{ serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [
      withServices('hetzner', 'hetzner-fsn1', { running: 9, failing: 0 }),
      withServices('vps', 'vps-ams', { running: 2, failing: 1 }),
      withServices('quiet', 'quiet-box'),
    ] }]);
    const tree = await renderPage();
    await act(async () => {
      const stage = tree.findAll(node => node.props?.testID === 'machines.index.collection:stage' && typeof node.props?.onLayout === 'function')[0]!;
      stage.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 900 } } });
    });
    const text = (node: { children: unknown[] } | undefined): string => !node ? '' : node.children
      .map(child => typeof child === 'string' ? child : text(child as { children: unknown[] })).join('');
    const work = (id: string) => text(tree.findAll(node => typeof node.type === 'string'
      && node.props?.testID === `machines.index.work.machine:srv_a:${id}`)[0]);
    const { t } = await import('@/text');
    expect(work('hetzner')).toContain(t('machineDetailPage.work.services', { count: 9 }));
    expect(work('hetzner')).not.toContain(t('machineDetailPage.work.failing', { count: 0 }));
    // Total observed services, then the failing ones.
    expect(work('vps')).toContain(t('machineDetailPage.work.services', { count: 3 }));
    expect(work('vps')).toContain(t('machineDetailPage.work.failing', { count: 1 }));
    // Not reported: no services part at all, never "0 services".
    expect(work('quiet')).not.toContain(t('machineDetailPage.work.services', { count: 0 }));
  });

  it('says a Machine\'s waiting security updates, or that it needs a restart, on the Work cell\'s second line (lab mIdx)', async () => {
    const withUpdates = (id: string, name: string, updates: object) => ({
      ...machine(id, name, `${id}.local`),
      daemonState: { status: 'running', setup: { version: 1, desiredRevision: 0, status: 'drifted', recipes: [], updates } },
    });
    await setMachines([{ serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [
      withUpdates('hetzner', 'hetzner-fsn1', { status: 'drifted', backend: 'apt', pendingSecurity: 3, pendingAll: 7, rebootNeeded: false }),
      withUpdates('vps', 'vps-ams', { status: 'drifted', backend: 'apt', pendingSecurity: 0, pendingAll: 2, rebootNeeded: true }),
      withUpdates('calm', 'calm-box', { status: 'satisfied', backend: 'apt', pendingSecurity: 0, pendingAll: 0 }),
    ] }]);
    const tree = await renderPage();
    await act(async () => {
      const stage = tree.findAll(node => node.props?.testID === 'machines.index.collection:stage' && typeof node.props?.onLayout === 'function')[0]!;
      stage.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 900 } } });
    });
    const updateLine = (id: string) => tree.findAll(node => typeof node.type === 'string'
      && node.props?.testID === `machines.index.updates.machine:srv_a:${id}`)[0]?.props.children;
    const { t } = await import('@/text');
    expect(updateLine('hetzner')).toBe(t('machineFleetUpdates.securityUpdates', { count: 3 }));
    expect(updateLine('vps')).toBe(t('machineFleetUpdates.restartNeeded'));
    expect(updateLine('calm')).toBeUndefined();
  });

  it('keeps one missing-value mark under each offline metric column', async () => {
    await setMachines([{ serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [
      { ...machine('machine-offline', 'Offline box', 'offline.local'), active: false },
    ] }]);
    const tree = await renderPage();
    await act(async () => {
      const stage = tree.findAll(node => node.props?.testID === 'machines.index.collection:stage' && typeof node.props?.onLayout === 'function')[0]!;
      stage.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1440, height: 900 } } });
    });
    const row = tree.findAll(node => node.props?.testID === 'machines.index.row.machine:srv_a:machine-offline')[0]!;
    const marks = row.findAll(node => typeof node.type === 'string' && node.props?.children === '—');
    expect(marks).toHaveLength(3);
  });

  it('says why an online machine it cannot read has no figures, where its figures would stand in the table', async () => {
    await setMachines([{ serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [
      machine('machine-a1', 'Machine A1', 'a.local'),
      { ...machine('machine-l', 'Shared box', 'shared.local'), metadata: null,
        availability: { kind: 'locked', reason: 'custodian_only' } } as never,
    ] }]);
    const tree = await renderPage();
    const row = tree.findAll(node => node.props?.testID === 'machines.index.row.machine:srv_a:machine-l')[0]!;
    const texts = row.findAll(node => typeof node.props?.children === 'string').map(node => node.props.children as string);
    expect(texts).toContain('machine.lockedReason.custodianOnly');
  });

  it.each([true, false])('pins the dashboard from the page’s two-Home attention census (needs attention: %s)', async (needsAttention) => {
    const calm = MachinePublishedResourceSummaryV1Schema.parse({ v: 1, vitals: { state: 'reporting' },
      host: { logicalCores: 8, memoryTotalBytes: 2 ** 34, bootedAt: 1 },
      attention: { level: 'calm', reasons: [] } });
    const attention = MachinePublishedResourceSummaryV1Schema.parse({ ...calm, attention: {
      level: 'needs_you', reasons: [{ key: 'disk', level: 'needs_you', since: 1, metric: 'disk', nextStep: 'free_up_space',
        kind: 'disk_full', volumeId: 'data', volumeLabel: '/data' }],
    } });
    await setMachines([
      { serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [
        { ...machine('machine-a1', 'Machine A1', 'a.local'), daemonState: { resources: calm } },
      ] },
      { serverId: 'srv_b', serverName: 'Home B', status: 'idle', machines: [
        { ...machine('machine-b1', 'Machine B1', 'b.local'), daemonState: { resources: needsAttention ? attention : calm } },
      ] },
    ]);
    const previousScope = storage.getState().profileScope;
    const previousApplied = getAppliedActiveServerSnapshot();
    const previousAvailable = isAppliedActiveServerRuntimeAvailable();
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId: 'srv_a', accountId: 'account-a' } });
    try {
      const tree = await renderPage();
      const document = tree.find(node => Array.isArray(node.props.binding?.presets));
      const presets: readonly WidgetAreaPresetV1[] = document.props.binding.presets;
      const group = presets[0]!.items.find(item => item.kind === 'group');
      expect(group?.kind === 'group' ? group.context?.machine : undefined).toEqual({ kind: 'value', value: needsAttention
        ? { serverId: 'srv_b', machineId: 'machine-b1' } : { serverId: 'srv_a', machineId: 'machine-a1' } });
      expect(tree.findAll(node => node.props.testID === 'machines.needs-you.srv_b.machine-b1').length > 0).toBe(needsAttention);
    } finally {
      standardCleanup();
      publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
      storage.setState({ profileScope: previousScope });
    }
  });

  it('says the fleet in one sentence and lists the machine that needs you, with its one action, above the table', async () => {
    const resources = {
      v: 1,
      vitals: { state: 'reporting' },
      host: { logicalCores: 8, memoryTotalBytes: 2 ** 34, bootedAt: 1 },
      attention: {
        level: 'needs_you',
        reasons: [
          {
            key: 'disk',
            level: 'needs_you',
            since: Date.now() - 60_000,
            metric: 'disk',
            nextStep: 'free_up_space',
            kind: 'disk_full',
            volumeId: 'v',
            volumeLabel: '/data',
          },
        ],
      },
    };
    await setMachines([
      {
        serverId: 'srv_a',
        serverName: 'Home A',
        status: 'idle',
        machines: [
          {
            ...machine('machine-a1', 'Machine A1', 'a.local'),
            daemonState: { resources },
          } as never,
          machine('machine-a2', 'Machine A2', 'b.local'),
        ],
      },
    ]);
    const tree = await renderPage();
    const header = tree.findAll(
      (node) =>
        node.props?.testID === 'machines.index.header' &&
        typeof node.props?.title === 'string',
    )[0]!;
    // The Needs-you row carries its reason once; the header describes the rest of the fleet.
    expect(header.props.title).toBe('settings.machines');
    expect(header.props.description).not.toContain('machineAttention.phrases.diskFull');
    // This file mocks Item, so the row's one action is read from the row it belongs to.
    const row = tree.findAll(
      (node) => node.props?.testID === 'machines.needs-you.srv_a.machine-a1',
    )[0]!;
    expect(row.props.titleAccessory.props.children).toBe('machineAttention.words.diskFull');
    const action = (
      row.props.rightElement as React.ReactElement<{
        children: React.ReactElement<{ onPress: () => void }>;
      }>
    ).props.children;
    await act(async () => {
      action.props.onPress();
    });
    // "Free up space" opens Storage prepared for the disk the reason names (plan 40 STO-23).
    expect(routerPushSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\/settings\/machines\/machine-a1\?serverId=srv_a&tab=storage&.*prepare=lowDisk/u,
      ),
    );
    expect(routerPushSpy.mock.calls.at(-1)?.[0]).toContain('volumeId=v');
  });

  it('counts the current fleet before an archived creation removes its Machine from the display collection', async () => {
    const text = await import('@/text');
    vi.spyOn(text, 't').mockImplementation((key: string, params?: unknown) => key === 'allMachines.machinesCount'
      ? `${typeof params === 'object' && params !== null && 'count' in params ? params.count : ''} Machines` : key);
    const archived: ManagedMachineV1 = {
      id: 'archived-creation', homeId: 'srv_a', custodianAccountId: 'owner',
      launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Old build box', choices: {} },
      controller: { machineId: 'controller', installationId: 'installation' },
      allocation: 'confirmed-absent', creationState: 'active', desired: 'delete', desiredWhen: 'now',
      intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
      enrolledMachineId: 'still-current', archivedAt: 1,
    };
    await setMachines([{ serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [
      machine('current', 'Current box', 'current.local'), machine('still-current', 'Retained machine', 'retained.local'),
    ] }], { managedByServerId: { srv_a: [archived] } });
    const tree = await renderPage();
    const count = tree.findHostByTestId('machines.index.header:count');
    expect(count).not.toBeNull();
    expect(findAllHostTestInstances(count!, () => true).flatMap(node => node.children.filter(child => typeof child === 'string')).join('')).toContain('2 Machines');
    expect(tree.findAll(node => node.props.testID === 'machines.index.row.machine:srv_a:still-current')).toHaveLength(0);
  });

  it('opens retained pending compute in the same Home without ordinary Machine RPC glyphs', async () => {
    const row: ManagedMachineV1 = {
      id: 'pending',
      homeId: 'home-a',
      custodianAccountId: 'owner',
      launch: {
        provider: { pluginId: 'custom.provisioner', localId: 'native' },
        schemaVersion: 1,
        name: 'Build box',
        choices: {},
      },
      controller: { machineId: 'controller', installationId: 'installation' },
      allocation: 'may-exist',
      creationState: 'active',
      desired: 'start',
      desiredWhen: 'now',
      intentRevision: 1,
      retention: { kind: 'until-delete' },
      wakeOnAcceptedMessage: false,
    };
    await setMachines(
      [
        {
          serverId: 'srv_a',
          serverName: 'Home A',
          status: 'idle',
          machines: [],
        },
      ],
      { managedByServerId: { 'srv_a': [row] } },
    );
    const tree = await renderPage();
    const pending = tree.findAll(
      (node) =>
        node.props?.testID === 'machines.index.row.managed:srv_a:pending' &&
        typeof node.props?.onPress === 'function',
    )[0]!;
    await act(async () => {
      await pressTestInstanceAsync(pending);
    });
    expect(routerPushSpy).toHaveBeenCalledWith(
      '/settings/machines/managed/pending?serverId=srv_a',
    );
    expect(tree.findAllByType('SelectionTiles' as never)).toHaveLength(0);
  });

  it('does not present an unreadable managed inventory as an empty Home', async () => {
    await setMachines(
      [
        {
          serverId: 'srv_a',
          serverName: 'Home A',
          status: 'idle',
          machines: [],
        },
      ],
      {
        managedInventory: {
          entries: {
            'srv_a': { status: 'error', errorCode: 'managed_request_failed' },
          },
        },
      },
    );
    const tree = await renderPage();
    expect(
      tree.findAll(
        (node) => node.props?.testID === 'settings.machines.managed.read.srv_a',
      ).length,
    ).toBeGreaterThan(0);
    expect(tree.findAllByType('SelectionTiles' as never)).toHaveLength(0);
  });

  it('restores the collection search after opening a row and returning on a phone', async () => {
    await setMachines([
      {
        serverId: 'srv_a',
        serverName: 'Home A',
        status: 'idle',
        machines: Array.from({ length: 9 }, (_, index) =>
          machine(
            `machine-${index}`,
            index === 0 ? 'Build box' : `Laptop ${index}`,
            `host-${index}.local`,
          ),
        ),
      },
    ]);
    const tree = await renderPage();
    // The main-screen head keeps the search behind its magnifier (owner 11-11).
    await act(async () => tree.findAll((node) => node.props?.testID === 'machines.index.search:toggle' && typeof node.props?.onPress === 'function')[0]!.props.onPress());
    const search = tree.findAll(
      (node) => node.props?.testID === 'machines.index.search',
    )[0]!;
    await act(async () => search.props.onChangeText('Build'));
    const selected = tree.findAll(
      (node) =>
        node.props?.testID === 'machines.index.row.machine:srv_a:machine-0' &&
        typeof node.props?.onPress === 'function',
    )[0]!;
    await act(async () => {
      await pressTestInstanceAsync(selected);
    });
    const returned = await renderPage();
    expect(
      returned.findAll(
        (node) => node.props?.testID === 'machines.index.search',
      )[0]!.props.value,
    ).toBe('Build');
    expect(
      returned.findAll(
        (node) =>
          node.props?.testID === 'machines.index.row.machine:srv_a:machine-1',
      ),
    ).toHaveLength(0);
  });

  it("keeps a long fleet's offline machines out of the table until asked for, and finds them by search", async () => {
    const offline = Array.from({ length: 9 }, (_, index) => ({
      ...machine(`old-${index}`, `Old ${index}`, `old${index}.local`),
      active: false,
      activeAt: 1,
    }));
    await setMachines([
      {
        serverId: 'srv_a',
        serverName: 'Home A',
        status: 'idle',
        machines: [machine('machine-a1', 'Machine A1', 'a.local'), ...offline],
      },
    ]);
    const tree = await renderPage();
    const visible = (key: string) =>
      tree.findAll(
        (node) =>
          node.props?.testID === `machines.index.row.machine:srv_a:${key}`,
      ).length > 0;

    expect(visible('machine-a1')).toBe(true);
    expect(visible('old-0')).toBe(false);
    // Aggregate membership must consume the same live presence as the visible row badges.
    await act(async () => {
      storage.getState().applyMachineActivityUpdates([{ id: 'old-0', active: true, activeAt: Date.now() }], { sourceServerId: 'srv_a' });
    });
    expect(visible('old-0')).toBe(true);
    expect(visible('old-1')).toBe(false);
    const show = tree.findAll(
      (node) =>
        node.props?.testID === 'machines.index.offline-action' &&
        typeof node.props?.onPress === 'function',
    )[0];
    expect(show).toBeDefined();
    await act(async () => {
      await pressTestInstanceAsync(show!);
    });
    expect(visible('old-0')).toBe(true);

    // A search reaches every machine, whatever the fold says.
    const fresh = await renderPage();
    await act(async () => fresh.findAll((node) => node.props?.testID === 'machines.index.search:toggle' && typeof node.props?.onPress === 'function')[0]!.props.onPress());
    const search = fresh.findAll(
      (node) => node.props?.testID === 'machines.index.search',
    )[0]!;
    await act(async () => search.props.onChangeText('Old 3'));
    expect(
      fresh.findAll(
        (node) =>
          node.props?.testID === 'machines.index.row.machine:srv_a:old-3',
      ).length,
    ).toBeGreaterThan(0);
  });

  it('builds only the table rows near the page viewport for a census-sized fleet', async () => {
    const fleet = Array.from({ length: 120 }, (_, index) => machine(`census-${index}`, `Census ${index}`, `census-${index}.local`));
    await setMachines([{ serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: fleet }]);
    await primeFeatures();
    // The page's physical scroller holds one 1000px viewport at the top.
    pageViewport.current = { top: 0, bottom: 1000 };
    const screen = await renderScreen(<MachinesSettingsView />);
    try {
      await waitForHomeGovernance(() => expect(screen.tree.findAll(node => node.props?.testID === 'machines.index.row.machine:srv_a:census-0'
        && typeof node.props?.onPress === 'function').length).toBeGreaterThan(0));
      await flushHookEffects();
      const rows = [...new Set(screen.tree.findAll(node => typeof node.props?.testID === 'string' && node.props.testID.startsWith('machines.index.row.machine:srv_a:census-')
        && typeof node.props?.onPress === 'function').map(node => node.props.testID as string))];
      // A data-sized table never mounts every row: what is built is bounded by the viewport, not the fleet.
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(fleet.length / 3);
    } finally {
      pageViewport.current = { top: 0, bottom: 1_000_000 };
      await screen.unmount();
    }
  });

  it('leaves searching a long fleet to the machine list when that list stands beside the page', async () => {
    const offline = Array.from({ length: 9 }, (_, index) => ({
      ...machine(`old-${index}`, `Old ${index}`, `old${index}.local`),
      active: false,
      activeAt: 1,
    }));
    await setMachines([
      { serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [machine('machine-a1', 'Machine A1', 'a.local'), ...offline] },
    ]);
    const { AllMachinesIndex } = await import('@/components/machines/index/AllMachinesIndex');
    const { MachinesDoorProvider } = await import('@/components/machines/page/machinesDoor');
    const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
    // The rail door on a wide screen: the list column (with its own search) is the shell column beside the index.
    const tree = (await renderScreen(<AppShellColumnContext.Provider value={{ present: true, columnVisible: true }}>
      <MachinesDoorProvider door="rail"><AllMachinesIndex /></MachinesDoorProvider>
    </AppShellColumnContext.Provider>)).tree;
    await flushHookEffects();
    expect(tree.findAll((node) => node.props?.testID === 'machines.index.row.machine:srv_a:machine-a1').length).toBeGreaterThan(0);
    expect(tree.findAll((node) => node.props?.testID === 'machines.index.search')).toHaveLength(0);
    expect(tree.findAll((node) => node.props?.testID === 'machines.index.search:toggle')).toHaveLength(0);
  });

  // F7 (WHOLE-PAGE-ACCEPT-1112): a collapsed column leaves the page as the only list, so it keeps search and add.
  it('keeps search and add on the wide page when the rail door\'s column is collapsed', async () => {
    const offline = Array.from({ length: 9 }, (_, index) => ({
      ...machine(`old-${index}`, `Old ${index}`, `old${index}.local`),
      active: false,
      activeAt: 1,
    }));
    await setMachines([
      { serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [machine('machine-a1', 'Machine A1', 'a.local'), ...offline] },
    ]);
    const { AllMachinesIndex } = await import('@/components/machines/index/AllMachinesIndex');
    const { MachinesDoorProvider } = await import('@/components/machines/page/machinesDoor');
    const { AppShellColumnContext } = await import('@/components/navigation/shell/appRail/appShellColumnContext');
    const tree = (await renderScreen(<AppShellColumnContext.Provider value={{ present: true, columnVisible: false }}>
      <MachinesDoorProvider door="rail"><AllMachinesIndex /></MachinesDoorProvider>
    </AppShellColumnContext.Provider>)).tree;
    await flushHookEffects();
    expect(tree.findAll((node) => node.props?.testID === 'machines.index.search:toggle').length).toBeGreaterThan(0);
    expect(addMenuItemIds(tree)).toContain('machine');
  });

  it('opens the canonical add-machine draft from both the browser and desktop collection', async () => {
    const webTree = await renderPage();
    expect(addMenuItemIds(webTree)).toEqual(['machine', 'preset']);

    desktopState.value = true;
    const desktopTree = await renderPage();
    expect(addMenuItemIds(desktopTree)).toEqual(['machine', 'preset']);
    const menu = desktopTree.findByType('DropdownMenu' as never) as unknown as {
      props: { onSelect: (id: string) => void };
    };
    await act(async () => menu.props.onSelect('machine'));
    expect(routerPushSpy).toHaveBeenCalledWith('/settings/machines/add');
  });

  it('lists this computer in the desktop app and opens its page in the collection', async () => {
    desktopState.value = true;
    const tree = await renderPage();

    const row = tree.findAll(
      (node) => node.props?.testID === 'settings.machines.thisComputer',
    )[0]!;
    await act(async () => {
      await pressTestInstanceAsync(row);
    });
    expect(routerPushSpy).toHaveBeenCalledWith(
      '/settings/machines/this-computer',
    );
  });

  it('shows the ways to add a machine when there are none, and offers a pool where the Home supports pools', async () => {
    await setMachines([
      { serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [] },
    ]);
    poolFeatureState.value = 'enabled';
    const tree = await renderPage();

    const tiles = tree.findByType('SelectionTiles' as never) as unknown as {
      props: { options: Array<{ id: string }>; onPress: (id: string) => void };
    };
    // The pool is added from its own section, so the tiles do not offer it twice.
    expect(tiles.props.options.map((option) => option.id)).toEqual(['machine']);
    // F7: an empty fleet has no "0 Machines · 0 sessions working" line and no view switch with nothing to switch.
    expect(tree.findAll((node) => node.props?.testID === 'machines.index.header:count')).toHaveLength(0);
    expect(tree.findAll((node) => typeof node.props?.testIDPrefix === 'string' && node.props.testIDPrefix === 'machines.index.view')).toHaveLength(0);
    expect(addMenuItemIds(tree)).toEqual(['machine', 'preset', 'pool']);
    const menu = tree.findByType('DropdownMenu' as never) as unknown as {
      props: { onSelect: (id: string) => void };
    };
    await act(async () => menu.props.onSelect('pool'));
    expect(routerPushSpy).toHaveBeenCalledWith(
      '/settings/machines/pools/new?serverId=srv_a',
    );
  });

  it('holds the collection loading, not the add tiles, while the first machine list loads', async () => {
    await setMachines(
      [
        {
          serverId: 'srv_a',
          serverName: 'Home A',
          status: 'loading',
          machines: [],
        },
      ],
    );
    const tree = await renderPage();

    expect(
      tree.findAll(
        (node) =>
          node.props?.testID === 'machines.index.collection' &&
          node.props?.loading === true,
      ).length,
    ).toBeGreaterThan(0);
    expect(tree.findAllByType('SelectionTiles' as never)).toHaveLength(0);
  });

  it('holds the whole first answer behind the collection loading, then publishes rows, headline and count together, and keeps them through a re-read', async () => {
    const profileId = homeProfiles.get('srv_a')!;
    const managedFirstReply = createDeferred<void>();
    home.answer(profileId, 'POST /v1/machines/managed/actions/list', { body: { machines: [] }, respondAfter: managedFirstReply.promise });
    const rowId = 'machines.index.row.machine:srv_a:machine-a1';
    const has = (tree: Awaited<ReturnType<typeof renderPage>>, testID: string) => tree.findAll(node => node.props?.testID === testID).length > 0;
    // The shared count line names the Machine count only once the fleet has answered.
    const countsMachines = (tree: Awaited<ReturnType<typeof renderPage>>) => tree.findAll(node => node.props?.testID === 'machines.index.header:count')
      .some(node => /\d+ Machines?\b/.test(String(node.props.children ?? '')));
    const screen = await renderScreen(React.createElement(MachinesSettingsView));
    await waitForHomeGovernance(() => expect(home.requests.some(request => request.path === '/v1/machines/managed/actions/list')).toBe(true));
    await flushHookEffects();
    // One machine is already known, but the created machines have not answered: no partial row, no count.
    expect(screen.tree.findAll(node => node.props?.testID === 'machines.index.collection' && node.props?.loading === true).length).toBeGreaterThan(0);
    expect(has(screen.tree, rowId)).toBe(false);
    expect(countsMachines(screen.tree)).toBe(false);
    await act(async () => managedFirstReply.resolve());
    await waitForHomeGovernance(() => expect(has(screen.tree, rowId)).toBe(true));
    expect(countsMachines(screen.tree)).toBe(true);
    // A later read keeps the answer already shown.
    const rereply = createDeferred<void>();
    home.answer(profileId, 'POST /v1/machines/managed/actions/list', { body: { machines: [] }, respondAfter: rereply.promise });
    const requests = home.requests.filter(request => request.path === '/v1/machines/managed/actions/list').length;
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    await act(async () => publishHomeAccountChange('srv_a'));
    await waitForHomeGovernance(() => expect(home.requests.filter(request => request.path === '/v1/machines/managed/actions/list').length).toBeGreaterThan(requests));
    expect(has(screen.tree, rowId)).toBe(true);
    expect(countsMachines(screen.tree)).toBe(true);
    await act(async () => rereply.resolve());
    await screen.unmount();
  });

  it('ends in a named failure with Retry, not the add tiles, when the Home cannot list its machines', async () => {
    await setMachines([
      {
        serverId: 'srv_a',
        serverName: 'Home A',
        status: 'error',
        machines: [],
      },
    ]);
    const tree = await renderPage();

    expect(tree.findAllByType('SelectionTiles' as never)).toHaveLength(0);
    const titles = tree
      .findAllByType('Item' as never)
      .map(
        (node) => (node as unknown as { props: { title: string } }).props.title,
      );
    expect(titles).not.toContain('common.loading');
    const failure = tree.find(
      (node) => node.props?.testID === 'settings.machines.unreadable',
    ) as unknown as {
      props: {
        title: string;
        rightElement: { props: { testID: string; onPress: () => void } };
      };
    };
    expect(failure.props.title).toContain('settingsMachines.unreadableTitle');
    const retry = failure.props.rightElement;
    expect(retry.props.testID).toBe('settings.machines.unreadable.retry');
    // The Action/HTTP refresh journey is exercised with the real Account binding in machinesList.refresh.test.tsx.
  });

  it('groups machines by Home when several Homes are shown, keeping a Home that has none', async () => {
    await setMachines([
      {
        serverId: 'srv_a',
        serverName: 'Home A',
        status: 'idle',
        machines: [machine('machine-a1', 'Machine A1', 'a.local')],
      },
      {
        serverId: 'srv_b',
        serverName: 'Home B',
        status: 'signedOut',
        machines: [],
      },
    ]);
    const tree = await renderPage();

    const collection = tree.findAll(
      (node) =>
        node.props?.testID === 'machines.index.collection' && node.props?.model,
    )[0]!;
    const groups = (
      collection.props.model.sections as Array<{
        group: { title: string; description?: string } | null;
      }>
    ).map((section) => section.group);
    expect(groups.map((group) => group?.title)).toEqual(['Home A', 'Home B']);
    expect(groups[1]?.description).toBe(
      'settingsMachines.count · server.signedOut',
    );
  });
});

describe('the machine list column in the rail door', () => {
  beforeEach(async () => {
    routerPushSpy.mockClear();
    routerReplaceSpy.mockClear();
    desktopState.value = false;
    poolFeatureState.value = 'disabled';
    await setMachines([
      {
        serverId: 'srv_a',
        serverName: 'Home A',
        status: 'idle',
        machines: [machine('machine-a1', 'Machine A1', 'a.local')],
      },
    ]);
  });

  it('keeps machine rows and All machines inside the rail door, and sends configuration to Settings', async () => {
    const { MachinesColumn } =
      await import('@/components/machines/collection/MachinesColumn');
    const tree = (await renderScreen(React.createElement(MachinesColumn))).tree;
    await waitForHomeGovernance(() => expect(tree.findAll(node =>
      node.props.testID === 'settings.machines.row.srv_a.machine-a1').length).toBeGreaterThan(0));
    const navigatedTo = () =>
      [...routerPushSpy.mock.calls, ...routerReplaceSpy.mock.calls].map(
        (call) => call[0],
      );

    const row = tree.findAll(
      (node) => node.props?.testID === 'settings.machines.row.srv_a.machine-a1',
    )[0]!;
    await act(async () => {
      await pressTestInstanceAsync(row);
    });
    expect(navigatedTo()).toContain('/machines/machine-a1?serverId=srv_a');

    const all = tree.findAll(
      (node) => node.props?.testID === 'settings.machines.rail.all',
    )[0]!;
    await act(async () => {
      await pressTestInstanceAsync(all);
    });
    expect(navigatedTo()).toContain('/machines');

    // Machine defaults are configuration: they have one home, the Settings door, and are pushed there.
    const defaults = tree.findAll(
      (node) => node.props?.testID === 'settings.machines.defaults',
    )[0]!;
    await act(async () => {
      await pressTestInstanceAsync(defaults);
    });
    expect(routerPushSpy.mock.calls.at(-1)?.[0]).toMatch(
      /^\/settings\/machines\/defaults/,
    );
  });

  it('opens with All machines and Defaults, then the machines under Your machines (lab m-defaults, R)', async () => {
    const { MachinesColumn } =
      await import('@/components/machines/collection/MachinesColumn');
    const tree = (await renderScreen(React.createElement(MachinesColumn))).tree;
    await waitForHomeGovernance(() => expect(tree.findAll(node =>
      node.props.testID === 'settings.machines.row.srv_a.machine-a1').length).toBeGreaterThan(0));
    const order = [
      'settings.machines.rail.all',
      'settings.machines.defaults',
      'settings.machines.row.srv_a.machine-a1',
    ];
    const seen: string[] = [];
    tree
      .findAll((node) => order.includes(node.props?.testID))
      .forEach((node) => {
        if (!seen.includes(node.props.testID)) seen.push(node.props.testID);
      });
    expect(seen).toEqual(order);
    expect(
      tree.findAll(
        (node) => node.props?.title === 'machines.destinations.yours',
      ).length,
    ).toBeGreaterThan(0);
  });

  it("keeps a long fleet's offline machines under one fold after the ones that can work", async () => {
    const offline = Array.from({ length: 9 }, (_, index) => ({
      ...machine(`old-${index}`, `Old ${index}`, `old${index}.local`),
      active: false,
      activeAt: 1,
    }));
    await setMachines([
      {
        serverId: 'srv_a',
        serverName: 'Home A',
        status: 'idle',
        machines: [machine('machine-a1', 'Machine A1', 'a.local'), ...offline],
      },
    ]);
    const { MachinesColumn } =
      await import('@/components/machines/collection/MachinesColumn');
    const tree = (await renderScreen(React.createElement(MachinesColumn))).tree;
    const visible = (testID: string) =>
      tree.findAll((node) => node.props?.testID === testID).length > 0;

    await waitForHomeGovernance(() => expect(visible('settings.machines.row.srv_a.machine-a1')).toBe(true));
    const fold = tree.findAll(
      (node) =>
        typeof node.props?.testID === 'string' &&
        node.props.testID.startsWith('settings.machines.offline.') &&
        node.props.detail !== undefined,
    )[0];
    expect(fold?.props.detail).toBe('9');
    expect(visible('settings.machines.row.srv_a.old-0')).toBe(false);

    await act(async () => {
      await pressTestInstanceAsync(fold!);
    });
    expect(visible('settings.machines.row.srv_a.old-0')).toBe(true);
  });
});

describe('the presets group in the rail', () => {
  const sectionIds = (tree: Awaited<ReturnType<typeof renderScreen>>['tree']) => tree.findAll((node) => typeof node.props?.testID === 'string'
    && node.props.testID.startsWith('settings.machines.presets.')).map((node) => node.props.testID as string);

  it('admits the active fleet beside an absent selected receipt while the archive is still loading', async () => {
    const { MachineCollectionRail } = await import('./collection/MachineCollectionList');
    const { CollectionSkeletonRows } = await import('@/components/ui/lists/collection/CollectionList');
    const fleet = Array.from({ length: 128 }, (_, index) => machine(`studio-${index}`, `Studio ${index}`, `studio-${index}.local`));
    await setMachines([{ serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: fleet }]);
    routeState.pathname = '/settings/machines/managed/removed-resource';
    const activeReply = createDeferred<void>();
    const archiveReply = createDeferred<void>();
    home.answer(homeProfiles.get('srv_a')!, 'POST /v1/machines/managed/actions/list', {
      select: input => ({ body: { machines: [] }, respondAfter:
        input && typeof input === 'object' && 'archived' in input && input.archived ? archiveReply.promise : activeReply.promise }),
    });
    const screen = await renderScreen(<MachineCollectionRail />);
    const row = () => screen.tree.findAll(node => typeof node.type === 'string'
      && node.props.testID === 'settings.machines.row.srv_a.studio-0')[0];
    try {
      await waitForHomeGovernance(() => expect(home.requests.some(request => request.path === '/v1/machines/managed/actions/list')).toBe(true));
      // An ordinary roster alone cannot answer whether there are created machines too.
      expect(row()).toBeUndefined();
      expect(screen.tree.findAllByType(CollectionSkeletonRows)).toHaveLength(1);
      await act(async () => activeReply.resolve());
      await waitForHomeGovernance(() => expect(home.requests.some(request => request.path === '/v1/machines/managed/actions/list'
        && request.input && typeof request.input === 'object' && 'archived' in request.input && request.input.archived)).toBe(true));
      await flushHookEffects();
      expect(row()).toBeDefined();
      expect(screen.tree.findAllByType(CollectionSkeletonRows)).toHaveLength(0);
      const reads = home.requests.filter(request => request.path === '/v1/machines/managed/actions/list').length;
      const admitted = row();
      await act(async () => storage.getState().applyMachineActivityUpdates(
        fleet.map(machine => ({ id: machine.id, active: true, activeAt: Date.now() })), { sourceServerId: 'srv_a' }));
      await flushHookEffects();
      expect(row()).toBe(admitted);
      // Fleet arrivals do not start another active/archive read while the archive is pending.
      expect(home.requests.filter(request => request.path === '/v1/machines/managed/actions/list')).toHaveLength(reads);
      await act(async () => pressTestInstanceAsync(row()!));
      expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/machines/studio-0?serverId=srv_a');
    } finally {
      activeReply.resolve();
      archiveReply.resolve();
      await screen.unmount();
    }
  });

  it('keeps admitted machine, pool and preset controls mounted and selected while a later name hydrates', async () => {
    const { MachineCollectionRail } = await import('./collection/MachineCollectionList');
    const named = machine('machine-a1', 'Studio', 'studio.local');
    await setMachines([{ serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [{ ...named, metadata: null, availability: undefined }] }]);
    routeState.pathname = '/settings/machines/machine-a1';
    poolFeatureState.value = 'enabled';
    await primeFeatures();
    const profileId = homeProfiles.get('srv_a')!;
    home.answer(profileId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [{
      id: 'build', homeId: 'srv_a', revision: 1, name: 'Build recipe', owner: { kind: 'account', accountId: 'account-a' },
      controller: { machineId: 'machine-a1', installationId: 'machine-a1-installation' },
      launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'Build box', choices: {} },
    }] } });
    home.answer(profileId, '/v1/machines/pools/list', { body: { pools: [{
      pool: { id: '00000000-0000-4000-8000-000000000001', name: 'Development', description: null,
        revision: 1, createdAt: 1, updatedAt: 1, members: [] },
      availability: { state: 'known', connectedCount: 0, enabledCount: 0 },
    }] } });
    const screen = await renderScreen(<MachineCollectionRail />);
    const ids = ['settings.machines.row.srv_a.machine-a1',
      'settings.machinePools.row.srv_a.00000000-0000-4000-8000-000000000001', 'settings.machines.preset.srv_a.build'];
    const read = (id: string) => screen.tree.findAll(node => typeof node.type === 'string' && node.props.testID === id)[0];
    // Initial hydration still holds the whole first answer.
    expect(read(ids[0]!)).toBeUndefined();
    await act(async () => storage.getState().applyMachines([named], false, { sourceServerId: 'srv_a' }));
    await waitForHomeGovernance(() => { for (const id of ids) expect(read(id)).toBeDefined(); });
    const admitted = ids.map(id => read(id));
    expect(read(ids[0]!)?.props.selected).toBe(true);

    const arriving = { ...machine('machine-b', 'Builder', 'builder.local'), metadata: null, availability: undefined };
    await act(async () => storage.getState().applyMachines([arriving], false, { sourceServerId: 'srv_a' }));
    await flushHookEffects();
    // No admitted row is unmounted to show collection skeletons.
    for (const [index, id] of ids.entries()) expect(read(id)).toBe(admitted[index]);
    expect(read(ids[0]!)?.props.selected).toBe(true);
    for (const id of ids) await act(async () => pressTestInstanceAsync(read(id)!));
    expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/machines/machine-a1?serverId=srv_a');
    expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/machines/pools/00000000-0000-4000-8000-000000000001?serverId=srv_a');
    expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/machines/presets/build?serverId=srv_a');

    await act(async () => storage.getState().applyMachines([
      { ...machine('machine-b', 'Builder', 'builder.local'), metadataVersion: arriving.metadataVersion + 1 },
    ], false, { sourceServerId: 'srv_a' }));
    await waitForHomeGovernance(() => expect(read('settings.machines.row.srv_a.machine-b')?.props.title).toBe('Builder'));
    expect(read(ids[0]!)).toBe(admitted[0]);
    expect(read(ids[0]!)?.props.selected).toBe(true);
    await screen.unmount();
  });

  it('keeps its group and its add control while the list is read again, and only waits for the first answer', async () => {
    const { MachinesColumn } = await import('@/components/machines/collection/MachinesColumn');
    await setMachines([{ serverId: 'srv_a', serverName: 'Home A', status: 'idle', machines: [machine('machine-a1', 'Machine A1', 'a.local')] }]);
    const profileId = homeProfiles.get('srv_a')!;
    const firstReply = createDeferred<void>();
    home.answer(profileId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] }, respondAfter: firstReply.promise });
    const screen = await renderScreen(React.createElement(MachinesColumn));
    await waitForHomeGovernance(() => expect(home.requests.some(request => request.path === '/v1/machines/presets/list')).toBe(true));
    expect(sectionIds(screen.tree)).not.toContain('settings.machines.presets.new.srv_a');
    await act(async () => firstReply.resolve());
    await waitForHomeGovernance(() => expect(sectionIds(screen.tree)).toContain('settings.machines.presets.new.srv_a'));
    const refreshReply = createDeferred<void>();
    home.answer(profileId, '/v1/machines/presets/list', { body: { kind: 'listed', presets: [] }, respondAfter: refreshReply.promise });
    const initialRequests = home.requests.filter(request => request.path === '/v1/machines/presets/list').length;
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    await act(async () => publishHomeAccountChange('srv_a', [MACHINE_PRESETS_ACCOUNT_CHANGE_ENTITY_ID_V1], { source: 'socket', changeKinds: ['account'] }));
    await waitForHomeGovernance(() => expect(home.requests.filter(request => request.path === '/v1/machines/presets/list').length).toBeGreaterThan(initialRequests));
    expect(sectionIds(screen.tree)).toContain('settings.machines.presets.new.srv_a');
    await act(async () => refreshReply.resolve());
    await screen.unmount();
  });
});

describe('MachinesRelayDriftBanner', () => {
  beforeEach(async () => {
    desktopState.value = false;
    relayDriftState.value = {
      title: 'Drift',
      description: 'This computer serves another Home.',
    };
  });

  it('says so on the web, where it cannot repair, and offers the repair in the desktop app', async () => {
    const web = (
      await renderScreen(React.createElement(MachinesRelayDriftBanner))
    ).tree;
    expect(
      web.findAll(
        (node) =>
          node.props?.testID === 'settings.machines.relayDrift.webNotice',
      ),
    ).not.toHaveLength(0);
    expect(web.findAllByType('RelayDriftActionCard' as never)).toHaveLength(0);

    desktopState.value = true;
    const desktop = (
      await renderScreen(React.createElement(MachinesRelayDriftBanner))
    ).tree;
    expect(desktop.findAllByType('RelayDriftActionCard' as never)).toHaveLength(
      1,
    );
  });
});
