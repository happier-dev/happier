import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { accountSettingsParse } from '@happier-dev/protocol';
import { renderScreen } from '@/dev/testkit';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import {
    createActivityNotificationTextModuleMock,
    installActivityNotificationRuntimeCommonModuleMocks,
} from './activityNotificationRuntimeTestHelpers';


type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const reactNativeRuntime = vi.hoisted(() => ({
    platformOs: 'ios' as 'web' | 'ios' | 'android',
}));

let isDesktopHostValue = false;
let visibleSessionIdsValue: string[] = [];
let localSettingsValue: Record<string, unknown> = {
    localNotificationsEnabled: true,
    localNotificationsShowReady: true,
    localNotificationsShowReadyMessageText: true,
    localNotificationsShowPendingPermissionRequests: true,
    localNotificationsShowPendingUserActionRequests: true,
};
let accountSettingsValue = accountSettingsParse({});
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

installActivityNotificationRuntimeCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return reactNativeRuntime.platformOs;
                },
            },
        });
    },
    text: async () => {
        return createActivityNotificationTextModuleMock();
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSettings: () => accountSettingsValue,
            useLocalSettings: () => localSettingsValue,
            useSetting: (key: keyof typeof accountSettingsValue) => accountSettingsValue[key],
            useLocalSetting: (key: keyof ReturnType<typeof localSettingsParse>) => localSettingsParse(localSettingsValue)[key],
            storage: {
                getState: () => ({
                    sessions: sessionsByIdValue,
                    localSettings: localSettingsValue,
                    settings: accountSettingsValue,
                }),
            },
        });
    },
});

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerUrl: () => 'https://stack.example.test',
}));

vi.mock('@/sync/domains/session/sessionSurfaceVisibility', () => ({
    isSessionSurfaceVisible: (sessionId: string) => visibleSessionIdsValue.includes(sessionId),
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => isDesktopHostValue,
}));

vi.mock('../channels/sendExpoLocalNotification', () => ({
    sendExpoLocalNotification,
}));

vi.mock('../channels/sendTauriLocalNotification', () => ({
    sendTauriLocalNotification,
}));

describe('ActivityLocalNotificationRuntime', () => {
    afterEach(async () => {
        reactNativeRuntime.platformOs = 'ios';
        isDesktopHostValue = false;
        visibleSessionIdsValue = [];
        localSettingsValue = {
            localNotificationsEnabled: true,
            localNotificationsShowReady: true,
            localNotificationsShowReadyMessageText: true,
            localNotificationsShowPendingPermissionRequests: true,
            localNotificationsShowPendingUserActionRequests: true,
        };
        accountSettingsValue = accountSettingsParse({});
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

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Ready session',
            body: 'Everything is ready.',
            data: expect.objectContaining({ sessionId: 'session-1' }),
            sound: 'happier_soft.wav',
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

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            title: 'Ready session',
            body: 'Turn finished. Open the session to continue.',
        }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('suppresses same-session notifications while the session is already open', async () => {
        visibleSessionIdsValue = ['session-1'];

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
        isDesktopHostValue = true;
        visibleSessionIdsValue = ['session-1'];

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

    it('suppresses reused ready notifications for the active direct-session view', async () => {
        visibleSessionIdsValue = ['session-1'];
        sessionsByIdValue = {
            'session-1': {
                id: 'session-1',
                metadata: {
                    summary: {
                        text: 'Direct session',
                    },
                    externalSessionV1: {
                        v: 1,
                        agentId: 'claude',
                        machineId: 'machine-1',
                        remoteSessionId: 'remote-1',
                        source: { kind: 'claudeConfig', configDir: '/tmp/.claude', projectId: 'proj-1' },
                    },
                },
            },
        };

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

    it('suppresses notifications for visible background sessions even when a different leaf is focused', async () => {
        visibleSessionIdsValue = ['session-1', 'session-2'];

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady('session-2', []);
        });

        expect(sendExpoLocalNotification).not.toHaveBeenCalled();
        expect(sendTauriLocalNotification).not.toHaveBeenCalled();

        await act(async () => {
            tree?.unmount();
        });
    });

    it('respects per-topic device-local toggles and routes tauri events to the desktop channel', async () => {
        reactNativeRuntime.platformOs = 'web';
        isDesktopHostValue = true;
        localSettingsValue = {
            ...localSettingsValue,
            localNotificationsShowReady: false,
        };

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
            body: 'Run: pwd',
        }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('suppresses local notifications during account quiet hours', async () => {
        accountSettingsValue = accountSettingsParse({
            attentionDeliveryPolicyV1: {
                v: 1,
                quietHours: {
                    enabled: true,
                    timezone: 'UTC',
                    windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
                },
            },
        });

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

    it('lets a device quiet-hours override deliver local notifications during account quiet hours', async () => {
        accountSettingsValue = accountSettingsParse({
            attentionDeliveryPolicyV1: {
                v: 1,
                quietHours: {
                    enabled: true,
                    timezone: 'UTC',
                    windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
                },
            },
        });
        localSettingsValue = {
            ...localSettingsValue,
            attentionDeviceOverridesV1: {
                v: 1,
                quietHoursOverride: { mode: 'disabled' },
            },
        };

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady('session-1', []);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ sessionId: 'session-1' }),
        }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('delivers quiet-hours silent local notifications without sound when configured by account policy', async () => {
        accountSettingsValue = accountSettingsParse({
            attentionDeliveryPolicyV1: {
                v: 1,
                quietHours: {
                    enabled: true,
                    timezone: 'UTC',
                    windows: [{ startLocalTime: '00:00', endLocalTime: '23:59' }],
                },
                channels: {
                    local_notification: {
                        quietHoursBehavior: 'silent',
                    },
                },
            },
        });

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady('session-1', []);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ sessionId: 'session-1' }),
            sound: null,
        }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('suppresses account-disabled local notification events even when legacy device toggles are enabled', async () => {
        accountSettingsValue = accountSettingsParse({
            attentionDeliveryPolicyV1: {
                v: 1,
                channels: {
                    local_notification: {
                        events: {
                            ready: { enabled: false },
                        },
                    },
                },
            },
        });

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

    it('passes resolved silent sound options to Expo local notifications', async () => {
        accountSettingsValue = accountSettingsParse({
            attentionDeliveryPolicyV1: {
                v: 1,
                sounds: {
                    defaultSoundId: 'none',
                },
            },
        });

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady('session-1', []);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ sessionId: 'session-1' }),
            sound: null,
        }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('passes bundled sound filenames and Android channel ids to Expo local notifications', async () => {
        reactNativeRuntime.platformOs = 'android';
        accountSettingsValue = accountSettingsParse({
            attentionDeliveryPolicyV1: {
                v: 1,
                sounds: {
                    defaultSoundId: 'soft',
                },
            },
        });

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady('session-1', []);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ sessionId: 'session-1' }),
            sound: 'happier_soft.wav',
            channelId: 'happier.default.soft.v1',
        }));

        await act(async () => {
            tree?.unmount();
        });
    });

    it('does not pass unsupported custom sound ids to Expo local notifications', async () => {
        accountSettingsValue = accountSettingsParse({
            attentionDeliveryPolicyV1: {
                v: 1,
                sounds: {
                    defaultSoundId: 'custom:imported-tone',
                },
            },
        });

        const { ActivityLocalNotificationRuntime } = await import('./ActivityLocalNotificationRuntime');
        const { notifyActivityReady } = await import('./activityLocalNotificationBus');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<ActivityLocalNotificationRuntime />)).tree;

        await act(async () => {
            notifyActivityReady('session-1', []);
        });

        expect(sendExpoLocalNotification).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ sessionId: 'session-1' }),
            sound: null,
        }));

        await act(async () => {
            tree?.unmount();
        });
    });
});
