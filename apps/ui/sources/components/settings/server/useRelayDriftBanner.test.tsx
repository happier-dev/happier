import * as React from 'react';
import renderer from 'react-test-renderer';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SystemTaskRunner } from '@/components/systemTasks/types';
import { renderScreen } from '@/dev/testkit';
import { buildRelayDriftRepairSystemTaskSpec } from '@/sync/domains/server/relayDrift/relayDriftSystemTask';
import { installServerSettingsHooksCommonModuleMocks } from './hooks/serverSettingsHooksTestHelpers';
import type { RelayDriftBanner } from './relayDriftTypes';

type ActiveServerSnapshot = Readonly<{
    serverId: string;
    serverUrl: string;
    activeLocalRelayUrl?: string | null;
    generation: number;
}>;

type CachedDoctorSnapshot = Readonly<{
    cachedAt: number;
    snapshot: {
        capturedAt: string;
        server: {
            activeServerId: string;
            serverUrl: string;
            publicServerUrl: string;
            webappUrl: string;
        };
        accountId: string | null;
        settings: {
            activeServerId: string | null;
            servers: readonly [];
            knownAccountIds: readonly string[];
        };
    };
}> | null;

const state = vi.hoisted(() => ({
    activeServerSnapshot: {
        serverId: 'server-a',
        serverUrl: 'https://relay.example.test',
        generation: 1,
    } as ActiveServerSnapshot,
    cachedDoctorSnapshot: null as CachedDoctorSnapshot,
    profiles: [
        {
            id: 'server-a',
            name: 'Relay A',
            serverUrl: 'https://relay.example.test',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: 0,
        },
    ],
    runner: null as SystemTaskRunner | null,
}));

installServerSettingsHooksCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

vi.mock('@/components/settings/server/hooks/usePrimaryMachineFromActiveSelection', () => ({
    usePrimaryMachineFromActiveSelection: () => 'machine-1',
}));

vi.mock('@/components/settings/systemStatus/cache/machineDoctorSnapshotCache', () => ({
    readCachedMachineDoctorSnapshot: () => state.cachedDoctorSnapshot,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => state.activeServerSnapshot,
    listServerProfiles: () => state.profiles,
}));

const upsertAndActivateServerSpy = vi.hoisted(() => vi.fn((..._args: any[]) => ({ id: 'server-daemon', serverUrl: 'https://daemon-relay.example.test' })));
vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>();
    return {
        ...actual,
        upsertAndActivateServer: (...args: unknown[]) => upsertAndActivateServerSpy(...args),
    };
});

const switchConnectionToActiveServerSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: (...args: unknown[]) => switchConnectionToActiveServerSpy(...args),
}));

const refreshFromActiveServerSpy = vi.hoisted(() => vi.fn(async (..._args: any[]) => {}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ refreshFromActiveServer: (...args: unknown[]) => refreshFromActiveServerSpy(...args) }),
}));

vi.mock('@/components/systemTasks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/systemTasks')>();
    return {
        ...actual,
        getDefaultSystemTaskRunner: () => state.runner,
    };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('useRelayDriftBanner', () => {
    beforeEach(() => {
        Reflect.deleteProperty(globalThis as { location?: unknown }, 'location');
        state.activeServerSnapshot = {
            serverId: 'server-a',
            serverUrl: 'https://relay.example.test',
            generation: 1,
        } as ActiveServerSnapshot;
        state.cachedDoctorSnapshot = null;
        state.profiles = [
            {
                id: 'server-a',
                name: 'Relay A',
                serverUrl: 'https://relay.example.test',
                createdAt: 0,
                updatedAt: 0,
                lastUsedAt: 0,
            },
        ];
        state.runner = {
            mode: 'dev',
            start: async () => 'task_1',
            cancel: async () => {},
            respond: async () => {},
            getSnapshot: () => null,
            subscribe: () => () => {},
        } satisfies SystemTaskRunner;
    });

    it('does not show drift when the daemon public relay matches the active relay', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: 'http://127.0.0.1:3000',
                    publicServerUrl: 'https://relay.example.test',
                    webappUrl: 'https://relay.example.test',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).toBeNull();
    });

    it('does not show drift when the active relay is public but the app same-origin matches the daemon local relay', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        Object.defineProperty(globalThis, 'location', {
            configurable: true,
            value: { origin: 'http://127.0.0.1:3000' },
        } as PropertyDescriptor);
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: 'http://127.0.0.1:3000',
                    publicServerUrl: '',
                    webappUrl: 'http://127.0.0.1:3000',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).toBeNull();
    });

    it('dispatches the relay repair system task when the action is pressed', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');
        const startMock = vi.fn(async (spec: unknown) => {
            SystemTaskSpecSchema.parse(spec);
            return 'task_1';
        });
        const cancelMock = vi.fn(async (_taskId: string) => {});
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        state.runner = createSystemTaskRunner({
            mode: 'dev',
            bridge: {
                start: startMock,
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                cancel: cancelMock,
                respond: async () => {},
            },
        });
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: '',
                    publicServerUrl: '',
                    webappUrl: '',
                },
                accountId: null,
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: [],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const resolvedBanner = banner as RelayDriftBanner | null;
        expect(resolvedBanner).not.toBeNull();
        if (!resolvedBanner) {
            throw new Error('Expected a relay drift banner');
        }
        await renderer.act(async () => {
            await resolvedBanner.onPress();
        });

        expect(startMock).toHaveBeenCalledWith(buildRelayDriftRepairSystemTaskSpec({
            activeRelayUrl: 'https://relay.example.test',
            activeWebappUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
        }));
        const bannerAfterStart = banner as RelayDriftBanner | null;
        expect(bannerAfterStart?.repairTaskSnapshot).toEqual(expect.objectContaining({
            taskId: 'task_1',
            status: 'running',
        }));

        await renderer.act(async () => {
            listeners.get('task_1')?.onEvent({
                protocolVersion: 1,
                taskId: 'task_1',
                tsMs: 100,
                type: 'progress',
                stepId: 'relay.connectBackgroundService.configureRelay',
                message: 'executor message',
            });
        });

        const bannerAfterEvent = banner as RelayDriftBanner | null;
        expect(bannerAfterEvent?.repairTaskSnapshot).toEqual(expect.objectContaining({
            currentStepId: 'relay.connectBackgroundService.configureRelay',
            latestMessage: 'executor message',
        }));
        expect(typeof bannerAfterEvent?.onCancelRepair).toBe('function');

        await renderer.act(async () => {
            await bannerAfterEvent?.onCancelRepair?.();
        });

        expect(cancelMock).toHaveBeenCalledWith('task_1');
    });

    it('infers the active webapp url when repairing Happier Cloud relay drift', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        const startMock = vi.fn(async (spec: unknown) => {
            SystemTaskSpecSchema.parse(spec);
            return 'task_1';
        });

        state.runner = createSystemTaskRunner({
            mode: 'dev',
            bridge: {
                start: startMock,
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });
        state.activeServerSnapshot = {
            serverId: 'cloud',
            serverUrl: 'https://api.happier.dev',
            generation: 1,
        } as ActiveServerSnapshot;
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'cloud',
                    serverUrl: '',
                    publicServerUrl: '',
                    webappUrl: '',
                },
                accountId: null,
                settings: {
                    activeServerId: 'cloud',
                    servers: [],
                    knownAccountIds: [],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).not.toBeNull();
        await renderer.act(async () => {
            await banner?.onPress();
        });

        expect(startMock).toHaveBeenCalledWith(buildRelayDriftRepairSystemTaskSpec({
            activeRelayUrl: 'https://api.happier.dev',
            activeWebappUrl: 'https://app.happier.dev',
            activeLocalRelayUrl: null,
        }));
    });

    it('passes the daemon local relay url to repair when the active relay matches the daemon public relay', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        const startMock = vi.fn(async (spec: unknown) => {
            SystemTaskSpecSchema.parse(spec);
            return 'task_1';
        });

        state.runner = createSystemTaskRunner({
            mode: 'dev',
            bridge: {
                start: startMock,
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });
        state.activeServerSnapshot = {
            serverId: 'server-a',
            serverUrl: 'https://relay.example.test',
            generation: 1,
        } as ActiveServerSnapshot;
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: 'http://127.0.0.1:3000',
                    publicServerUrl: 'https://relay.example.test',
                    webappUrl: 'https://relay.example.test',
                },
                accountId: null,
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: [],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).not.toBeNull();
        await renderer.act(async () => {
            await banner?.onPress();
        });

        expect(startMock).toHaveBeenCalledWith(buildRelayDriftRepairSystemTaskSpec({
            activeRelayUrl: 'https://relay.example.test',
            activeWebappUrl: 'https://relay.example.test',
            activeLocalRelayUrl: 'http://127.0.0.1:3000',
        }));
    });

    it('prefers the active snapshot local relay url when available', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        const startMock = vi.fn(async (spec: unknown) => {
            SystemTaskSpecSchema.parse(spec);
            return 'task_1';
        });

        state.runner = createSystemTaskRunner({
            mode: 'dev',
            bridge: {
                start: startMock,
                async subscribe() {
                    return () => {};
                },
                async cancel() {},
                async respond() {},
            },
        });
        state.activeServerSnapshot = {
            serverId: 'server-a',
            serverUrl: 'https://relay.example.test',
            activeLocalRelayUrl: 'http://127.0.0.1:3000',
            generation: 2,
        } as ActiveServerSnapshot;
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-b',
                    serverUrl: 'https://other-relay.example.test',
                    publicServerUrl: 'https://other-relay.example.test',
                    webappUrl: 'https://other-relay.example.test',
                },
                accountId: null,
                settings: {
                    activeServerId: 'server-b',
                    servers: [],
                    knownAccountIds: [],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).not.toBeNull();
        await renderer.act(async () => {
            await banner?.onPress();
        });

        expect(startMock).toHaveBeenCalledWith(buildRelayDriftRepairSystemTaskSpec({
            activeRelayUrl: 'https://relay.example.test',
            activeWebappUrl: 'https://relay.example.test',
            activeLocalRelayUrl: 'http://127.0.0.1:3000',
        }));
    });

    it('marks the repair action unavailable when the system task bridge is unavailable', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const startMock = vi.fn(async () => 'task_1');
        state.runner = {
            mode: 'unavailable',
            start: startMock,
            cancel: async () => {},
            respond: async () => {},
            getSnapshot: () => null,
            subscribe: () => () => {},
        } satisfies SystemTaskRunner;
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: '',
                    publicServerUrl: '',
                    webappUrl: '',
                },
                accountId: null,
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: [],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const resolvedBanner = banner as RelayDriftBanner | null;
        expect(resolvedBanner).not.toBeNull();
        expect(resolvedBanner?.actionDisabled).toBe(true);
        expect(resolvedBanner?.actionHint).toBe('settings.systemTaskBridgeUnavailable');

        await renderer.act(async () => {
            await resolvedBanner?.onPress();
        });

        expect(startMock).not.toHaveBeenCalled();
    });

    it('exposes a secondary action for switching to the daemon relay when the daemon is connected to a different relay', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: 'https://daemon-relay.example.test',
                    publicServerUrl: 'https://daemon-relay.example.test',
                    webappUrl: 'https://daemon-relay.example.test',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const resolvedBanner = banner as RelayDriftBanner | null;
        expect(resolvedBanner).not.toBeNull();
        const secondaryActionLabel = (resolvedBanner as unknown as { secondaryActionLabel?: unknown }).secondaryActionLabel;
        expect(secondaryActionLabel).toBe('server.switchToServer');

        await renderer.act(async () => {
            await (resolvedBanner as unknown as { onSecondaryPress?: () => void | Promise<void> }).onSecondaryPress?.();
        });

        expect(upsertAndActivateServerSpy).toHaveBeenCalledWith(expect.objectContaining({
            serverUrl: 'https://daemon-relay.example.test',
        }));
        expect(switchConnectionToActiveServerSpy).toHaveBeenCalled();
        expect(refreshFromActiveServerSpy).toHaveBeenCalled();
    });

    it('uses an authenticate action label when the relay matches but the daemon still needs auth', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: 'https://relay.example.test',
                    publicServerUrl: 'https://relay.example.test',
                    webappUrl: 'https://relay.example.test',
                },
                accountId: null,
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: [],
                },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        const resolvedBanner = banner as RelayDriftBanner | null;
        expect(resolvedBanner).not.toBeNull();
        expect(resolvedBanner?.actionLabel).toBe('common.authenticate');
    });
});
