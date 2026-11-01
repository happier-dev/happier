import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, flushHookEffects, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installMachinesSettingsCommonModuleMocks } from './machinesSettingsTestHelpers';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachinePublishedResourceSummaryV1Schema } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
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
      pathname: '/settings/machines',
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
vi.mock('@/components/ui/lists/ItemList', () => ({
  ItemList: ({ children }: { children?: React.ReactNode }) =>
    React.createElement('ItemList', null, children),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
  ItemGroup: ({
    children,
    title,
    description,
  }: {
    children?: React.ReactNode;
    title?: React.ReactNode;
    description?: React.ReactNode;
  }) => React.createElement('Group', { title, description }, children),
}));
vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: Record<string, unknown>) => React.createElement('Item', props),
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
  const allMachines = groups.flatMap((group) => group.machines);
  storage.setState({ machines: Object.fromEntries(allMachines.map(row => [row.id, createMachineFixture(row)])),
    machineListByServerId: Object.fromEntries(groups.map(group => [group.serverId, group.machines.map(row => createMachineFixture(row))])),
    machineListStatusByServerId: Object.fromEntries(groups.map(group => [group.serverId, group.status])) });
  await updateEffectiveHomeViewState(() => ({ version: 1,
    groups: [{ id: 'test-fleet', name: 'Fleet', serverIds: groups.map(group => group.serverId), presentation: 'grouped' }],
    activeTargetKind: 'group', activeTargetId: 'test-fleet' }), { scope: 'device' });
}

async function renderPage() {
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

afterEach(() => { standardCleanup(); clearMachineRequestReachabilityForTest(); });

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
    storage.getState().applyMachines([{ ...retained, activeAt: now - 20_286 }], false, { sourceServerId: scope.serverId });
  });
  // Real heartbeat-only publication retains the semantic roster inputs. The
  // mounted row must still project the owner's fresh verdict without reopening.
  expect(storage.getState().machineListByServerId[scope.serverId]).toBe(before);
  expect(resolveMachineReachability(scope, storage.getState().machines.studio!)).toBe('reachable');
  expect(row().props.accessibilityLabel).toContain('settingsOverview.machineOnline');
  await act(async () => { recordMachineRequestFailed({ ...scope, machineId: retained.id }); });
  expect(row().props.accessibilityLabel).toContain('settingsOverview.machineUnreachableFromHome');
  await act(async () => { recordMachineRequestSucceeded({ ...scope, machineId: retained.id }); });
  expect(row().props.accessibilityLabel).toContain('settingsOverview.machineOnline');
  await act(async () => { withdrawMachinePresenceForScope(scope); });
  expect(row().props.accessibilityLabel).toContain('common.unknown');
  await act(async () => { captureMachinePresenceObservation(scope)([retained.id]); });
  expect(row().props.accessibilityLabel).toContain('settingsOverview.machineOnline');
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
    expect(header.props.title).toContain('machineAttention.phrases.diskFull');
    // This file mocks Item, so the row's one action is read from the row it belongs to.
    const row = tree.findAll(
      (node) => node.props?.testID === 'machines.needs-you.srv_a.machine-a1',
    )[0]!;
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
    const screen = await renderScreen(React.createElement(MachinesSettingsView));
    await waitForHomeGovernance(() => expect(home.requests.some(request => request.path === '/v1/machines/managed/actions/list')).toBe(true));
    await flushHookEffects();
    // One machine is already known, but the created machines have not answered: no partial row, no count.
    expect(screen.tree.findAll(node => node.props?.testID === 'machines.index.collection' && node.props?.loading === true).length).toBeGreaterThan(0);
    expect(has(screen.tree, rowId)).toBe(false);
    expect(has(screen.tree, 'machines.index.count')).toBe(false);
    await act(async () => managedFirstReply.resolve());
    await waitForHomeGovernance(() => expect(has(screen.tree, rowId)).toBe(true));
    expect(has(screen.tree, 'machines.index.count')).toBe(true);
    // A later read keeps the answer already shown.
    const rereply = createDeferred<void>();
    home.answer(profileId, 'POST /v1/machines/managed/actions/list', { body: { machines: [] }, respondAfter: rereply.promise });
    const requests = home.requests.filter(request => request.path === '/v1/machines/managed/actions/list').length;
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    await act(async () => publishHomeAccountChange('srv_a'));
    await waitForHomeGovernance(() => expect(home.requests.filter(request => request.path === '/v1/machines/managed/actions/list').length).toBeGreaterThan(requests));
    expect(has(screen.tree, rowId)).toBe(true);
    expect(has(screen.tree, 'machines.index.count')).toBe(true);
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
    await act(async () => publishHomeAccountChange('srv_a'));
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
