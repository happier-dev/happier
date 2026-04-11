import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';

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
    return createReactNativeWebMock({
        useWindowDimensions: () => ({
            width: 1440,
            height: 900,
            scale: 2,
            fontScale: 1,
        }),
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
    return createUnistylesMock({
        theme: {
            colors: {
                text: '#000000',
                textSecondary: '#777777',
                success: '#00aa55',
                warningCritical: '#cc5500',
                divider: '#dddddd',
                surface: '#ffffff',
                accent: {
                    blue: '#0055ff',
                    indigo: '#2255ff',
                    orange: '#ff8800',
                    purple: '#9955ff',
                },
                groupped: {
                    background: '#ffffff',
                    sectionTitle: '#666666',
                    chevron: '#666666',
                },
            },
        },
    });
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
    getActiveServerSnapshot: () => ({ generation: 1, serverId: 'srv_1', serverUrl: 'https://api.happier.dev' }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => [],
}));

vi.mock('@/sync/ops/machines', () => ({
    machineCollectBugReportDiagnostics: async () => ({}),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    return createStorageModuleStub({
        useProfile: () => ({ id: 'acct_1', username: 'tester', connectedServices: [] }),
        useIsDataReady: () => true,
        useRealtimeStatus: () => 'connected',
        useSocketStatus: () => ({ status: 'connected', lastError: null, lastErrorAt: null }),
        useLastSyncAt: () => null,
        useMachineListByServerId: () => ({
            srv_1: [],
        }),
        useMachineListStatusByServerId: () => ({
            srv_1: 'loaded',
        }),
    });
});

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => false,
}));

describe('SystemStatusView vector icons missing', () => {
    it('renders System Status when @expo/vector-icons exports Ionicons as undefined', async () => {
        const { SystemStatusView } = await import('./SystemStatusView');

        const screen = await renderScreen(<SystemStatusView />);

        expect(screen.findByTestId('system-status-screen')).toBeTruthy();
    });
});
