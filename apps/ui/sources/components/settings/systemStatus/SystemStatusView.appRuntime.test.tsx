import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const setClipboardStringSafeMock = vi.hoisted(() => vi.fn(async () => true));
const modalAlertMock = vi.hoisted(() => vi.fn());

afterEach(() => {
    standardCleanup();
    setClipboardStringSafeMock.mockReset();
    setClipboardStringSafeMock.mockResolvedValue(true);
    modalAlertMock.mockReset();
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
                success: '#00aa00',
                warningCritical: '#cc5500',
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
    return createModalModuleMock({
        spies: { alert: modalAlertMock },
    }).module;
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' }, deviceName: 'test-device' },
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: setClipboardStringSafeMock,
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

vi.mock('@/sync/runtime/readCurrentAppRuntimeInfo', () => ({
    readCurrentAppRuntimeInfo: () => ({
        appVersion: '1.2.3',
        nativeApplicationVersion: '1.2.0',
        nativeBuildVersion: '101',
        applicationId: 'dev.happier.app',
        updateChannel: 'preview',
        updateId: 'update-123',
        runtimeVersion: '18',
        updateCreatedAt: '2026-04-06T12:34:56.000Z',
        launchSource: 'ota',
    }),
}));

vi.mock('./OtaUpdateStatusSection', () => ({
    OtaUpdateStatusSection: () => null,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useProfile: () => ({ id: 'prof_1', username: 'u1', connectedServices: [] }),
        useIsDataReady: () => true,
        useRealtimeStatus: () => 'connected',
        useSocketStatus: () => ({ status: 'connected', lastError: null, lastErrorAt: null }),
        useLastSyncAt: () => null,
        useMachineListByServerId: () => ({}),
        useMachineListStatusByServerId: () => ({}),
    });
});

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => false,
}));

describe('SystemStatusView app runtime info', () => {
    it('shows app runtime details and copies OTA runtime metadata into the system-status JSON payload', async () => {
        const { SystemStatusView } = await import('./SystemStatusView');
        const screen = await renderScreen(<SystemStatusView />);

        const text = screen.getTextContent();
        expect(text).toContain('bugReports.composer.environment.appVersionLabel');
        expect(text).toContain('1.2.3');
        expect(text).toContain('settingsAgents.releaseChannelTitle');
        expect(text).toContain('preview');

        const copyRow = screen.find((node) => (
            node.props?.title === 'systemStatus.actions.copyJson' &&
            typeof node.props?.onPress === 'function'
        ));
        await pressTestInstanceAsync(copyRow, 'copy system status JSON');

        expect(setClipboardStringSafeMock).toHaveBeenCalledTimes(1);
        expect(modalAlertMock).not.toHaveBeenCalled();

        const clipboardCalls = setClipboardStringSafeMock.mock.calls as unknown as Array<Array<string>>;
        const clipboardPayload = clipboardCalls[0]?.[0];
        const payload = JSON.parse(String(clipboardPayload ?? '{}'));
        expect(payload.environment).toMatchObject({
            appVersion: '1.2.3',
            nativeApplicationVersion: '1.2.0',
            nativeBuildVersion: '101',
            applicationId: 'dev.happier.app',
            updates: {
                channel: 'preview',
                updateId: 'update-123',
                runtimeVersion: '18',
                createdAt: '2026-04-06T12:34:56.000Z',
                launchSource: 'ota',
            },
        });
    });
});
