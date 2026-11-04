import * as React from 'react';
import { act } from 'react-test-renderer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushHookEffects,
    invokeTestInstanceHandler,
    pressTestInstanceAsync,
    renderScreen,
    renderHook,
    standardCleanup,
} from '@/dev/testkit';
import { createMachineDiagnosticsFixture, createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
    clearCachedMachineDoctorSnapshot,
    writeCachedMachineDoctorSnapshot,
} from '@/components/machines/doctorSnapshot/machineDoctorSnapshotCache';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

// The status projection now needs the actual Home credential authority, not only display rows.
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();

const machineCollectBugReportDiagnosticsMock = vi.hoisted(() => vi.fn());
const state = (() => {
    const createMachine = (displayName: string) => createMachineFixture({
        activeAt: Date.now(),
        metadata: {
            host: `${displayName.toLowerCase().replace(/\s+/g, '-')}.local`,
            displayName,
            platform: 'darwin',
            arch: 'arm64',
            happyCliVersion: '1.2.3',
            happyHomeDir: '/Users/tester/.happier',
            homeDir: '/Users/tester',
        },
    });

    return {
        profileUsername: 'tester' as string | undefined,
        machineListByServerId: {
            srv_1: [createMachine('Machine One')],
        } as Record<string, Array<ReturnType<typeof createMachine>>>,
        activeServerSnapshot: {
            generation: 1,
            serverId: 'srv_1',
            serverUrl: 'https://api.happier.dev',
        },
        createMachine,
        reset() {
            this.profileUsername = 'tester';
            this.machineListByServerId = {
                srv_1: [createMachine('Machine One')],
            };
            this.activeServerSnapshot = {
                generation: 1,
                serverId: 'srv_1',
                serverUrl: 'https://api.happier.dev',
            };
        },
    };
})();

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
    standardCleanup();
    (await import('@/sync/domains/machines/reachability/machineReachability')).clearMachineRequestReachabilityForTest();
    await home.reset();
});

vi.mock('react-native-mmkv', () => {
    class MMKV {
        #store = new Map<string, string>();

        public getString(key: string): string | undefined {
            return this.#store.get(key);
        }

        public set(key: string, value: string): void {
            this.#store.set(key, value);
        }

        public delete(key: string): void {
            this.#store.delete(key);
        }
    }

    return { MMKV };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: vi.fn(), back: vi.fn(), replace: vi.fn(), setParams: vi.fn() } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: Record<string, unknown>) => {
            if (key === 'machine.runtimeSummary' && params) {
                return `summary:${String(params.cliVersion ?? '')}:${String(params.daemonVersion ?? '')}:${String(params.daemonRing ?? '')}:${String(params.installationCount ?? '')}:${String(params.serviceCount ?? '')}:${String(params.warningCount ?? '')}`;
            }
            return key;
        },
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' }, deviceName: 'test-device' },
}));

vi.mock('expo-application', () => ({
    nativeApplicationVersion: '0.0.0-test',
    nativeBuildVersion: '1',
    applicationId: 'dev.happier.test',
}));

vi.mock('expo-updates', async () => (await import('@/dev/testkit/mocks/expoUpdates')).createExpoUpdatesMock());

// Only the RPC transport is replaced; doctor parsing, caching, and admission remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(machineCollectBugReportDiagnosticsMock));

const { storage } = await import('@/sync/domains/state/storageStore');
const { getVoiceSessionSnapshot, setVoiceSessionSnapshot } = await import('@/voice/session/voiceSessionStore');
const { SystemStatusView } = await import('./SystemStatusView');
const { OverviewMachinesSection } = await import('../overview/OverviewMachinesSection');
const { useMachineFleetModel } = await import('@/components/machines/widgets/MachineFleetWidget');
const { isMachineSelectableForFleet } = await import('@/sync/domains/machines/administration/fleetUnion');
const beforeStorage = storage.getState();
const beforeVoice = getVoiceSessionSnapshot();

async function renderStatus() {
    storage.setState(current => ({
        isDataReady: true,
        profileScope: { serverId: 'srv_1', accountId: 'acct_1' },
        profile: { ...current.profile, id: 'acct_1', username: state.profileUsername ?? null },
        machines: Object.fromEntries((state.machineListByServerId.srv_1 ?? []).map(machine => [machine.id, machine])),
        machineListByServerId: state.machineListByServerId,
        machineListStatusByServerId: Object.fromEntries(Object.keys(state.machineListByServerId).map(serverId => [serverId, 'idle' as const])),
    }));
    return renderScreen(React.createElement(SystemStatusView));
}

afterEach(() => { storage.setState(beforeStorage, true); setVoiceSessionSnapshot(beforeVoice); });

describe('SystemStatusView runtime inventory', () => {
    beforeEach(async () => {
        state.reset();
        installHomeGovernanceBoundaries(home);
        await home.addHome({ name: 'Status Home', serverUrl: state.activeServerSnapshot.serverUrl,
            serverIdentityId: 'srv_1', accountId: 'acct_1', currentAccount: true });
        const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const scope = await renderHook(() => useServerCredentialAccountScopeBinding('srv_1'));
        await waitForHomeGovernance(() => expect(scope.getCurrent().resolution)
            .toMatchObject({ kind: 'bound', scope: { serverId: 'srv_1', accountId: 'acct_1' } }));
        await scope.unmount();
        setVoiceSessionSnapshot({
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        });
        machineCollectBugReportDiagnosticsMock.mockReset();
        clearCachedMachineDoctorSnapshot({ serverId: 'srv_1', machineId: 'machine-1' });
        clearCachedMachineDoctorSnapshot({ serverId: 'srv_2', machineId: 'machine-1' });
        machineCollectBugReportDiagnosticsMock.mockResolvedValue({
            ...createMachineDiagnosticsFixture(),
            doctorSnapshot: {
                capturedAt: '2026-04-07T10:11:12.000Z',
                server: {
                    activeServerId: 'srv_1',
                    serverUrl: 'https://api.happier.dev',
                    publicServerUrl: 'https://api.happier.dev',
                    webappUrl: 'https://app.happier.dev',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'srv_1',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
                daemonStatus: {
                    server: {
                        activeServerId: 'srv_1',
                        serverUrl: 'https://api.happier.dev',
                        localServerUrl: 'http://127.0.0.1:3005',
                        publicServerUrl: 'https://api.happier.dev',
                        webappUrl: 'https://app.happier.dev',
                        comparableKey: 'https://api.happier.dev',
                    },
                    daemon: {
                        running: true,
                        pid: 4321,
                        httpPort: 3005,
                        startedWithCliVersion: '1.2.0',
                        startedWithPublicReleaseChannel: 'stable',
                    },
                    service: { installed: true, running: true },
                    auth: {
                        authenticated: true,
                        machineRegistered: true,
                        machineId: 'machine-1',
                        needsAuth: false,
                        accountId: 'acct_1',
                    },
                },
                installations: {
                    happier: {
                        activeInvocation: {
                            path: '/opt/happier/bin/happier',
                            realPath: '/opt/happier/bin/happier',
                            invokerName: 'happier',
                            ring: 'preview',
                            version: '1.2.3',
                            installationId: 'managed:preview:/opt/happier/cli-preview/current',
                        },
                        installations: [
                            {
                                id: 'managed:preview:/opt/happier/cli-preview/current',
                                source: 'firstPartyManaged',
                                components: ['happier-cli', 'happier-daemon'],
                                ring: 'preview',
                                version: '1.2.3',
                                path: '/opt/happier/cli-preview/current',
                                realPath: '/opt/happier/cli-preview/current',
                                shimName: 'hprev',
                                onPath: true,
                                managedRoot: '/opt/happier/cli-preview',
                            },
                            {
                                id: 'pathBinary:/usr/local/bin/happier',
                                source: 'pathBinary',
                                components: ['happier-cli', 'happier-daemon'],
                                ring: 'stable',
                                version: '1.0.0',
                                path: '/usr/local/bin/happier',
                                realPath: '/usr/local/bin/happier',
                                shimName: 'happier',
                                onPath: true,
                                managedRoot: null,
                            },
                        ],
                    },
                },
                services: {
                    happier: {
                        services: [
                            {
                                id: 'daemon:com.happier.cli.daemon.preview.machine-1',
                                serviceType: 'daemon',
                                platform: 'darwin',
                                backend: 'launchd',
                                label: 'com.happier.cli.daemon.preview.machine-1',
                                verification: 'verified',
                                ring: 'preview',
                                targetMode: 'default-following',
                                instanceId: 'machine-1',
                                scope: 'user',
                                definitionPath: '/Users/tester/Library/LaunchAgents/com.happier.cli.daemon.preview.machine-1.plist',
                                executablePath: '/opt/happier/cli-preview/current/happier',
                                installed: true,
                                running: true,
                            },
                        ],
                    },
                },
                repairSummary: {
                    schemaVersion: 1,
                    status: 'needs_attention',
                    findingCounts: {
                        total: 1,
                        warning: 1,
                        actionable: 1,
                    },
                    findingKinds: ['multiple_happier_installations_on_path'],
                },
                warnings: [
                    {
                        code: 'MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH',
                        severity: 'warning',
                        message: 'Multiple Happier CLI installations were detected on PATH.',
                        repairCommands: ['happier doctor --json'],
                    },
                ],
            },
        });
    });

    it('renders the current CLI, daemon, and runtime inventory summary', async () => {
        const screen = await renderStatus();

        await flushHookEffects({ cycles: 2, turns: 2 });

        const text = screen.getTextContent();
        expect(text).toContain('machine.runtimeInventory');
        expect(text).toContain('summary:1.2.3:1.2.0:stable:1:1:1');
        expect(text).toContain('machine.doctorRepairSummary');
        expect(text).toContain('machine.doctorRepairFindingsSummary');
        expect(text).toContain('MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH');
    });

    it('lists online machines and keeps the offline ones behind one quiet row, without speaking for machines nobody checked', async () => {
        const online = state.createMachine('Studio');
        const retired = { ...state.createMachine('Retired devbox'), id: 'machine-2', activeAt: 1 };
        state.machineListByServerId = { srv_1: [online, retired] };
        const screen = await renderStatus();
        await flushHookEffects({ cycles: 2, turns: 2 });

        const text = screen.getTextContent();
        expect(text).toContain('Studio');
        expect(text).not.toContain('Retired devbox');
        const offlineRow = screen.findAll((node) => node.props?.title === 'systemStatus.machine.offline' && node.props?.detail === '1');
        expect(offlineRow.length).toBeGreaterThan(0);

        // Nothing is said about an unchecked daemon until the person asks.
        expect(screen.getTextContent()).not.toContain('systemStatus.machine.daemonAttributionUnknown');
    });

    it('withdraws mounted machine presence to unknown without folding it among genuinely offline machines', async () => {
        const known = { ...state.createMachine('Studio'), id: 'present' };
        const offline = { ...state.createMachine('Sleeping'), id: 'sleeping', active: false, activeAt: 0 };
        state.machineListByServerId = { srv_1: [known, offline] };
        const screen = await renderStatus();
        await flushHookEffects({ cycles: 2, turns: 2 });
        const { withdrawMachinePresenceForScope, captureMachinePresenceObservation } = await import('@/sync/domains/machines/reachability/machineReachability');
        await act(async () => {
            const scope = { serverId: 'srv_1', accountId: 'acct_1' };
            withdrawMachinePresenceForScope(scope);
            captureMachinePresenceObservation(scope)(['sleeping']);
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(screen.getTextContent()).toContain('Studio');
        expect(screen.getTextContent()).toContain('common.unknown');
        const offlineRows = screen.findAll(node => node.props.title === 'systemStatus.machine.offline' && node.props.detail === '1');
        expect(offlineRows.length).toBeGreaterThan(0);
    });

    it('shows the active Home once, even when its saved profile id differs from its identity', async () => {
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        expect(getServerProfileById('srv_1')?.id).not.toBe('srv_1');
        const screen = await renderStatus();
        await flushHookEffects({ cycles: 2, turns: 2 });

        const sections = screen.findAll((node) => typeof node.props?.title === 'string' && node.props.title.startsWith('systemStatus.sections.machines'));
        expect(sections.some((node) => node.props.title === 'systemStatus.sections.machinesActiveServer')).toBe(true);
        expect(sections.some((node) => node.props.title !== 'systemStatus.sections.machinesActiveServer' && !String(node.props.title).includes('machinesActiveServer'))).toBe(false);
    });

    it('names same-named machines apart with the canonical machine-name owner and hides an idle voice row', async () => {
        const first = state.createMachine('Studio');
        const second = { ...state.createMachine('Studio'), id: 'machine-2' };
        state.machineListByServerId = { srv_1: [first, second] };
        const screen = await renderStatus();
        await flushHookEffects({ cycles: 2, turns: 2 });

        for (const header of screen.findAll((node) => node.props?.title === 'systemStatus.machines.calmOnline' && typeof node.props?.onPress === 'function')) {
            await pressTestInstanceAsync(header, 'open calm machines');
        }
        await flushHookEffects({ cycles: 2, turns: 2 });
        const titles = screen.findAll((node) => typeof node.props?.title === 'string').map((node) => String(node.props.title));
        expect(titles.filter((title) => title.startsWith('Studio ·')).length).toBe(2);
        expect(titles).not.toContain('systemStatus.ui.realtime');
    });

    it('folds calm online machines into one counted row and lists only the machines that need attention', async () => {
        const calmA = { ...state.createMachine('Calm A'), id: 'machine-a' };
        const calmB = { ...state.createMachine('Calm B'), id: 'machine-b' };
        const drifted = { ...state.createMachine('Drifted'), id: 'machine-c' };
        state.machineListByServerId = { srv_1: [calmA, calmB, drifted] };
        const baseline = machineCollectBugReportDiagnosticsMock.getMockImplementation();
        machineCollectBugReportDiagnosticsMock.mockImplementation(async (request: { machineId: string }) => {
            const result = await baseline?.(request);
            const machineId = request.machineId;
            if (machineId !== 'machine-c' || !result?.doctorSnapshot) return result;
            return { ...result, doctorSnapshot: { ...result.doctorSnapshot, accountId: 'acct_other' } };
        });
        const screen = await renderStatus();
        await flushHookEffects({ cycles: 4, turns: 4 });

        const text = screen.getTextContent();
        expect(text).toContain('Drifted');
        expect(text).not.toContain('Calm A');
        const fold = screen.findAll((node) => node.props?.title === 'systemStatus.machines.calmOnline');
        expect(fold.some((node) => node.props?.detail === '2')).toBe(true);
    });

    it('hides the username row when the account has no name instead of showing a placeholder', async () => {
        state.profileUsername = undefined;
        const screen = await renderStatus();
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.findAll((node) => node.props?.title === 'systemStatus.identity.username')).toHaveLength(0);
        expect(screen.findAll((node) => node.props?.title === 'systemStatus.identity.accountId').length).toBeGreaterThan(0);
    });

    it('projects the same reachable fleet through Administration, Overview and System Status', async () => {
        const { recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
        const reachable = state.createMachine('Reachable');
        const failing = { ...state.createMachine('Failing'), id: 'machine-f' };
        const replaced = { ...state.createMachine('Replaced'), id: 'machine-r', replacedByMachineId: 'machine-new' };
        const second = { ...state.createMachine('Second'), id: 'machine-s' };
        state.machineListByServerId = { srv_1: [reachable, second, failing, replaced] };
        recordMachineRequestFailed({ serverId: 'srv_1', accountId: 'acct_1', machineId: 'machine-f' });
        const connection = await restoreServerAccountForTest({
            serverUrl: state.activeServerSnapshot.serverUrl, serverIdentityId: 'srv_1',
            accountId: 'acct_1', request: home.request,
        });
        try {
            const screen = await renderStatus();
            const overview = await renderScreen(React.createElement(OverviewMachinesSection, { testID: 'overview' }));
            const fleetModel = await renderHook(() => useMachineFleetModel());
            await flushHookEffects({ cycles: 2, turns: 2 });

            const accountScope = { serverId: 'srv_1', accountId: 'acct_1' };
            expect(isMachineSelectableForFleet(accountScope, reachable)).toBe(true);
            expect(isMachineSelectableForFleet(accountScope, failing)).toBe(false);
            expect(isMachineSelectableForFleet(accountScope, replaced)).toBe(false);
            expect(fleetModel.getCurrent().fleet.map(({ machine, online }) => ({ id: machine.id, online })))
                .toEqual([{ id: 'machine-1', online: true }, { id: 'machine-s', online: true }, { id: 'machine-f', online: false }]);
            expect(overview.findByTestId('overview.all')).not.toBeNull();
            expect(overview.getTextContent()).not.toContain('Replaced');

            for (const header of screen.findAll((node) => node.props?.title === 'systemStatus.machines.calmOnline' && typeof node.props?.onPress === 'function')) {
                await pressTestInstanceAsync(header, 'open calm machines');
            }
            await flushHookEffects({ cycles: 2, turns: 2 });
            const text = screen.getTextContent();
            expect(text).toContain('Reachable');
            expect(text).not.toContain('Replaced');
            // The failing machine sits behind the Offline row, not among the online machines.
            expect(text).not.toContain('Failing');
            const offline = screen.findAll((node) => node.props?.title === 'systemStatus.machine.offline' && node.props?.detail === '1');
            expect(offline.length).toBeGreaterThan(0);
        } finally {
            standardCleanup();
            await connection.dispose();
        }
    });

    it('reports the canonical Voice session status rather than a copied sync-store projection', async () => {
        setVoiceSessionSnapshot({
            adapterId: 'realtime_openai',
            sessionId: 'session-1',
            status: 'connecting',
            mode: 'idle',
            canStop: true,
        });
        const screen = await renderStatus();

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.getTextContent()).toContain('connecting');
    });

    it('refreshes machine attribution using machine targets rather than target keys', async () => {
        const screen = await renderStatus();

        await flushHookEffects({ cycles: 2, turns: 2 });
        machineCollectBugReportDiagnosticsMock.mockClear();

        const refreshItem = screen.find((node) => (
            node.props?.title === 'systemStatus.actions.refreshMachineAttribution' &&
            typeof node.props?.onPress === 'function'
        ));
        await pressTestInstanceAsync(refreshItem, 'refresh machine attribution');
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(machineCollectBugReportDiagnosticsMock).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1',
            timeoutMs: 4000,
            serverId: 'srv_1',
        }));
    });

    it('does not flag daemon attribution mismatch for loopback-equivalent Relay URLs', async () => {
        await home.addHome({ name: 'Local Home', serverUrl: 'http://localhost:34567',
            serverIdentityId: 'srv_1', accountId: 'acct_1', currentAccount: true });
        machineCollectBugReportDiagnosticsMock.mockResolvedValueOnce({
            ...createMachineDiagnosticsFixture(),
            doctorSnapshot: {
                capturedAt: '2026-04-07T10:11:12.000Z',
                server: {
                    activeServerId: 'srv_1',
                    serverUrl: 'http://127.0.0.1:34567',
                    publicServerUrl: 'http://127.0.0.1:34567',
                    webappUrl: 'http://localhost:34567',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'srv_1',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
                daemonStatus: {
                    server: {
                        activeServerId: 'srv_1',
                        serverUrl: 'http://127.0.0.1:34567',
                        localServerUrl: 'http://127.0.0.1:34567',
                        publicServerUrl: 'http://127.0.0.1:34567',
                        webappUrl: 'http://localhost:34567',
                        comparableKey: 'http://localhost:34567',
                    },
                    daemon: {
                        running: true,
                        pid: 4321,
                        httpPort: 59949,
                        startedWithCliVersion: '1.2.0',
                        startedWithPublicReleaseChannel: 'stable',
                    },
                    service: { installed: false, running: false },
                    auth: {
                        authenticated: true,
                        machineRegistered: true,
                        machineId: 'machine-1',
                        needsAuth: false,
                        accountId: 'acct_1',
                    },
                },
                installations: { happier: { installations: [] } },
                services: { happier: { services: [] } },
                warnings: [],
            },
        });

        const screen = await renderStatus();

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.getTextContent()).not.toContain('systemStatus.mismatch');
    });

    it('refreshes a machine inventory from the row long press using the machine target', async () => {
        const screen = await renderStatus();

        await flushHookEffects({ cycles: 2, turns: 2 });
        machineCollectBugReportDiagnosticsMock.mockClear();

        const machineRow = screen.find((node) => (
            node.props?.title === 'Machine One' &&
            typeof node.props?.onLongPress === 'function'
        ));
        await act(async () => {
            invokeTestInstanceHandler(machineRow, 'onLongPress', undefined, 'machine row');
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(machineCollectBugReportDiagnosticsMock).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'machine-1',
            timeoutMs: 4000,
            serverId: 'srv_1',
        }));
    });

    it('keeps runtime inventory scoped per server when two servers expose the same machine id', async () => {
        await home.addHome({ name: 'Other Home', serverUrl: 'https://other-status.test',
            serverIdentityId: 'srv_2', accountId: 'acct_1', currentAccount: true, active: false });
        state.machineListByServerId = {
            srv_1: [{ ...state.createMachine('Machine One A'), activeAt: 1 }],
            srv_2: [{ ...state.createMachine('Machine One B'), activeAt: 1 }],
        };

        writeCachedMachineDoctorSnapshot({
            serverId: 'srv_1',
            machineId: 'machine-1',
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-04-07T10:11:12.000Z',
                server: {
                    activeServerId: 'srv_1',
                    serverUrl: 'https://srv-1.test',
                    publicServerUrl: 'https://srv-1.test',
                    webappUrl: 'https://app.srv-1.test',
                },
                accountId: 'acct_1',
                settings: { activeServerId: 'srv_1', servers: [], knownAccountIds: ['acct_1'] },
                daemonStatus: {
                    server: {
                        activeServerId: 'srv_1',
                        serverUrl: 'https://srv-1.test',
                        localServerUrl: 'http://127.0.0.1:3005',
                        publicServerUrl: 'https://srv-1.test',
                        webappUrl: 'https://app.srv-1.test',
                        comparableKey: 'https://srv-1.test',
                    },
                    daemon: {
                        running: true,
                        pid: 1,
                        httpPort: 3005,
                        startedWithCliVersion: '1.0.0',
                        startedWithPublicReleaseChannel: 'stable',
                    },
                    service: { installed: true, running: true },
                    auth: {
                        authenticated: true,
                        machineRegistered: true,
                        machineId: 'machine-1',
                        needsAuth: false,
                        accountId: 'acct_1',
                    },
                },
                installations: {
                    happier: {
                        activeInvocation: {
                            path: '/opt/happier/bin/happier',
                            realPath: '/opt/happier/bin/happier',
                            invokerName: 'happier',
                            ring: 'stable',
                            version: '1.0.0',
                            installationId: 'install-1',
                        },
                        installations: [],
                    },
                },
                services: { happier: { services: [] } },
                warnings: [],
            },
        });
        writeCachedMachineDoctorSnapshot({
            serverId: 'srv_2',
            machineId: 'machine-1',
            cachedAt: 2,
            snapshot: {
                capturedAt: '2026-04-07T10:11:12.000Z',
                server: {
                    activeServerId: 'srv_2',
                    serverUrl: 'https://srv-2.test',
                    publicServerUrl: 'https://srv-2.test',
                    webappUrl: 'https://app.srv-2.test',
                },
                accountId: 'acct_1',
                settings: { activeServerId: 'srv_2', servers: [], knownAccountIds: ['acct_1'] },
                daemonStatus: {
                    server: {
                        activeServerId: 'srv_2',
                        serverUrl: 'https://srv-2.test',
                        localServerUrl: 'http://127.0.0.1:3005',
                        publicServerUrl: 'https://srv-2.test',
                        webappUrl: 'https://app.srv-2.test',
                        comparableKey: 'https://srv-2.test',
                    },
                    daemon: {
                        running: true,
                        pid: 2,
                        httpPort: 3005,
                        startedWithCliVersion: '2.0.0',
                        startedWithPublicReleaseChannel: 'stable',
                    },
                    service: { installed: true, running: true },
                    auth: {
                        authenticated: true,
                        machineRegistered: true,
                        machineId: 'machine-1',
                        needsAuth: false,
                        accountId: 'acct_1',
                    },
                },
                installations: {
                    happier: {
                        activeInvocation: {
                            path: '/opt/happier/bin/happier',
                            realPath: '/opt/happier/bin/happier',
                            invokerName: 'happier',
                            ring: 'stable',
                            version: '2.0.0',
                            installationId: 'install-2',
                        },
                        installations: [],
                    },
                },
                services: { happier: { services: [] } },
                warnings: [],
            },
        });

        const screen = await renderStatus();

        await flushHookEffects({ cycles: 2, turns: 2 });
        // Offline machines sit behind one row per Home; open both to read their inventory.
        for (const header of screen.findAll((node) => node.props?.title === 'systemStatus.machine.offline' && typeof node.props?.onPress === 'function')) {
            await pressTestInstanceAsync(header, 'open offline machines');
        }
        await flushHookEffects({ cycles: 2, turns: 2 });

        const text = screen.getTextContent();
        expect(text).toContain('summary:1.0.0:1.0.0:stable:0:0:0');
        expect(text).toContain('summary:2.0.0:2.0.0:stable:0:0:0');
    });
});
