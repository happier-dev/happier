import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionStatus } from 'expo-modules-core';

import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { flushHookEffects } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const deletePushTokenMock = vi.fn();
const fetchPushTokensMock = vi.fn();
const modalConfirmMock = vi.fn();
const modalAlertMock = vi.fn();

function createPassthroughComponentMock(tag: string) {
    return (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(tag, props, props.children);
}

function createItemMock() {
    return (props: Record<string, unknown> & { children?: React.ReactNode; rightElement?: React.ReactNode }) =>
        React.createElement('Item', props, props.rightElement, props.children);
}

function createItemRowActionsMock() {
    return (props: Record<string, unknown> & { actions?: Array<{ id: string; inlineTestID?: string; onPress: () => void }> }) => {
        const actions = Array.isArray(props.actions) ? props.actions : [];
        return React.createElement(
            'ItemRowActions',
            props,
            actions.map((action) => (
                React.createElement('ItemRowAction', {
                    key: action.id,
                    testID: action.inlineTestID ?? action.id,
                    onPress: action.onPress,
                })
            )),
        );
    };
}

vi.mock('expo-notifications', () => ({
    getPermissionsAsync: vi.fn(),
    requestPermissionsAsync: vi.fn(),
    getExpoPushTokenAsync: vi.fn(),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/auth/context/AuthContext', () => {
    const credentials = { token: 't', secret: 's' };
    return { useAuth: () => ({ credentials }) };
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: 'https://api.happier.dev', generation: 1 }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/sync/api/session/apiPush', () => ({
    fetchPushTokens: (...args: unknown[]) => fetchPushTokensMock(...args),
    deletePushToken: (...args: unknown[]) => deletePushTokenMock(...args),
}));

vi.mock('@/sync/engine/account/syncAccount', () => ({
    registerPushTokenIfAvailable: vi.fn(async () => {}),
}));

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios' },
            Linking: { openSettings: vi.fn(async () => {}) },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                confirm: modalConfirmMock,
                alert: modalAlertMock,
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettings: () => ({
                notificationsSettingsV1: { v: 1, pushEnabled: true },
            }),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    accent: { blue: '#00f' },
                    warning: '#f90',
                    textSecondary: '#666',
                    textDestructive: '#f00',
                },
            },
        });
    },
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: createPassthroughComponentMock('ItemList'),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: createPassthroughComponentMock('ItemGroup'),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: createItemMock(),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: createItemRowActionsMock(),
}));

describe('PushNotificationTroubleshootingView', () => {
    beforeEach(() => {
        deletePushTokenMock.mockReset();
        fetchPushTokensMock.mockReset();
        modalConfirmMock.mockReset();
        modalAlertMock.mockReset();
    });

    it('marks the current token as this device', async () => {
        const Notifications = await import('expo-notifications');
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
            status: PermissionStatus.GRANTED,
            expires: 'never',
            granted: true,
            canAskAgain: false,
        } satisfies Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({
            type: 'expo',
            data: 'ExponentPushToken[current]',
        } satisfies Awaited<ReturnType<typeof Notifications.getExpoPushTokenAsync>>);

        fetchPushTokensMock.mockResolvedValue([
            { id: 't1', token: 'ExponentPushToken[current]', createdAt: 1, updatedAt: 2, clientServerUrl: null },
            { id: 't2', token: 'ExponentPushToken[stale]', createdAt: 1, updatedAt: 2, clientServerUrl: null },
        ]);

        const { PushNotificationTroubleshootingView } = await import('./PushNotificationTroubleshootingView');
        const screen = await renderSettingsView(<PushNotificationTroubleshootingView />);
        await flushHookEffects({ cycles: 10 });

        const row = screen.findRow('settings-notifications-push-troubleshooting-device-t1');
        expect(row?.props?.detail).toBe('settingsNotifications.pushTroubleshooting.devices.thisDevice');
    });

    it('deletes a stale token after confirmation', async () => {
        const Notifications = await import('expo-notifications');
        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
            status: PermissionStatus.GRANTED,
            expires: 'never',
            granted: true,
            canAskAgain: false,
        } satisfies Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({
            type: 'expo',
            data: 'ExponentPushToken[current]',
        } satisfies Awaited<ReturnType<typeof Notifications.getExpoPushTokenAsync>>);

        fetchPushTokensMock.mockResolvedValue([
            { id: 't1', token: 'ExponentPushToken[current]', createdAt: 1, updatedAt: 2, clientServerUrl: null },
            { id: 't2', token: 'ExponentPushToken[stale]', createdAt: 1, updatedAt: 2, clientServerUrl: null },
        ]);
        modalConfirmMock.mockResolvedValue(true);
        deletePushTokenMock.mockResolvedValue(undefined);

        const { PushNotificationTroubleshootingView } = await import('./PushNotificationTroubleshootingView');
        const screen = await renderSettingsView(<PushNotificationTroubleshootingView />);
        await flushHookEffects({ cycles: 10 });

        const staleRow = screen.findRow('settings-notifications-push-troubleshooting-device-t2');
        expect(staleRow?.props?.onPress).toBeUndefined();

        await act(async () => {
            screen.pressByTestId('settings-notifications-push-troubleshooting-device-t2-remove');
        });

        expect(deletePushTokenMock).toHaveBeenCalledWith({ token: 't', secret: 's' }, 'ExponentPushToken[stale]');
    });

    it('alerts when opening settings fails while requesting permission', async () => {
        const Notifications = await import('expo-notifications');
        const { Linking } = await import('react-native');

        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
            status: PermissionStatus.DENIED,
            expires: 'never',
            granted: false,
            canAskAgain: false,
        } satisfies Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({
            type: 'expo',
            data: 'ExponentPushToken[current]',
        } satisfies Awaited<ReturnType<typeof Notifications.getExpoPushTokenAsync>>);
        fetchPushTokensMock.mockResolvedValue([]);
        vi.mocked(Linking.openSettings).mockRejectedValueOnce(new Error('nope'));

        const { PushNotificationTroubleshootingView } = await import('./PushNotificationTroubleshootingView');
        const screen = await renderSettingsView(<PushNotificationTroubleshootingView />);
        await flushHookEffects({ cycles: 10 });

        await act(async () => {
            screen.pressByTestId('settings-notifications-push-troubleshooting-request-permission');
        });

        expect(modalAlertMock).toHaveBeenCalledWith('common.error', 'settingsNotifications.pushTroubleshooting.loadError');
    });

    it('alerts when re-registering fails', async () => {
        const Notifications = await import('expo-notifications');
        const account = await import('@/sync/engine/account/syncAccount');

        vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
            status: PermissionStatus.GRANTED,
            expires: 'never',
            granted: true,
            canAskAgain: false,
        } satisfies Awaited<ReturnType<typeof Notifications.getPermissionsAsync>>);
        vi.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({
            type: 'expo',
            data: 'ExponentPushToken[current]',
        } satisfies Awaited<ReturnType<typeof Notifications.getExpoPushTokenAsync>>);
        fetchPushTokensMock.mockResolvedValue([]);
        vi.mocked(account.registerPushTokenIfAvailable).mockRejectedValueOnce(new Error('nope'));

        const { PushNotificationTroubleshootingView } = await import('./PushNotificationTroubleshootingView');
        const screen = await renderSettingsView(<PushNotificationTroubleshootingView />);
        await flushHookEffects({ cycles: 10 });

        await act(async () => {
            screen.pressByTestId('settings-notifications-push-troubleshooting-reregister');
        });

        expect(modalAlertMock).toHaveBeenCalledWith('common.error', 'settingsNotifications.pushTroubleshooting.loadError');
    });
});
