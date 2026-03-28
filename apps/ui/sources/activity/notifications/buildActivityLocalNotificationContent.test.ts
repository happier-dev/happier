import {
    PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS,
    PUSH_NOTIFICATION_CATEGORY_IDS,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';
import {
    createActivityNotificationTextModuleMock,
    installActivityNotificationRuntimeCommonModuleMocks,
} from './runtime/activityNotificationRuntimeTestHelpers';

installActivityNotificationRuntimeCommonModuleMocks({
    text: async () => createActivityNotificationTextModuleMock(),
});

describe('buildActivityLocalNotificationContent', () => {
    it('uses the latest assistant text for ready notifications when available', async () => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');

        const notification = buildActivityLocalNotificationContent({
            event: {
                kind: 'ready',
                sessionId: 'session-1',
                messages: [
                    {
                        kind: 'agent-text',
                        id: 'message-1',
                        createdAt: 1,
                        text: 'The branch is ready to review.',
                    },
                ] as any,
            },
            session: {
                id: 'session-1',
                metadata: {
                    summary: {
                        text: 'Review branch',
                    },
                },
            } as any,
            serverUrl: 'https://stack.example.test',
            includeReadyMessageText: true,
        });

        expect(notification).toMatchObject({
            title: 'Review branch',
            body: 'The branch is ready to review.',
            data: {
                sessionId: 'session-1',
                serverUrl: 'https://stack.example.test',
            },
            expo: {
                channelId: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.defaultV1,
            },
        });
    });

    it('falls back to the generic ready body when rich ready previews are disabled', async () => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');

        const notification = buildActivityLocalNotificationContent({
            event: {
                kind: 'ready',
                sessionId: 'session-1',
                messages: [
                    {
                        kind: 'agent-text',
                        id: 'message-1',
                        createdAt: 1,
                        text: 'The branch is ready to review.',
                    },
                ] as any,
            },
            session: {
                id: 'session-1',
                metadata: {
                    summary: {
                        text: 'Review branch',
                    },
                },
            } as any,
            serverUrl: 'https://stack.example.test',
            includeReadyMessageText: false,
        });

        expect(notification).toMatchObject({
            title: 'Review branch',
            body: 'Turn finished. Open the session to continue.',
        });
    });

    it('includes permission routing metadata and category wiring', async () => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');

        const notification = buildActivityLocalNotificationContent({
            event: {
                kind: 'agent-request',
                sessionId: 'session-2',
                requestId: 'req-1',
                requestKind: 'permission',
                toolName: 'Bash',
                toolArgs: {
                    command: 'git status',
                },
            },
            session: {
                id: 'session-2',
                metadata: {
                    summary: {
                        text: 'Repo status',
                    },
                },
            } as any,
            serverUrl: 'https://stack.example.test',
        });

        expect(notification).toMatchObject({
            title: 'Repo status',
            body: 'Run: git status',
            data: {
                sessionId: 'session-2',
                requestId: 'req-1',
                serverUrl: 'https://stack.example.test',
            },
            expo: {
                categoryIdentifier: PUSH_NOTIFICATION_CATEGORY_IDS.permissionRequestV1,
                channelId: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.permissionRequestsV1,
            },
        });
    });

    it('extracts the first question for user-action notifications', async () => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');

        const notification = buildActivityLocalNotificationContent({
            event: {
                kind: 'agent-request',
                sessionId: 'session-3',
                requestId: 'req-2',
                requestKind: 'user_action',
                toolName: 'AskUserQuestion',
                toolArgs: {
                    questions: [
                        {
                            header: 'Branch name',
                            question: 'Which branch should I use?',
                        },
                    ],
                },
            },
            session: {
                id: 'session-3',
                metadata: {},
            } as any,
            serverUrl: 'https://stack.example.test',
        });

        expect(notification).toMatchObject({
            title: 'Session',
            body: 'Which branch should I use?',
            data: {
                sessionId: 'session-3',
                requestId: 'req-2',
                serverUrl: 'https://stack.example.test',
            },
            expo: {
                categoryIdentifier: PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1,
                channelId: PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS.userActionRequestsV1,
            },
        });
    });
});
