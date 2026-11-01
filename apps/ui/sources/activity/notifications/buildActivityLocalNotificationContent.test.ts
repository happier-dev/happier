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
            body: 'Command: git status',
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

    it.each(['AskUserQuestion', 'ask_user_question'] as const)(
      'extracts the first question for %s user-action notifications',
      async (toolName) => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');

        const notification = buildActivityLocalNotificationContent({
            event: {
                kind: 'agent-request',
                sessionId: 'session-3',
                requestId: 'req-2',
                requestKind: 'user_action',
                toolName,
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
            body: expect.stringContaining('Which branch should I use?'),
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
      },
    );
    it.each(['permission', 'user_action'] as const)('hides %s details when request previews are disabled', async (requestKind) => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');
        const notification = buildActivityLocalNotificationContent({
            event: { kind: 'agent-request', sessionId: 'session-1', requestId: 'req-private', requestKind,
                toolName: requestKind === 'permission' ? 'Bash' : 'AskUserQuestion',
                toolArgs: requestKind === 'permission' ? { command: 'cat private.txt' } : { questions: [{ question: 'Private question?', options: [{ label: 'Secret option' }] }] } },
            session: null,
            serverUrl: 'https://stack.example.test',
            includeRequestMessageText: false,
        });
        expect(notification.body).toBe(requestKind === 'permission'
            ? 'Approval required.'
            : 'This session needs your input.');
        expect(notification.data.requestId).toBe('req-private');
    });

    it('includes question options in request previews', async () => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');
        const notification = buildActivityLocalNotificationContent({
            event: { kind: 'agent-request', sessionId: 'session-1', requestId: 'req-options', requestKind: 'user_action',
                toolName: 'AskUserQuestion', toolArgs: { questions: [{ question: 'Which branch?', options: [{ label: 'Main' }, { label: 'Develop' }] }] } },
            session: null,
            serverUrl: 'https://stack.example.test',
        });
        expect(notification.body).toContain('Which branch?');
        expect(notification.body).toContain('Main');
        expect(notification.body).toContain('Develop');
    });

    it.each([
        [{ question: 'Which branch?', options: [{ label: 'Main\n\tbranch', description: 'Stable\n\tcode', value: 'main-value' }, { label: 'Develop', choice: 'develop-value' }] },
            { kind: 'choices', questionKey: 'Which branch?', values: ['main-value', 'develop-value'] }, 'happier.questionChoices2.v1', 'Which branch?\n1. Main branch — Stable code\n2. Develop'],
        [{ question: 'Branch name?', freeform: { placeholder: 'Name', multiline: false } },
            { kind: 'text', questionKey: 'Branch name?', allowEmpty: false }, 'happier.questionText.v1', 'Branch name?'],
    ])('offers a simple exact question through its existing notification producer', async (question, descriptor, category, body) => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');
        const notification = buildActivityLocalNotificationContent({
            event: { kind: 'agent-request', sessionId: 'question-session', requestId: 'request', occurrenceId: 'occurrence',
                requestKind: 'user_action', toolName: 'AskUserQuestion', toolArgs: { questions: [question] } },
            session: null, serverUrl: 'https://stack.example.test', accountId: 'account',
        });
        expect(notification).toMatchObject({ body, data: { accountId: 'account', requestId: 'request', occurrenceId: 'occurrence',
            questionAnswerV1: descriptor }, expo: { categoryIdentifier: category } });
        const privateNotice = buildActivityLocalNotificationContent({
            event: { kind: 'agent-request', sessionId: 'question-session', requestId: 'request', occurrenceId: 'occurrence',
                requestKind: 'user_action', toolName: 'AskUserQuestion', toolArgs: { questions: [question] } },
            session: null, serverUrl: 'https://stack.example.test', accountId: 'account', includeRequestMessageText: false,
        });
        expect(privateNotice.data.questionAnswerV1).toBeUndefined();
        expect(privateNotice.expo.categoryIdentifier).toBe(PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1);
        expect(privateNotice.body).toBe('This session needs your input.');
    });

});
