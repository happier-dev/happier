import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { parseNotificationTap } from './notificationRouting';

function createResponse(params: Readonly<{
    actionIdentifier: string;
    data: Record<string, unknown>;
}>) {
    return {
        actionIdentifier: params.actionIdentifier,
        notification: {
            request: {
                identifier: 'notification-1',
                content: {
                    data: params.data,
                },
            },
        },
    };
}

describe('parseNotificationTap', () => {
    it('returns the final command union for notification taps', () => {
        const parsed = parseNotificationTap({
            response: createResponse({
                actionIdentifier: 'DEFAULT',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-a',
                    serverUrl: 'https://stack.example.test',
                },
            }),
            defaultActionIdentifier: 'DEFAULT',
        });

        expect(parsed).toMatchObject({
            command: {
                kind: 'openSession',
                sessionId: 'session-1',
                serverId: 'server-a',
                serverUrl: 'https://stack.example.test',
                route: '/session/session-1?serverId=server-a',
            },
            dedupeKey: 'notification-1:DEFAULT',
        });
    });

    it('keeps direct notification actions as executeAction commands for the runtime safety gate', () => {
        const parsed = parseNotificationTap({
            response: createResponse({
                actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
                data: {
                    sessionId: 'session-1',
                    requestId: 'request-1',
                    serverId: 'server-a',
                    serverUrl: 'https://stack.example.test',
                },
            }),
            defaultActionIdentifier: 'DEFAULT',
        });

        expect(parsed?.command).toMatchObject({
            kind: 'executeAction',
            actionId: 'session.permission.respond',
            defaultSessionId: 'session-1',
            payload: {
                decision: 'allow',
                sessionId: 'session-1',
                requestId: 'request-1',
            },
            target: {
                serverUrl: 'https://stack.example.test',
            },
        });
    });

    it('returns ignore for unknown notification actions', () => {
        const parsed = parseNotificationTap({
            response: createResponse({
                actionIdentifier: 'UNKNOWN_ACTION',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-a',
                    serverUrl: 'https://stack.example.test',
                },
            }),
            defaultActionIdentifier: 'DEFAULT',
        });

        expect(parsed).toMatchObject({
            command: {
                kind: 'ignore',
                reason: 'unknown_action',
            },
        });
    });
});
