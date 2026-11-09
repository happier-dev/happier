import {
    PUSH_NOTIFICATION_ANDROID_CHANNEL_IDS,
    PUSH_NOTIFICATION_ACTION_IDS,
    PUSH_NOTIFICATION_CATEGORY_IDS,
} from '@happier-dev/protocol/push/pushNotificationActions';
import { describe, expect, it } from 'vitest';
import {
    createActivityNotificationTextModuleMock,
    installActivityNotificationRuntimeCommonModuleMocks,
} from './runtime/activityNotificationRuntimeTestHelpers';

installActivityNotificationRuntimeCommonModuleMocks({
    text: async () => {
        const boundary = createActivityNotificationTextModuleMock();
        return { ...boundary, t: (key: string, params?: Record<string, unknown>) =>
            key === 'notifications.activity.requestLabels.answerAll'
                ? `Réponds aux ${params?.count} questions dans Happier` : boundary.t(key, params) };
    },
});

describe('buildActivityLocalNotificationContent', () => {

    it.each([
        [{ question: 'Which branch?', options: [{ label: 'Main\n\tbranch', description: 'Stable\n\tcode', value: 'main-value' }, { label: 'Develop', choice: 'dev-value' }] },
            { kind: 'choices', questionKey: 'Which branch?', values: ['main-value', 'dev-value'] }, 'happier.questionChoices2.v1', 'Which branch?\n1. Main branch — Stable code\n2. Develop'],
        [{ question: 'Branch name?', freeform: { multiline: false, allowEmpty: false } },
            { kind: 'text', questionKey: 'Branch name?', allowEmpty: false }, 'happier.questionText.v1', 'Branch name?'],
    ])('offers a simple exact question only with its bound Account and private preview', async (question, descriptor, category, body) => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');
        const event = { kind: 'agent-request' as const, event: 'user_action_required' as const,
            address: { serverId: 'server-a', sessionId: 'question-session' }, requestId: 'question-request', turnId: 'turn-question',
            requestKind: 'user_action' as const, toolName: 'AskUserQuestion', toolArgs: { questions: [question] } };
        const params = { event, session: null, serverUrl: 'https://home-a.example.test', accountId: 'notification-account' };
        expect(buildActivityLocalNotificationContent(params)).toMatchObject({ body,
            data: { accountId: 'notification-account', requestId: 'question-request', turnId: 'turn-question', questionAnswerV1: descriptor },
            expo: { categoryIdentifier: category } });
        for (const notice of [buildActivityLocalNotificationContent({ ...params, previewBehavior: 'status_only' }),
            buildActivityLocalNotificationContent({ ...params, accountId: undefined })]) {
            expect(notice.data.questionAnswerV1).toBeUndefined();
            expect(notice.expo.categoryIdentifier).toBe(PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1);
        }
    });

    it('links an above-cap notification to its owning session without an inline answer', async () => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');
        const { parseNotificationTap } = await import('./notificationRouting');
        const notification = buildActivityLocalNotificationContent({
            event: {
                kind: 'agent-request', event: 'user_action_required',
                address: { serverId: 'server-b', sessionId: 'session-five' },
                requestId: 'request-five',
                requestKind: 'user_action',
                toolName: 'AskUserQuestion',
                toolArgs: { questions: Array.from({ length: 5 }, (_, index) => ({ question: `Question ${index}?` })) },
            },
            session: null,
            serverUrl: 'https://home-b.example.test',
        });
        expect(notification.body).toBe('Réponds aux 5 questions dans Happier');
        expect(notification.data).toMatchObject({ serverId: 'server-b', sessionId: 'session-five', requestId: 'request-five' });
        expect(notification.expo.categoryIdentifier).toBe(PUSH_NOTIFICATION_CATEGORY_IDS.userActionRequestV1);
        const tap = parseNotificationTap({
            defaultActionIdentifier: 'default',
            response: {
                actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.userActionOpenV1,
                notification: { request: { content: { data: notification.data } } },
            },
        });
        expect(tap?.command).toMatchObject({
            kind: 'openSession', serverId: 'server-b', sessionId: 'session-five',
            route: '/session/session-five?serverId=server-b',
        });
    });

    it('keeps Follow classification and exact message identity while applying preview privacy', async () => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');
        const event = {
            kind: 'session-update' as const, event: 'message' as const,
            address: { serverId: 'server-a', sessionId: 'session-1' },
            committedSequence: { sequenceDomain: 'session_transcript' as const, sequence: 7 },
            messages: [{ kind: 'agent-text' as const, id: 'message-7', localId: null, seq: 7, createdAt: 7, text: 'Private result' }],
        };
        const rich = buildActivityLocalNotificationContent({ event, session: null,
            serverUrl: 'https://stack.example.test', previewBehavior: 'include_preview' });
        expect(rich.body).toBe('Private result');
        expect(rich.data.activityEvent).toEqual({ type: 'message', sequenceDomain: 'session_transcript', messageSeq: 7 });
        const privateNotification = buildActivityLocalNotificationContent({ event, session: null,
            serverUrl: 'https://stack.example.test', previewBehavior: 'status_only' });
        expect(privateNotification.body).not.toContain('Private result');
        expect(privateNotification.data.activityEvent).toEqual(rich.data.activityEvent);
        expect(privateNotification.expo.categoryIdentifier).toBeUndefined();
    });

    it('preserves the exact Home through notification content and interaction parsing', async () => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');
        const { parseNotificationTap } = await import('./notificationRouting');
        const notification = buildActivityLocalNotificationContent({
            event: { kind: 'ready', event: 'ready', address: { serverId: 'server-b', sessionId: 'same-id' } },
            session: null,
            serverUrl: 'https://home-b.example.test',
        });
        const tap = parseNotificationTap({
            defaultActionIdentifier: 'default',
            response: { actionIdentifier: 'default', notification: { request: { content: { data: notification.data } } } },
        });
        expect(tap?.command).toMatchObject({
            kind: 'openSession', serverId: 'server-b',
            route: '/session/same-id?serverId=server-b',
        });
    });

    it('uses the latest assistant text for ready notifications when available', async () => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');

        const notification = buildActivityLocalNotificationContent({
            event: {
                kind: 'ready', event: 'ready',
                address: { serverId: 'server-a', sessionId: 'session-1' },
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
                kind: 'ready', event: 'ready',
                address: { serverId: 'server-a', sessionId: 'session-1' },
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
                kind: 'agent-request', event: 'permission_required',
                address: { serverId: 'server-a', sessionId: 'session-2' },
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

    it('extracts the first question for user-action notifications', async () => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');

        const notification = buildActivityLocalNotificationContent({
            event: {
                kind: 'agent-request', event: 'user_action_required',
                address: { serverId: 'server-a', sessionId: 'session-3' },
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
    });

    it('titles a notification by the same Session name the list and header show, not only its summary', async () => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const notification = buildActivityLocalNotificationContent({
            event: {
                kind: 'agent-request', event: 'permission_required',
                address: { serverId: 'server-a', sessionId: 'session-named' },
                requestId: 'req-named', requestKind: 'permission',
                toolName: 'Bash', toolArgs: { command: 'ls' },
            },
            session: createSessionFixture({ id: 'session-named', metadata: { name: 'Deploy bot', path: '/work/app', host: 'box' } as never }),
            serverUrl: 'https://stack.example.test',
        });
        expect(notification.title).toBe('Deploy bot');
    });

    it('extracts the first question for snake_case ask-user-question notifications', async () => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');

        const notification = buildActivityLocalNotificationContent({
            event: {
                kind: 'agent-request', event: 'user_action_required',
                address: { serverId: 'server-a', sessionId: 'session-4' },
                requestId: 'req-3',
                requestKind: 'user_action',
                toolName: 'ask_user_question',
                toolArgs: {
                    questions: [
                        {
                            question: 'Which branch should I use?',
                        },
                    ],
                },
            },
            session: {
                id: 'session-4',
                metadata: {},
            } as any,
            serverUrl: 'https://stack.example.test',
        });

        expect(notification).toMatchObject({
            title: 'Session',
            body: expect.stringContaining('Which branch should I use?'),
        });
    });    it.each(['permission', 'user_action'] as const)('hides %s details when request previews are disabled', async (requestKind) => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');
        const notification = buildActivityLocalNotificationContent({
            event: { kind: 'agent-request', event: requestKind === 'permission' ? 'permission_required' : 'user_action_required', address: { serverId: 'server-a', sessionId: 'session-1' }, requestId: 'req-private', requestKind,
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
            event: { kind: 'agent-request', event: 'user_action_required', address: { serverId: 'server-a', sessionId: 'session-1' }, requestId: 'req-options', requestKind: 'user_action',
                toolName: 'AskUserQuestion', toolArgs: { questions: [{ question: 'Which branch?', options: [{ label: 'Main' }, { label: 'Develop' }] }] } },
            session: null,
            serverUrl: 'https://stack.example.test',
        });
        expect(notification.body).toContain('Which branch?');
        expect(notification.body).toContain('Main');
        expect(notification.body).toContain('Develop');
    });

    it('keeps the already privacy-filtered context on a status-only notification while withholding private content', async () => {
        const { buildActivityLocalNotificationContent } = await import('./buildActivityLocalNotificationContent');
        // The runtime supplies this line from the shared context projection, which never contains
        // content-derived facts. Only the Session title and message preview wait for readiness, so
        // a locked/status-only alert still names its exact Home, audience, freshness and content
        // state (Lane 07.4 §8, L07-R42/L07-I37).
        const contextLine = 'Home A · Offline · Last updated 18m ago · Developers · Encrypted access pending';
        const notification = buildActivityLocalNotificationContent({
            event: {
                kind: 'ready', event: 'ready',
                address: { serverId: 'server-a', sessionId: 'session-locked' },
                messages: [{
                    kind: 'agent-text', id: 'message-1', createdAt: 1, text: 'PRIVATE-PREVIEW-SENTINEL',
                }] as any,
            },
            session: {
                id: 'session-locked',
                metadata: { summary: { text: 'PRIVATE-TITLE-SENTINEL' } },
            } as any,
            serverUrl: 'https://home-a.example.test',
            contextLine,
            previewBehavior: 'status_only',
            includeReadyMessageText: true,
        });

        expect(notification.title).toBe(`Session · ${contextLine}`);
        expect(notification.body).toBe('Turn finished. Open the session to continue.');
        expect(`${notification.title} ${notification.body}`).not.toContain('PRIVATE');
    });

});
