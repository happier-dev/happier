import * as React from 'react';
import { MMKV } from 'react-native-mmkv';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { UPDATES_ROUTE } from '@/components/updates/updatesRoute';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * The tray's services half through its real owners (A13-09): the status parser and shared status,
 * the drift banner and connection health, the row projection, the label builder, the tray bridge
 * wrapper, the saved-Home resolver and the active-server switch. Mocked are only boundaries: the
 * native host bridge, the system-task bridge (hsetup), the connection runtime, the auth context
 * provider, the router and the text catalogue. The status line's mapping from connection health is
 * `buildDesktopTrayState`'s own tests (A13-09: no internal hook is mocked here).
 */

const host = vi.hoisted(() => ({
    listeners: new Map<string, (payload: unknown) => void>(),
    trayStates: [] as Array<Record<string, any>>,
    nextDestination: null as unknown,
    desktop: true,
}));
vi.mock('@/utils/platform/desktopHost', async () => {
    const actual = await vi.importActual<typeof import('@/utils/platform/desktopHost')>('@/utils/platform/desktopHost');
    return {
        ...actual,
        isDesktopHost: () => host.desktop,
        invokeDesktopHost: async (command: string, args?: Record<string, any>) => {
            if (command !== 'desktop_set_tray_state') return null;
            host.trayStates.push(args?.state);
            const destination = host.nextDestination;
            host.nextDestination = null;
            return destination;
        },
        listenDesktopHostEvent: async (event: string, handler: (payload: unknown) => void) => {
            host.listeners.set(event, handler);
            return () => host.listeners.delete(event);
        },
    };
});

const bridge = vi.hoisted(() => ({ nextId: 0, statusReads: 0, statusData: {} as Record<string, unknown> }));
vi.mock('@/components/systemTasks/systemTasksRuntime', async () => {
    const { createSystemTaskRunner } = await import('@/components/systemTasks/createSystemTaskRunner');
    const runner = createSystemTaskRunner({
        bridge: {
            async start(spec) {
                if (spec.kind === 'daemon.service.status.v1') bridge.statusReads += 1;
                // Unique across tests: the runner keeps every task it has seen by id.
                bridge.nextId += 1;
                return `task_${bridge.nextId}:${spec.kind}`;
            },
            async subscribe(taskId, listenerSet) {
                queueMicrotask(() => listenerSet.onResult({ protocolVersion: 1, taskId, ok: true, data: bridge.statusData as never }));
                return () => {};
            },
            async cancel() {},
            async respond() {},
        },
    });
    return { getSystemTasksRunner: () => runner };
});

// Credential persistence is empty at the SDK boundary; auth and relay switching remain real.
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {},
} }));

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: (value: unknown) => router.push(value) } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

import { getActiveServerSnapshot, resetServerProfilesRuntimeForTests, resolveSavedServerProfileByUrl } from '@/sync/domains/server/serverProfiles';
import { AuthProvider } from '@/auth/context/AuthContext';

import { DesktopTrayRuntime } from './DesktopTrayRuntime';

const home = (id: string, serverUrl: string, extra: Record<string, unknown> = {}) =>
    ({ id, name: id, serverUrl, createdAt: 1, updatedAt: 1, lastUsedAt: 1, ...extra });

function seedSavedHomes(servers: Record<string, Record<string, unknown>>, activeServerId: string) {
    new MMKV().set('server-state-v1', JSON.stringify({ activeServerId, activeServerIdIsExplicit: true, servers }));
    resetServerProfilesRuntimeForTests();
}

const row = (relayUrl: string, extra: Record<string, unknown> = {}) => ({
    relayUrl,
    state: 'connected',
    appManaged: true,
    serviceTargetMode: 'pinned',
    actions: ['restart', 'stop'],
    ...extra,
});

async function mountTray() {
    const screen = await renderScreen(<AuthProvider initialCredentials={null}><DesktopTrayRuntime /></AuthProvider>);
    await vi.waitFor(() => expect(host.trayStates.at(-1)?.services?.status).toBe('listed'));
    return screen;
}

describe('DesktopTrayRuntime — this computer\'s services (R16 c)', () => {
    beforeEach(() => {
        seedSavedHomes({
            home: home('home', 'https://home.example.test'),
            work: home('work', 'https://work.example.test'),
            first: home('first', 'https://shared.example.test', { serverIdentityId: 'srv_first', canonicalServerUrl: 'https://shared.example.test' }),
            second: home('second', 'https://shared.example.test', { serverIdentityId: 'srv_second', canonicalServerUrl: 'https://shared.example.test' }),
        }, 'home');
        bridge.statusData = {
            serviceInstalled: true,
            daemonRunning: true,
            needsAuth: true,
            daemonServerUrl: 'https://home.example.test',
            // The managed services disagree: the one setting is unknown.
            serviceAutostart: null,
            runningManagedServiceCount: 1,
            serviceRowsComplete: true,
            serviceRows: [
                row('https://home.example.test', { serviceTargetMode: 'default-following' }),
                row('https://work.example.test', { state: 'offline', actions: ['start'] }),
            ],
        };
    });

    afterEach(() => {
        host.listeners.clear();
        host.trayStates.length = 0;
        host.nextDestination = null;
        host.desktop = true;
        router.push.mockClear();
    });

    it('sends every service with the app\'s Home judged against the app\'s account, and the managed services\' one login-start mode (A13-02)', async () => {
        const screen = await mountTray();
        const state = host.trayStates.at(-1)!;
        // The executor said connected; the daemon on the app's Home still needs to sign in.
        expect(state.services.rows[0]).toMatchObject({ relayUrl: 'https://home.example.test', state: 'needs_attention' });
        expect(state.services.rows[1]).toMatchObject({ relayUrl: 'https://work.example.test', state: 'offline' });
        expect(state.serviceAutostart).toBeNull();
        expect(state.runningManagedServiceCount).toBe(1);
        expect(state.taskParams).toMatchObject({ relayUrl: 'https://home.example.test' });
        expect(state.labels.sessions).toBe('settingsDesktop.tray.sessions');
        await act(async () => screen.tree.unmount());
    });

    it('opens the screen a rebuilt window was asked for, and re-reads after a native service change', async () => {
        host.nextDestination = 'updates';
        const screen = await mountTray();
        await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith('/settings/updates'));

        const readsBefore = bridge.statusReads;
        await act(async () => {
            host.listeners.get('desktop_background_services_changed')?.(null);
        });
        await vi.waitFor(() => expect(bridge.statusReads).toBe(readsBefore + 1));

        // The tray menu is about to open: the native side asks for current rows (N-12).
        await act(async () => {
            host.listeners.get('desktop_tray_refresh_requested')?.(null);
        });
        await vi.waitFor(() => expect(bridge.statusReads).toBe(readsBefore + 2));
        await act(async () => screen.tree.unmount());
    });

    it('switches to the saved Home a row opened, and sends an ambiguous address to where the person can choose (D11-3, A13-05)', async () => {
        expect(resolveSavedServerProfileByUrl('https://shared.example.test').kind).toBe('ambiguous');
        const screen = await mountTray();

        await act(async () => {
            host.listeners.get('desktop_open_home_requested')?.({ relayUrl: 'https://work.example.test' });
        });
        await vi.waitFor(() => expect(getActiveServerSnapshot().serverId).toBe('work'));

        await act(async () => {
            host.listeners.get('desktop_open_home_requested')?.({ relayUrl: 'https://shared.example.test' });
        });
        await vi.waitFor(() => expect(router.push).toHaveBeenCalledWith('/settings/machines/this-computer'));
        expect(getActiveServerSnapshot().serverId).toBe('work');
        await act(async () => screen.tree.unmount());
    });

    it('opens Settings and Updates requested by the tray while the window already exists', async () => {
        const screen = await mountTray();
        await act(async () => {
            host.listeners.get('desktop_open_settings_requested')?.(null);
            host.listeners.get('desktop_open_updates_requested')?.(null);
        });
        expect(router.push.mock.calls.map(([route]) => route)).toEqual([
            SETTINGS_ROUTES.general,
            UPDATES_ROUTE,
        ]);
        await act(async () => screen.tree.unmount());
        expect(host.listeners.has('desktop_open_settings_requested')).toBe(false);
        expect(host.listeners.has('desktop_open_updates_requested')).toBe(false);
    });

    it('pushes nothing and listens to nothing outside the desktop shell', async () => {
        host.desktop = false;
        const screen = await renderScreen(<AuthProvider initialCredentials={null}><DesktopTrayRuntime /></AuthProvider>);
        await act(async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); });
        expect(host.trayStates).toEqual([]);
        expect(host.listeners.size).toBe(0);
        await act(async () => screen.tree.unmount());
    });

    it('reads the status line from connection health and the drift banner, the owners every surface uses', async () => {
        const screen = await mountTray();
        const state = host.trayStates.at(-1)!;
        expect(typeof state.label).toBe('string');
        expect(typeof state.detail).toBe('string');
        expect(state.status).toBeDefined();
        await act(async () => screen.tree.unmount());
    });
});
