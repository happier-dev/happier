import React from 'react';
import { act } from 'react-test-renderer';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { clearCachedMachineDoctorSnapshot, writeCachedMachineDoctorSnapshot } from '@/components/machines/doctorSnapshot/machineDoctorSnapshotCache';
import { installMachineDetailsCommonModuleMocks } from './machineDetailsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class {} };

const machineCollectBugReportDiagnosticsMock = vi.hoisted(() => vi.fn());
const activeServerIdRef = vi.hoisted(() => ({ current: 'server-a' }));
const routerParamsRef = vi.hoisted(() => ({ current: { id: 'machine-1' } as Record<string, string> }));
const setActiveServerAndSwitchMock = vi.hoisted(() => vi.fn(async () => true));
const machineListByServerIdRef = vi.hoisted(() => ({
    current: {} as Record<string, Array<{ id: string }>>,
}));

installMachineDetailsCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const mock = createExpoRouterMock({
            router: { back: vi.fn(), push: vi.fn(), replace: vi.fn(), setParams: vi.fn() },
            params: routerParamsRef.current,
        });
        return {
            ...mock.module,
            useLocalSearchParams: () => routerParamsRef.current,
            useGlobalSearchParams: () => routerParamsRef.current,
        };
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string, params?: Record<string, unknown>) => {
                if (key === 'machine.runtimeSummary' && params) {
                    return `summary:${String(params.cliVersion ?? '')}:${String(params.daemonVersion ?? '')}:${String(params.installationCount ?? '')}:${String(params.serviceCount ?? '')}:${String(params.warningCount ?? '')}`;
                }
                return key;
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSessions: () => [],
            useMachineListByServerId: () => machineListByServerIdRef.current,
            useMachine: () => ({
                id: 'machine-1',
                active: true,
                activeAt: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                seq: 1,
                metadata: {
                    displayName: 'Machine One',
                    host: 'machine-one.local',
                    platform: 'darwin',
                    happyCliVersion: '1.2.3',
                    happyHomeDir: '/Users/tester/.happier',
                    homeDir: '/Users/tester',
                },
                metadataVersion: 1,
                daemonState: {
                    pid: 4321,
                    httpPort: 3005,
                    startTime: Date.now() - 60_000,
                    startedWithCliVersion: '1.2.0',
                },
                daemonStateVersion: 2,
                revokedAt: null,
            }),
            useSetting: () => false,
            useSettingMutable: () => [null, vi.fn()],
            useSettings: () => ({}),
        });
    },
});

vi.mock('@/sync/ops/machines', () => ({
    machineCollectBugReportDiagnostics: machineCollectBugReportDiagnosticsMock,
}));

vi.mock('@/components/machines/DetectedClisList', () => ({ DetectedClisList: () => null }));
vi.mock('@/components/machines/MachineTransferExposureSection', () => ({ MachineTransferExposureSection: () => null }));
vi.mock('@/components/machines/InstallableDepInstaller', () => ({ InstallableDepInstaller: () => null }));
vi.mock('@/components/ui/forms/Switch', () => ({ Switch: () => null }));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({ DropdownMenu: () => null }));
vi.mock('@/components/ui/pathBrowser/PathInputBrowseButton', () => ({ PathInputBrowseButton: () => null }));
vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({ openMachinePathBrowserModal: vi.fn(async () => null) }));
vi.mock('@/components/sessions/runs/ExecutionRunRow', () => ({ ExecutionRunRow: () => null }));
vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({ useMachineCapabilitiesCache: () => ({ state: { status: 'idle' }, refresh: vi.fn() }) }));
vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => () => {} }));
vi.mock('@/hooks/ui/useMountedShouldContinue', () => ({ useMountedShouldContinue: () => () => true }));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({ setActiveServerAndSwitch: setActiveServerAndSwitchMock }));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => String(left ?? '').trim() === String(right ?? '').trim(),
    getActiveServerId: () => activeServerIdRef.current,
}));
vi.mock('@/sync/sync', () => ({ sync: { refreshMachinesThrottled: vi.fn(), refreshMachines: vi.fn(), retryNow: vi.fn() } }));
vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    tryShowDaemonUnavailableAlertForRpcError: () => false,
    tryShowDaemonUnavailableAlertForRpcFailure: () => false,
}));
vi.mock('@/utils/path/pathUtils', () => ({ resolveAbsolutePath: () => '' }));
vi.mock('@/utils/sessions/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/sessions/sessionUtils', () => ({ formatPathRelativeToHome: () => '', getSessionName: () => '', getSessionSubtitle: () => '' }));
vi.mock('@/sync/domains/settings/terminalSettings', () => ({ resolveTerminalSpawnOptions: () => ({}) }));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionConsole', () => ({ resolveWindowsRemoteSessionConsoleFromMachineMetadata: () => 'visible' }));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode', () => ({
    readMachineWindowsRemoteSessionLaunchMode: () => undefined,
    resolveEffectiveWindowsRemoteSessionLaunchMode: () => ({ mode: 'visible' }),
}));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions', () => ({ WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS: [] }));
vi.mock('@/sync/ops', () => ({
    machineSpawnNewSession: vi.fn(async () => ({ type: 'error', errorCode: 'unexpected', errorMessage: 'noop' })),
    machineStopDaemon: vi.fn(async () => ({ message: 'noop' })),
    machineStopSession: vi.fn(async () => ({ ok: true })),
    machineUpdateMetadata: vi.fn(async () => ({})),
    machineExecutionRunsList: vi.fn(async () => ({ ok: true, runs: [] })),
    machineRevokeFromAccount: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/sync/ops/sessionExecutionRuns', () => ({ sessionExecutionRunStop: vi.fn(async () => ({ ok: true })) }));

describe('MachineDetailScreen runtime inventory', () => {
    beforeEach(() => {
        machineCollectBugReportDiagnosticsMock.mockReset();
        activeServerIdRef.current = 'server-a';
        routerParamsRef.current = { id: 'machine-1' };
        machineListByServerIdRef.current = {};
        setActiveServerAndSwitchMock.mockReset();
        setActiveServerAndSwitchMock.mockResolvedValue(true);
        clearCachedMachineDoctorSnapshot({ serverId: 'server-a', machineId: 'machine-1' });
        clearCachedMachineDoctorSnapshot({ serverId: 'server-b', machineId: 'machine-1' });
        machineCollectBugReportDiagnosticsMock.mockResolvedValue({
            doctorSnapshot: {
                capturedAt: '2026-04-07T10:11:12.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: 'https://api.happier.dev',
                    publicServerUrl: 'https://api.happier.dev',
                    webappUrl: 'https://app.happier.dev',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
                daemonStatus: {
                    server: {
                        activeServerId: 'server-a',
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

    afterEach(() => {
        standardCleanup();
    });

    it('shows the runtime inventory section with summary and warnings', async () => {
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        await flushHookEffects({ cycles: 2, turns: 2 });

        const text = screen.getTextContent();
        expect(text).toContain('machine.runtimeInventory');
        expect(text).toContain('summary:1.2.3:1.2.0:1:1:1');
        expect(text).toContain('machine.runtimeInventoryInstallations');
        expect(text).toContain('machine.runtimeInventoryServices');
        expect(text).toContain('machine.backgroundServiceModes.defaultFollowing');
        expect(text).toContain('MULTIPLE_HAPPIER_INSTALLATIONS_ON_PATH');
    });

    it('uses the machine list server id for runtime inventory when the route has no serverId param', async () => {
        machineListByServerIdRef.current = {
            'server-b': [{ id: 'machine-1' }],
        };
        machineCollectBugReportDiagnosticsMock.mockImplementation(async (_machineId: string, options?: { serverId?: string | null }) => {
            if (options?.serverId !== 'server-b') {
                return null;
            }

            return {
                doctorSnapshot: {
                    capturedAt: '2026-04-07T10:11:14.000Z',
                    server: {
                        activeServerId: 'server-b',
                        serverUrl: 'https://server-b.example.test',
                        publicServerUrl: 'https://server-b.example.test',
                        webappUrl: 'https://server-b.example.test',
                    },
                    accountId: 'acct_b',
                    settings: {
                        activeServerId: 'server-b',
                        servers: [],
                        knownAccountIds: ['acct_b'],
                    },
                    daemonStatus: {
                        server: {
                            activeServerId: 'server-b',
                            serverUrl: 'https://server-b.example.test',
                            localServerUrl: 'http://127.0.0.1:3005',
                            publicServerUrl: 'https://server-b.example.test',
                            webappUrl: 'https://server-b.example.test',
                            comparableKey: 'https://server-b.example.test',
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
                            accountId: 'acct_b',
                        },
                    },
                },
            };
        });

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(machineCollectBugReportDiagnosticsMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-b',
        }));
        expect(screen.getTextContent()).toContain('machine.runtimeInventory');
    });

    it('does not prefetch the runtime inventory until the requested server becomes active', async () => {
        routerParamsRef.current = { id: 'machine-1', serverId: 'server-b' };
        writeCachedMachineDoctorSnapshot({
            serverId: 'server-b',
            machineId: 'machine-1',
            cachedAt: 444,
            snapshot: {
                capturedAt: '2026-04-07T10:11:14.000Z',
                server: {
                    activeServerId: 'server-b',
                    serverUrl: 'https://server-b.example.test',
                    publicServerUrl: 'https://server-b.example.test',
                    webappUrl: 'https://server-b.example.test',
                },
                accountId: 'acct_b',
                settings: {
                    activeServerId: 'server-b',
                    servers: [],
                    knownAccountIds: ['acct_b'],
                },
                warnings: [
                    {
                        code: 'SERVER_B_ONLY_WARNING',
                        severity: 'warning',
                        message: 'Server B cached warning',
                        repairCommands: ['happier doctor --json'],
                    },
                ],
            },
        });
        let resolveSwitch: (() => void) | null = null;
        setActiveServerAndSwitchMock.mockImplementation(async () => {
            await new Promise<void>((resolve) => {
                resolveSwitch = resolve;
            });
            activeServerIdRef.current = 'server-b';
            return true;
        });

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(machineCollectBugReportDiagnosticsMock).not.toHaveBeenCalled();
        expect(screen.getTextContent()).not.toContain('machine.runtimeInventory');
        expect(screen.getTextContent()).not.toContain('SERVER_B_ONLY_WARNING');

        await act(async () => {
            if (typeof resolveSwitch === 'function') {
                resolveSwitch();
            }
        });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(machineCollectBugReportDiagnosticsMock).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-b',
        }));
        expect(screen.getTextContent()).toContain('machine.runtimeInventory');
    });

    it('re-fetches the runtime inventory when pull-to-refresh runs', async () => {
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(machineCollectBugReportDiagnosticsMock).toHaveBeenCalledTimes(1);

        const refreshControl = screen.findByType('ScrollView').props.refreshControl;
        await act(async () => {
            await refreshControl.props.onRefresh();
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(machineCollectBugReportDiagnosticsMock).toHaveBeenCalledTimes(2);
    });
});
