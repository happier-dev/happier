import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

installDisconnectedServerSocketBoundary(socket => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
});

const home = createHomeGovernanceHarness();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = null;
    await home.reset();
    storage.setState(beforeStorage, true);
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
    return createReactNativeWebMock({
        Dimensions: {
            get: () => ({
                width: 1440,
                height: 900,
                scale: 2,
                fontScale: 1,
            }),
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: undefined,
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: vi.fn(), back: vi.fn(), replace: vi.fn(), setParams: vi.fn() } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
        translateLoose: (key: string) => key,
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

const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { SystemStatusView } = await import('./SystemStatusView');
const beforeStorage = storage.getState();

describe('SystemStatusView vector icons missing', () => {
    it('renders System Status when @expo/vector-icons exports Ionicons as undefined', async () => {
        const serverUrl = 'https://missing-icons.example.test';
        const homeId = await home.addHome({
            name: 'Personal Home', serverUrl, serverIdentityId: 'srv_missing_icons', accountId: 'account-a',
        });
        home.answer(homeId, '/v1/machines', { body: [] });
        connection = await restoreServerAccountForTest({ serverUrl, request: home.request });
        const activeServerId = getActiveServerSnapshot().serverId;
        storage.setState(current => ({
            isDataReady: true,
            profileScope: { serverId: activeServerId, accountId: 'account-a' },
            profile: { ...current.profile, id: 'prof_1', username: 'tester', connectedServices: [] },
            machines: {},
            machineListByServerId: { [activeServerId]: [] },
            machineListStatusByServerId: { [activeServerId]: 'idle' },
        }));

        const screen = await renderScreen(<SystemStatusView />);

        expect(screen.findByTestId('system-status-screen')).toBeTruthy();
    });
});
