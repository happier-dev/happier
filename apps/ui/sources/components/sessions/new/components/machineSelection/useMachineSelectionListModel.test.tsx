import * as React from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, renderScreen } from '@/dev/testkit';
import { synthesizeSelectionListRenderPlan } from '@/components/ui/selectionList/SelectionListRenderPlan';
import { publishMachineActivityForTest } from '@/dev/testkit/harness/machinePresence';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded, resolveMachineReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { linkMachineActivity } from '@/sync/domains/machines/machineActivity';
import { storage } from '@/sync/domains/state/storageStore';
import { buildMachineDestinationModel as buildScopedMachineDestinationModel } from './buildMachineDestinationModel';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { ServerScopedMachine, ServerScopedMachineGroup } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import type { ManagedMachineSelectionOffer } from './managedMachineSelection';
import { buildManagedMachineSelectionOffers } from './managedMachineSelection';

import type {
    BuildMachineSelectionListModelParams,
    useMachineSelectionListModel as UseMachineSelectionListModel,
} from './useMachineSelectionListModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The modal host is the one genuine boundary the custom-expiry flow crosses; the
// real `showTemporaryComputerExpiryModal`, the real editor contract and the real
// commit path all run beneath it.
const modalHost = vi.hoisted(() => ({
    show: vi.fn((_config: unknown) => 'modal-id'),
}));

// Hoist the genuine presentation boundaries before the static destination-model
// import reaches its UI dependencies. Installing them from a later helper leaves
// those dependencies holding the real text/modal/native modules.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key, params) => key === 'machines.destinations.shared' ? `${key}:${String(params?.team)}` : key,
}));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: { show: modalHost.show },
}).module);

const network = await installSessionOpsNetworkBoundary();
const fixtureScope = { serverId: 'server-a', accountId: 'account-a' };
const fixtureScopes = new Map([['server-a', fixtureScope], ['server-b', { serverId: 'server-b', accountId: 'account-b' }]]);
function buildMachineDestinationModel(input: Parameters<typeof buildScopedMachineDestinationModel>[0]) {
    return buildScopedMachineDestinationModel({ ...input, scopesByServerId: fixtureScopes });
}
let useMachineSelectionListModel: typeof UseMachineSelectionListModel;
let NewSessionMachineSelectionContent: typeof import('../NewSessionMachineSelectionContent').NewSessionMachineSelectionContent;
let SelectionList: typeof import('@/components/ui/selectionList').SelectionList;
afterEach(() => { clearMachineRequestReachabilityForTest(); network.resetRequests(); });
afterAll(() => network.dispose());

beforeAll(async () => {
    ({ useMachineSelectionListModel } = await import('./useMachineSelectionListModel'));
    ({ NewSessionMachineSelectionContent } = await import('../NewSessionMachineSelectionContent'));
    ({ SelectionList } = await import('@/components/ui/selectionList'));
}, 240_000);

// The package harness clears device storage before every test, including credentials and Homes.
beforeEach(async () => {
    await network.addHome('https://server-a', 'account-a');
    await network.addHome('https://server-b', 'account-b');
    storage.setState((state) => ({
        ...state,
        machines: {},
        machineDisplayById: {},
        machineListByServerId: {},
        machineListStatusByServerId: {},
        machineRecordsByServerId: {},
        machinePresenceById: {},
        machinePresenceByServerId: {},
    }));
});

function createMachine(id: string): Machine {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: Date.now(),
        metadata: {
            host: `${id}.local`,
            platform: 'darwin',
            happyCliVersion: '1.0.0',
            happyHomeDir: '/Users/tester/.happy',
            displayName: id,
            homeDir: '/Users/tester',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

function createScopedMachine(machine: Machine): ServerScopedMachine {
    storage.getState().applyMachines([machine], false, { sourceServerId: 'server-a', sourceAccountId: 'account-a' });
    const admitted = storage.getState().machineRecordsByServerId['server-a']?.[machine.id];
    if (!admitted) throw new Error('expected an admitted Machine fixture');
    linkMachineActivity(admitted, machine);
    const row = {
        ...machine,
        serverId: 'server-a',
        serverName: 'Server A',
    };
    linkMachineActivity(machine, row);
    return row;
}

type Fixture = Readonly<{
    machines: ReadonlyArray<Machine>;
    groups: ReadonlyArray<ServerScopedMachineGroup>;
    recent: ReadonlyArray<Machine>;
    favorites: ReadonlyArray<Machine>;
}>;

/** Each case owns its Machine records and the canonical activity subscriptions they acquire. */
function createFixture(machines: readonly Machine[] = ['m-1', 'm-2', 'm-3'].map(createMachine)): Fixture {
    return {
        machines,
        groups: [{
            serverId: 'server-a',
            serverName: 'Server A',
            loading: false,
            signedOut: false,
            machines: machines.map(createScopedMachine),
        }],
        recent: [machines[0]!],
        favorites: [machines[1]!],
    };
}

type Handlers = Readonly<{
    selectSpy: ReturnType<typeof vi.fn>;
    toggleSpy: ReturnType<typeof vi.fn>;
    onSelectMachine: (machine: Machine) => void;
    onSelectScopedMachine: (machine: ServerScopedMachine) => void;
    onToggleFavorite: (machine: Machine) => void;
}>;

/**
 * Every field except the handlers is referentially stable across renders — the
 * new-session screen model stabilizes groups / recent / favorites by signature
 * (`useStableValueBySignature`). Only the handlers are recreated, exactly like
 * the machine popover's `renderContent({ requestClose, maxHeight })` does on
 * every measured-placement pass while the popover is open.
 */
function buildParams(fixture: Fixture, handlers: Handlers): BuildMachineSelectionListModelParams {
    return {
        groups: fixture.groups,
        selectedMachine: fixture.machines[0]!,
        selectedServerId: 'server-a',
        recentMachines: fixture.recent,
        favoriteMachines: fixture.favorites,
        onSelectMachine: handlers.onSelectMachine,
        onSelectScopedMachine: handlers.onSelectScopedMachine,
        serverId: 'server-a',
        onToggleFavorite: handlers.onToggleFavorite,
        showFavorites: true,
        showRecent: true,
        showSearch: true,
        showCliGlyphs: true,
        autoDetectCliGlyphs: true,
        favoriteGroupPlacement: 'afterRecent',
        testIdPrefix: 'new-session-machine',
    };
}

function makeHandlers(): Handlers {
    const selectSpy = vi.fn();
    const toggleSpy = vi.fn();
    return {
        selectSpy,
        toggleSpy,
        onSelectMachine: (machine) => selectSpy(machine.id),
        onSelectScopedMachine: (machine) => selectSpy(machine.id),
        onToggleFavorite: (machine) => toggleSpy(machine.id),
    };
}

async function renderModel(fixture: Fixture, initialProps: Handlers) {
    return renderHook<ReturnType<typeof UseMachineSelectionListModel>, Handlers>(
        (handlers) => useMachineSelectionListModel(buildParams(fixture, handlers)),
        { initialProps },
    );
}

function firstStaticOption(model: ReturnType<typeof UseMachineSelectionListModel>) {
    const section = model.rootStep.sections[0];
    if (section?.kind !== 'static') throw new Error('expected a leading static section');
    const option = section.options[0];
    if (!option) throw new Error('expected at least one option');
    return option;
}

describe('useMachineSelectionListModel', () => {
    it('keeps unknown Home counts and Pool members unknown until each census settles', async () => {
        const fixture = { ...createFixture([createMachine('member-a')]), recent: [], favorites: [] };
        const settledGroups = [fixture.groups[0]!, { ...fixture.groups[0]!, serverId: 'server-b', serverName: 'Server B' }];
        const coldGroups = settledGroups.map(group => ({ ...group, loading: true, machines: [] }));
        const base = { ...buildParams(fixture, makeHandlers()), poolGroups: [{
            serverId: 'server-a', accountId: 'account-a', serverName: 'Server A', status: 'idle' as const,
            projectionReady: true, pools: [{ pool: { id: 'pool-a', name: 'Development', description: null,
                revision: 1, createdAt: 1, updatedAt: 1,
                members: [{ machineId: 'member-a', enabled: true, priorityTier: 0, state: 'revoked' as const }] },
                availability: { state: 'known' as const, connectedCount: 0, enabledCount: 1 } }],
        }] };
        const rendered = await renderHook(({ groups }) => useMachineSelectionListModel({ ...base, groups }),
            { initialProps: { groups: coldGroups as typeof settledGroups } });
        const section = (id: string) => rendered.getCurrent().rootStep.sections.find(section => section.id === id);
        const sectionCount = (id: string) => { const found = section(id); return found?.kind === 'static' ? found.count : undefined; };
        for (const id of ['server:server-a', 'server:server-b']) expect.soft(sectionCount(id)).toBeUndefined();
        const poolSubtitle = () => {
            const pools = section('server:server-a:machine-pools');
            return pools?.kind === 'static' ? pools.options[0]?.subtitle : undefined;
        };
        expect(poolSubtitle()).toContain('common.loading');
        expect.soft(poolSubtitle()).not.toContain('machine.removedMachine');
        expect(poolSubtitle()).not.toContain('member-a');
        await rendered.rerender({ groups: settledGroups });
        for (const id of ['server:server-a', 'server:server-b']) expect(sectionCount(id)).toBe(1);
        expect(poolSubtitle()).toContain('member-a');
        expect(poolSubtitle()).toContain('machinePools.availabilityKnown');
        await rendered.unmount();
    });

    it.each([1, 2])('shows failed census state rather than an empty Machine roster across %s Homes', async homeCount => {
        const fixture = { ...createFixture([]), recent: [], favorites: [] };
        const failed = { ...fixture.groups[0]!, error: true };
        const groups = homeCount === 1 ? [failed] : [failed,
            { ...failed, serverId: 'server-b', serverName: 'Server B', error: false }];
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams({ ...fixture, groups }, makeHandlers()), onConnectMachine: () => {},
        }));
        const options = rendered.getCurrent().rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []);
        expect(options.find(option => option.id === 'server:server-a:error'))
            .toMatchObject({ label: 'common.unavailable', disabled: true });
        expect(options.some(option => option.id === 'server:server-a:empty')).toBe(false);
        expect(rendered.getCurrent().rootStep.sections.some(section => section.id === 'use-one-you-have')).toBe(false);
    });
    it.each(['owned', 'shared'] as const)('retains selected metadata outside a closed %s offline fold', async ownership => {
        const machines = ['Selected desktop', 'Other desktop'].map(id => ({ ...createMachine(id), active: false, activeAt: 0,
            ...(ownership === 'shared' ? { isShared: true, access: {
                custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use' as const,
                resourceMode: 'plain' as const, accessState: 'ready' as const,
            } } : {}),
        }));
        const fixture = createFixture(machines);
        publishMachineActivityForTest(fixture.machines);
        const rendered = await renderHook(() => useMachineSelectionListModel({ ...buildParams(fixture, makeHandlers()),
            recentMachines: [], favoriteMachines: [], showRecent: false, showFavorites: false, showCliGlyphs: false,
        }));
        expect(rendered.getCurrent()).toMatchObject({ selectedOption: { id: 'Selected desktop', label: 'Selected desktop' } });
        expect(rendered.getCurrent().rootStep.sections.flatMap(section => section.kind === 'static' ? section.options.map(option => option.id) : []))
            .toEqual([ownership === 'owned' ? 'offline:all' : 'offline:shared:alice']);
    });

    it('folds a large New Session offline roster once per section and expands only that section in place', async () => {
        const machines = Array.from({ length: 220 }, (_, i) => ({ ...createMachine(`offline-${i}`), active: false, activeAt: 0 }));
        const shared = machines.slice(0, 3).map(machine => ({ ...machine, id: `shared-${machine.id}`, isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use' as const, resourceMode: 'plain' as const, accessState: 'ready' as const,
        } }));
        const fixture = createFixture([...machines, ...shared]);
        publishMachineActivityForTest(fixture.machines);
        const rendered = await renderScreen(<NewSessionMachineSelectionContent {...buildParams(fixture, makeHandlers())}
            recentMachines={[]} favoriteMachines={[]} showCliGlyphs={false} />);
        try {
            const options = () => (rendered.findByType(SelectionList).props as React.ComponentProps<typeof SelectionList>)
                .rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : []);
            expect(options().map(option => option.id)).toEqual(['offline:all', 'offline:shared:alice']);
            const step = (rendered.findByType(SelectionList).props as React.ComponentProps<typeof SelectionList>).rootStep;
            const search = synthesizeSelectionListRenderPlan({ sections: step.sections, inputValue: 'offline-0',
                filterQuery: 'offline-0', dynamicSectionStates: new Map() });
            expect(search.map(section => ({ id: section.id, options: section.options.map(option => option.id) })))
                .toEqual([{ id: 'all', options: ['offline:all', 'offline-0'] },
                    { id: 'shared:alice', options: ['offline:shared:alice', 'shared-offline-0'] }]);
            await act(async () => rendered.findByTestId('new-session-machine-list:machine-root:option:offline:shared:alice')?.props.onPress());
            expect(options().map(option => option.id)).toEqual(['offline:all', 'offline:shared:alice', ...shared.map(machine => machine.id)]);
        } finally { await rendered.unmount(); }
    });

    it.each([
        { entry: 'MachineSelector dropdown', purpose: 'session', showCliGlyphs: false },
        { entry: 'MachineSelector list / New Session picker', purpose: 'session', showCliGlyphs: true },
        { entry: 'WorkerDestinationPicker finite', purpose: 'finite', showCliGlyphs: false },
        { entry: 'WorkerDestinationPicker service', purpose: 'service-start', showCliGlyphs: false },
    ] as const)('keeps section folds, custodian names and availability together for $entry', async ({ purpose, showCliGlyphs }) => {
        const own = ['own-a', 'own-b'].map(id => ({ ...createMachine(id), active: false, activeAt: 0 }));
        const shared = ['alice-a', 'alice-b'].map(id => ({ ...createMachine(id), active: false, activeAt: 0, isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use' as const,
            resourceMode: 'plain' as const, accessState: 'ready' as const,
        } }));
        const online = createMachine('online');
        const fixture = createFixture([...own, ...shared, online]);
        publishMachineActivityForTest(fixture.machines);
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, makeHandlers()), selectedMachine: null,
            recentMachines: [], favoriteMachines: [], purpose, showCliGlyphs,
            // Worker callers supply their workspace. No worker answer is fabricated here:
            // a reachable machine without a settled placement remains unavailable.
            ...(purpose === 'session' ? {} : { workerPlacement: { workspace: { serverId: 'server-a', refId: 'checkout' } } }),
        }));
        try {
            const sections = () => rendered.getCurrent().rootStep.sections.filter(section => section.kind === 'static');
            const options = () => sections().flatMap(section => section.options);
            expect(sections().find(section => section.id === 'shared:alice')?.title).toBe('machines.destinations.shared:Alice');
            expect(options().filter(option => option.id.startsWith('offline:')).map(option => option.id))
                .toEqual(['offline:all', 'offline:shared:alice']);
            expect(options().find(option => option.id === online.id)?.disabled).toBe(purpose !== 'session');
            await act(async () => options().find(option => option.id === 'offline:shared:alice')!.onSelect?.());
            expect(options().map(option => option.id)).toContain('alice-a');
            expect(options().map(option => option.id)).not.toContain('own-a');
            expect(options().find(option => option.id === 'alice-a')?.disabled).toBe(true);
        } finally { await rendered.unmount(); }
    });

    it('keeps a New Session roster row online across elapsed time and disables it on pushed activity withdrawal', async () => {
        const { publishMachineActivity } = await import('@/sync/domains/machines/machineActivity');
        vi.useFakeTimers({ toFake: ['Date'] });
        const now = Date.now();
        vi.setSystemTime(now);
        const machine = createMachine('presence-row');
        const fixture: Fixture = { machines: [machine], groups: [{ serverId: 'server-a', serverName: 'Server A',
            loading: false, signedOut: false, machines: [createScopedMachine(machine)] }], recent: [], favorites: [] };
        const rendered = await renderModel(fixture, makeHandlers());
        try {
            expect(firstStaticOption(rendered.getCurrent()).disabled).toBe(false);
            vi.setSystemTime(now + 60_001);
            expect(firstStaticOption(rendered.getCurrent()).disabled).toBe(false);
            await act(async () => publishMachineActivity(machine, { active: false, activeAt: now },
                fixture.groups.flatMap(group => group.machines.filter(row => row.id === machine.id))));
            expect(firstStaticOption(rendered.getCurrent()).subtitle).toContain('settingsOverview.machineOffline');
            expect(firstStaticOption(rendered.getCurrent()).disabled).toBe(true);
        } finally { await rendered.unmount(); vi.useRealTimers(); }
    });

    it('keeps the New Session roster on current presence across retained scoped inventory and heartbeat renewal', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { readMachineActivity } = await import('@/sync/domains/machines/machineActivity');
        const { useServerScopedMachineOptions } = await import('@/components/sessions/new/hooks/machines/useServerScopedMachineOptions');
        const now = Date.now();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(now);
        const machine = { ...createMachine('retained-roster'), activeAt: now - 20_286 };
        const fixture: Fixture = { machines: [machine], groups: [], recent: [], favorites: [] };
        const params = buildParams(fixture, makeHandlers());
        const allowedServerIds = ['server-a'];
        const activeMachines: Machine[] = [];
        storage.getState().applyMachines([machine], true, { sourceServerId: fixtureScope.serverId });
        storage.getState().markMachineListSettled(fixtureScope.serverId);
        recordMachineRequestSucceeded({ ...fixtureScope, machineId: machine.id, observedAtMs: now - 2_101 });
        const rendered = await renderHook(() => {
            const groups = useServerScopedMachineOptions({ allowedServerIds, activeServerId: 'server-a', activeMachines, inventoryPurpose: 'launch' });
            return useMachineSelectionListModel({ ...params, groups, showFavorites: false, showRecent: false });
        });
        try {
            expect(firstStaticOption(rendered.getCurrent()).subtitle).toContain('settingsOverview.machineOnline');
            const onlineModel = rendered.getCurrent();
            const inventory = storage.getState().machineListByServerId[fixtureScope.serverId];
            for (let tick = 1; tick <= 3; tick++) {
                vi.setSystemTime(now + tick * 20_000);
                await act(async () => storage.getState().applyMachineActivityUpdates([
                    { id: machine.id, active: true, activeAt: Date.now() - 20_286 },
                ], { sourceServerId: fixtureScope.serverId }));
            }
            expect(storage.getState().machineListByServerId[fixtureScope.serverId]).toBe(inventory);
            expect(inventory?.[0]?.activeAt).toBe(now - 20_286);
            expect(readMachineActivity(inventory![0]!).activeAt).toBe(now + 60_000 - 20_286);
            expect(rendered.getCurrent()).toBe(onlineModel);
            // Force the real model to observe the same request failure/recovery
            // edges as authoring. A copied heartbeat must not turn recovery Offline.
            await act(async () => { recordMachineRequestFailed({ ...fixtureScope, machineId: machine.id }); });
            await act(async () => { recordMachineRequestSucceeded({ ...fixtureScope, machineId: machine.id }); });
            const current = storage.getState().machineListByServerId[fixtureScope.serverId]![0]!;
            expect(resolveMachineReachability(fixtureScope, current)).toBe('reachable');
            const row = firstStaticOption(rendered.getCurrent());
            expect(row.subtitle).toContain('settingsOverview.machineOnline');
            expect(row.disabled).toBe(false);
        } finally { await rendered.unmount(); vi.useRealTimers(); }
    });

    it.each(['all', 'recent', 'favorites', 'shared'] as const)('agrees on %s row admission, pinned buckets and the automatic shortcut after request failure/recovery', async placement => {
        const machine: Machine = { ...createMachine('reachable-machine'), ...(placement === 'shared' ? {
            isShared: true, access: { custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use' as const,
                resourceMode: 'plain' as const, accessState: 'ready' as const },
        } : {}) };
        const fixture: Fixture = { machines: [machine], groups: [{ serverId: 'server-a', serverName: 'Server A', loading: false,
            signedOut: false, machines: [createScopedMachine(machine)] }],
            recent: placement === 'recent' ? [machine] : [], favorites: placement === 'favorites' ? [machine] : [] };
        const handlers = makeHandlers();
        const rendered = await renderModel(fixture, handlers);
        const destinations = () => buildMachineDestinationModel({ groups: fixture.groups, recentMachines: fixture.recent,
            favoriteMachines: fixture.favorites, managedMachineProjection: { state: 'unavailable', rowCount: 0 } });
        const option = () => {
            const row = rendered.getCurrent().rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : [])
                .find(row => row.id === machine.id);
            if (!row) throw new Error('expected retained Machine row');
            return row;
        };
        try {
            await act(async () => recordMachineRequestFailed({ serverId: 'other-home', accountId: 'account-a', machineId: machine.id, observedAtMs: 1 }));
            expect(option().disabled).not.toBe(true);
            expect(destinations().soleSelectableDestination?.machine.id).toBe(machine.id);
            await act(async () => recordMachineRequestFailed({ ...fixtureScope, machineId: machine.id, observedAtMs: 2 }));
            expect(option().disabled).toBe(true);
            expect(destinations().soleSelectableDestination).toBeNull();
            act(() => option().onSelect?.());
            expect(handlers.selectSpy).not.toHaveBeenCalled();
            expect(rendered.getCurrent().rootStep.sections.filter(section => section.id === 'recent' || section.id === 'favorites')).toEqual([]);
            expect(buildMachineDestinationModel({ purpose: 'finite', groups: fixture.groups,
                resolveMachinePlacementFacts: () => ({ ownership: placement === 'shared' ? 'shared' : 'owned', worker: {
                    eligible: true, candidate: { serverId: 'server-a', machineId: machine.id }, load: { kind: 'unknown' }, explanation: 'load_unknown',
                } }),
            }).soleSelectableDestination).toBeNull();
            await act(async () => recordMachineRequestSucceeded({ ...fixtureScope, machineId: machine.id, observedAtMs: 3 }));
            expect(option().disabled).not.toBe(true);
            expect(destinations().soleSelectableDestination?.machine.id).toBe(machine.id);
            act(() => option().onSelect?.());
            expect(handlers.selectSpy).toHaveBeenCalledWith(machine.id);
        } finally { await rendered.unmount(); }
    });
    it.each([
        { purpose: 'finite', ownership: 'owned', managedWake: 'asleep' },
        { purpose: 'finite', ownership: 'owned', managedWake: 'starting' },
        { purpose: 'session', ownership: 'shared', managedWake: 'asleep' },
        { purpose: 'session', ownership: 'shared', managedWake: 'starting' },
    ] as const)('allows an exact $ownership $managedWake $purpose row without inventing a guest worker status', async ({ purpose, ownership, managedWake }) => {
        const machine: Machine = { ...createMachine('sleeping'), active: false, activeAt: 1,
            ...(purpose === 'session' ? { managedInputRuntime: {
                nativeReady: false, wakeState: managedWake, newSessionWake: { kind: 'available' as const },
            } } : {}),
            ...(ownership === 'shared' ? { isShared: true, access: {
                custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready',
            } } : {}) };
        const handlers = makeHandlers();
        const fixture: Fixture = { machines: [machine], groups: [{ serverId: 'server-a', serverName: 'Server A', loading: false,
            signedOut: false, machines: [createScopedMachine(machine)] }], recent: [], favorites: [] };
        const rendered = await renderHook(() => useMachineSelectionListModel({ ...buildParams(fixture, handlers), purpose,
            resolveMachinePlacementFacts: () => ({ ownership, managedWake }) }));
        try {
            const section = rendered.getCurrent().rootStep.sections.find(section => section.kind === 'static'
                && section.options.some(option => option.id === machine.id));
            if (section?.kind !== 'static') throw new Error('expected exact Machine row');
            const option = section.options.find(option => option.id === machine.id)!;
            expect(option.disabled).not.toBe(true);
            expect(rendered.getCurrent().managedWakeByServerId['server-a']?.[machine.id]).toBe(managedWake);
            act(() => option.onSelect?.());
            expect(handlers.selectSpy).toHaveBeenCalled();
        } finally { await rendered.unmount(); }
    });
    it('keeps the option of every unchanged Machine row when one row changes (one list redraw per arrival is one row)', async () => {
        const fixture = createFixture();
        const handlers = makeHandlers();
        let groups = fixture.groups;
        const rendered = await renderHook(() => useMachineSelectionListModel({ ...buildParams(fixture, handlers), groups }));
        const optionsOf = (model: ReturnType<typeof UseMachineSelectionListModel>) => model.rootStep.sections
            .flatMap(section => section.kind === 'static' ? section.options.map(option => [`${section.id}|${option.id}`, option] as const) : []);
        const before = new Map(optionsOf(rendered.getCurrent()));
        const [changed, ...unchanged] = fixture.machines;
        const renamed = { ...changed!, metadata: { ...changed!.metadata!, displayName: 'Renamed' } };
        groups = fixture.groups.map(group => ({ ...group, machines: group.machines.map(machine => machine.id === renamed.id
            ? { ...machine, metadata: { ...machine.metadata!, displayName: 'Renamed' } } : machine) }));
        await act(async () => { await rendered.rerender(); });
        const after = new Map(optionsOf(rendered.getCurrent()));
        expect(after.size).toBe(before.size);
        let keptRows = 0;
        for (const [key, option] of after) {
            if (option.id === renamed.id || option.id.endsWith(`::${renamed.id}`)) {
                expect(option).not.toBe(before.get(key));
            } else if (unchanged.some(machine => option.id === machine.id || option.id.endsWith(`::${machine.id}`))) {
                expect(option).toBe(before.get(key));
                keptRows += 1;
            }
        }
        expect(keptRows).toBeGreaterThan(0);
        const retained = [...after.values()].find(option => unchanged.some(machine => machine.id === option.id));
        retained!.onSelect?.();
        expect(handlers.selectSpy).toHaveBeenCalledWith(retained!.id);
    });

    it('keeps the list model when a host rebuilds equal Temporary computer rows', async () => {
        const fixture = createFixture();
        const handlers = makeHandlers();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, handlers),
            // The popover overlay re-invokes its content per render; rows differ only in closure identity.
            temporaryComputers: [{ serverId: 'server-a', artifactTarget: 'darwin-arm64', selected: false,
                workspace: null, onSelect: () => {} }],
        }));
        const first = rendered.getCurrent().rootStep;
        await rendered.rerender();
        expect(rendered.getCurrent().rootStep).toBe(first);
    });

    it.each(['session', 'finite', 'service-start'] as const)('keeps %s managed recipe selection separate from published artifacts and exact machines', async purpose => {
        const fixture = createFixture();
        const handlers = makeHandlers();
        const selection = { kind: 'preset', homeId: 'server-a', id: 'recipe', revision: 3 } as const;
        const receipt = {
            launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1,
                name: 'Guest', choices: { cores: 2 } },
            controller: { machineId: 'host', installationId: 'installation' }, optionStatus: 'current' as const,
            prerequisites: [], billing: { location: 'local' as const, stoppedBilling: 'not-billed' as const },
            retentionCapabilities: { supportedIntents: ['start', 'stop', 'delete'] as ('start' | 'stop' | 'delete')[] },
            retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false,
            price: { amount: '1.25', currency: 'USD', unit: 'hour', source: 'provider', observedAt: 1 },
            preset: { id: 'recipe', revision: 3, name: 'Guest' },
        };
        const draft = { selection, receipt, archiveEffect: 'keep' as const };
        const onSelectManagedMachine = vi.fn();
        const onConfigure = vi.fn();
        const artifactSelect = vi.fn();
        const onOpenManagedPresets = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, handlers),
            purpose,
            temporaryComputers: [{ serverId: 'server-a', artifactTarget: 'darwin-arm64', selected: false,
                workspace: null, packageExpiresAt: 12345, onSelect: artifactSelect }],
            managedMachines: [{ id: 'managed-machine:server-a:preset:recipe:3', homeId: 'server-a', kind: 'preset',
                title: 'Guest', subtitle: 'host · Keep', draft }, { id: 'managed-machine:server-a:one-off', homeId: 'server-a',
                kind: 'one-off', title: 'One-off', onSelect: onConfigure }],
            selectedManagedMachine: draft,
            onSelectManagedMachine,
            onOpenManagedPresets,
        }));
        const model = rendered.getCurrent();
        const managed = model.rootStep.sections.find((section) => section.id === 'managed-machines');
        const published = model.rootStep.sections.find((section) => section.id === 'temporary-computer');
        expect(managed?.kind).toBe('static');
        expect(published?.title).toBe(purpose === 'session' ? 'newSession.temporaryComputer.publishedTitle' : undefined);
        if (managed?.kind !== 'static') throw new Error('expected a managed recipe section');
        expect(managed.options.map((row) => row.id)).toEqual([
            'managed-machine:server-a:preset:recipe:3', 'managed-machine:server-a:one-off',
        ]);
        // "New machine" with a quiet trailing "Presets" destination; a preset reads as a preset, one-off as an add.
        expect(managed.title).toBe('newSession.managedMachine.title');
        expect(managed.action?.label).toBe('machinePresets.short');
        managed.action?.onPress();
        expect(onOpenManagedPresets).toHaveBeenCalledOnce();
        expect((managed.options[0]?.icon as React.ReactElement<{ name: string }>).props.name).toBe('stack');
        // The one-off entry reads as making a new one (circled plus); Connect a computer keeps the bare plus (lab m-pick).
        expect((managed.options[1]?.icon as React.ReactElement<{ name: string }>).props.name).toBe('plus-circle');
        expect(model.selectedOptionId).toBe('managed-machine:server-a:preset:recipe:3');
        expect(managed.options[0]?.rightAccessory).toBeUndefined();
        expect(managed.options[0]?.subtitle).not.toContain('1.25');
        expect(managed.options[0]?.subtitle).toBe(purpose === 'finite'
            ? 'host · Keep · managedMachines.picker.createdOnRun' : 'host · Keep');
        expect(managed.options[1]?.subtitle).toBe(purpose === 'finite' ? 'managedMachines.picker.createdOnRun' : undefined);
        managed.options[0]?.onSelect?.();
        expect(onSelectManagedMachine).toHaveBeenCalledWith(draft);
        managed.options[1]?.onSelect?.();
        expect(onConfigure).toHaveBeenCalledOnce();
        expect(artifactSelect).not.toHaveBeenCalled();
        expect(handlers.selectSpy).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('selects an unreviewed default preset by its qualified Home and opens the existing configurator', async () => {
        const fixture = createFixture();
        const handlers = makeHandlers();
        const configure = vi.fn();
        const preset = { id: 'recipe', homeId: 'home-a', revision: 2, name: 'Guest',
            owner: { kind: 'account' as const, accountId: 'owner' },
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} } };
        const managedMachines = ['home-a', 'home-b'].flatMap(homeId => buildManagedMachineSelectionOffers({
            homeId, presets: [{ ...preset, homeId }], oneOffTitle: 'One-off', onConfigure: configure,
        }));
        const rendered = await renderHook((homeId: string) => useMachineSelectionListModel({
            ...buildParams(fixture, handlers), managedMachines,
            managedPlacementPreset: { kind: 'preset', homeId, presetId: 'recipe' },
        }), { initialProps: 'home-a' });
        try {
            expect(rendered.getCurrent().selectedOptionId).toBe('managed-machine:home-a:preset:recipe:2');
            const section = rendered.getCurrent().rootStep.sections.find(section => section.id === 'managed-machines');
            if (section?.kind !== 'static') throw new Error('expected preset choices');
            section.options.find(option => option.id === rendered.getCurrent().selectedOptionId)?.onSelect?.();
            expect(configure).toHaveBeenCalledWith(preset);
            await rendered.rerender('home-b');
            expect(rendered.getCurrent().selectedOptionId).toBe('managed-machine:home-b:preset:recipe:2');
        } finally { await rendered.unmount(); }
    });

    it('does not expose managed recipes for purposes that require an existing destination', async () => {
        const fixture = createFixture();
        const handlers = makeHandlers();
        const onSelect = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, handlers), purpose: 'trigger',
            managedMachines: [{ id: 'managed-machine:server-a:one-off', homeId: 'server-a', title: 'One-off', onSelect }],
        }));
        expect(rendered.getCurrent().rootStep.sections.some((section) => section.id === 'managed-machines')).toBe(false);
        expect(onSelect).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('retires an old managed row activation when its purpose or Home offer is replaced or unavailable', async () => {
        const fixture = createFixture();
        const handlers = makeHandlers();
        const onSelect = vi.fn();
        const offer: ManagedMachineSelectionOffer = { id: 'managed-machine:server-a:one-off', homeId: 'server-a', title: 'One-off', onSelect };
        const base = buildParams(fixture, handlers);
        const rendered = await renderHook(
            (props: BuildMachineSelectionListModelParams) => useMachineSelectionListModel(props),
            { initialProps: { ...base, managedMachines: [offer] } },
        );
        const section = rendered.getCurrent().rootStep.sections.find((candidate) => candidate.id === 'managed-machines');
        if (section?.kind !== 'static') throw new Error('expected a managed recipe section');
        const oldOption = section.options[0]!;
        await rendered.rerender({ ...base, purpose: 'trigger', managedMachines: [offer] });
        oldOption.onSelect?.();
        expect(onSelect).not.toHaveBeenCalled();
        await rendered.rerender({ ...base, managedMachines: [{ ...offer, disabled: true, unavailableText: 'offline' }] });
        oldOption.onSelect?.();
        expect(onSelect).not.toHaveBeenCalled();
        await rendered.rerender({ ...base, managedMachines: [{ ...offer, id: 'managed-machine:server-b:one-off', homeId: 'server-b' }] });
        oldOption.onSelect?.();
        expect(onSelect).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('keeps exact shared Home targets grouped and prevents a presentation override widening readiness for Sessions and triggers', async () => {
        const ready: Machine = { ...createMachine('shared'), isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready',
        } };
        const pending: Machine = { ...ready, id: 'pending', metadata: null,
            access: { ...ready.access!, accessState: 'key_pending' },
            availability: { kind: 'locked', reason: 'recipient_key_pending' } };
        const own = createMachine('own');
        const group = { serverId: 'server-a', serverName: 'Server A', loading: false, signedOut: false,
            machines: [own, ready, pending].map(createScopedMachine) };
        const scopedSelect = vi.fn();
        const params = (purpose: 'session' | 'trigger'): BuildMachineSelectionListModelParams => ({
            groups: [group, { ...group, serverId: 'server-b', serverName: 'Server B', machines: [] }],
            selectedMachine: pending, selectedServerId: 'server-a', recentMachines: [], favoriteMachines: [],
            showFavorites: false, showRecent: false, showSearch: false, showCliGlyphs: false, autoDetectCliGlyphs: false,
            onSelectMachine: vi.fn(), onSelectScopedMachine: scopedSelect, purpose,
            resolveMachineAvailability: () => ({ selectable: true }),
        });
        const model = await renderHook(() => useMachineSelectionListModel(params('session')));
        const shared = model.getCurrent().rootStep.sections.find((section) => section.id === 'server:server-a:shared:alice');
        if (shared?.kind !== 'static') throw new Error('expected a scoped shared ownership section');
        const { describeMachineSharedGroupTitle, describeMachineSharedOwnership } = await import('@/sync/domains/machines/machineOwnershipGroups');
        expect(shared.title).toBe(`Server A · ${describeMachineSharedGroupTitle(ready.access!.custodian)}`);
        expect(shared.options.map((option) => option.id)).toEqual(['server-a::shared', 'server-a::pending']);
        // The group already names the owner; the row says its own facts once (FIN-DESIGN-REVIEW L5).
        expect(shared.options[0]?.subtitle).not.toContain(describeMachineSharedOwnership(ready));
        expect(shared.options[0]?.subtitle).toContain('macOS');
        expect(model.getCurrent().selectedOptionId).toBe('server-a::pending');
        expect(shared.options[1]?.disabled).toBe(true);
        shared.options[1]?.onSelect?.();
        expect(scopedSelect).not.toHaveBeenCalled();
        shared.options[0]?.onSelect?.();
        expect(scopedSelect).toHaveBeenCalledWith(group.machines[1]);
        await model.unmount();
        scopedSelect.mockClear();
        const trigger = await renderHook(() => useMachineSelectionListModel(params('trigger')));
        const triggerShared = trigger.getCurrent().rootStep.sections.find((section) => section.id === 'server:server-a:shared:alice');
        if (triggerShared?.kind !== 'static') throw new Error('expected retained shared section');
        // The 2026-11-03 shared-Workflow ruling admits ready shared trigger targets.
        expect(triggerShared.options.map(option => Boolean(option.disabled))).toEqual([false, true]);
        triggerShared.options[1]?.onSelect?.();
        expect(scopedSelect).not.toHaveBeenCalled();
        triggerShared.options[0]?.onSelect?.();
        expect(scopedSelect).toHaveBeenCalledWith(group.machines[1]);
        await trigger.unmount();
    });

    it('says an offline shared machine is offline once, under the group that names its owner (FIN-DESIGN-REVIEW L5)', async () => {
        const offline: Machine = { ...createMachine('shared-offline'), active: false, activeAt: 1, isShared: true, access: {
            custodian: { accountId: 'alice', displayName: 'Alice' }, role: 'use', resourceMode: 'plain', accessState: 'ready',
        } };
        const group = { serverId: 'server-a', serverName: 'Server A', loading: false, signedOut: false, machines: [createScopedMachine(offline)] };
        const model = await renderHook(() => useMachineSelectionListModel({ groups: [group],
            selectedMachine: offline, selectedServerId: 'server-a', recentMachines: [], favoriteMachines: [], showFavorites: false, showRecent: false,
            showSearch: false, showCliGlyphs: false, autoDetectCliGlyphs: false, onSelectMachine: vi.fn(), onSelectScopedMachine: vi.fn() }));
        const option = model.getCurrent().rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : [])
            .find(entry => entry.id.endsWith('shared-offline'));
        const { describeMachineSharedOwnership } = await import('@/sync/domains/machines/machineOwnershipGroups');
        expect(option?.subtitle).toBeDefined();
        expect(option?.subtitle).not.toContain('common.unavailable');
        expect(option?.subtitle).not.toContain(describeMachineSharedOwnership(offline)!);
        await model.unmount();
    });
    it.each([true, false])('keeps a shared bucket distinct when its custodian name is unavailable (single Home: %s)', async singleHome => {
        const shared = { ...createMachine('shared-without-owner'), isShared: true };
        const group = { serverId: 'server-a', serverName: 'Server A', loading: false, signedOut: false, machines: [createScopedMachine(shared)] };
        const model = await renderHook(() => useMachineSelectionListModel({ groups: singleHome ? [group] : [group, { ...group, serverId: 'server-b', machines: [] }],
            selectedMachine: null, selectedServerId: 'server-a', recentMachines: [], favoriteMachines: [], showFavorites: false, showRecent: false,
            showSearch: false, showCliGlyphs: false, autoDetectCliGlyphs: false, onSelectMachine: vi.fn(), onSelectScopedMachine: vi.fn() }));
        const section = model.getCurrent().rootStep.sections.find(section => section.id === (singleHome ? 'shared:' : 'server:server-a:shared:'));
        const { describeMachineSharedGroupTitle } = await import('@/sync/domains/machines/machineOwnershipGroups');
        expect(section?.title).toBe(`${singleHome ? '' : 'Server A · '}${describeMachineSharedGroupTitle(undefined)}`);
        await model.unmount();
    });
    it('names a single Home\'s own machines "Your machines" (lab m-pick)', async () => {
        const fixture = createFixture();
        const rendered = await renderModel({ ...fixture, recent: [], favorites: [] }, makeHandlers());
        const titles = rendered.getCurrent().rootStep.sections.map((section) => section.kind === 'static' ? section.title : undefined);
        expect(titles).toContain('machines.destinations.yours');
        expect(titles).not.toContain('newSession.machinePicker.allTitle');
    });

    it('shows a machine\'s favorite star on web only when it is a favorite or its row is under the pointer or keyboard', async () => {
        const { Platform } = await import('react-native');
        const { renderScreen } = await import('@/dev/testkit');
        const { SelectionListOptionStateContext } = await import('@/components/ui/selectionList/SelectionListOptionStateContext');
        const { MachineSelectionRowAccessory } = await import('./MachineSelectionRowAccessory');
        const previousOS = Platform.OS;
        Object.defineProperty(Platform, 'OS', { value: 'web', configurable: true, writable: true });
        try {
            const machine = { ...createMachine('quiet'), active: false, activeAt: 0 };
            const stars = async (state: Readonly<{ hovered: boolean; focused: boolean }>, isFavorite: boolean) => {
                const screen = await renderScreen(
                    <SelectionListOptionStateContext.Provider value={state}>
                        <MachineSelectionRowAccessory machine={machine} showCliGlyphs={false} autoDetectCliGlyphs={false}
                            showFavoriteToggle isFavorite={isFavorite} onToggleFavorite={() => {}} />
                    </SelectionListOptionStateContext.Provider>,
                );
                const count = screen.tree.findAll((node) => node.props.accessibilityRole === 'button'
                    && typeof node.props.onPress === 'function').length;
                await screen.unmount();
                return count;
            };
            expect(await stars({ hovered: false, focused: false }, false)).toBe(0);
            expect(await stars({ hovered: true, focused: false }, false)).toBeGreaterThan(0);
            expect(await stars({ hovered: false, focused: true }, false)).toBeGreaterThan(0);
            expect(await stars({ hovered: false, focused: false }, true)).toBeGreaterThan(0);
        } finally {
            Object.defineProperty(Platform, 'OS', { value: previousOS, configurable: true, writable: true });
        }
    });

    it('keeps the selected unavailable machine visible without allowing activation', async () => {
        const machine = { ...createMachine('retired'), revokedAt: Date.now() };
        const onSelectMachine = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [{ serverId: 'server-a', serverName: 'Server A', loading: false, signedOut: false, machines: [createScopedMachine(machine)] }],
            selectedMachine: machine, selectedServerId: 'server-a', recentMachines: [], favoriteMachines: [],
            onSelectMachine, onSelectScopedMachine: vi.fn(), includeSelectedUnavailableMachineId: machine.id,
            showFavorites: true, showRecent: true, showSearch: true, showCliGlyphs: false, autoDetectCliGlyphs: false,
        }));
        const section = rendered.getCurrent().rootStep.sections[0];
        expect(section?.kind).toBe('static');
        if (section?.kind !== 'static') throw new Error('expected unavailable machine section');
        expect(section.options[0]?.disabled).toBe(true);
        section.options[0]?.onSelect?.();
        expect(onSelectMachine).not.toHaveBeenCalled();
    });

    it('shows the resolved Temporary computer target even when no machine is available', async () => {
        const onSelectTemporaryComputer = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [],
            selectedMachine: null,
            selectedServerId: 'server-a',
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            temporaryComputers: [{
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                selected: true,
                workspace: { kind: 'endpoint_home' },
                onSelect: onSelectTemporaryComputer,
            }],
            showFavorites: true,
            showRecent: true,
            showSearch: true,
            showCliGlyphs: true,
            autoDetectCliGlyphs: true,
            testIdPrefix: 'new-session-machine',
        }));

        const section = rendered.getCurrent().rootStep.sections[0];
        expect(section?.kind).toBe('static');
        if (section?.kind !== 'static') throw new Error('expected the Temporary computer section');
        expect(section.options).toHaveLength(1);
        expect(section.options[0]).toMatchObject({
            id: 'temporary-computer:server-a:linux-x64',
            testID: 'new-session-machine-temporary-computer:server-a:linux-x64',
            label: 'newSession.temporaryComputer.title',
        });
        expect(rendered.getCurrent().selectedOptionId).toBe('temporary-computer-workspace:server-a:linux-x64:endpoint_home');

        const workspaceStep = section.options[0]!.openStep;
        expect(workspaceStep).toMatchObject({
            id: 'temporary-computer-workspace:server-a:linux-x64',
            title: 'newSession.temporaryComputer.workspace.title',
        });
        // Expiry is offered beside the folder, defaulting to Never, and the
        // folder choice is what commits the target.
        const expirySection = workspaceStep?.sections[0];
        if (expirySection?.kind !== 'static') throw new Error('expected the expiry section');
        expect(expirySection.options.map((option) => option.id)).toEqual([
            'temporary-computer-expiry:server-a:linux-x64:never',
            'temporary-computer-expiry:server-a:linux-x64:inOneDay',
            'temporary-computer-expiry:server-a:linux-x64:inOneWeek',
            'temporary-computer-expiry:server-a:linux-x64:custom',
        ]);
        // Never is the default, and the section says so in the one place the
        // list actually renders a current answer.
        expect(expirySection.resultHint).toBe('newSession.temporaryComputer.expiry.never');

        const workspaceSection = workspaceStep?.sections[1];
        if (workspaceSection?.kind !== 'static') throw new Error('expected the workspace section');
        // The step names the endpoint's folder from the endpoint's point of
        // view — the creator is not choosing their own working directory — and
        // marks the recommended default the same way the expiry section marks
        // its own.
        expect(workspaceSection.title).toBe('newSession.temporaryComputer.workspace.title');
        expect(workspaceSection.options.map((option) => [option.id, option.label, option.subtitle])).toEqual([
            [
                'temporary-computer-workspace:server-a:linux-x64:choose_on_endpoint',
                'newSession.temporaryComputer.target.workspaceChoose',
                'newSession.temporaryComputer.workspace.chooseRecommended',
            ],
            [
                'temporary-computer-workspace:server-a:linux-x64:endpoint_home',
                'newSession.temporaryComputer.target.workspaceHome',
                'newSession.temporaryComputer.workspace.homeDetail',
            ],
        ]);
        // The committed folder is echoed in the one place the list renders a
        // current answer, exactly like the expiry beside it.
        expect(workspaceSection.resultHint).toBe('newSession.temporaryComputer.target.workspaceHome');
        workspaceSection.options[0]!.onSelect?.();
        workspaceSection.options[1]!.onSelect?.();
        expect(onSelectTemporaryComputer).toHaveBeenNthCalledWith(1, { kind: 'choose_on_endpoint' }, undefined);
        expect(onSelectTemporaryComputer).toHaveBeenNthCalledWith(2, { kind: 'endpoint_home' }, undefined);
        await rendered.unmount();
    });

    it('commits an explicitly chosen package expiry as an absolute instant with the folder', async () => {
        const onSelectTemporaryComputer = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [],
            selectedMachine: null,
            selectedServerId: 'server-a',
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            temporaryComputers: [{
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                selected: false,
                workspace: null,
                onSelect: onSelectTemporaryComputer,
            }],
            showFavorites: true,
            showRecent: true,
            showSearch: true,
            showCliGlyphs: true,
            autoDetectCliGlyphs: true,
        }));

        const readWorkspaceStep = () => {
            const section = rendered.getCurrent().rootStep.sections[0];
            if (section?.kind !== 'static') throw new Error('expected the Temporary computer section');
            return section.options[0]?.openStep;
        };
        const readExpirySection = () => {
            const expiry = readWorkspaceStep()?.sections[0];
            if (expiry?.kind !== 'static') throw new Error('expected the expiry section');
            return expiry;
        };
        const expiryOptions = () => readExpirySection().options;

        const before = Date.now();
        await act(async () => { expiryOptions()[1]!.onSelect?.(); });
        const after = Date.now();
        // This suite's `t` returns keys, so the exact instant is proven by the
        // commit below; here the section must stop reporting Never.
        expect(readExpirySection().resultHint).toBe('newSession.temporaryComputer.expiry.expiresAt');

        const workspace = readWorkspaceStep()?.sections[1];
        if (workspace?.kind !== 'static') throw new Error('expected the workspace section');
        await act(async () => { workspace.options[1]!.onSelect?.(); });

        expect(onSelectTemporaryComputer).toHaveBeenCalledTimes(1);
        const [committedWorkspace, committedExpiry] = onSelectTemporaryComputer.mock.calls[0]!;
        expect(committedWorkspace).toEqual({ kind: 'endpoint_home' });
        // Absolute, resolved once at selection time — not a duration anything
        // downstream has to count down.
        expect(committedExpiry).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);
        expect(committedExpiry).toBeLessThanOrEqual(after + 24 * 60 * 60 * 1000);
        await rendered.unmount();
    });

    it('commits an arbitrary future instant chosen through the shared date and time editor', async () => {
        const onSelectTemporaryComputer = vi.fn();
        // A moment no offered shortcut can produce: the contract is an optional
        // absolute expiry the author states exactly, not a menu of durations.
        const chosen = new Date(2031, 4, 17, 6, 42).getTime();
        modalHost.show.mockClear();
        modalHost.show.mockImplementation((config: unknown) => {
            const resolve = (config as { props: { onResolve: (value: number | null) => void } }).props.onResolve;
            queueMicrotask(() => resolve(chosen));
            return 'modal-id';
        });
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [],
            selectedMachine: null,
            selectedServerId: 'server-a',
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            temporaryComputers: [{
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                selected: false,
                workspace: null,
                onSelect: onSelectTemporaryComputer,
            }],
            showFavorites: true,
            showRecent: true,
            showSearch: true,
            showCliGlyphs: true,
            autoDetectCliGlyphs: true,
        }));

        const readWorkspaceStep = () => {
            const section = rendered.getCurrent().rootStep.sections[0];
            if (section?.kind !== 'static') throw new Error('expected the Temporary computer section');
            return section.options[0]?.openStep;
        };
        const readExpirySection = () => {
            const expiry = readWorkspaceStep()?.sections[0];
            if (expiry?.kind !== 'static') throw new Error('expected the expiry section');
            return expiry;
        };

        await act(async () => { readExpirySection().options[3]!.onSelect?.(); });
        await act(async () => { await Promise.resolve(); });

        expect(modalHost.show).toHaveBeenCalledOnce();
        expect(readExpirySection().resultHint).toBe('newSession.temporaryComputer.expiry.expiresAt');

        const workspace = readWorkspaceStep()?.sections[1];
        if (workspace?.kind !== 'static') throw new Error('expected the workspace section');
        await act(async () => { workspace.options[0]!.onSelect?.(); });

        expect(onSelectTemporaryComputer).toHaveBeenCalledWith({ kind: 'choose_on_endpoint' }, chosen);
        modalHost.show.mockReset();
        modalHost.show.mockImplementation(() => 'modal-id');
        await rendered.unmount();
    });

    it('keeps the committed expiry when the author backs out of the date and time editor', async () => {
        const onSelectTemporaryComputer = vi.fn();
        const committed = new Date(2030, 0, 2, 3, 4).getTime();
        modalHost.show.mockClear();
        modalHost.show.mockImplementation((config: unknown) => {
            const resolve = (config as { props: { onResolve: (value: number | null) => void } }).props.onResolve;
            queueMicrotask(() => resolve(null));
            return 'modal-id';
        });
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [],
            selectedMachine: null,
            selectedServerId: 'server-a',
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            temporaryComputers: [{
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                selected: true,
                workspace: { kind: 'endpoint_home' },
                packageExpiresAt: committed,
                onSelect: onSelectTemporaryComputer,
            }],
            showFavorites: true,
            showRecent: true,
            showSearch: true,
            showCliGlyphs: true,
            autoDetectCliGlyphs: true,
        }));

        const readWorkspaceStep = () => {
            const section = rendered.getCurrent().rootStep.sections[0];
            if (section?.kind !== 'static') throw new Error('expected the Temporary computer section');
            return section.options[0]?.openStep;
        };
        const expiry = readWorkspaceStep()?.sections[0];
        if (expiry?.kind !== 'static') throw new Error('expected the expiry section');
        await act(async () => { expiry.options[3]!.onSelect?.(); });
        await act(async () => { await Promise.resolve(); });

        const workspace = readWorkspaceStep()?.sections[1];
        if (workspace?.kind !== 'static') throw new Error('expected the workspace section');
        await act(async () => { workspace.options[1]!.onSelect?.(); });

        expect(onSelectTemporaryComputer).toHaveBeenCalledWith({ kind: 'endpoint_home' }, committed);
        modalHost.show.mockReset();
        modalHost.show.mockImplementation(() => 'modal-id');
        await rendered.unmount();
    });

    it('names each published platform row for a person rather than by artifact id', async () => {
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [],
            selectedMachine: null,
            selectedServerId: 'server-a',
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            temporaryComputers: [{
                serverId: 'server-a',
                artifactTarget: 'darwin-arm64',
                selected: false,
                workspace: null,
                onSelect: vi.fn(),
            }, {
                serverId: 'server-a',
                artifactTarget: 'windows-x64',
                selected: false,
                workspace: null,
                onSelect: vi.fn(),
            }],
            showFavorites: true,
            showRecent: true,
            showSearch: true,
            showCliGlyphs: true,
            autoDetectCliGlyphs: true,
        }));

        const section = rendered.getCurrent().rootStep.sections[0];
        if (section?.kind !== 'static') throw new Error('expected the Temporary computer section');
        const platformSection = section.options[0]?.openStep?.sections[0];
        if (platformSection?.kind !== 'static') throw new Error('expected the platform section');
        for (const option of platformSection.options) {
            expect(option.label).not.toMatch(/^(darwin|windows|linux)-/);
            // The accessible name says the same thing the row shows, so a screen
            // reader never hears an identifier the screen does not display.
            expect(option.accessibilityLabel).toContain(option.label as string);
        }
        expect(platformSection.options[0]?.label).toBe('newSession.temporaryComputer.platform.darwin-arm64');
        expect(platformSection.options[1]?.label).toBe('newSession.temporaryComputer.platform.windows-x64');
        await rendered.unmount();
    });

    it('keeps platform and workspace as nested picker steps when several artifacts are available', async () => {
        const selectLinux = vi.fn();
        const selectWindows = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [],
            selectedMachine: null,
            selectedServerId: 'server-a',
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            temporaryComputers: [{
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                selected: false,
                workspace: null,
                onSelect: selectLinux,
            }, {
                serverId: 'server-a',
                artifactTarget: 'windows-x64',
                selected: false,
                workspace: null,
                onSelect: selectWindows,
            }],
            showFavorites: true,
            showRecent: true,
            showSearch: true,
            showCliGlyphs: true,
            autoDetectCliGlyphs: true,
        }));

        const section = rendered.getCurrent().rootStep.sections[0];
        if (section?.kind !== 'static') throw new Error('expected the Temporary computer section');
        const platformStep = section.options[0]?.openStep;
        const platformSection = platformStep?.sections[0];
        if (platformSection?.kind !== 'static') throw new Error('expected the platform section');
        expect(platformSection.options).toHaveLength(2);
        expect(platformSection.options[0]?.openStep?.id).toBe('temporary-computer-workspace:server-a:linux-x64');
        expect(platformSection.options[1]?.openStep?.id).toBe('temporary-computer-workspace:server-a:windows-x64');
        expect(selectLinux).not.toHaveBeenCalled();
        expect(selectWindows).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('keeps an unavailable restored Temporary computer visible and routes retry to its projection owner', async () => {
        const retry = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups: [],
            selectedMachine: null,
            selectedServerId: 'server-a',
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            temporaryComputers: [{
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                selected: true,
                workspace: { kind: 'choose_on_endpoint' },
                disabled: true,
                unavailableText: 'newSession.temporaryComputer.status.failed',
                onRetry: retry,
                onSelect: vi.fn(),
            }],
            showFavorites: true,
            showRecent: true,
            showSearch: true,
            showCliGlyphs: true,
            autoDetectCliGlyphs: true,
            testIdPrefix: 'new-session-machine',
        }));

        const section = rendered.getCurrent().rootStep.sections[0];
        if (section?.kind !== 'static') throw new Error('expected the Temporary computer section');
        expect(section.options[0]).toMatchObject({
            id: 'temporary-computer:server-a:linux-x64',
            disabled: true,
            subtitle: 'newSession.temporaryComputer.status.failed',
        });
        expect(section.options[0]?.openStep).toBeUndefined();
        // One failure, one row (DRA D13): the retry is the section's action, not a second option row.
        expect(section.options).toHaveLength(1);
        expect(section.action).toMatchObject({ label: 'common.retry' });
        section.action?.onPress();
        expect(retry).toHaveBeenCalledOnce();
        expect(rendered.getCurrent().selectedOptionId).toBe('temporary-computer:server-a:linux-x64');
        await rendered.unmount();
    });

    it('shows pending and retryable unavailable feedback on the selected Pool row', async () => {
        const fixture = createFixture();
        const poolId = '3a948f0c-bc30-491c-b764-37f0e6744d1f';
        const base = {
            ...buildParams(fixture, makeHandlers()),
            poolGroups: [{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                pools: [{
                    pool: {
                        id: poolId,
                        name: 'Development',
                        description: null,
                        revision: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        members: [],
                    },
                    availability: { state: 'known' as const, connectedCount: 1, enabledCount: 1 },
                }],
            }],
            onSelectPool: vi.fn(),
        };
        const rendered = await renderHook(
            (props: BuildMachineSelectionListModelParams) => useMachineSelectionListModel(props),
            {
                initialProps: {
                    ...base,
                    poolSelectionStatus: { kind: 'resolving', serverId: 'server-a', accountId: 'account-a', poolId },
                },
            },
        );

        let poolOption = firstStaticOption(rendered.getCurrent());
        expect(poolOption.subtitle).toBe('machinePools.resolvingTarget');
        expect(poolOption.disabled).toBe(true);

        await rendered.rerender({
            ...base,
            poolSelectionStatus: {
                kind: 'unavailable',
                serverId: 'server-a',
                accountId: 'account-a',
                poolId,
                reason: 'no_available_machine',
            },
        });
        poolOption = firstStaticOption(rendered.getCurrent());
        expect(poolOption.subtitle).toBe('machinePools.resolveNoAvailable');
        expect(poolOption.disabled).toBe(false);
        await rendered.unmount();
    });

    it('keeps a retained Pool row readable without advertising its cached connection count as current', async () => {
        const fixture = createFixture();
        const poolId = '3a948f0c-bc30-491c-b764-37f0e6744d1f';
        const onSelectPool = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, makeHandlers()),
            poolGroups: [{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                status: 'error',
                projectionReady: true,
                pools: [{
                    pool: {
                        id: poolId, name: 'Development', description: null,
                        revision: 1, createdAt: 1, updatedAt: 1, members: [],
                    },
                    availability: { state: 'known' as const, connectedCount: 2, enabledCount: 2 },
                }],
            }],
            onSelectPool,
            onRefreshPools: vi.fn(),
        }));

        const poolOption = firstStaticOption(rendered.getCurrent());
        expect(poolOption.disabled).toBe(true);
        expect(poolOption.subtitle).toContain('machinePools.refreshFailed');
        expect(poolOption.subtitle).not.toContain('machinePools.availabilityKnown');
        poolOption.onSelect?.();
        expect(onSelectPool).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('does not resolve a retained Pool row while its Home Machine list is failed', async () => {
        const fixture = createFixture();
        const onSelectPool = vi.fn();
        const failedGroups = fixture.groups.map((group) => ({ ...group, error: true }));
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams({ ...fixture, groups: failedGroups }, makeHandlers()),
            poolGroups: [{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                status: 'idle',
                projectionReady: true,
                pools: [{
                    pool: {
                        id: 'pool-a', name: 'Development', description: null,
                        revision: 1, createdAt: 1, updatedAt: 1, members: [],
                    },
                    availability: { state: 'known' as const, connectedCount: 1, enabledCount: 1 },
                }],
            }],
            onSelectPool,
        }));

        const poolOption = firstStaticOption(rendered.getCurrent());
        expect(poolOption.disabled).toBe(true);
        expect(poolOption.subtitle).toContain('common.error');
        expect(poolOption.subtitle).not.toContain('machinePools.availabilityKnown');
        poolOption.onSelect?.();
        expect(onSelectPool).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('names a Pool member whose decrypted Machine metadata is unavailable as a locked machine', async () => {
        const fixture = createFixture();
        const machineId = 'machine-without-readable-metadata';
        const unidentifiedMachine = createMachine(machineId);
        // Sync explicitly marks an unreadable Machine locked; null metadata alone can still be hydrating.
        unidentifiedMachine.metadata = null;
        unidentifiedMachine.availability = { kind: 'locked', reason: 'decryption_failed' };
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams({
                ...fixture,
                groups: [{
                    ...fixture.groups[0]!,
                    machines: [createScopedMachine(unidentifiedMachine)],
                }],
            }, makeHandlers()),
            poolGroups: [{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                status: 'idle',
                projectionReady: true,
                pools: [{
                    pool: {
                        id: 'pool-a',
                        name: 'Development',
                        description: null,
                        revision: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        members: [{
                            machineId,
                            enabled: true,
                            priorityTier: 0,
                            state: 'connected',
                        }],
                    },
                    availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
                }],
            }],
            onSelectPool: vi.fn(),
        }));

        const poolOption = firstStaticOption(rendered.getCurrent());
        // A member whose details cannot be read is a locked machine, never a raw or short id.
        const { getMachineDisplayName } = await import('@/utils/sessions/machineDisplayNames');
        const lockedName = getMachineDisplayName(unidentifiedMachine);
        expect(poolOption.subtitle).toContain(lockedName);
        expect(poolOption.accessibilityLabel).toContain(lockedName);
        expect(poolOption.subtitle).not.toContain(machineId.slice(0, 8));
        await rendered.unmount();
    });

    it('uses only enabled members in the visible and accessible Pool preview', async () => {
        const fixture = createFixture();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, makeHandlers()),
            poolGroups: [{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                status: 'idle',
                projectionReady: true,
                pools: [{
                    pool: {
                        id: 'pool-a', name: 'Development', description: null,
                        revision: 1, createdAt: 1, updatedAt: 1,
                        members: [
                            { machineId: 'm-1', enabled: false, priorityTier: 0, state: 'connected' },
                            { machineId: 'm-2', enabled: true, priorityTier: 1, state: 'connected' },
                            { machineId: 'm-3', enabled: true, priorityTier: 1, state: 'connected' },
                        ],
                    },
                    availability: { state: 'known', connectedCount: 2, enabledCount: 2 },
                }],
            }],
            onSelectPool: vi.fn(),
        }));

        const poolOption = firstStaticOption(rendered.getCurrent());
        expect(poolOption.subtitle).toContain('m-2, m-3');
        expect(poolOption.subtitle).not.toContain('m-1');
        expect(poolOption.accessibilityLabel).toContain('m-2, m-3');
        expect(poolOption.accessibilityLabel).not.toContain('m-1');
        await rendered.unmount();
    });

    it('includes the exact Home in accessible Pool labels when several Homes are shown', async () => {
        const machineA = createScopedMachine(createMachine('machine-a'));
        const machineB = {
            ...createScopedMachine(createMachine('machine-a')),
            serverId: 'server-b',
            serverName: 'Server B',
        };
        const pool = (id: string) => ({
            pool: {
                id,
                name: 'Development',
                description: null,
                revision: 1,
                createdAt: 1,
                updatedAt: 1,
                members: [{ machineId: 'machine-a', priorityTier: 0, enabled: true, state: 'connected' as const }],
            },
            availability: { state: 'known' as const, connectedCount: 1, enabledCount: 1 },
        });
        const groups = [
            { serverId: 'server-a', serverName: 'Server A', loading: false, signedOut: false, machines: [machineA] },
            { serverId: 'server-b', serverName: 'Server B', loading: false, signedOut: false, machines: [machineB] },
        ];
        const rendered = await renderHook(() => useMachineSelectionListModel({
            groups,
            poolGroups: [
                { serverId: 'server-a', accountId: 'account-a', serverName: 'Server A', status: 'idle', projectionReady: true, pools: [pool('pool-a')] },
                { serverId: 'server-b', accountId: 'account-b', serverName: 'Server B', status: 'idle', projectionReady: true, pools: [pool('pool-b')] },
            ],
            selectedMachine: null,
            selectedServerId: null,
            recentMachines: [],
            favoriteMachines: [],
            onSelectMachine: vi.fn(),
            onSelectScopedMachine: vi.fn(),
            onSelectPool: vi.fn(),
            showFavorites: false,
            showRecent: false,
            showSearch: true,
            showCliGlyphs: false,
            autoDetectCliGlyphs: false,
        }));

        const poolSections = rendered.getCurrent().rootStep.sections.filter((section) => (
            section.kind === 'static' && section.id.endsWith(':machine-pools')
        ));
        expect(poolSections).toHaveLength(2);
        expect(poolSections[0]?.kind === 'static' ? poolSections[0].options[0]?.accessibilityLabel : '').toContain('Server A');
        expect(poolSections[1]?.kind === 'static' ? poolSections[1].options[0]?.accessibilityLabel : '').toContain('Server B');
        await rendered.unmount();
    });

    it('says a failed Pool read and its Retry on one row when the Home has no Pools to show', async () => {
        const fixture = createFixture();
        const onRefreshPools = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, makeHandlers()),
            poolGroups: [{ serverId: 'server-a', accountId: 'account-a', serverName: 'Server A', status: 'error', projectionReady: true, pools: [] }],
            onSelectPool: vi.fn(),
            onRefreshPools,
        }));
        const section = rendered.getCurrent().rootStep.sections[0];
        if (section?.kind !== 'static') throw new Error('expected the Pool section');
        expect(section.options.map((option) => option.id)).toEqual(['pool-refresh:server-a']);
        const row = section.options[0]!;
        expect(row.label).toBe('machinePools.refreshFailed');
        expect(row.rightAccessory).toBeTruthy();
        row.onSelect?.();
        expect(onRefreshPools).toHaveBeenCalledWith('server-a');
        await rendered.unmount();
    });

    it('offers a failed Home an explicit retry into the canonical Machine refresh owner', async () => {
        const fixture = createFixture();
        const failedGroups = fixture.groups.map((group) => ({ ...group, error: true }));
        const onRefreshMachines = vi.fn();
        const onRefreshPools = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams({ ...fixture, groups: failedGroups }, makeHandlers()),
            poolGroups: [{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                status: 'idle',
                projectionReady: true,
                pools: [{
                    pool: {
                        id: 'pool-a', name: 'Development', description: null,
                        revision: 1, createdAt: 1, updatedAt: 1, members: [],
                    },
                    availability: { state: 'unknown' as const },
                }],
            }],
            onSelectPool: vi.fn(),
            onRefreshMachines,
            onRefreshPools,
        }));

        const section = rendered.getCurrent().rootStep.sections[0];
        if (section?.kind !== 'static') throw new Error('expected the Pool section');
        const retry = section.options.find((option) => option.id === 'pool-refresh:server-a');
        // One cause, one row: the failure in words and its Retry at the row's end, never a second row.
        expect(retry?.label).toBe('machinePools.refreshFailed');
        expect(retry?.accessibilityLabel).toContain('common.retry');
        expect(retry?.rightAccessory).toBeTruthy();
        expect(retry?.disabled).toBeFalsy();
        retry?.onSelect?.();
        expect(onRefreshMachines).toHaveBeenCalledOnce();
        expect(onRefreshPools).not.toHaveBeenCalled();
        await rendered.unmount();
    });

    it('routes each unavailable resolve outcome to its own existing recovery owner', async () => {
        const fixture = createFixture();
        const poolId = '3a948f0c-bc30-491c-b764-37f0e6744d1f';
        const onOpenPoolSettings = vi.fn();
        const onRefreshPools = vi.fn();
        const onDismissPoolSelection = vi.fn();
        const base = {
            ...buildParams(fixture, makeHandlers()),
            poolGroups: [{
                serverId: 'server-a',
                accountId: 'account-a',
                serverName: 'Server A',
                status: 'idle' as const,
                projectionReady: true,
                pools: [{
                    pool: {
                        id: poolId, name: 'Development', description: null,
                        revision: 1, createdAt: 1, updatedAt: 1, members: [],
                    },
                    availability: { state: 'known' as const, connectedCount: 0, enabledCount: 0 },
                }],
            }],
            onSelectPool: vi.fn(),
            onOpenPoolSettings,
            onRefreshPools,
            onDismissPoolSelection,
        };
        const rendered = await renderHook(
            (props: BuildMachineSelectionListModelParams) => useMachineSelectionListModel(props),
            {
                initialProps: {
                    ...base,
                    poolSelectionStatus: { kind: 'unavailable', serverId: 'server-a', accountId: 'account-a', poolId, reason: 'empty' },
                },
            },
        );

        const optionIdsOf = () => {
            const section = rendered.getCurrent().rootStep.sections[0];
            if (section?.kind !== 'static') throw new Error('expected the Pool section');
            return section.options;
        };
        const settings = optionIdsOf().find((option) => option.id === 'pool-settings:server-a');
        expect(settings?.label).toBe('machinePools.openSettings');
        settings?.onSelect?.();
        expect(onOpenPoolSettings).toHaveBeenCalledWith({ serverId: 'server-a', poolId });
        expect(optionIdsOf().some((option) => option.id === 'pool-pick-machine:server-a')).toBe(false);

        await rendered.rerender({
            ...base,
            poolSelectionStatus: {
                kind: 'unavailable', serverId: 'server-a', accountId: 'account-a', poolId, reason: 'no_available_machine',
            },
        });
        expect(optionIdsOf().some((option) => option.id === 'pool-settings:server-a')).toBe(false);
        optionIdsOf().find((option) => option.id === 'pool-refresh:server-a')?.onSelect?.();
        expect(onRefreshPools).toHaveBeenCalledWith('server-a');
        const pickSpecific = optionIdsOf().find((option) => option.id === 'pool-pick-machine:server-a');
        expect(pickSpecific?.label).toBe('machinePools.pickSpecificMachine');
        pickSpecific?.onSelect?.();
        expect(onDismissPoolSelection).toHaveBeenCalledOnce();

        await rendered.rerender({ ...base, poolSelectionStatus: {
            kind: 'unavailable', serverId: 'server-a', accountId: 'account-a', poolId, reason: 'worker_status_unavailable',
        } });
        expect(optionIdsOf().find(option => option.id === `pool:server-a:${poolId}`)?.subtitle)
            .toBe('machinePools.resolvePresenceUnavailable');

        // A current Home with a cached zero-connected summary still reaches the authoritative
        // resolve; only the Home's own currentness may deny activation.
        expect(optionIdsOf().find((option) => option.id === `pool:server-a:${poolId}`)?.disabled).toBe(false);
        await rendered.unmount();
    });

    it('explains a disabled domain decision when the caller supplies no detail', async () => {
        const fixture = createFixture();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, makeHandlers()),
            recentMachines: [], favoriteMachines: [], showFavorites: false, showRecent: false,
            resolveMachineAvailability: () => ({ selectable: false }),
        }));
        try {
            const rows = rendered.getCurrent().rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : [])
                .filter(option => option.id === 'm-1');
            expect(rows).not.toHaveLength(0);
            expect(rows.every(row => row.disabled && row.subtitle?.includes('common.unavailable'))).toBe(true);
        } finally { await rendered.unmount(); }
    });

    it('explains a disabled target while its exact Home Account scope is unavailable', async () => {
        const fixture = createFixture();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, makeHandlers()),
            groups: [{ ...fixture.groups[0]!, serverId: 'unbound-home',
                machines: fixture.machines.map(machine => ({ ...machine, serverId: 'unbound-home', serverName: 'Retained Home' })) }],
            serverId: 'unbound-home', selectedServerId: 'unbound-home',
            recentMachines: [], favoriteMachines: [], showFavorites: false, showRecent: false,
        }));
        try {
            expect(resolveMachineReachability(null, fixture.machines[0]!)).toBe('unknown');
            const row = rendered.getCurrent().rootStep.sections.flatMap(section => section.kind === 'static' ? section.options : [])
                .find(option => option.id === 'm-1');
            expect(row?.disabled).toBe(true);
            expect(row?.subtitle).toContain('common.unavailable');
        } finally { await rendered.unmount(); }
    });

    it('lets a consuming domain decide which rows are selectable and shows its reason', async () => {
        // Admit the intended initial state, rather than replaying an older offline clock over a live row.
        const fixture = createFixture([createMachine('m-1'),
            { ...createMachine('m-2'), active: false, activeAt: 0 }, createMachine('m-3')]);
        const handlers = makeHandlers();
        const offline = fixture.machines[1]!;
        const machines = [fixture.machines[0]!, offline].map(createScopedMachine);
        const params = (withDomainDecision: boolean): BuildMachineSelectionListModelParams => ({
            ...buildParams(fixture, handlers),
            groups: [{ ...fixture.groups[0]!, machines }],
            recentMachines: [],
            favoriteMachines: [],
            showFavorites: false,
            showRecent: false,
            ...(withDomainDecision ? {
                resolveMachineAvailability: (machine: Machine) => machine.id === offline.id
                    ? { selectable: true, detail: 'offline but eligible' }
                    : { selectable: false, detail: 'update required' },
            } : {}),
        });
        const rowsOf = (model: ReturnType<typeof UseMachineSelectionListModel>) => {
            const section = model.rootStep.sections.find((candidate) => candidate.id === 'all');
            if (section?.kind !== 'static') throw new Error('expected the all-machines section');
            return new Map(section.options.map((option) => [option.id, option]));
        };

        const canonical = await renderHook(() => useMachineSelectionListModel(params(false)));
        const canonicalRows = rowsOf(canonical.getCurrent());
        expect(canonicalRows.get('m-1')?.disabled).toBe(false);
        expect(canonicalRows.get('m-2')?.disabled).toBe(true);
        // K1 anatomy: the second line is the machine's status line, presence first, with the
        // presence dot leading it (online / offline) instead of a trailing "● Online" label. An online
        // machine then says what it is (lab m-pick "Online · Linux"); an offline one keeps last-seen only.
        expect(canonicalRows.get('m-1')?.subtitle).toBe('settingsOverview.machineOnline · macOS');
        expect(canonicalRows.get('m-2')?.subtitle).toBe('settingsOverview.machineOffline');
        expect(canonicalRows.get('m-1')?.subtitleLeading).toBeTruthy();
        expect(canonicalRows.get('m-2')?.subtitleLeading).toBeTruthy();
        await canonical.unmount();

        const decided = await renderHook(() => useMachineSelectionListModel(params(true)));
        const rows = rowsOf(decided.getCurrent());
        expect(rows.get('m-2')?.disabled).toBe(false);
        expect(rows.get('m-2')?.subtitle).toBe('settingsOverview.machineOffline · offline but eligible');
        expect(rows.get('m-1')?.disabled).toBe(true);
        expect(rows.get('m-1')?.subtitle).toBe('settingsOverview.machineOnline · macOS · update required');

        rows.get('m-1')?.onSelect?.();
        expect(handlers.selectSpy).not.toHaveBeenCalled();
        rows.get('m-2')?.onSelect?.();
        expect(handlers.selectSpy).toHaveBeenCalledWith('m-2');
        await decided.unmount();
    });

    it('reuses the derived model when only the caller handler identities change', async () => {
        const rendered = await renderModel(createFixture(), makeHandlers());
        const first = rendered.getCurrent();

        await rendered.rerender(makeHandlers());
        const second = rendered.getCurrent();

        // Handlers are behaviour, not data: recreating them must not rebuild the
        // step tree, because every row's `icon` / `rightAccessory` element loses
        // referential identity when it does, and React can then no longer skip
        // the row subtrees while the popover re-renders.
        expect(second.rootStep).toBe(first.rootStep);
        expect(second.rootStep.sections).toBe(first.rootStep.sections);
        expect(firstStaticOption(second)).toBe(firstStaticOption(first));
        expect(firstStaticOption(second).rightAccessory).toBe(firstStaticOption(first).rightAccessory);

        await rendered.unmount();
    });

    it('rebuilds the model when the machine data actually changes', async () => {
        // Same handler identities, different data: the model MUST be rebuilt,
        // otherwise the ref indirection would freeze the list against real
        // machine/recent/favorite updates.
        const fixture = createFixture();
        const handlers = makeHandlers();
        const rendered = await renderHook<ReturnType<typeof UseMachineSelectionListModel>, ReadonlyArray<Machine>>(
            (recent) => useMachineSelectionListModel({ ...buildParams(fixture, handlers), recentMachines: recent }),
            { initialProps: fixture.recent },
        );
        const before = rendered.getCurrent().rootStep;
        expect(before.sections.map((section) => section.id)).toEqual(['recent', 'favorites', 'all']);

        await rendered.rerender([fixture.machines[2]!]);
        const after = rendered.getCurrent().rootStep;
        expect(after).not.toBe(before);
        const recentSection = after.sections[0];
        if (recentSection?.kind !== 'static') throw new Error('expected the recent section');
        expect(recentSection.options.map((option) => option.id)).toEqual(['m-3']);

        await rendered.unmount();
    });

    it('activates the LATEST handler after the caller replaced it', async () => {
        const initialHandlers = makeHandlers();
        const rendered = await renderModel(createFixture(), initialHandlers);

        const nextHandlers = makeHandlers();
        await rendered.rerender(nextHandlers);

        firstStaticOption(rendered.getCurrent()).onSelect?.();

        expect(nextHandlers.selectSpy).toHaveBeenCalledTimes(1);
        expect(initialHandlers.selectSpy).not.toHaveBeenCalled();

        await rendered.unmount();
    });
});

describe('useMachineSelectionListModel · Run on order (lab m-pick)', () => {
    it('lists existing machines first, then machines that do not exist yet, then Connect a computer', async () => {
        const fixture = createFixture();
        const handlers = makeHandlers();
        const onConnectMachine = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, handlers),
            temporaryComputers: [{ serverId: 'server-a', artifactTarget: 'linux-x64', selected: false,
                workspace: null, onSelect: vi.fn() }],
            managedMachines: [{ id: 'managed-machine:server-a:one-off', homeId: 'server-a', kind: 'one-off',
                title: 'One-off', onSelect: vi.fn() }],
            onConnectMachine,
        }));
        const ids = rendered.getCurrent().rootStep.sections.map((section) => section.id);
        const firstNew = ids.indexOf('managed-machines');
        expect(firstNew).toBeGreaterThan(0);
        // Every machine section (recent, favorites, yours, shared) precedes the not-yet-machines.
        expect(ids.slice(firstNew)).toEqual(['managed-machines', 'temporary-computer']);

        // "Connect a computer…" closes the New machine group, after the presets and the one-off.
        const newMachine = rendered.getCurrent().rootStep.sections[firstNew];
        if (newMachine?.kind !== 'static') throw new Error('expected the New machine section');
        expect(newMachine.options.map((option) => option.id)).toEqual(['managed-machine:server-a:one-off', 'connect-machine']);
        const connect = newMachine.options.at(-1);
        expect(connect).toMatchObject({
            label: 'managedMachines.picker.connectComputer',
            subtitle: 'managedMachines.picker.connectComputerHelp',
        });
        connect?.onSelect?.();
        expect(onConnectMachine).toHaveBeenCalledTimes(1);
        await rendered.unmount();
    });

    it('with no machine yet, asks where to run: Create in the cloud, then Use one you have (58d AF1)', async () => {
        const fixture = { ...createFixture(), machines: [], recent: [], favorites: [] };
        fixture.groups = fixture.groups.map((group) => ({ ...group, machines: [] }));
        const onConnectMachine = vi.fn();
        const rendered = await renderHook(() => useMachineSelectionListModel({
            ...buildParams(fixture, makeHandlers()),
            selectedMachine: null,
            managedMachines: [{ id: 'managed-machine:server-a:one-off', homeId: 'server-a', kind: 'one-off',
                title: 'One-off', onSelect: vi.fn() }],
            onConnectMachine,
        }));
        const sections = rendered.getCurrent().rootStep.sections.filter((section) => section.kind === 'static');
        expect(sections.map((section) => [section.id, section.title])).toEqual([
            ['managed-machines', 'managedMachines.picker.createInCloud'],
            ['use-one-you-have', 'managedMachines.picker.useOneYouHave'],
        ]);
        expect(sections[0]!.options.map((option) => option.id)).toEqual(['managed-machine:server-a:one-off']);
        sections[1]!.options[0]?.onSelect?.();
        expect(onConnectMachine).toHaveBeenCalledTimes(1);
        await rendered.unmount();
    });

    it('marks every machine row with that machine\'s own mark, including recent ones', async () => {
        const { MachineRowMark } = await import('./MachineSelectionRowAccessory');
        const rendered = await renderHook(() => useMachineSelectionListModel(buildParams(createFixture(), makeHandlers())));
        const marks = rendered.getCurrent().rootStep.sections.flatMap((section) => section.kind === 'static'
            && section.id !== 'managed-machines' && section.id !== 'temporary-computer'
            ? section.options.map((option) => ({ id: option.id, icon: option.icon as React.ReactElement<{ machineId?: string }> }))
            : []);
        expect(marks.length).toBeGreaterThan(1);
        for (const mark of marks) {
            expect(mark.icon.type).toBe(MachineRowMark);
            expect(mark.id.endsWith(mark.icon.props.machineId ?? '<none>')).toBe(true);
        }
        await rendered.unmount();
    });

    it('offers no Connect row where the host cannot open the Add flow', async () => {
        const fixture = createFixture();
        const rendered = await renderHook(() => useMachineSelectionListModel(buildParams(fixture, makeHandlers())));
        expect(rendered.getCurrent().rootStep.sections.some((section) => section.kind === 'static'
            && section.options.some((option) => option.id === 'connect-machine'))).toBe(false);
        await rendered.unmount();
    });
});
