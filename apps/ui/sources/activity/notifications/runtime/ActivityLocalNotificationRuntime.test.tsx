import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/text', () => ({
    t: (key: string) => {
        switch (key) {
            case 'notifications.activity.defaultSessionTitle':
                return 'Session';
            case 'notifications.activity.readyFallbackBody':
                return 'Turn finished. Open the session to continue.';
            case 'notifications.activity.permissionFallbackBody':
                return 'Approval required.';
            case 'notifications.activity.userActionFallbackBody':
                return 'This session needs your input.';
            default:
                return key;
        }
    },
}));

let platformOs: 'web' | 'ios' | 'android' = 'ios';
let isTauriDesktopValue = false;
let activeViewingSessionIdValue: string | null = null;
let localSettingsValue: Record<string, unknown> = {
    localNotificationsEnabled: true,
    localNotificationsShowReady: true,
    localNotificationsShowReadyMessageText: true,
    localNotificationsShowPendingPermissionRequests: true,
    localNotificationsShowPendingUserActionRequests: true,
};
let sessionsByIdValue: Record<string, unknown> = {
    'session-1': {
        id: 'session-1',
        metadata: {
            summary: {
                text: 'Ready session',
            },
        },
    },
};

const sendExpoLocalNotification = vi.hoisted(() => vi.fn(async () => 'notif-1'));
const sendTauriLocalNotification = vi.hoisted(() => vi.fn(async () => true));

vi.mock('react-native', () => ({
    Platform: {
        get OS() {
            return platformOs;
        },
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSettings: () => localSettingsValue,
    storage: {
        getState: () => ({
            sessions: sessionsByIdValue,
            localSettings: localSettingsValue,
        }),
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://stack.example.test',
}));

vi.mock('@/sync/domains/session/activeViewingSession', () => ({
    getActiveViewingSessionId: () => activeViewingSessionIdValue,
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => isTauriDesktopValue,
}));

vi.mock('../channels/sendExpoLocalNotification', () => ({
    sendExpoLocalNotification,
}));

vi.mock('../channels/sendTauriLocalNotification', () => ({
    sendTauriLocalNotification,
}));

describe('ActivityLocalNotificationRuntime', () => {
    afterEach(async () => {
        platformOs = 'ios';
        isTauriDesktopValue = false;
        activeViewingSessionIdValue = null;
        localSettingsValue = {
            localNotificationsEnabled: true,
            localNotificationsShowReady: true,
            localNotificationsShowReadyMessageText: true,
            localNotificationsShowPendingPermissionRequests: true,
            localNotificationsShowPendingUserActionRequests: true,
        };
        sessionsByIdValue = {
            'session-1': {
                id: 'session-1',
                metadata: {
                    summary: {
                        text: 'Ready session',
                    },
                },
            },
        };
        sendExpoLocalNotification.mockClear();
        sendTauriLocalNotification.mockClear();

        const { resetActivityLocalNotificationRuntimeForTests } = await import('./activityLocalNotificationBus');
        resetActivityLocalNotificationRuntimeForTests();
    });

    it('sends ready events to the Expo local notification channel when enabled', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ActivityLocalNotificationRuntime />);
        });

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

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Ready session',
            body: 'Everything is ready.',
            data: expect.objectContaining({ sessionId: 'session-1' }),
        }));
        expect(sendTauriLocalNotification).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('uses the generic ready body when rich ready previews are disabled locally', async () => {
        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        localSettingsValue = {
            ...localSettingsValue,
            localNotificationsShowReadyMessageText: false,
        };

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ActivityLocalNotificationRuntime />);
        });

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

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Ready session',
            body: 'Turn finished. Open the session to continue.',
        }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('suppresses same-session notifications while the session is already open', async () => {
        activeViewingSessionIdValue = 'session-1';

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ActivityLocalNotificationRuntime />);
        });

        await act(async () => {
            notifyActivityReady('session-1', []);
        });

        expect(sendExpoLocalNotification).not.toHaveBeenCalled();
        expect(sendTauriLocalNotification).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('respects per-topic device-local toggles and routes tauri events to the desktop channel', async () => {
        platformOs = 'web';
        isTauriDesktopValue = true;
        localSettingsValue = {
            ...localSettingsValue,
            localNotificationsShowReady: false,
        };

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady, notifyActivityAgentRequest } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<ActivityLocalNotificationRuntime />);
        });

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
            body: 'Run: pwd',
        }));

        await act(async () => {
            tree?.unmount();
        });
    });
});
