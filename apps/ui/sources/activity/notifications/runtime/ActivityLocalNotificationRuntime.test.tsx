import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import * as profiles from '@/sync/domains/server/serverProfiles';
import { setActiveViewingSessionId, clearActiveViewingSessionsForServerScopeReset } from '@/sync/domains/session/activeViewingSession';


type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const reactNativeRuntime = vi.hoisted(() => ({
    platformOs: 'ios' as 'web' | 'ios' | 'android',
    isTauri: false,
}));

const initialState = storage.getState();

const sendExpoLocalNotification = vi.hoisted(() => vi.fn(async () => 'notif-1'));
const sendTauriLocalNotification = vi.hoisted(() => vi.fn(async () => true));

vi.mock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return reactNativeRuntime.platformOs;
                },
            },
        });
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    const labels: Record<string, string> = {
        'notifications.activity.defaultSessionTitle': 'Session',
        'notifications.activity.readyFallbackBody': 'Turn finished. Open the session to continue.',
        'notifications.activity.requestLabels.command': 'Command',
    };
    return createTextModuleMock({ translate: (key) => labels[key] ?? key });
});

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => reactNativeRuntime.isTauri,
}));

vi.mock('expo-notifications', () => ({
    scheduleNotificationAsync: sendExpoLocalNotification,
    getPresentedNotificationsAsync: async () => [],
    addNotificationReceivedListener: () => ({ remove() {} }),
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
    isPermissionGranted: async () => true,
    requestPermission: async () => 'granted',
    sendNotification: sendTauriLocalNotification,
}));

describe('ActivityLocalNotificationRuntime', () => {
    beforeEach(() => {
        storage.setState(initialState, true);
        const profile = profiles.upsertServerProfile({ serverUrl: 'https://stack.example.test', name: 'Test' });
        profiles.setActiveServerId(profile.id, { scope: 'device' });
        storage.setState({ profileScope: { serverId: profile.id, accountId: 'account-1' } });
        storage.getState().applyLocalSettings({ localNotificationsEnabled: true, localNotificationsShowReady: true,
            localNotificationsShowReadyMessageText: true, localNotificationsShowPendingPermissionRequests: true,
            localNotificationsShowPendingUserActionRequests: true });
        const session = createSessionFixture();
        storage.getState().applySessions([{ ...session, metadata: { ...session.metadata!, summary: { text: 'Ready session', updatedAt: 1 } } }]);
    });
    afterEach(async () => {
        reactNativeRuntime.platformOs = 'ios';
        reactNativeRuntime.isTauri = false;
        clearActiveViewingSessionsForServerScopeReset();
        await act(async () => { storage.setState(initialState, true); });
        sendExpoLocalNotification.mockClear();
        sendTauriLocalNotification.mockClear();

        const { resetActivityLocalNotificationRuntimeForTests } = await import('./activityLocalNotificationBus');
        resetActivityLocalNotificationRuntimeForTests();
    });

    it('sends ready events to the Expo local notification channel when enabled', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady('session-1', [
                {
                    kind: 'agent-text',
                    id: 'message-1',
                    createdAt: 1,
                    text: 'Everything is ready.',
                } as any,
            ]);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({ content: expect.objectContaining({
            title: 'Ready session',
            body: 'Everything is ready.',
            data: expect.objectContaining({ sessionId: 'session-1' }),
        }) }));
        expect(sendTauriLocalNotification).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('uses the generic ready body when rich ready previews are disabled locally', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        storage.getState().applyLocalSettings({ localNotificationsShowReadyMessageText: false });

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady('session-1', [
                {
                    kind: 'agent-text',
                    id: 'message-1',
                    createdAt: 1,
                    text: 'Everything is ready.',
                } as any,
            ]);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({ content: expect.objectContaining({
            title: 'Ready session',
            body: 'Turn finished. Open the session to continue.',
        }) }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('suppresses same-session notifications while the session is already open', async () => {
        setActiveViewingSessionId('session-1');

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady('session-1', []);
        });

        expect(sendExpoLocalNotification).not.toHaveBeenCalled();
        expect(sendTauriLocalNotification).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('sends same-session Tauri notifications when the desktop window is not active', async () => {
        const globalWithDocument = globalThis as unknown as { document?: unknown };
        const originalDocument = globalWithDocument.document;
        globalWithDocument.document = {
            visibilityState: 'hidden',
            hasFocus: () => false,
        };
        reactNativeRuntime.platformOs = 'web';
        reactNativeRuntime.isTauri = true;
        setActiveViewingSessionId('session-1');

        try {
            const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
            const { notifyActivityReady } = await import('./activityLocalNotificationBus');

            let tree: renderer.ReactTestRenderer | null = null;
            tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

            await act(async () => {
                notifyActivityReady('session-1', []);
            });

            expect(sendExpoLocalNotification).not.toHaveBeenCalled();
            expect(sendTauriLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
                title: 'Ready session',
            }));

            await act(async () => {
                tree?.unmount();
            });
        } finally {
            globalWithDocument.document = originalDocument;
        }
    });

    it('respects per-topic device-local toggles and routes tauri events to the desktop channel', async () => {
        reactNativeRuntime.platformOs = 'web';
        reactNativeRuntime.isTauri = true;
        storage.getState().applyLocalSettings({ localNotificationsShowReady: false });

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady, notifyActivityAgentRequest } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady('session-1', []);
            notifyActivityAgentRequest({
                sessionId: 'session-1',
                requestId: 'req-7',
                requestKind: 'permission',
                toolName: 'Bash',
                toolArgs: { command: 'pwd' },
            });
        });

        expect(sendExpoLocalNotification).not.toHaveBeenCalled();
        expect(sendTauriLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Ready session',
            body: 'Command: pwd',
        }));

        await act(async () => {
            tree?.unmount();
        });
    });
});
