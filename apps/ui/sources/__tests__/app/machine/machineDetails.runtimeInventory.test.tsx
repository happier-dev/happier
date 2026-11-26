import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { arrangeMachineDetailsHomeForTests, initializeMachineDetailsRuntimeForTests } from './machineDetailsRuntimeHarness';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const routerParamsRef = vi.hoisted(() => ({ current: { id: 'machine-1', page: 'doctor' } as Record<string, string> }));
installTerminalRouteCommonModuleMocks({
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
        translate: (key, params) => key === 'machine.runtimeSummary'
            ? `summary:${params?.cliVersion}:${params?.daemonVersion}:${params?.installationCount}:${params?.serviceCount}:${params?.warningCount}`
            : key,
    }),
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        params: () => routerParamsRef.current,
    }).module,
});

const network = await initializeMachineDetailsRuntimeForTests();
const { clearCachedMachineDoctorSnapshot, writeCachedMachineDoctorSnapshot } = await import('@/components/machines/doctorSnapshot/machineDoctorSnapshotCache');
const disposeActionExecutorLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeActionExecutorLoader);
/** Doctor snapshot reads as the machine receives them over the socket RPC wire. */
function diagnosticsReads() {
    return network.requests.filter(request => request.method === RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS);
}
let home: Awaited<ReturnType<typeof arrangeMachineDetailsHomeForTests>> | null = null;
let otherHome: Awaited<ReturnType<typeof network.addHome>>;
let blockedSwitch: ReturnType<typeof createDeferred<void>> | null = null;
let diagnosticsResponder: (machineId: string, options?: { serverId?: string | null }) => unknown | Promise<unknown>;

beforeEach(async () => {
    routerParamsRef.current = { id: 'machine-1', page: 'doctor' };
    const machine = createMachineFixture({
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
            });
    home = await arrangeMachineDetailsHomeForTests(network, {
        serverUrl: 'https://inventory-a.example.test', machines: [machine],
    });
    otherHome = await network.addHome('https://inventory-b.example.test', 'inventory-account-b');
    home.storage.getState().applyMachines([machine], true, {
        sourceServerId: otherHome.id, sourceAccountId: otherHome.accountId,
    });
    clearCachedMachineDoctorSnapshot({ serverId: home.home.id, machineId: machine.id });
    clearCachedMachineDoctorSnapshot({ serverId: otherHome.id, machineId: machine.id });
    diagnosticsResponder = async () => ({
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
    network.setRpcResponder(async request => {
        const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, 'rpc');
        const response = request.method === RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS
            ? await diagnosticsResponder(request.targetId, { serverId: request.serverUrl === home!.home.serverUrl ? home!.home.id : otherHome.id })
            : {};
        return await socketRpcCodec.encodeResponse({ mode: 'plain' }, response, decoded.callId);
    });
});

afterEach(async () => {
    blockedSwitch?.resolve();
    blockedSwitch = null;
    await standardCleanup();
    await home?.dispose();
    home = null;
});

describe('MachineDetailScreen runtime inventory', () => {
    it('uses the machine list server id for runtime inventory when the route has no serverId param', async () => {
            home!.state.machines = [];
            await home!.sync.refreshMachines();
            diagnosticsResponder = async (_machineId: string, options?: { serverId?: string | null }) => {
                if (options?.serverId !== otherHome.id) {
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
            };

            const { MachineSubPageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachineSubPageScreen');
            const screen = await home!.render(MachineDetailScreen);

            await flushHookEffects({ cycles: 2, turns: 2 });

            await vi.waitFor(() => expect(diagnosticsReads()).toEqual([expect.objectContaining({
                targetId: 'machine-1', serverUrl: otherHome.serverUrl,
            })]));
            expect(screen.getTextContent()).toContain('machine.runtimeInventory');
        });

    it('does not prefetch the runtime inventory until the requested server becomes active', async () => {
            routerParamsRef.current = { id: 'machine-1', serverId: otherHome.id, page: 'doctor' };
            writeCachedMachineDoctorSnapshot({
                serverId: otherHome.id,
                machineId: 'machine-1',
                cachedAt: 444,
                snapshot: {
                    capturedAt: '2026-04-07T10:11:14.000Z',
                    server: {
                        activeServerId: otherHome.id,
                        serverUrl: 'https://server-b.example.test',
                        publicServerUrl: 'https://server-b.example.test',
                        webappUrl: 'https://server-b.example.test',
                    },
                    accountId: 'acct_b',
                    settings: {
                        activeServerId: otherHome.id,
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
            blockedSwitch = createDeferred<void>();
            const switchReleased = blockedSwitch.promise;
            home!.state.beforeRequest = async url => {
                if (url.origin === new URL(otherHome.serverUrl).origin) await switchReleased;
            };

            const { MachineSubPageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachineSubPageScreen');
            const screen = await home!.render(MachineDetailScreen);

            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(diagnosticsReads()).toEqual([]);
            expect(screen.getTextContent()).not.toContain('machine.runtimeInventory');
            expect(screen.getTextContent()).not.toContain('SERVER_B_ONLY_WARNING');

            await act(async () => {
                blockedSwitch!.resolve();
            });
            await flushHookEffects({ cycles: 2, turns: 2 });
            await vi.waitFor(() => expect(diagnosticsReads()).toEqual([expect.objectContaining({
                targetId: 'machine-1', serverUrl: otherHome.serverUrl,
            })]));
            expect(screen.getTextContent()).toContain('machine.runtimeInventory');
        });

    it('asks the machine for its doctor snapshot only on the Doctor page, never on the Overview', async () => {
            routerParamsRef.current = { id: 'machine-1' };
            const { MachinePageScreen } = await import('@/components/machines/page/MachinePageScreen');
            const screen = await home!.render(MachinePageScreen);
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(screen.findByTestId('machine-page-row-doctor')).toBeTruthy();
            expect(diagnosticsReads()).toEqual([]);
            expect(screen.getTextContent()).not.toContain('machine.runtimeInventory');
        });

    it('re-fetches the runtime inventory when pull-to-refresh runs', async () => {
            const { MachineSubPageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachineSubPageScreen');
            const screen = await home!.render(MachineDetailScreen);

            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(diagnosticsReads()).toHaveLength(1);

            const refreshControl = screen.findByType('ScrollView').props.refreshControl;
            await act(async () => {
                await refreshControl.props.onRefresh();
            });
            await flushHookEffects({ cycles: 2, turns: 2 });

            expect(diagnosticsReads()).toHaveLength(2);
        });
});
