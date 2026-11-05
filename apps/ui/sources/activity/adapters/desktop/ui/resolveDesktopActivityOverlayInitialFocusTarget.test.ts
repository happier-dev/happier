import { describe, expect, it, vi } from 'vitest';

import { resolveDesktopActivityOverlayInitialFocusTarget } from './resolveDesktopActivityOverlayInitialFocusTarget';
import type {
    DesktopActivityOverlayExpandedCard,
    DesktopActivityOverlayUiModel,
} from './shared/desktopActivityOverlayUiModel';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
    });
});

function createModel(
    expanded: Partial<DesktopActivityOverlayUiModel['expanded']>,
): DesktopActivityOverlayUiModel {
    return {
        visible: true,
        generatedAt: 1,
        faces: { faces: [], overflowCount: 0 },
        conversation: null,
        collapsed: {
            title: 'Sessions',
            statusText: null,
            defaultTarget: 'open-primary-session',
            activity: 'needsYou',
            sessionCount: null,
        },
        expanded: {
            title: 'Active sessions',
            rows: [],
            ...expanded,
        },
    };
}

const sessionOverviewCard: DesktopActivityOverlayExpandedCard = {
    id: 'session-overview-1',
    kind: 'session_overview',
    sessionId: 'session-1',
    serverId: 'server-1',
    title: 'Session One',
    subtitle: 'Repo',
    statusText: null,
    previewText: null,
    attentionState: 'idle',
    active: true,
    updatedAt: 1,
};

const permissionCard: DesktopActivityOverlayExpandedCard = {
    id: 'permission:request-1',
    kind: 'permission_request',
    requestId: 'request-1',
    sessionId: 'session-2',
    serverId: 'server-1',
    title: 'Approve command',
    summary: 'npm test',
    toolLabel: 'Bash',
    questionText: null,
    count: 1,
    openActionIdentifier: 'open-session:session-2',
    allowActionIdentifier: 'session.permission.respond',
    denyActionIdentifier: 'session.permission.respond',
    // Focus consumes the rendered choices supplied by the card producer.
    actions: [{
        id: 'deny',
        label: 'No',
        actionIdentifier: 'session.permission.respond',
        data: { requestId: 'request-1', sessionId: 'session-2', serverId: 'server-1', decision: 'denied' },
        tone: 'danger',
    }],
};

describe('resolveDesktopActivityOverlayInitialFocusTarget', () => {
    it('prefers the first actionable card over a later session row', () => {
        const target = resolveDesktopActivityOverlayInitialFocusTarget(
            createModel({ cards: [permissionCard, sessionOverviewCard] }),
        );

        expect(target).toEqual({
            kind: 'card_action',
            cardId: 'permission:request-1',
            actionId: 'deny',
        });
    });

    it('skips copy-only cards and qualifies the first multi-session row by Home', () => {
        const target = resolveDesktopActivityOverlayInitialFocusTarget(
            createModel({
                cards: [
                    { id: 'quota-1', kind: 'quota_summary', title: 'Usage', summary: null },
                    {
                        id: 'multi-1',
                        kind: 'multi_session_list',
                        title: 'Sessions',
                        rows: [
                            {
                                sessionId: 'session-9',
                                serverId: 'server-2',
                                title: 'Session Nine',
                                subtitle: null,
                                statusText: null,
                                previewText: null,
                            },
                        ],
                    },
                ],
            }),
        );

        expect(target).toEqual({
            kind: 'session_row',
            cardId: 'multi-1',
            sessionId: 'session-9',
            serverId: 'server-2',
        });
    });

    it('falls back to the island surface when there is nothing to act on at all', () => {
        expect(resolveDesktopActivityOverlayInitialFocusTarget(
            createModel({}),
        )).toEqual({ kind: 'surface' });
    });
});
