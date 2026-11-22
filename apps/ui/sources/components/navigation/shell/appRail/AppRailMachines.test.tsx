import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';
import { machineResourceStore } from '@/sync/domains/machines/resources/machineResourceStore';
import { settingsParse } from '@/sync/domains/settings/settings';
import { machinesRailSeenState } from '@/sync/domains/state/machineAdministrationUiState';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';

const vitalsRpc = vi.hoisted(() => vi.fn(async (_input: { machineId: string }) => ({ state: 'not_reported', sample: null,
    series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } })));
// The resource request leaves the app process; warm demand and membership stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(vitalsRpc);
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

let servedHome: Awaited<ReturnType<typeof serveActionHomes>> | undefined;
beforeEach(async () => {
    replacePersistentUiStateForTest(machinesRailSeenState, {});
    servedHome = await serveActionHomes({ homes: [{ key: 'rail', serverUrl: 'https://rail-warm.test', accountId: 'rail-account', currentAccount: true }],
        route: request => request.path === '/v1/features' ? Response.json(createRootLayoutFeaturesResponse()) : undefined });
});
afterEach(async () => {
    standardCleanup();
    clearMachineRequestReachabilityForTest();
    machineResourceStore.reset();
    vitalsRpc.mockClear();
    await servedHome?.dispose();
    servedHome = undefined;
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** A machine's published resource summary (plan 20's daemonState `resources`), as the daemon writes it. */
function published(level: 'calm' | 'look' | 'needs_you', reasons: readonly unknown[]) {
    return { v: 1, vitals: { state: 'reporting' }, host: { logicalCores: 8, memoryTotalBytes: 16 * 2 ** 30, bootedAt: 1 },
        attention: { level, reasons } };
}

function memoryReason(key: string) {
    return { key, level: 'needs_you', since: Date.now() - 6 * 60_000, metric: 'memory', nextStep: 'review_processes',
        kind: 'memory_pressure', pressure: 'critical', swapping: true };
}

function machine(id: string, overrides: Partial<Machine> = {}): Machine {
    return {
        id,
        seq: 1,
        createdAt: 1000,
        updatedAt: 1000,
        active: true,
        activeAt: Date.now(),
        presenceProtocolVersion: 1,
        metadata: { host: id, platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        revokedAt: null,
        ...overrides,
    };
}

async function setHomeMachines(machines: readonly Machine[], accountId = 'rail-account') {
    const activeServerId = servedHome!.homes.rail!.id;
    const revisions = storage.getState().machines;
    storage.setState((state) => ({
        settings: settingsParse({ ...state.settings,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }),
    }));
    await publishMachineInventoryForTest({ serverId: activeServerId, accountId }, machines.map(machine => ({
        ...machine,
        daemonStateVersion: (revisions[machine.id]?.daemonStateVersion ?? 0) + 1,
    })));
}

function railScopeKey() {
    return serverAccountScopeKeySuffix(storage.getState().profileScope!);
}

describe('AppRailMachines', () => {
    it('names the latest reachable Guard event and does no fleet re-read on unrelated Machine arrivals', async () => {
        const previous = storage.getState();
        const acted = (id: string, at: number) => machine(id, { daemonState: { resources: { ...published('calm', []),
            lastAutomaticAction: { kind: 'stopped_session', at, entryId: id, undoable: true,
                facts: { rule: 'idle_sessions' } },
        } } });
        const now = Date.now();
        const online = acted('reachable-guard', now - 2000);
        const offline = { ...acted('offline-guard', now - 1000), active: false, activeAt: 1 };
        const others = Array.from({ length: 146 }, (_, index) => machine(`quiet-${index}`));
        try {
            const { AppRailMachines } = await import('./AppRailMachines');
            const sentences = await import('@/components/machines/summary/machineResourceSentences');
            const read = vi.spyOn(sentences, 'readMachinePublishedResources');
            const scope = { serverId: servedHome!.homes.rail!.id, accountId: 'rail-account' };
            await publishMachineInventoryForTest(scope, [online, offline, ...others]);
            const screen = await renderScreen(<AppRailMachines />);
            expect(screen.findByTestId('app-rail-machines-badge')).not.toBeNull();
            expect.soft(screen.findByTestId('app-rail-machines')?.props.accessibilityLabel).toContain(online.id);
            read.mockClear();
            for (let index = 0; index < 20; index += 1) {
                await act(async () => storage.setState(state => ({ machines: {
                    ...state.machines, [others[0].id]: { ...others[0], metadataVersion: index + 2 },
                } })));
            }
            expect(read).not.toHaveBeenCalled();
        } finally {
            vi.restoreAllMocks();
            storage.setState(previous);
        }
    });

    it('keeps guard acknowledgements local to the exact Account and Home without writing settings', async () => {
        const previous = storage.getState();
        const acted = machine('guard-machine', { daemonState: { resources: { ...published('calm', []),
            lastAutomaticAction: { kind: 'stopped_session', at: Date.now() - 1000, entryId: 'idle-session', undoable: true,
                facts: { rule: 'idle_sessions' } },
        } } as never });
        try {
            await setHomeMachines([acted]);
            const { AppRailMachines } = await import('./AppRailMachines');
            const { SidebarFooterPopoverButton } = await import('../sidebarFooter/SidebarFooterPopoverButton');
            const screen = await renderScreen(<AppRailMachines />);
            expect(screen.findByTestId('app-rail-machines-badge')).not.toBeNull();
            const before = storage.getState().localSettings;
            await act(async () => screen.root.findByType(SidebarFooterPopoverButton).props.onOpenIntent?.());
            expect(screen.findByTestId('app-rail-machines-badge')).toBeNull();
            await act(async () => setHomeMachines([acted], 'unseen-guard-account'));
            expect(screen.findByTestId('app-rail-machines-badge')).not.toBeNull();
            expect(storage.getState().localSettings).toBe(before);
            await act(async () => setHomeMachines([acted]));
            expect(screen.findByTestId('app-rail-machines-badge')).toBeNull();
        } finally { storage.setState(previous); }
    });
    it('forgets a seen look reason on closed recovery so the same reason badges on recurrence', async () => {
        const previousState = storage.getState();
        const reason = { key: 'disk:data', kind: 'disk_nearly_full', level: 'look', metric: 'disk', since: 1,
            volumeId: 'data', volumeLabel: 'Data', nextStep: 'free_up_space' };
        const look = machine('edge-1', { daemonState: { resources: published('look', [reason]) } as never });
        try {
            await setHomeMachines([look]);
            const key = railScopeKey();
            machinesRailSeenState.set(key, { look: { '["another-home","other"]': ['memory'] }, guardSeenAt: 0 });
            const { AppRailMachines } = await import('./AppRailMachines');
            const { SidebarFooterPopoverButton } = await import('../sidebarFooter/SidebarFooterPopoverButton');
            const screen = await renderScreen(<AppRailMachines />);
            expect(screen.findByTestId('app-rail-machines-badge')).not.toBeNull();
            await act(async () => screen.root.findByType(SidebarFooterPopoverButton).props.onOpenIntent?.());
            expect(screen.findByTestId('app-rail-machines-badge')).toBeNull();
            const acknowledgedAt = machinesRailSeenState.read(key)!.guardSeenAt;
            await act(async () => machinesRailSeenState.set(key, {
                ...machinesRailSeenState.read(key)!,
                look: { ...machinesRailSeenState.read(key)!.look, '["another-home","other"]': ['memory'] },
            }));
            await act(async () => setHomeMachines([machine('edge-1', { daemonState: { resources: published('calm', []) } as never })]));
            expect(machinesRailSeenState.read(key)).toEqual({ look: { '["another-home","other"]': ['memory'] }, guardSeenAt: acknowledgedAt });
            await act(async () => setHomeMachines([look]));
            expect(screen.findByTestId('app-rail-machines-badge')).not.toBeNull();
            expect(screen.findByTestId('sidebar-machines-popover-content')).toBeNull();
        } finally {
            storage.setState(previousState);
        }
    });

    it.each(['offline', 'missing_publication', 'reader_failed', 'account_switch'] as const)('does not mistake %s for a recovered look reason', async condition => {
        const previousState = storage.getState();
        const reason = { key: 'disk:data', kind: 'disk_nearly_full', level: 'look', metric: 'disk', since: 1,
            volumeId: 'data', volumeLabel: 'Data' };
        const look = machine('edge-1', { daemonState: { resources: published('look', [reason]) } as never });
        try {
            await setHomeMachines([look]);
            const key = railScopeKey();
            const { AppRailMachines } = await import('./AppRailMachines');
            const { SidebarFooterPopoverButton } = await import('../sidebarFooter/SidebarFooterPopoverButton');
            const screen = await renderScreen(<AppRailMachines />);
            await act(async () => screen.root.findByType(SidebarFooterPopoverButton).props.onOpenIntent?.());
            const seen = machinesRailSeenState.read(key);
            await act(async () => {
                if (condition === 'account_switch') {
                    await setHomeMachines([machine('edge-1', { daemonState: { resources: published('calm', []) } as never })], 'another-account');
                } else await setHomeMachines([condition === 'offline' ? { ...look, active: false, activeAt: 1 }
                    : condition === 'missing_publication' ? { ...look, daemonState: null }
                    : { ...look, daemonState: { resources: { ...published('calm', []), vitals: { state: 'unavailable', reason: 'reader_failed', since: 1 } } } as never }]);
            });
            expect(machinesRailSeenState.read(key)).toBe(seen);
            await act(async () => setHomeMachines([look]));
            expect(screen.findByTestId('app-rail-machines-badge')).toBeNull();
        } finally {
            storage.setState(previousState);
        }
    });

    it('does not request machine resources before the popover opens', async () => {
        const serverId = servedHome!.homes.rail!.id;
        const failed = machine('warm-failed');
        const ready = machine('warm-ready');
        storage.setState({ profileScope: { serverId, accountId: 'rail-account' }, machines: { [failed.id]: failed, [ready.id]: ready },
            machineListByServerId: { [serverId]: [failed, ready] }, machineListStatusByServerId: { [serverId]: 'idle' } });
        recordMachineRequestFailed({ serverId, accountId: 'rail-account', machineId: failed.id });
        const { AppRailMachines } = await import('./AppRailMachines');
        const { SidebarFooterPopoverButton } = await import('../sidebarFooter/SidebarFooterPopoverButton');
        const screen = await renderScreen(<AppRailMachines />);
        await act(async () => screen.root.findByType(SidebarFooterPopoverButton).props.onWarmIntent?.());
        await flushHookEffects();
        expect(vitalsRpc).not.toHaveBeenCalled();
        await act(async () => screen.root.findByType(SidebarFooterPopoverButton).props.onWarmIntent?.());
        await flushHookEffects();
        expect(vitalsRpc).not.toHaveBeenCalled();
    });
    it('names the counts on the closed icon, draws no badge for machines that are merely offline, and stays still on heartbeats', async () => {
        const previousState = storage.getState();
        try {
            await setHomeMachines([
                machine('laptop'),
                machine('devbox'),
                machine('studio', { active: false, activeAt: Date.now() - 2 * DAY_MS }),
            ]);
            const { AppRailMachines } = await import('./AppRailMachines');
            let commits = 0;
            const screen = await renderScreen(
                <React.Profiler id="rail-machines" onRender={() => { commits += 1; }}>
                    <AppRailMachines />
                </React.Profiler>,
            );
            await flushHookEffects({ cycles: 2 });

            const button = screen.findByTestId('app-rail-machines');
            expect(button?.props.accessibilityLabel).toContain('settings.machines');
            expect(button?.props.accessibilityLabel).toContain('settingsOverview.machinesOnlineCount(count=2)');
            expect(button?.props.accessibilityLabel).toContain('settingsOverview.machinesOfflineCount(count=1)');
            // M3: offline is not a problem, so the icon carries no badge; the popover is not mounted.
            expect(screen.findByTestId('app-rail-machines-badge')).toBeNull();
            expect(screen.findByTestId('sidebar-machines-popover-content')).toBeNull();

            const commitsBefore = commits;
            await act(async () => {
                await setHomeMachines([
                    machine('laptop', { activeAt: Date.now(), metadataVersion: 2 }),
                    machine('devbox', { activeAt: Date.now() }),
                    machine('studio', { active: false, activeAt: Date.now() - 2 * DAY_MS, updatedAt: 2000 }),
                ]);
            });
            expect(commits).toBe(commitsBefore);
        } finally {
            storage.setState(previousState);
        }
    });

    it('counts the machines that need you, names the machine and reason, and stays still when another machine changes', async () => {
        const previousState = storage.getState();
        const edge = { resources: published('needs_you', [memoryReason('memory:critical')]) } as never;
        try {
            await setHomeMachines([
                machine('edge-1', { metadata: { host: 'edge-1', displayName: 'edge-1', platform: 'linux', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                    daemonState: edge }),
                machine('laptop', { daemonState: { resources: published('calm', []) } as never }),
            ]);
            const { AppRailMachines } = await import('./AppRailMachines');
            let commits = 0;
            const screen = await renderScreen(
                <React.Profiler id="rail-machines" onRender={() => { commits += 1; }}>
                    <AppRailMachines />
                </React.Profiler>,
            );
            await flushHookEffects({ cycles: 2 });

            expect(screen.findByTestId('app-rail-machines-badge')?.props.testID).toBe('app-rail-machines-badge');
            const label = screen.findByTestId('app-rail-machines')?.props.accessibilityLabel as string;
            expect(label).toContain('machineAttention.phrases.memoryCritical');
            expect(label).toContain('edge-1');

            const commitsBefore = commits;
            await act(async () => {
                await setHomeMachines([
                    machine('edge-1', { metadata: { host: 'edge-1', displayName: 'edge-1', platform: 'linux', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
                        daemonState: edge }),
                    // An unrelated machine's state moves on: the closed icon renders nothing.
                    machine('laptop', { daemonState: { resources: published('calm', []) } as never, daemonStateVersion: 3, activeAt: Date.now() }),
                ]);
            });
            expect(commits).toBe(commitsBefore);
        } finally {
            storage.setState(previousState);
        }
    });

    it('shows the icon selected while the Machines page is open through the rail door, without opening the popover', async () => {
        const { AppRailMachines } = await import('./AppRailMachines');
        const selectedButtons = (screen: Awaited<ReturnType<typeof renderScreen>>) => screen.findAll((node) =>
            node.props?.testID === 'app-rail-machines' && node.props?.selected === true);
        const closed = await renderScreen(<AppRailMachines />);
        expect(selectedButtons(closed)).toHaveLength(0);
        const open = await renderScreen(<AppRailMachines selected />);
        expect(selectedButtons(open).length).toBeGreaterThan(0);
        expect(open.findByTestId('sidebar-machines-popover-content')).toBeNull();
    });

    it('previews its popover on hover like the Usage icon', async () => {
        const { AppRailMachines } = await import('./AppRailMachines');
        const { SidebarFooterPopoverButton } = await import('../sidebarFooter/SidebarFooterPopoverButton');
        const screen = await renderScreen(<AppRailMachines />);
        expect(screen.root.findByType(SidebarFooterPopoverButton).props.hoverPreview).toBe(true);
    });
});
