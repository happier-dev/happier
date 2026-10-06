import * as React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CachedMachineDoctorSnapshot } from '@/components/machines/doctorSnapshot/machineDoctorSnapshotCache';
import type { LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import type { ActiveServerSnapshot } from '@/sync/domains/server/serverProfiles';
import type { SystemTaskRunner } from '@/components/systemTasks/types';
import type { RelayDriftBanner } from './relayDriftTypes';

import { installLocalStorageMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createManualSystemTaskRunner } from '@/dev/testkit/harness/manualSystemTaskRunner';
import { renderScreen as renderCanonicalScreen } from '@/dev/testkit/render/renderScreen';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { buildRelayDriftRepairSystemTaskSpec } from '@/sync/domains/server/relayDrift/relayDriftSystemTask';
import { buildLocalDaemonServiceSystemTaskSpec } from '@/components/systemTasks/specs/localControl/buildLocalDaemonServiceSystemTaskSpec';

const state = vi.hoisted(() => ({
    activeServerSnapshot: { serverId: 'server-a', serverUrl: 'https://relay.example.test', generation: 1 } as ActiveServerSnapshot,
    cachedDoctorSnapshot: null as CachedMachineDoctorSnapshot | null,
    runner: null as SystemTaskRunner | null,
}));
const administrationTargetState = vi.hoisted(() => ({
    current: {
        target: { serverIdentityId: 'srv_identity_a', machineId: 'machine-1' },
        serverId: 'server-a',
        machine: { id: 'machine-1', metadata: { displayName: 'Machine 1', host: 'machine-1.local' } },
    } as {
        target: { serverIdentityId: string; machineId: string };
        serverId: string;
        machine: { id: string; metadata: { displayName: string; host: string } };
    } | null,
}));
const localDaemonControlState = vi.hoisted(() => ({
    status: null as LocalDaemonStatusData | null,
    isUnavailable: false,
}));
const approvalMocks = vi.hoisted(() => ({
    readCredentials: vi.fn(async (..._args: unknown[]) => ({ token: 'relay-a-bearer' }) as { token: string } | null),
    endpointFetch: vi.fn(async (..._args: unknown[]) => new Response('{}', { status: 200 })),
    createServerFetchAtEndpoint: vi.fn((..._args: unknown[]) => approvalMocks.endpointFetch),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return { ...actual, TokenStorage: {
        ...actual.TokenStorage,
        getCredentialsForServerUrl: (...args: unknown[]) => approvalMocks.readCredentials(...args),
    } };
});
vi.mock('@/sync/http/client', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/http/client')>();
    return { ...actual, createServerFetchAtEndpoint: (...args: unknown[]) => approvalMocks.createServerFetchAtEndpoint(...args) };
});
// The OS task fixture injects a real runner. Prompt custody and the daemon/setup
// hooks beneath this system-task facade are never replaced.
vi.mock('@/components/systemTasks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/systemTasks')>();
    return { ...actual, getDefaultSystemTaskRunner: () => state.runner! };
});

let localStorageHandle: ReturnType<typeof installLocalStorageMock>;
const seededProfiles = new Set<string>();

async function renderScreen(element: React.ReactElement) {
    const profiles = await import('@/sync/domains/server/serverProfiles');
    if (state.activeServerSnapshot.activeLocalRelayUrl) {
        vi.stubGlobal('window', { location: { origin: state.activeServerSnapshot.activeLocalRelayUrl } });
    }
    const profile = await profiles.adoptHomeProfile({
        descriptor: {
            serverUrl: state.activeServerSnapshot.serverUrl,
            homeServerIdentityId: 'srv_identity_a',
            displayName: 'Relay A',
        },
        source: 'manual', suggestedName: 'Relay A',
    });
    seededProfiles.add(profile.id);
    await profiles.setActiveServerId(profile.id, { scope: 'device' });
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
    const selected = administrationTargetState.current;
    const machine = selected ? createMachineFixture({
        id: selected.machine.id,
        metadata: { ...createMachineFixture().metadata!, ...selected.machine.metadata },
        active: true, activeAt: Date.now(),
    }) : null;
    const current = storage.getState();
    storage.setState({
        isDataReady: true,
        machines: machine ? { [machine.id]: machine } : {},
        machineListByServerId: {},
        machineListStatusByServerId: {},
        settings: {
            ...current.settings,
            machineAdministrationTargetsLocalV1: selected ? {
                [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.relayDrift]: {
                    serverIdentityId: 'srv_identity_a', machineId: selected.machine.id,
                },
            } : {},
        },
    });
    const { clearCachedMachineDoctorSnapshot, writeCachedMachineDoctorSnapshot } = await import('@/components/machines/doctorSnapshot/machineDoctorSnapshotCache');
    const cacheScope = { serverId: 'srv_identity_a', machineId: selected?.machine.id ?? 'machine-1' };
    clearCachedMachineDoctorSnapshot(cacheScope);
    if (state.cachedDoctorSnapshot) {
        const snapshot = state.cachedDoctorSnapshot.snapshot;
        // The published DoctorSnapshot schema requires configured URLs even
        // before authentication; blank strings were invalid boundary fixtures.
        const server = Object.fromEntries(Object.entries(snapshot.server).map(([key, value]) => [
            key, value || (key === 'activeServerId' ? 'srv_identity_a' : state.activeServerSnapshot.serverUrl),
        ]));
        const { DoctorSnapshotSchema } = await import('@happier-dev/protocol');
        writeCachedMachineDoctorSnapshot({
            ...cacheScope, cachedAt: state.cachedDoctorSnapshot.cachedAt,
            snapshot: DoctorSnapshotSchema.parse({ ...snapshot, server }),
        });
    }
    if (localDaemonControlState.status) {
        const { publishLocalDaemonStatus } = await import('@/components/settings/machines/localControl/localDaemonSharedState');
        publishLocalDaemonStatus(state.runner!, localDaemonControlState.status);
    }
    return renderCanonicalScreen(element);
}

afterEach(async () => {
    standardCleanup();
    const profiles = await import('@/sync/domains/server/serverProfiles');
    for (const id of seededProfiles) if (profiles.getServerProfileById(id)) await profiles.removeServerProfile(id);
    seededProfiles.clear();
    localStorageHandle.restore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
});
describe('useRelayDriftBanner', () => {
    beforeEach(async () => {
        vi.stubGlobal('window', { location: {} });
        vi.stubGlobal('document', {});
        vi.stubEnv('EXPO_PUBLIC_HAPPY_STORAGE_SCOPE', `relay-drift-${crypto.randomUUID()}`);
        localStorageHandle = installLocalStorageMock();
        (await import('@/sync/domains/server/serverProfiles')).resetServerProfilesRuntimeForTests();
        Reflect.deleteProperty(globalThis as { location?: unknown }, 'location');
        state.activeServerSnapshot = {
            serverId: 'server-a',
            serverUrl: 'https://relay.example.test',
            generation: 1,
        } as ActiveServerSnapshot;
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        storage.setState({ profile: { ...profileDefaults } });
        state.cachedDoctorSnapshot = null;
        state.runner = createManualSystemTaskRunner('dev').runner;
        administrationTargetState.current = {
            target: { serverIdentityId: 'srv_identity_a', machineId: 'machine-1' },
            serverId: 'server-a',
            machine: {
                id: 'machine-1',
                metadata: { displayName: 'Machine 1', host: 'machine-1.local' },
            },
        };
        localDaemonControlState.status = {
            serviceInstalled: false,
            daemonRunning: false,
            needsAuth: false,
            machineId: 'machine-1',
        };
        localDaemonControlState.isUnavailable = false;
    });

    it('disables local repair when the selected machine is not the system-task bridge machine', async () => {
        localDaemonControlState.status = { serviceInstalled: false, daemonRunning: false, needsAuth: false, machineId: 'machine-local' };
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
                settings: { activeServerId: 'server-a', servers: [], knownAccountIds: [] },
            },
        };
        const start = vi.fn(async (spec: import('@happier-dev/protocol').SystemTaskSpec) => spec.kind === 'daemon.service.status.v1' ? 'status_task' : 'task_1');
        const manual = createManualSystemTaskRunner('dev');
        manual.bridge.start.mockImplementation(start);
        state.runner = manual.runner;
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }
        await renderScreen(React.createElement(Probe));

        expect(banner).toMatchObject({
            actionDisabled: true,
            actionHint: 'settings.systemTaskBridgeUnavailable',
        });
        await renderer.act(async () => {
            await banner?.onPress();
        });
        expect(start.mock.calls.some(([spec]) => spec.kind !== 'daemon.service.status.v1')).toBe(false);
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

    // R10: a first-run machine has nothing installed yet, so there is nothing that could have
    // drifted. With no doctor snapshot and no local daemon status the classifier sees a null
    // daemon relay and reports `daemon_not_configured`, which would otherwise render as a warning
    // nagging about an ordinary pre-setup state. Acquiring the first daemon belongs to setup.
    it('shows no banner for a machine the app has no daemon facts about', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        state.cachedDoctorSnapshot = null;
        localDaemonControlState.status = null;

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).toBeNull();
    });

    // R10 through the facts the desktop actually has. The doctor cache is written only when
    // someone opens Diagnosis, while `useLocalDaemonControl` refreshes the local status on mount,
    // so "no doctor snapshot + a resolved local status" is the ordinary state of every desktop.
    it('shows no banner when the local daemon status reports no background service on this machine', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        state.cachedDoctorSnapshot = null;
        localDaemonControlState.status = {
            serviceInstalled: false,
            daemonRunning: false,
            needsAuth: true,
            machineId: null,
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).toBeNull();
    });

    it('shows no banner when the local daemon status proves the daemon is already on the active relay', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        state.cachedDoctorSnapshot = null;
        localDaemonControlState.status = {
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-1',
            daemonServerUrl: 'https://relay.example.test',
            daemonAccountId: 'acct_1',
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).toBeNull();
    });

    // …and the local facts are genuinely classified, not merely used to suppress the banner: a
    // daemon pointed somewhere else is real drift and must still be reported by name.
    it('classifies drift from the local daemon status when the daemon is on another relay', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        state.cachedDoctorSnapshot = null;
        localDaemonControlState.status = {
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-1',
            daemonServerUrl: 'https://daemon-relay.example.test',
            daemonAccountId: 'acct_1',
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).toMatchObject({
            kind: 'warning',
            title: 'machine.thisComputer.title.daemon_url_mismatch',
        });
    });

    // S11: this computer's daemon is healthy on the app's own Home but signed in to another
    // account, so it is not in this account's machine list and no Administration target can
    // name it. The desktop's own status is still a fact about THIS computer: it must be explained.
    it('explains a daemon of another account on this Home even when it is not one of this account\'s machines', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        storage.setState({ profile: { ...profileDefaults, id: 'acct_app', username: 'leeroy' } });
        administrationTargetState.current = null;
        state.cachedDoctorSnapshot = null;
        localDaemonControlState.status = {
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-of-other-account',
            daemonServerUrl: 'https://relay.example.test',
            daemonAccountId: 'acct_other',
        };
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }

        await renderScreen(React.createElement(Probe));

        expect(banner).toMatchObject({
            kind: 'warning',
            title: 'machine.thisComputer.title.daemon_account_mismatch',
            description: 'machine.thisComputer.description.daemon_account_mismatch',
            actionLabel: 'machine.thisComputer.action.daemon_account_mismatch',
        });
        storage.setState({ profile: { ...profileDefaults } });
    });

    // R10 D1: moving this computer's daemon off another account is never silent.
    it('asks before switching a daemon of another account and starts nothing when declined', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { profileDefaults } = await import('@/sync/domains/profiles/profile');
        const { Modal } = await import('@/modal');
        storage.setState({ profile: { ...profileDefaults, id: 'acct_app', username: 'leeroy' } });
        administrationTargetState.current = null;
        localDaemonControlState.status = {
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: false,
            machineId: 'machine-of-other-account',
            daemonServerUrl: 'https://relay.example.test',
            daemonAccountId: 'acct_other',
        };
        const start = vi.fn(async (spec: import('@happier-dev/protocol').SystemTaskSpec) => spec.kind === 'daemon.service.status.v1' ? 'status_task' : 'task_1');
        const manual = createManualSystemTaskRunner('dev');
        manual.bridge.start.mockImplementation(start);
        state.runner = manual.runner;
        const confirm = vi.mocked(Modal.confirm);
        confirm.mockClear();
        confirm.mockResolvedValueOnce(false);
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }
        await renderScreen(React.createElement(Probe));

        await renderer.act(async () => {
            await (banner as RelayDriftBanner | null)?.onPress();
        });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm.mock.calls[0]?.[0]).toBe('machine.thisComputer.moveConfirm.title');
        expect(start.mock.calls.some(([spec]) => spec.kind !== 'daemon.service.status.v1')).toBe(false);

        confirm.mockResolvedValueOnce(true);
        await renderer.act(async () => {
            await (banner as RelayDriftBanner | null)?.onPress();
        });
        expect(start).toHaveBeenCalledWith(buildRelayDriftRepairSystemTaskSpec({
            activeRelayUrl: 'https://relay.example.test',
            activeWebappUrl: 'https://relay.example.test',
            activeLocalRelayUrl: null,
            activeAccountId: 'acct_app',
        }));
        storage.setState({ profile: { ...profileDefaults } });
    });

    it('does not fall back to the active machine when the Administration target is unavailable', async () => {
        administrationTargetState.current = null;
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: {
                    activeServerId: 'server-a',
                    serverUrl: 'https://different-relay.example.test',
                    publicServerUrl: 'https://different-relay.example.test',
                    webappUrl: 'https://different-relay.example.test',
                },
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
            },
        };
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
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
        Object.defineProperty(globalThis.window, 'location', {
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
            const parsed = SystemTaskSpecSchema.parse(spec);
            return parsed.kind === 'daemon.service.status.v1' ? 'status_task' : 'task_1';
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
                stepId: 'setup.repairThisComputer.configureRelay',
                message: 'executor message',
            });
        });

        const bannerAfterEvent = banner as RelayDriftBanner | null;
        expect(bannerAfterEvent?.repairTaskSnapshot).toEqual(expect.objectContaining({
            currentStepId: 'setup.repairThisComputer.configureRelay',
            latestMessage: 'executor message',
        }));
        expect(typeof bannerAfterEvent?.onCancelRepair).toBe('function');

        await renderer.act(async () => {
            await bannerAfterEvent?.onCancelRepair?.();
        });

        expect(cancelMock).toHaveBeenCalledWith('task_1');
    });

    it('answers the repair task\'s token-only pairing prompt through the explicit-target approval owner', async () => {
        approvalMocks.readCredentials.mockClear();
        approvalMocks.endpointFetch.mockClear();
        approvalMocks.endpointFetch
            .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending', supportsV2: true }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }));

        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const respondMock = vi.fn(async (_taskId: string, _answer: unknown) => {});
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        state.runner = createSystemTaskRunner({
            mode: 'dev',
            bridge: {
                async start(spec) {
                    return spec.kind === 'daemon.service.status.v1' ? 'status_task' : 'task_repair_approval';
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                respond: respondMock,
            },
        });
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: { activeServerId: 'server-a', serverUrl: '', publicServerUrl: '', webappUrl: '' },
                accountId: null,
                settings: { activeServerId: 'server-a', servers: [], knownAccountIds: [] },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }
        await renderScreen(React.createElement(Probe));

        const resolvedBanner = banner as RelayDriftBanner | null;
        if (!resolvedBanner) throw new Error('Expected a relay drift banner');
        await renderer.act(async () => {
            await resolvedBanner.onPress();
        });

        await renderer.act(async () => {
            approvalMocks.readCredentials.mockClear();
            approvalMocks.createServerFetchAtEndpoint.mockClear();
            const taskListener = listeners.get('task_repair_approval');
            expect(taskListener).toBeDefined();
            taskListener?.onEvent({
                protocolVersion: 1,
                taskId: 'task_repair_approval',
                tsMs: 120,
                type: 'prompt',
                stepId: 'setup.repairThisComputer.authRequest',
                message: 'Approve pairing request',
                data: {
                    kind: 'authRequest',
                    publicKey: 'pub-key-b64',
                    response: 'opaque-token-only-response-b64',
                    responseKind: 'tokenOnly',
                    relayUrl: 'https://relay.example.test',
                    webappUrl: 'https://relay.example.test',
                    cliProvenance: 'managed',
                },
            });
            await Promise.resolve();
            await Promise.resolve();
        });

        // Repair is answered by the one approval owner: the Home-scoped credential for the
        // explicit target is read, the opaque response is posted, and the task resumes.
        await waitForHomeGovernance(() => expect(respondMock).toHaveBeenCalledWith('task_repair_approval', { approved: true }));
        expect(approvalMocks.readCredentials).toHaveBeenCalledWith(
            'https://relay.example.test',
            { serverId: 'srv_identity_a' },
        );
        expect(JSON.stringify(respondMock.mock.calls)).not.toContain('relay-a-bearer');
        expect(JSON.stringify(respondMock.mock.calls)).not.toContain('opaque-token-only-response-b64');
    });

    it('declines a repair pairing prompt whose target identity does not match the active relay', async () => {
        approvalMocks.readCredentials.mockClear();
        approvalMocks.createServerFetchAtEndpoint.mockClear();

        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const respondMock = vi.fn(async (_taskId: string, _answer: unknown) => {});
        const listeners = new Map<string, {
            onEvent: (payload: unknown) => void;
            onResult: (payload: unknown) => void;
        }>();
        state.runner = createSystemTaskRunner({
            mode: 'dev',
            bridge: {
                async start(spec) {
                    return spec.kind === 'daemon.service.status.v1' ? 'status_task' : 'task_repair_mismatch';
                },
                async subscribe(taskId, listenerSet) {
                    listeners.set(taskId, listenerSet);
                    return () => {
                        listeners.delete(taskId);
                    };
                },
                async cancel() {},
                respond: respondMock,
            },
        });
        state.cachedDoctorSnapshot = {
            cachedAt: 1,
            snapshot: {
                capturedAt: '2026-03-29T00:00:00.000Z',
                server: { activeServerId: 'server-a', serverUrl: '', publicServerUrl: '', webappUrl: '' },
                accountId: null,
                settings: { activeServerId: 'server-a', servers: [], knownAccountIds: [] },
            },
        };

        let banner: RelayDriftBanner | null = null;
        function Probe() {
            banner = useRelayDriftBanner();
            return null;
        }
        await renderScreen(React.createElement(Probe));
        const resolvedBanner = banner as RelayDriftBanner | null;
        if (!resolvedBanner) throw new Error('Expected a relay drift banner');
        await renderer.act(async () => {
            await resolvedBanner.onPress();
        });

        await renderer.act(async () => {
            approvalMocks.readCredentials.mockClear();
            approvalMocks.createServerFetchAtEndpoint.mockClear();
            const taskListener = listeners.get('task_repair_mismatch');
            expect(taskListener).toBeDefined();
            taskListener?.onEvent({
                protocolVersion: 1,
                taskId: 'task_repair_mismatch',
                tsMs: 120,
                type: 'prompt',
                stepId: 'setup.repairThisComputer.authRequest',
                message: 'Approve pairing request',
                data: {
                    kind: 'authRequest',
                    publicKey: 'pub-key-b64',
                    response: 'opaque-token-only-response-b64',
                    responseKind: 'tokenOnly',
                    relayUrl: 'https://other-relay.example.test',
                    webappUrl: 'https://other-relay.example.test',
                },
            });
            await Promise.resolve();
            await Promise.resolve();
        });

        await waitForHomeGovernance(() => expect(respondMock).toHaveBeenCalledWith('task_repair_mismatch', { approved: false, reason: 'relay_mismatch' }));
        expect(approvalMocks.readCredentials).not.toHaveBeenCalled();
        expect(approvalMocks.createServerFetchAtEndpoint).not.toHaveBeenCalled();
    });

    it('infers the active webapp url when repairing Happier Cloud relay drift', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        const startMock = vi.fn(async (spec: unknown) => {
            const parsed = SystemTaskSpecSchema.parse(spec);
            return parsed.kind === 'daemon.service.status.v1' ? 'status_task' : 'task_1';
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
            activeWebappUrl: 'https://cloud.happier.dev',
            activeLocalRelayUrl: null,
        }));
    });

    it('passes the daemon local relay url to repair when the active relay matches the daemon public relay', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        const startMock = vi.fn(async (spec: unknown) => {
            const parsed = SystemTaskSpecSchema.parse(spec);
            return parsed.kind === 'daemon.service.status.v1' ? 'status_task' : 'task_1';
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
            const parsed = SystemTaskSpecSchema.parse(spec);
            return parsed.kind === 'daemon.service.status.v1' ? 'status_task' : 'task_1';
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
            ...createManualSystemTaskRunner('unavailable').runner,
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

    it('keeps the active relay authoritative when the daemon is connected to a different relay', async () => {
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
        expect((resolvedBanner as unknown as { secondaryActionLabel?: unknown }).secondaryActionLabel).toBeUndefined();
        expect((resolvedBanner as unknown as { onSecondaryPress?: unknown }).onSecondaryPress).toBeUndefined();
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        expect(getActiveServerSnapshot().serverUrl).toBe('https://relay.example.test');
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
        expect(resolvedBanner?.actionLabel).toBe('machine.thisComputer.action.daemon_needs_auth');
    });

    it('restarts the existing local background service instead of launching full repair when the relay matches but the daemon is not running', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        const startMock = vi.fn(async (spec: unknown) => {
            const parsed = SystemTaskSpecSchema.parse(spec);
            return parsed.kind === 'daemon.service.status.v1' ? 'status_task' : 'task_restart';
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
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
                daemonStatus: {
                    server: {
                        activeServerId: 'srv_identity_a',
                        serverUrl: 'https://relay.example.test',
                        localServerUrl: null,
                        publicServerUrl: 'https://relay.example.test',
                        webappUrl: 'https://relay.example.test',
                        comparableKey: null,
                    },
                    daemon: { running: false, pid: null, httpPort: null },
                    service: {
                        installed: true,
                        running: false,
                    },
                    auth: {
                        authenticated: true, machineRegistered: true,
                        machineId: 'machine-1', needsAuth: false, accountId: 'acct_1',
                    },
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

        await renderer.act(async () => {
            await resolvedBanner?.onPress();
        });

        expect(startMock).toHaveBeenCalledWith(buildLocalDaemonServiceSystemTaskSpec('daemon.service.restart.v1'));
    });

    it('uses doctor service health when daemon status does not include readiness', async () => {
        const { useRelayDriftBanner } = await import('./useRelayDriftBanner');
        const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
        const { SystemTaskSpecSchema } = await import('@happier-dev/protocol');

        const startMock = vi.fn(async (spec: unknown) => {
            const parsed = SystemTaskSpecSchema.parse(spec);
            return parsed.kind === 'daemon.service.status.v1' ? 'status_task' : 'task_restart';
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
                accountId: 'acct_1',
                settings: {
                    activeServerId: 'server-a',
                    servers: [],
                    knownAccountIds: ['acct_1'],
                },
                serviceHealth: {
                    backgroundService: {
                        installed: true,
                        running: false,
                        healthy: null,
                    },
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
        expect(resolvedBanner?.actionLabel).toBe('machine.thisComputer.action.daemon_not_running');

        await renderer.act(async () => {
            await resolvedBanner?.onPress();
        });

        expect(startMock).toHaveBeenCalledWith(buildLocalDaemonServiceSystemTaskSpec('daemon.service.restart.v1'));
    });
});
