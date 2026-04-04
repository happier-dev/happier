import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { parseActivityInteraction } from './parseActivityInteraction';

describe('parseActivityInteraction', () => {
    it('treats the default action as an open-session interaction', () => {
        const parsed = parseActivityInteraction({
            actionIdentifier: 'DEFAULT',
            defaultActionIdentifier: 'DEFAULT',
            data: {
                sessionId: 'session-1',
                serverUrl: 'https://stack.example.test',
            },
        });

        expect(parsed).toEqual({
            actionIdentifier: 'DEFAULT',
            isDefaultTap: true,
            isOpenAction: true,
            route: '/session/session-1',
            serverUrl: 'https://stack.example.test',
            permissionAction: null,
        });
    });

    it('parses permission allow actions into a generic permission action payload', () => {
        const parsed = parseActivityInteraction({
            actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
            defaultActionIdentifier: 'DEFAULT',
            data: {
                sessionId: 'session-2',
                requestId: 'req-1',
                serverUrl: 'https://stack.example.test',
            },
        });

        expect(parsed).toEqual({
            actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
            isDefaultTap: false,
            isOpenAction: false,
            route: '/session/session-2',
            serverUrl: 'https://stack.example.test',
            permissionAction: {
                action: 'allow',
                sessionId: 'session-2',
                requestId: 'req-1',
            },
        });
    });

    it('returns null for unknown action identifiers', () => {
        expect(parseActivityInteraction({
            actionIdentifier: 'UNKNOWN',
            defaultActionIdentifier: 'DEFAULT',
            data: {
                sessionId: 'session-3',
            },
        })).toBeNull();
    });

    it('parses activity-surface targets into open-session and inbox routes', () => {
        const primary = parseActivityInteraction({
            actionIdentifier: 'open-primary-session',
            defaultActionIdentifier: 'DEFAULT',
            data: {
                primarySessionId: 'session-primary',
            },
        });
        const session = parseActivityInteraction({
            actionIdentifier: 'open-session:session-2',
            defaultActionIdentifier: 'DEFAULT',
            data: null,
        });
        const inbox = parseActivityInteraction({
            actionIdentifier: 'open-inbox',
            defaultActionIdentifier: 'DEFAULT',
            data: null,
        });

        expect(primary).toEqual({
            actionIdentifier: 'open-primary-session',
            isDefaultTap: false,
            isOpenAction: true,
            route: '/session/session-primary',
            serverUrl: null,
            permissionAction: null,
        });
        expect(session).toEqual({
            actionIdentifier: 'open-session:session-2',
            isDefaultTap: false,
            isOpenAction: true,
            route: '/session/session-2',
            serverUrl: null,
            permissionAction: null,
        });
        expect(inbox).toEqual({
            actionIdentifier: 'open-inbox',
            isDefaultTap: false,
            isOpenAction: true,
            route: '/inbox',
            serverUrl: null,
            permissionAction: null,
        });
    });
});
