import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type { DesktopActivityOverlayUiModel } from './shared/desktopActivityOverlayUiModel';
import {
    resolveDesktopActivityOverlayCardActionInstanceTestID,
    resolveDesktopActivityOverlayCardInstanceTestID,
    resolveDesktopActivityOverlayCardKindTestID,
} from './shared/desktopActivityOverlaySelectors.mjs';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('Text', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => {
            switch (key) {
                case 'notifications.activity.readyFallbackBody':
                    return 'The island stays available and will wake up when new activity arrives.';
                case 'notifications.actions.allow':
                    return 'Allow';
                case 'notifications.actions.deny':
                    return 'Deny';
                case 'common.open':
                    return 'Open';
                default:
                    return key;
            }
        },
    });
});

describe('DesktopActivityOverlayExpanded', () => {
    function createCollapsedModel(overrides: Partial<DesktopActivityOverlayUiModel['collapsed']> = {}): DesktopActivityOverlayUiModel['collapsed'] {
        return {
            title: 'Primary session',
            statusText: 'Needs attention',
            defaultTarget: 'open-primary-session',
            sessionCount: 1,
            primaryCardKind: 'session_overview',
            ...overrides,
        };
    }

    function createSessionOverviewCard(
        overrides: Partial<Extract<NonNullable<DesktopActivityOverlayUiModel['expanded']['cards']>[number], { kind: 'session_overview' }>> = {},
    ): Extract<NonNullable<DesktopActivityOverlayUiModel['expanded']['cards']>[number], { kind: 'session_overview' }> {
        return {
            id: 'session-overview-1',
            kind: 'session_overview',
            sessionId: 'session-1',
            title: 'Primary session',
            subtitle: 'Agent on machine',
            statusText: 'Needs attention',
            previewText: 'Need your approval',
            attentionState: 'permission_required',
            active: true,
            updatedAt: 1,
            ...overrides,
        };
    }

    function createPermissionRequestCard(
        overrides: Partial<Extract<NonNullable<DesktopActivityOverlayUiModel['expanded']['cards']>[number], { kind: 'permission_request' }>> = {},
    ): Extract<NonNullable<DesktopActivityOverlayUiModel['expanded']['cards']>[number], { kind: 'permission_request' }> {
        return {
            id: 'permission-1',
            kind: 'permission_request',
            requestId: 'permission-1',
            sessionId: 'session-1',
            title: 'Edit src/auth/middleware.ts',
            summary: 'The agent needs approval before editing this file.',
            toolLabel: 'Claude asks',
            questionText: null,
            count: 1,
            openActionIdentifier: 'open-session:session-1',
            allowActionIdentifier: 'approve-permission',
            denyActionIdentifier: 'deny-permission',
            actions: [
                {
                    id: 'deny',
                    label: 'Deny',
                    actionIdentifier: 'deny-permission',
                    data: { requestId: 'permission-1', sessionId: 'session-1', decision: 'deny' },
                    tone: 'danger',
                },
                {
                    id: 'allow',
                    label: 'Allow',
                    actionIdentifier: 'approve-permission',
                    data: { requestId: 'permission-1', sessionId: 'session-1', decision: 'allow' },
                    tone: 'primary',
                },
                {
                    id: 'open',
                    label: 'Open',
                    actionIdentifier: 'open-session:session-1',
                    data: { requestId: 'permission-1', sessionId: 'session-1' },
                    tone: 'secondary',
                },
            ],
            ...overrides,
        };
    }

    function createUserQuestionCard(
        overrides: Partial<Extract<NonNullable<DesktopActivityOverlayUiModel['expanded']['cards']>[number], { kind: 'user_question' }>> = {},
    ): Extract<NonNullable<DesktopActivityOverlayUiModel['expanded']['cards']>[number], { kind: 'user_question' }> {
        return {
            id: 'question-1',
            kind: 'user_question',
            requestId: 'question-1',
            sessionId: 'session-1',
            title: 'Which deployment target?',
            summary: 'Choose where the agent should deploy.',
            toolLabel: 'Claude asks',
            questionText: 'Which deployment target?',
            count: 1,
            openActionIdentifier: 'open-session:session-1',
            actions: [
                {
                    id: 'production',
                    label: 'Production',
                    actionIdentifier: 'answer-user-question',
                    data: { requestId: 'question-1', sessionId: 'session-1', answers: ['production'] },
                    tone: 'primary',
                },
            ],
            ...overrides,
        };
    }

    function createModel(overrides: Partial<DesktopActivityOverlayUiModel> = {}): DesktopActivityOverlayUiModel {
        return {
            visible: true,
            isExpanded: true,
            generatedAt: 1,
            collapsed: createCollapsedModel(),
            expanded: {
                title: 'Sessions',
                rows: [
                    {
                        sessionId: 'session-1',
                        title: 'Primary session',
                        subtitle: 'Agent on machine',
                        statusText: 'Needs attention',
                        previewText: 'Need your approval',
                    },
                ],
                cards: [createSessionOverviewCard()],
            },
            window: {
                collapsed: { width: 340, height: 72 },
                expanded: { width: 420, height: 220 },
            },
            ...overrides,
        };
    }

    it('renders preview text in expanded desktop overlay rows when enabled', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel()}
                onCollapse={() => {}}
                onOpenSession={() => {}}
                onOpenInbox={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('Need your approval');
    });

    it('renders the notch-integrated chrome surface when the visual mode is notch integrated', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="notch_integrated"
                model={createModel()}
                onCollapse={() => {}}
                onOpenSession={() => {}}
                onOpenInbox={() => {}}
            />,
        );

        expect(screen.findByTestId('desktop-activity-overlay-expanded-notch')).toBeTruthy();
        expect(screen.findByTestId('desktop-activity-overlay-expanded-action-open-inbox')).toBeNull();
        expect(screen.findByTestId('desktop-activity-overlay-expanded-action-collapse')).toBeNull();
        expect(screen.getTextContent()).not.toContain('Sessions');
        expect(screen.getTextContent()).not.toContain('common.close');
        expect(screen.getTextContent()).not.toContain('common.open tabs.inbox');
    });

    it('renders passive session overview as a compact island row without a management Open button', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="notch_integrated"
                model={createModel()}
                onCollapse={() => {}}
                onOpenSession={() => {}}
                onOpenInbox={() => {}}
            />,
        );

        expect(screen.findByTestId(resolveDesktopActivityOverlayCardKindTestID('session_overview'))).toBeTruthy();
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('session-1', 'open'))).toBeNull();
        expect(screen.getTextContent()).not.toContain('Open');
    });

    it('renders an explicit idle card instead of falling back to quiet session-row content', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel({
                    collapsed: createCollapsedModel({
                        title: 'No active sessions',
                        statusText: null,
                        defaultTarget: 'open-inbox',
                        sessionCount: null,
                        primaryCardKind: 'idle_state',
                    }),
                    expanded: {
                        title: 'Sessions',
                        rows: [],
                        cards: [
                            {
                                id: 'idle',
                                kind: 'idle_state',
                                title: 'No active sessions',
                            },
                        ],
                    },
                })}
                onCollapse={() => {}}
                onOpenSession={() => {}}
                onOpenInbox={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('No active sessions');
        expect(screen.getTextContent()).toContain('will wake up when new activity arrives');
        expect(screen.findByTestId('desktop-activity-overlay-card-idle-idle')).toBeTruthy();
    });

    it('renders direct permission card actions from the model and routes them through the card action handler', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const onAction = vi.fn();

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel({
                    collapsed: createCollapsedModel({
                        title: 'Permission required',
                        statusText: '1 request',
                        defaultTarget: 'open-session:session-1',
                        sessionCount: 1,
                        primaryCardKind: 'permission_request',
                    }),
                    expanded: {
                        title: 'Actions',
                        rows: [],
                        cards: [createPermissionRequestCard()],
                    },
                })}
                onCollapse={() => {}}
                onOpenSession={() => {}}
                onOpenInbox={() => {}}
                onAction={onAction}
            />,
        );

        expect(screen.getTextContent()).toContain('Edit src/auth/middleware.ts');
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardKindTestID('permission_request'))).toBeTruthy();
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardInstanceTestID(createPermissionRequestCard()))).toBeTruthy();
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('permission-1', 'open'))).toBeNull();

        screen.pressByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('permission-1', 'allow'));

        expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
            actionIdentifier: 'approve-permission',
            data: { requestId: 'permission-1', sessionId: 'session-1', decision: 'allow' },
        }));
    });

    it('renders direct user-question choices from the card model', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const onAction = vi.fn();

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel({
                    collapsed: createCollapsedModel({
                        title: 'Claude asks',
                        statusText: 'Choose an answer',
                        defaultTarget: 'open-session:session-1',
                        sessionCount: 1,
                        primaryCardKind: 'user_question',
                    }),
                    expanded: {
                        title: 'Actions',
                        rows: [],
                        cards: [createUserQuestionCard()],
                    },
                })}
                onCollapse={() => {}}
                onOpenSession={() => {}}
                onOpenInbox={() => {}}
                onAction={onAction}
            />,
        );

        expect(screen.getTextContent()).toContain('Which deployment target?');
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardKindTestID('user_question'))).toBeTruthy();

        screen.pressByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('question-1', 'production'));

        expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
            actionIdentifier: 'answer-user-question',
            data: { requestId: 'question-1', sessionId: 'session-1', answers: ['production'] },
        }));
    });
});
