import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

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
                accent: {
                    indigo: '#0000ff',
                    blue: '#0000ff',
                    orange: '#ff8800',
                    purple: '#9900ff',
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
        translate: (key: string) => key,
        translateLoose: (key: string) => key,
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' }, deviceName: 'test-device' },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ generation: 1, serverId: 'srv_1', serverUrl: 'http://example.local' }),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    listServerProfiles: () => [],
}));

vi.mock('@/sync/ops/machines', () => ({
    machineCollectBugReportDiagnostics: async () => ({}),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useProfile: () => ({ id: 'prof_1', username: 'u1', connectedServices: [] }),
    useIsDataReady: () => true,
    useRealtimeStatus: () => 'connected',
    useSocketStatus: () => ({ status: 'connected', lastError: null, lastErrorAt: null }),
    useEndpointConnectivity: () => ({
            status: 'offline',
            reason: 'server_unreachable',
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: Date.now(),
            lastErrorMessage: 'Network request failed',
        }),
    useLastSyncAt: () => null,
    useAllMachines: () => [],
    useMachineListByServerId: () => ({}),
    useMachineListStatusByServerId: () => ({}),
});
});

describe('SystemStatusView (endpoint connectivity)', () => {
    it('imports SystemStatusView in the unit environment', async () => {
        const { SystemStatusView } = await import('./SystemStatusView');
        expect(SystemStatusView).toBeTruthy();
    });
});
