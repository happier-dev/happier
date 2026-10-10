import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionStatus } from 'expo-modules-core';

import { renderSettingsView as renderSettingsViewBoundary } from '@/dev/testkit/harness/settingsViewHarness';
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modalConfirmMock = vi.fn();
const modalAlertMock = vi.fn();
let settingsValue: Record<string, unknown> = {
    notificationsSettingsV1: { v: 1, pushEnabled: true },
};
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
afterEach(standardCleanup);
let home: string;
let deleteDisabled = false;
const answerPushTokens = (tokens: unknown[]) => harness.answer(home, '/v1/push-tokens', { body: { tokens } });
async function renderSettingsView(node: React.ReactElement) {
    const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const credentials = await TokenStorage.getCredentialsForServerUrl(getActiveServerSnapshot().serverUrl, { serverId: home });
    const { storage } = await import('@/sync/domains/state/storage');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    const settings = settingsParse({ ...storage.getState().settings, ...settingsValue, attentionDeliveryPolicyV1: undefined,
        actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, ...(deleteDisabled
            ? { actions: { 'notifications.push.tokens.remove': { disabledSurfaces: ['ui'] } } }
            : { approvalWaivedSurfaces: {
            'notifications.push.tokens.remove': ['ui'], 'notifications.push.register': ['ui'],
        } }) }) });
    storage.setState({ settings, settingsVersion: 1 });
    harness.answer(home, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: settings } } });
    return renderSettingsViewBoundary(<InjectedAuthProvider credentials={credentials}>{node}</InjectedAuthProvider>);
}

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

// Metro's deferred module loader is a boundary; Action admission and writers stay real.
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});

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
    storage: 'real',
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
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
    beforeEach(async () => {
        await harness.reset();
        await loadSyncSingletonForTests();
        const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
        resetScopedHomeActionExecutorsForTests();
        home = await harness.addHome({ name: 'Push', serverUrl: 'https://push-troubleshooting.example', serverIdentityId: 'srv_push',
            accountId: 'push-owner', currentAccount: true });
        modalConfirmMock.mockReset();
        modalAlertMock.mockReset();
        deleteDisabled = false;
        settingsValue = {
            notificationsSettingsV1: { v: 1, pushEnabled: true },
        };
    });

    it('backfills the account push status from legacy notification settings', async () => {
        settingsValue = {
            notificationsSettingsV1: { v: 1, pushEnabled: false },
        };
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
        answerPushTokens([]);

        const { PushNotificationTroubleshootingView } = await import('./PushNotificationTroubleshootingView');
        const screen = await renderSettingsView(<PushNotificationTroubleshootingView />);
        await flushHookEffects({ cycles: 20 });

        expect(Notifications.getPermissionsAsync).toHaveBeenCalled();
        expect(Notifications.getExpoPushTokenAsync).toHaveBeenCalled();
        const accountSettingRow = screen.findRowByTitle('settingsNotifications.pushTroubleshooting.status.accountSettingTitle');
        expect(accountSettingRow?.props?.detail).toBe('common.disabled');
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

        answerPushTokens([
            { id: 't1', token: 'ExponentPushToken[current]', createdAt: 1, updatedAt: 2, clientServerUrl: null },
            { id: 't2', token: 'ExponentPushToken[stale]', createdAt: 1, updatedAt: 2, clientServerUrl: null },
        ]);

        const { PushNotificationTroubleshootingView } = await import('./PushNotificationTroubleshootingView');
        const screen = await renderSettingsView(<PushNotificationTroubleshootingView />);
        await flushHookEffects({ cycles: 20 });

        const row = screen.findRow('settings-notifications-push-troubleshooting-device-t1');
        expect(row?.props?.detail).toBe('settingsNotifications.pushTroubleshooting.devices.thisDevice');
    });

    it.each([false, true])('removes a stale registration only through enabled Action admission (disabled=%s)', async disabled => {
        deleteDisabled = disabled;
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

        answerPushTokens([
            { id: 't1', token: 'ExponentPushToken[current]', createdAt: 1, updatedAt: 2, clientServerUrl: null },
            { id: 't2', token: 'ExponentPushToken[stale]', createdAt: 1, updatedAt: 2, clientServerUrl: null },
        ]);
        modalConfirmMock.mockResolvedValue(true);
        harness.answer(home, `DELETE /v1/push-tokens/${encodeURIComponent('ExponentPushToken[stale]')}`, { body: { success: true } });

        const { PushNotificationTroubleshootingView } = await import('./PushNotificationTroubleshootingView');
        const screen = await renderSettingsView(<PushNotificationTroubleshootingView />);
        await flushHookEffects({ cycles: 20 });

        const staleRow = screen.findRow('settings-notifications-push-troubleshooting-device-t2');
        expect(staleRow?.props?.onPress).toBeUndefined();

        await act(async () => {
            screen.pressByTestId('settings-notifications-push-troubleshooting-device-t2-remove');
        });

        if (disabled) {
            await waitForHomeGovernance(() => expect(modalAlertMock).toHaveBeenCalledWith('common.error', 'settingsNotifications.pushTroubleshooting.remove.error'));
            expect(harness.requestsFor(`/v1/push-tokens/${encodeURIComponent('ExponentPushToken[stale]')}`)).toEqual([]);
        } else {
            await waitForHomeGovernance(() => expect(harness.requestsFor(`/v1/push-tokens/${encodeURIComponent('ExponentPushToken[stale]')}`)).toHaveLength(1));
        }
    });

    it('routes a blocked permission to system settings and alerts when that fails', async () => {
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
        answerPushTokens([]);
        vi.mocked(Linking.openSettings).mockRejectedValueOnce(new Error('nope'));
        // The OS refuses further prompts, so the primed flow offers a trip to system settings.
        modalConfirmMock.mockResolvedValue(true);

        const { PushNotificationTroubleshootingView } = await import('./PushNotificationTroubleshootingView');
        const screen = await renderSettingsView(<PushNotificationTroubleshootingView />);
        await flushHookEffects({ cycles: 20 });

        // The OS will not ask again, so the action says where it leads.
        expect(screen.findAllByTestId('settings-notifications-push-troubleshooting-request-permission')[0]?.props.title)
            .toBe('settingsNotifications.pushPriming.openSettings');

        await act(async () => {
            screen.pressByTestId('settings-notifications-push-troubleshooting-request-permission');
        });

        expect(modalConfirmMock).toHaveBeenCalledWith(
            'settingsNotifications.pushPriming.blockedTitle',
            'settingsNotifications.pushPriming.blockedBody',
            expect.anything(),
        );
        expect(Linking.openSettings).toHaveBeenCalled();
        expect(modalAlertMock).toHaveBeenCalledWith('common.error', 'settingsNotifications.pushPriming.openSettingsFailed');
    });

    it('reports an unreachable notification runtime and keeps recovery actions usable', async () => {
        const Notifications = await import('expo-notifications');
        vi.mocked(Notifications.getPermissionsAsync).mockRejectedValue(new Error('native module unavailable'));
        vi.mocked(Notifications.getExpoPushTokenAsync).mockRejectedValue(new Error('native module unavailable'));
        answerPushTokens([]);

        const { PushNotificationTroubleshootingView } = await import('./PushNotificationTroubleshootingView');
        const screen = await renderSettingsView(<PushNotificationTroubleshootingView />);
        await flushHookEffects({ cycles: 20 });

        // The runtime failure must be reported as such, not left indistinguishable from a pending
        // check or a denied permission.
        const permissionRow = screen.findRowByTitle('settingsNotifications.pushTroubleshooting.permission.title');
        expect(permissionRow?.props.detail).toBe('settingsNotifications.pushTroubleshooting.permission.runtimeUnavailable');
        expect(permissionRow?.props.subtitle).toBe('settingsNotifications.pushTroubleshooting.permission.runtimeUnavailableSubtitle');

        // Refresh is the recovery action; a misbehaving load must never disable it.
        const refreshRow = screen.findRow('settings-notifications-push-troubleshooting-refresh');
        expect(refreshRow?.props.disabled).toBeFalsy();
        expect(refreshRow?.props.loading).toBeFalsy();
    });

    it('alerts when registration recovery cannot reload the token list', async () => {
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
        answerPushTokens([]);

        const { PushNotificationTroubleshootingView } = await import('./PushNotificationTroubleshootingView');
        const screen = await renderSettingsView(<PushNotificationTroubleshootingView />);
        await flushHookEffects({ cycles: 20 });

        // Nothing to ask for once the permission is granted.
        expect(screen.findByTestId('settings-notifications-push-troubleshooting-request-permission')).toBeNull();

        harness.answer(home, 'POST /v1/push-tokens', { status: 400, body: { error: 'registration rejected' } });
        harness.answer(home, '/v1/push-tokens', { status: 503, body: { error: 'token list unavailable' } });

        await act(async () => {
            screen.pressByTestId('settings-notifications-push-troubleshooting-reregister');
        });

        await waitForHomeGovernance(() => expect(modalAlertMock).toHaveBeenCalledWith('common.error', 'settingsNotifications.pushTroubleshooting.loadError'));
    });
});
