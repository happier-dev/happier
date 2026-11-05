import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachinePoolViewV1 } from '@happier-dev/protocol';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

import { createMachineFixture, renderScreen } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import type { ActiveSelectionMachineGroup } from '@/components/settings/machines/hooks/useActiveSelectionMachineGroups';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

installDisconnectedServerSocketBoundary();
const { machineResourceStore } = await import('@/sync/domains/machines/resources/machineResourceStore');
const { storage } = await import('@/sync/domains/state/storageStore');
const resourceRpc = vi.hoisted(() => vi.fn());
const appVisibility = vi.hoisted(() => ({ emit: (_state: 'active' | 'background') => {} }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: resourceRpc }));
vi.mock('react-native', async () => {
    const { createReactNativeAppStateEmitter, createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const emitter = createReactNativeAppStateEmitter('active');
    appVisibility.emit = emitter.emit;
    return createReactNativeWebMock({ AppState: emitter.appState });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOME = 'srv_popover_demand';
// The signed-in Account the Home's machines are reached through: reachability is unknown without it.
const SCOPE = { serverId: HOME, accountId: 'account-a' };
const routerPush = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
    groups: [] as ActiveSelectionMachineGroup[],
    managed: {} as Record<string, readonly ManagedMachineV1[]>,
    pools: [] as MachinePoolViewV1[],
    source: null as unknown,
}));

// Boundaries only: navigation, the local daemon's status (which machine is this computer), the
// network-backed machine/pool inventories, and the store adapter that feeds Activity. The
// collection model, the Activity classifier and the working-count projection stay real.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => params && 'count' in params ? `${key}:${params.count}`
        : params && 'team' in params ? `${key}:${params.team}` : key });
});
vi.mock('@/components/settings/machines/machinesSettingsViewModel', () => ({
    useMachinesSettingsViewModel: () => ({
        activeServerId: HOME, isLoadingMachines: false, showMachinesGroupedByServer: false,
        visibleMachineGroups: state.groups, managedByServerId: state.managed,
    }),
}));
vi.mock('@/sync/engine/machines/useMachinePoolProjections', () => ({
    useMachinePoolProjections: (groups: ReadonlyArray<{ serverId: string }>) => groups.map(group => ({
        serverId: group.serverId, accountId: 'account-a', featureStatus: 'enabled', featureEnabled: true,
        pools: state.pools, status: 'idle', ready: true,
    })),
}));
vi.mock('@/components/machines/add/useMachineAddPaths', () => ({
    useMachineAddPaths: () => [{ id: 'thisComputer', runs: 'task' }, { id: 'anotherComputer', runs: 'command' }],
    useThisComputerMachineId: () => 'mine',
}));
vi.mock('@/activity/source/useActivityAttentionSource', () => ({
    useActivityAttentionSummarySource: () => state.source,
}));
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => ({ refreshFromActiveServer: async () => {} }) }));

function machine(id: string, overrides: Partial<Machine> = {}): Machine {
    const fixture = createMachineFixture({ id, active: true, activeAt: Date.now() });
    return { ...fixture, metadata: { ...fixture.metadata!, displayName: id, platform: 'linux' }, ...overrides };
}

function workingOn(id: string, machineId: string): Session {
    return createSessionFixture({
        id, serverId: HOME, seq: 2, lastViewedSessionSeq: 2, active: true, presence: 'online', thinking: true,
        thinkingAt: Date.now(), updatedAt: 30, metadata: { ...createSessionFixture().metadata!, machineId },
    });
}

function source(sessions: readonly Session[]): ActivityAttentionSource {
    return {
        isDataReady: true,
        sessionsById: Object.fromEntries(sessions.map(session => [session.id, session])),
        sessionListRowsByServerId: { [HOME]: Object.fromEntries(sessions.map(session => [session.id, buildSessionListRenderableFromSession(session)])) },
        ordinarySessionListMembershipByServerId: { [HOME]: sessions.map(session => session.id) },
        sessionListIndexByServerId: { [HOME]: sessions.map(session => ({ type: 'session' as const, sessionId: session.id, serverId: HOME, serverName: 'Home A' })) },
        concurrentSessionListCacheByServerId: {},
    } as ActivityAttentionSource;
}

const pending: ManagedMachineV1 = {
    id: 'pending', homeId: 'home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, name: 'build-box', choices: {} },
    controller: { machineId: 'controller', installationId: 'installation' }, allocation: 'bound', creationState: 'active',
    resource: { contributionRef: { pluginId: 'custom.provisioner', localId: 'native' }, schemaVersion: 1, value: { nativeId: 'resource' } },
    desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
} as ManagedMachineV1;

const pool: MachinePoolViewV1 = {
    pool: { id: '00000000-0000-4000-8000-000000000001', name: 'Builders', description: null, revision: 1, createdAt: 1, updatedAt: 1,
        members: [{ machineId: 'mine', priorityTier: 0, enabled: true, state: 'connected' }] },
    availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
};

const fleet = () => [
    machine('mine'),
    machine('edge', { active: false, activeAt: 1 }),
    machine('shared', { isShared: true, access: { custodian: { accountId: 'alice', displayName: 'Alice' },
        role: 'use', resourceMode: 'plain', accessState: 'ready' } as Machine['access'] }),
];

async function renderPopover(options?: Parameters<typeof renderScreen>[1]) {
    // The inventory fixture feeds both its group projection and the canonical
    // Machine owner. Attention reads current rows there, not retained mock rows.
    for (const group of state.groups) {
        storage.getState().applyMachines([...group.machines], true, {
            sourceServerId: group.serverId,
            ...(group.accountScope ? { sourceAccountId: group.accountScope.accountId } : {}),
        });
    }
    const { SidebarMachinesPopoverContent } = await import('./SidebarMachinesPopoverContent');
    return renderScreen(<SidebarMachinesPopoverContent close={() => {}} maxHeight={520} />, options);
}

it.each([false, true])('keeps needs-you machines in the open popover demand and releases on background/close (mixed=%s)', async mixed => {
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://popover-demand.test', serverIdentityId: HOME });
    const urgent = machine('urgent', { daemonState: { resources: { v: 1, vitals: { state: 'reporting' },
        host: { logicalCores: 4, memoryTotalBytes: 100, bootedAt: 1 }, attention: { level: 'needs_you', reasons: [
            { kind: 'memory_pressure', key: 'memory', level: 'needs_you', since: 1, metric: 'memory', pressure: 'critical', swapping: false, nextStep: 'review_processes' },
        ] } } } });
    const calm = machine('calm', { daemonState: { resources: { ...urgent.daemonState!.resources, attention: { level: 'calm', reasons: [] } } } });
    const machines = mixed ? [urgent, calm] : [urgent];
    state.groups = [{ serverId: HOME, serverName: 'Home A', accountScope: SCOPE, status: 'idle', machines }];
    state.source = source([]); state.managed = {}; state.pools = [];
    storage.setState({ machineListByServerId: { [HOME]: machines }, machineListStatusByServerId: { [HOME]: 'idle' } });
    const watches: AbortSignal[] = [];
    resourceRpc.mockImplementation(async ({ method, signal }: { method: string; signal?: AbortSignal }) => {
        if (method === RPC_METHODS.DAEMON_VITALS_WATCH) {
            if (signal) watches.push(signal);
            return new Promise(() => {});
        }
        return { state: 'reporting', sample: { v: 1, sampledAt: Date.now(), intervalMs: 15_000,
            cpu: { reported: false, reason: 'unavailable' }, memory: { reported: false, reason: 'unavailable' },
            disk: { reported: false, reason: 'unavailable' }, network: { reported: false, reason: 'unavailable' } },
            series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] }, attention: { level: 'calm', reasons: [] } };
    });
    try {
        // The native/DOM geometry boundary places these two meters inside the physical scroller.
        const rect = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 100 }) };
        const screen = await renderPopover({ createNodeMock: () => ({ ...rect, getInnerViewRef: () => rect }) });
        await act(async () => { await vi.waitFor(() => {
            const reads = resourceRpc.mock.calls.map(([input]) => input).filter(input => input.method === RPC_METHODS.MACHINES_VITALS_GET);
            expect(reads.map(input => input.machineId).sort()).toEqual(machines.map(row => row.id).sort());
            expect(watches).toHaveLength(machines.length);
        }); });
        await act(async () => appVisibility.emit('background'));
        expect(watches.every(signal => signal.aborted)).toBe(true);
        await act(async () => appVisibility.emit('active'));
        await screen.unmount();
        expect(watches.every(signal => signal.aborted)).toBe(true);
    } finally {
        machineResourceStore.reset(); resourceRpc.mockReset(); await connection.dispose();
    }
});

async function labels(screen: Awaited<ReturnType<typeof renderPopover>>) {
    const { CollectionListGroupLabel } = await import('@/components/ui/lists/collection/CollectionList');
    return screen.findAllByType(CollectionListGroupLabel).map(node => node.props.title);
}

describe('SidebarMachinesPopoverContent', () => {
    beforeEach(() => {
        routerPush.mockClear();
        state.groups = [{ serverId: HOME, serverName: 'Home A', accountScope: SCOPE, status: 'idle', machines: fleet() }];
        state.managed = { [HOME]: [pending] };
        state.pools = [pool];
        state.source = source([workingOn('s1', 'mine'), workingOn('s2', 'mine'), workingOn('s3', 'shared')]);
    });

    it('lists the machine collection groups the list column shows, then pools', async () => {
        const screen = await renderPopover();
        // The column's own model decides the groups and their titles; the popover adds none and drops none.
        const { buildMachineCollection } = await import('@/components/settings/machines/collection/machineCollectionModel');
        const column = buildMachineCollection({ groups: state.groups, groupedByHome: false, managedByServerId: state.managed });
        expect(column.sections.map(section => section.title)).toEqual([
            // Lab `R`: your machines, the ones Happier created, then each member's shared machines.
            'machines.destinations.yours', 'machines.destinations.created', 'machines.destinations.shared:Alice',
        ]);
        expect(await labels(screen)).toEqual([...column.sections.map(section => section.title), 'machinePools.title']);
        expect(screen.findByTestId(`settings.machinePools.row.${HOME}.${pool.pool.id}`)).toBeTruthy();
    });

    it("says what each machine is doing from the Activity classifier's per-machine count", async () => {
        const screen = await renderPopover();
        const { Item } = await import('@/components/ui/lists/Item');
        const row = (id: string) => screen.findAllByType(Item).find(node => node.props.testID === `sidebar-machines-row.${HOME}.${id}`);
        // The work word sits on the name's line (the row's title meta), never in the detail slot that centres
        // against the strip beneath the name.
        const meta = (id: string) => (row(id)?.props.titleMeta as React.ReactElement<{ children: unknown }> | undefined)?.props.children;
        expect(row('mine')?.props.titleAccessory).toBeTruthy();
        expect(row('mine')?.props.detail).toBeUndefined();
        expect(meta('mine')).toBe('machineDetailPage.work.working:2');
        expect(meta('shared')).toBe('machineDetailPage.work.working:1');
        // Offline says why, never "No work": one quiet line under the name, where an online row has its strip
        // (MPG-18), so a long presence sentence never wraps the name's line.
        const edge = row('edge')?.props;
        expect(edge?.titleMeta).toBeUndefined();
        expect((edge?.subtitle as React.ReactElement<{ children: unknown }> | undefined)?.props.children)
            .toEqual(expect.stringMatching(/./));
        expect((edge?.subtitle as React.ReactElement<{ children: unknown }> | undefined)?.props.children)
            .not.toBe('machineDetailPage.work.none');
        expect(screen.findByTestId('sidebar-machines-working')?.props.children).toBe('machineDetailPage.work.working:3');
    });

    it('opens a machine and All machines through the rail door', async () => {
        const screen = await renderPopover();
        // The press measures the row's mark first (its rectangle travels to the page header), then navigates.
        await act(async () => { screen.findByTestId(`sidebar-machines-row.${HOME}.shared`)!.props.onPress(); });
        await vi.waitFor(() => expect(routerPush).toHaveBeenLastCalledWith(`/machines/shared?serverId=${HOME}`));
        await screen.pressByTestIdAsync('sidebar-machines-all');
        expect(routerPush).toHaveBeenLastCalledWith('/machines');
    });

    it('titles the popover by what needs a look and lists that machine first under Needs you, not again below', async () => {
        const resources = { v: 1, vitals: { state: 'reporting' }, host: { logicalCores: 8, memoryTotalBytes: 2 ** 34, bootedAt: 1 },
            attention: { level: 'needs_you', reasons: [{ key: 'memory', level: 'needs_you', since: Date.now() - 60_000, metric: 'memory',
                nextStep: 'review_processes', kind: 'memory_pressure', pressure: 'critical', swapping: true }] } };
        state.groups = [{ serverId: HOME, serverName: 'Home A', accountScope: SCOPE, status: 'idle',
            machines: [machine('mine', { daemonState: { resources } as never }), machine('other')] }];
        const screen = await renderPopover();
        expect(screen.findAll(node => node.props?.testID === 'sidebar-machines-popover-content' && typeof node.props?.title === 'string')[0]?.props.title)
            .toContain('machineAttention.phrases.memoryCritical');
        expect(screen.findByTestId(`sidebar-machines-needs-you.${HOME}.mine`)).toBeTruthy();
        expect(screen.findByTestId(`sidebar-machines-row.${HOME}.mine`)).toBeNull();
        expect(screen.findByTestId(`sidebar-machines-row.${HOME}.other`)).toBeTruthy();
        await act(async () => { screen.findByTestId(`sidebar-machines-needs-you.${HOME}.mine.action`)!.props.onPress(); });
        expect(routerPush).toHaveBeenLastCalledWith(`/machines/mine?serverId=${HOME}&tab=processes&sort=memory`);
    });

    it('has no All machines link with exactly one machine', async () => {
        state.groups = [{ serverId: HOME, serverName: 'Home A', accountScope: SCOPE, status: 'idle', machines: [machine('mine')] }];
        state.managed = {};
        const screen = await renderPopover();
        expect(screen.findByTestId(`sidebar-machines-row.${HOME}.mine`)).toBeTruthy();
        expect(screen.findByTestId('sidebar-machines-all')).toBeNull();
    });

    it('invites adding this computer when there is no machine', async () => {
        state.groups = [{ serverId: HOME, serverName: 'Home A', accountScope: SCOPE, status: 'idle', machines: [] }];
        state.managed = {};
        state.pools = [];
        const screen = await renderPopover();
        await screen.pressByTestIdAsync('sidebar-machines-add-this-computer');
        expect(routerPush).toHaveBeenLastCalledWith('/settings/machines/add?path=thisComputer');
        expect(screen.findByTestId('sidebar-machines-list')).toBeNull();
    });

    it('says a signed-out Home cannot be listed and offers its sign-in', async () => {
        state.groups = [
            { serverId: HOME, serverName: 'Home A', accountScope: SCOPE, status: 'idle', machines: [machine('mine')] },
            { serverId: 'acme', serverName: 'Acme', status: 'signedOut', machines: [] },
        ];
        state.managed = {};
        const screen = await renderPopover();
        expect(screen.findByTestId('sidebar-machines-signed-out.acme')).toBeTruthy();
        expect(screen.findByTestId('sidebar-machines-sign-in.acme')).toBeTruthy();
    });
});
