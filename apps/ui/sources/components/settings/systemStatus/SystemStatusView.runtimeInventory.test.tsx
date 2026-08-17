import * as React from 'react';
import { act } from 'react-test-renderer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    flushHookEffects,
    invokeTestInstanceHandler,
    pressTestInstanceAsync,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import {
    clearCachedMachineDoctorSnapshot,
    writeCachedMachineDoctorSnapshot,
} from '@/components/machines/doctorSnapshot/machineDoctorSnapshotCache';
import type { VoiceSessionSnapshot } from '@/voice/session/types';

const machineCollectBugReportDiagnosticsMock = vi.hoisted(() => vi.fn());
const voiceSessionSnapshot = vi.hoisted((): { current: VoiceSessionSnapshot } => ({
    current: {
        adapterId: null,
        sessionId: null,
        status: 'disconnected' as const,
        mode: 'idle' as const,
        canStop: false,
    },
}));
const state = vi.hoisted(() => {
    const createMachine = (displayName: string) => ({
        id: 'machine-1',
        active: true,
        activeAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        seq: 1,
        metadata: {
            host: `${displayName.toLowerCase().replace(/\s+/g, '-')}.local`,
            displayName,
            platform: 'darwin',
            arch: 'arm64',
            happyCliVersion: '1.2.3',
            happyHomeDir: '/Users/tester/.happier',
            homeDir: '/Users/tester',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        revokedAt: null,
    });

    return {
        isMachineOnline: true,
        allMachines: [createMachine('Machine One')],
        machineListByServerId: {
            srv_1: [createMachine('Machine One')],
        } as Record<string, Array<ReturnType<typeof createMachine>>>,
        machineListStatusByServerId: {
            srv_1: 'loaded',
        } as Record<string, string>,
        activeServerSnapshot: {
            generation: 1,
            serverId: 'srv_1',
            serverUrl: 'https://api.happier.dev',
        },
        createMachine,
        reset() {
            this.isMachineOnline = true;
            this.allMachines = [createMachine('Machine One')];
            this.machineListByServerId = {
                srv_1: [createMachine('Machine One')],
            };
            this.machineListStatusByServerId = {
                srv_1: 'loaded',
            };
            this.activeServerSnapshot = {
                generation: 1,
                serverId: 'srv_1',
                serverUrl: 'https://api.happier.dev',
            };
        },
    };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
    standardCleanup();
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
    return createUnistylesMock({
        theme: {
            colors: {
                text: '#000000',
                textSecondary: '#777777',
                success: '#00aa55',
                warningCritical: '#cc5500',
                accent: {
                    blue: '#0055ff',
                    indigo: '#2255ff',
                    orange: '#ff8800',
                    purple: '#9955ff',
                },
                surface: '#ffffff',
                groupped: {
                    background: '#ffffff',
                    sectionTitle: '#666666',
                    chevron: '#666666',
                },
            },
        },
    });
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

vi.mock('expo-updates', () => ({
    updateId: null,
    createdAt: null,
    channel: 'preview',
    runtimeVersion: '18',
    isEmbeddedLaunch: true,
}));

vi.mock('./OtaUpdateStatusSection', () => ({
    OtaUpdateStatusSection: () => null,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => state.activeServerSnapshot,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => [],
}));

vi.mock('@/sync/ops/machines', () => ({
    machineCollectBugReportDiagnostics: machineCollectBugReportDiagnosticsMock,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    return createStorageModuleStub({
        useProfile: () => ({ id: 'acct_1', username: 'tester', connectedServices: [] }),
        useIsDataReady: () => true,
        useRealtimeStatus: () => 'connected',
        useSocketStatus: () => ({ status: 'connected', lastError: null, lastErrorAt: null }),
        useLastSyncAt: () => null,
        useAllMachines: () => state.allMachines,
        useMachineListByServerId: () => state.machineListByServerId,
        useMachineListStatusByServerId: () => state.machineListStatusByServerId,
    });
});

vi.mock('@/voice/session/voiceSession', () => ({
    useVoiceSessionSnapshot: () => voiceSessionSnapshot.current,
}));

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => state.isMachineOnline,
}));

describe('SystemStatusView runtime inventory', () => {
    beforeEach(() => {
        state.reset();
        voiceSessionSnapshot.current = {
            adapterId: null,
            sessionId: null,
            status: 'disconnected',
            mode: 'idle',
            canStop: false,
        };
        machineCollectBugReportDiagnosticsMock.mockReset();
        clearCachedMachineDoctorSnapshot({ serverId: 'srv_1', machineId: 'machine-1' });
        clearCachedMachineDoctorSnapshot({ serverId: 'srv_2', machineId: 'machine-1' });
        machineCollectBugReportDiagnosticsMock.mockResolvedValue({
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
        const { SystemStatusView } = await import('@/components/settings/systemStatus/SystemStatusView');
        const screen = await renderScreen(React.createElement(SystemStatusView));

        await flushHookEffects({ cycles: 2, turns: 2 });

        const text = screen.getTextContent();
        expect(text).toContain('machine.runtimeInventory');
        expect(text).toContain('summary:1.2.3:1.2.0:stable:1:1:1');
        expect(text).toContain('machine.doctorRepairSummary');
        expect(text).toContain('machine.doctorRepairFindingsSummary');
        expect(text).toContain('MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH');
    });

    it('reports the canonical Voice session status rather than a copied sync-store projection', async () => {
        voiceSessionSnapshot.current = {
            adapterId: 'realtime_openai',
            sessionId: 'session-1',
            status: 'connecting',
            mode: 'idle',
            canStop: true,
        };
        const { SystemStatusView } = await import('@/components/settings/systemStatus/SystemStatusView');
        const screen = await renderScreen(React.createElement(SystemStatusView));

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.getTextContent()).toContain('connecting');
    });

    it('refreshes machine attribution using machine targets rather than target keys', async () => {
        const { SystemStatusView } = await import('@/components/settings/systemStatus/SystemStatusView');
        const screen = await renderScreen(React.createElement(SystemStatusView));

        await flushHookEffects({ cycles: 2, turns: 2 });
        machineCollectBugReportDiagnosticsMock.mockClear();

        const refreshItem = screen.find((node) => (
            node.props?.title === 'systemStatus.actions.refreshMachineAttribution' &&
            typeof node.props?.onPress === 'function'
        ));
        await pressTestInstanceAsync(refreshItem, 'refresh machine attribution');
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(machineCollectBugReportDiagnosticsMock).toHaveBeenCalledWith('machine-1', {
            timeoutMs: 4000,
            serverId: 'srv_1',
        });
    });

    it('does not flag daemon attribution mismatch for loopback-equivalent Relay URLs', async () => {
        state.activeServerSnapshot = {
            generation: 2,
            serverId: 'srv_1',
            serverUrl: 'http://localhost:34567',
        };
        machineCollectBugReportDiagnosticsMock.mockResolvedValueOnce({
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

        const { SystemStatusView } = await import('@/components/settings/systemStatus/SystemStatusView');
        const screen = await renderScreen(React.createElement(SystemStatusView));

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(screen.getTextContent()).not.toContain('systemStatus.mismatch');
    });

    it('refreshes a machine inventory from the row long press using the machine target', async () => {
        const { SystemStatusView } = await import('@/components/settings/systemStatus/SystemStatusView');
        const screen = await renderScreen(React.createElement(SystemStatusView));

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

        expect(machineCollectBugReportDiagnosticsMock).toHaveBeenCalledWith('machine-1', {
            timeoutMs: 4000,
            serverId: 'srv_1',
        });
    });

    it('keeps runtime inventory scoped per server when two servers expose the same machine id', async () => {
        state.isMachineOnline = false;
        state.allMachines = [
            state.createMachine('Machine One A'),
            state.createMachine('Machine One B'),
        ];
        state.machineListByServerId = {
            srv_1: [state.createMachine('Machine One A')],
            srv_2: [state.createMachine('Machine One B')],
        };
        state.machineListStatusByServerId = {
            srv_1: 'loaded',
            srv_2: 'loaded',
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

        const { SystemStatusView } = await import('@/components/settings/systemStatus/SystemStatusView');
        const screen = await renderScreen(React.createElement(SystemStatusView));

        await flushHookEffects({ cycles: 2, turns: 2 });

        const text = screen.getTextContent();
        expect(text).toContain('summary:1.0.0:1.0.0:stable:0:0:0');
        expect(text).toContain('summary:2.0.0:2.0.0:stable:0:0:0');
    });
});
