import { describe, expect, it, vi } from 'vitest';

import type { DesktopActivityOverlayExpandedCard } from '../shared/desktopActivityOverlayUiModel';
import {
    resolveDesktopActivityOverlayCompletionStateActions,
    resolveDesktopActivityOverlayRequestCardActions,
} from './resolveDesktopActivityOverlayCardActions';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

describe('resolveDesktopActivityOverlayCardActions', () => {
    it('normalizes permission actions to translated labels and canonical decisions', () => {
        const card: Extract<DesktopActivityOverlayExpandedCard, { kind: 'permission_request' }> = {
            id: 'permission:request-1',
            kind: 'permission_request',
            requestId: 'request-1',
            sessionId: 'session-1',
            serverId: null,
            title: 'Approve command',
            summary: 'npm test',
            toolLabel: 'Bash',
            questionText: null,
            count: 1,
            openActionIdentifier: 'open-session:session-1',
            allowActionIdentifier: 'session.permission.respond',
            denyActionIdentifier: 'session.permission.respond',
            actions: [
                {
                    id: 'allow:request-1',
                    label: 'Allow',
                    actionIdentifier: 'session.permission.respond',
                    data: { requestId: 'request-1', sessionId: 'session-1', decision: 'allow' },
                    tone: 'primary',
                },
                {
                    id: 'deny:request-1',
                    label: 'Deny',
                    actionIdentifier: 'session.permission.respond',
                    data: { requestId: 'request-1', sessionId: 'session-1', decision: 'deny' },
                    tone: 'danger',
                },
            ],
        };

        expect(resolveDesktopActivityOverlayRequestCardActions(card)).toEqual([
            expect.objectContaining({
                id: 'deny',
                label: 'notifications.actions.deny',
                data: { requestId: 'request-1', sessionId: 'session-1', decision: 'deny' },
            }),
            expect.objectContaining({
                id: 'allow',
                label: 'notifications.actions.allow',
                data: { requestId: 'request-1', sessionId: 'session-1', decision: 'allow' },
            }),
        ]);
    });

    it('keeps user-question option labels while filtering stale open actions', () => {
        const card: Extract<DesktopActivityOverlayExpandedCard, { kind: 'user_question' }> = {
            id: 'question:request-1',
            kind: 'user_question',
            requestId: 'request-1',
            sessionId: 'session-1',
            serverId: null,
            title: 'Choose target',
            summary: null,
            toolLabel: 'Question',
            questionText: 'Choose target',
            count: 1,
            openActionIdentifier: 'open-session:session-1',
            actions: [
                {
                    id: 'production',
                    label: 'Production',
                    actionIdentifier: 'session.user_action.answer',
                    data: { requestId: 'request-1', sessionId: 'session-1' },
                    tone: 'primary',
                },
                {
                    id: 'open:request-1',
                    label: 'Open',
                    actionIdentifier: 'open-session:session-1',
                    data: { requestId: 'request-1', sessionId: 'session-1' },
                    tone: 'primary',
                },
            ],
        };

        expect(resolveDesktopActivityOverlayRequestCardActions(card)).toEqual([
            expect.objectContaining({
                id: 'production',
                label: 'Production',
            }),
        ]);
    });

    it('normalizes completion open actions instead of reusing stale model labels', () => {
        const card: Extract<DesktopActivityOverlayExpandedCard, { kind: 'completion_state' }> = {
            id: 'completion:session-1',
            kind: 'completion_state',
            sessionId: 'session-1',
            serverId: null,
            title: 'Ready',
            summary: null,
            openActionIdentifier: 'open-session:session-1',
            variant: 'turn_complete',
            autoDismissMs: 15000,
            sticky: false,
            actions: [
                {
                    id: 'open:session-1',
                    label: 'Open stale label',
                    actionIdentifier: 'open-session:session-1',
                    data: { sessionId: 'session-1' },
                    tone: 'primary',
                },
            ],
        };

        expect(resolveDesktopActivityOverlayCompletionStateActions(card)).toEqual([
            expect.objectContaining({
                id: 'open',
                label: 'common.open',
                actionIdentifier: 'open-session:session-1',
                data: { sessionId: 'session-1' },
            }),
        ]);
    });
});
