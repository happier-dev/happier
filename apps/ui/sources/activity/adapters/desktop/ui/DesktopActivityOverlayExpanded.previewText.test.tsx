import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';

import type { DesktopActivityOverlayUiModel } from './shared/desktopActivityOverlayUiModel';
import {
    resolveDesktopActivityOverlayCardActionInstanceTestID,
    resolveDesktopActivityOverlayCardInstanceTestID,
    resolveDesktopActivityOverlayCardKindTestID,
} from './shared/desktopActivityOverlaySelectors.mjs';

type ExpandedCard = NonNullable<DesktopActivityOverlayUiModel['expanded']['cards']>[number];
type SessionOverviewCard = Extract<ExpandedCard, { kind: 'session_overview' }>;
type PermissionRequestCard = Extract<ExpandedCard, { kind: 'permission_request' }>;
type UserQuestionCard = Extract<ExpandedCard, { kind: 'user_question' }>;
type CompletionStateCard = Extract<ExpandedCard, { kind: 'completion_state' }>;
const reactDeferredValueMockState = vi.hoisted(() => ({
    override: null as null | ((value: unknown) => unknown),
}));

vi.mock('react', async (importActual) => {
    const actual = await importActual<typeof import('react')>();
    return {
        ...actual,
        useDeferredValue: <Value,>(value: Value): Value => (
            reactDeferredValueMockState.override
                ? reactDeferredValueMockState.override(value) as Value
                : actual.useDeferredValue(value)
        ),
    };
});

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
    TextInput: (props: React.PropsWithChildren<Record<string, unknown>>) => React.createElement('TextInput', props, props.children),
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

    function createSessionOverviewCard(overrides: Partial<SessionOverviewCard> = {}): SessionOverviewCard {
        return {
            id: 'session-overview-1',
            kind: 'session_overview',
            sessionId: 'session-1',
            serverId: 'server-1',
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

    function createPermissionRequestCard(overrides: Partial<PermissionRequestCard> = {}): PermissionRequestCard {
        return {
            id: 'permission-1',
            kind: 'permission_request',
            requestId: 'permission-1',
            sessionId: 'session-1',
            serverId: 'server-1',
            title: 'Edit src/auth/middleware.ts',
            summary: 'The agent needs approval before editing this file.',
            toolLabel: 'Claude asks',
            questionText: null,
            count: 1,
            openActionIdentifier: 'open-session:session-1',
            allowActionIdentifier: 'approve-permission',
            denyActionIdentifier: 'deny-permission',
            risk: 'low',
            actions: [
                {
                    id: 'deny',
                    label: 'Deny',
                    actionIdentifier: 'deny-permission',
                    data: { requestId: 'permission-1', sessionId: 'session-1', serverId: 'server-1', decision: 'deny' },
                    tone: 'danger',
                },
                {
                    id: 'allow',
                    label: 'Allow',
                    actionIdentifier: 'approve-permission',
                    data: { requestId: 'permission-1', sessionId: 'session-1', serverId: 'server-1', decision: 'allow' },
                    tone: 'primary',
                },
                {
                    id: 'open',
                    label: 'Open',
                    actionIdentifier: 'open-session:session-1',
                    data: { requestId: 'permission-1', sessionId: 'session-1', serverId: 'server-1' },
                    tone: 'secondary',
                },
            ],
            ...overrides,
        };
    }

    function createUserQuestionCard(overrides: Partial<UserQuestionCard> = {}): UserQuestionCard {
        return {
            id: 'question-1',
            kind: 'user_question',
            requestId: 'question-1',
            sessionId: 'session-1',
            serverId: 'server-1',
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
                    data: { requestId: 'question-1', sessionId: 'session-1', serverId: 'server-1', answers: ['production'] },
                    tone: 'primary',
                },
            ],
            ...overrides,
        };
    }

    function createCompletionStateCard(overrides: Partial<CompletionStateCard> = {}): CompletionStateCard {
        return {
            id: 'completion:session-1',
            kind: 'completion_state',
            sessionId: 'session-1',
            serverId: 'server-1',
            title: 'Turn complete',
            summary: 'Review the final answer in the session.',
            openActionIdentifier: 'open-session:session-1',
            variant: 'turn_complete',
            autoDismissMs: 15000,
            sticky: false,
            actions: [
                {
                    id: 'open:session-1',
                    label: 'Open',
                    actionIdentifier: 'open-session:session-1',
                    data: { sessionId: 'session-1', serverId: 'server-1' },
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
                        serverId: 'server-1',
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
                onOpenSession={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('Need your approval');
    });

    it('uses a transparent scroll mask when expanded overlay content overflows', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel()}
                onOpenSession={() => {}}
            />,
        );
        const scroll = screen.findByTestId('desktop-activity-overlay-expanded-scroll');

        await act(async () => {
            invokeTestInstanceHandler(scroll, 'onLayout', {
                nativeEvent: { layout: { width: 420, height: 100 } },
            });
            scroll?.props.onContentSizeChange(420, 240);
        });

        expect(String(JSON.stringify(screen.findByTestId('desktop-activity-overlay-expanded-scroll')?.props.style)))
            .toContain('transparent 100%');
    });

    it('renders the notch-integrated chrome surface when the visual mode is notch integrated', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="notch_integrated"
                model={createModel()}
                onOpenSession={() => {}}
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
                onOpenSession={() => {}}
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
                onOpenSession={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('No active sessions');
        expect(screen.getTextContent()).toContain('will wake up when new activity arrives');
        expect(screen.findByTestId('desktop-activity-overlay-card-idle-idle')).toBeTruthy();
    });

    it('renders the current overlay card set without deferring to stale cards', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const staleCards: DesktopActivityOverlayUiModel['expanded']['cards'] = [
            createSessionOverviewCard({
                id: 'stale-session-card',
                sessionId: 'stale-session',
                title: 'Stale session row',
            }),
        ];
        reactDeferredValueMockState.override = (value) => (
            Array.isArray(value) ? staleCards : value
        );

        try {
            const screen = await renderScreen(
                <DesktopActivityOverlayExpanded
                    visualMode="notch_integrated"
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
                    onOpenSession={() => {}}
                />,
            );

            expect(screen.findByTestId(resolveDesktopActivityOverlayCardKindTestID('idle_state'))).toBeTruthy();
            expect(screen.getTextContent()).toContain('No active sessions');
            expect(screen.getTextContent()).not.toContain('Stale session row');
        } finally {
            reactDeferredValueMockState.override = null;
        }
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
                onOpenSession={() => {}}
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
            data: { requestId: 'permission-1', sessionId: 'session-1', serverId: 'server-1', decision: 'allow' },
        }));
    });

    it('renders low-risk always-allow permission actions and high-risk review-only actions', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel({
                    expanded: {
                        title: 'Actions',
                        rows: [],
                        cards: [
                            createPermissionRequestCard({
                                requestId: 'permission-low',
                                risk: 'low',
                                toolLabel: 'Read',
                                actions: [
                                    {
                                        id: 'always_allow',
                                        label: 'Always allow Read',
                                        actionIdentifier: 'approve-permission',
                                        data: { requestId: 'permission-low', sessionId: 'session-1', serverId: 'server-1', decision: 'allow', persistence: 'always' },
                                        tone: 'secondary',
                                    },
                                ],
                            }),
                            createPermissionRequestCard({
                                requestId: 'permission-high',
                                risk: 'high',
                                toolLabel: 'Bash',
                                actions: [
                                    {
                                        id: 'deny',
                                        label: 'Deny',
                                        actionIdentifier: 'deny-permission',
                                        data: { requestId: 'permission-high', sessionId: 'session-1', serverId: 'server-1', decision: 'deny' },
                                        tone: 'danger',
                                    },
                                    {
                                        id: 'open',
                                        label: 'Open',
                                        actionIdentifier: 'open-session:session-1',
                                        data: { requestId: 'permission-high', sessionId: 'session-1', serverId: 'server-1' },
                                        tone: 'primary',
                                    },
                                ],
                            }),
                        ],
                    },
                })}
                onOpenSession={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('Always allow Read');
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('permission-low', 'always_allow'))).toBeTruthy();
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('permission-high', 'allow'))).toBeNull();
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('permission-high', 'open'))).toBeTruthy();
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
                onOpenSession={() => {}}
                onAction={onAction}
            />,
        );

        expect(screen.getTextContent()).toContain('Which deployment target?');
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardKindTestID('user_question'))).toBeTruthy();

        screen.pressByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('question-1', 'production'));

        expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
            actionIdentifier: 'answer-user-question',
            data: { requestId: 'question-1', sessionId: 'session-1', serverId: 'server-1', answers: ['production'] },
        }));
    });

    it('renders numbered user-question chips with inline other input', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const onAction = vi.fn();

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel({
                    expanded: {
                        title: 'Actions',
                        rows: [],
                        cards: [createUserQuestionCard({
                            actions: [
                                {
                                    id: 'option-1-production',
                                    label: '1. Production',
                                    actionIdentifier: 'answer-user-question',
                                    data: { requestId: 'question-1', sessionId: 'session-1', serverId: 'server-1', answers: ['production'] },
                                    tone: 'primary',
                                },
                                {
                                    id: 'other',
                                    label: 'Other',
                                    actionIdentifier: 'session.user_action.answer',
                                    data: { requestId: 'question-1', sessionId: 'session-1', serverId: 'server-1' },
                                    tone: 'secondary',
                                    inputKind: 'inline_text',
                                },
                            ],
                        })],
                    },
                })}
                onOpenSession={() => {}}
                onAction={onAction}
            />,
        );

        expect(screen.getTextContent()).toContain('1. Production');
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('question-1', 'other'))).toBeTruthy();
        expect(screen.findByTestId('desktop-activity-overlay-question-other-input-question-1')).toBeTruthy();

        await act(async () => {
            screen.changeTextByTestId('desktop-activity-overlay-question-other-input-question-1', 'Canary');
        });
        screen.pressByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('question-1', 'other'));

        expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
            actionIdentifier: 'session.user_action.answer',
            data: expect.objectContaining({
                requestId: 'question-1',
                sessionId: 'session-1',
                serverId: 'server-1',
                answers: [{ question: 'Which deployment target?', answer: 'Canary' }],
            }),
        }));
    });

    it('renders completion-state card content without unsupported-kind crash', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const completionCard = createCompletionStateCard();
        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        await expect((async () => {
            screen = await renderScreen(
                <DesktopActivityOverlayExpanded
                    visualMode="floating_overlay"
                    model={createModel({
                        collapsed: createCollapsedModel({
                            title: 'Turn complete',
                            statusText: 'Ready to review',
                            defaultTarget: 'open-session:session-1',
                            sessionCount: 1,
                            primaryCardKind: 'completion_state',
                        }),
                        expanded: {
                            title: 'Actions',
                            rows: [],
                            cards: [completionCard],
                        },
                    })}
                    onOpenSession={() => {}}
                />,
            );
        })()).resolves.toBeUndefined();
        expect(screen.getTextContent()).toContain('Turn complete');
        expect(screen.getTextContent()).toContain('Review the final answer in the session.');
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardKindTestID('completion_state'))).toBeTruthy();
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardInstanceTestID(completionCard))).toBeTruthy();
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID('session-1', 'open'))).toBeTruthy();
    });

    it('auto-dismisses non-sticky completion variants while keeping sticky variants', async () => {
        vi.useFakeTimers();
        const { act } = await import('react-test-renderer');
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel({
                    expanded: {
                        title: 'Actions',
                        rows: [],
                        cards: [
                            createCompletionStateCard({
                                id: 'completion:turn',
                                sessionId: 'turn',
                                variant: 'turn_complete',
                                autoDismissMs: 15000,
                                sticky: false,
                            }),
                            createCompletionStateCard({
                                id: 'completion:subagent',
                                sessionId: 'subagent',
                                variant: 'subagent_done',
                                autoDismissMs: 0,
                                sticky: true,
                            }),
                            createCompletionStateCard({
                                id: 'completion:tool',
                                sessionId: 'tool',
                                variant: 'pending_tool',
                                autoDismissMs: 0,
                                sticky: true,
                            }),
                        ],
                    },
                })}
                onOpenSession={() => {}}
            />,
        );

        expect(screen.findByTestId('desktop-activity-overlay-completion-turn')?.props['data-auto-dismiss-ms']).toBe(15000);
        expect(screen.findByTestId('desktop-activity-overlay-completion-subagent')?.props['data-sticky']).toBe(true);
        expect(screen.findByTestId('desktop-activity-overlay-completion-tool')?.props['data-variant']).toBe('pending_tool');

        await act(async () => {
            await vi.advanceTimersByTimeAsync(15000);
        });

        expect(screen.findByTestId('desktop-activity-overlay-completion-turn')).toBeNull();
        expect(screen.findByTestId('desktop-activity-overlay-completion-subagent')).toBeTruthy();
        expect(screen.findByTestId('desktop-activity-overlay-completion-tool')).toBeTruthy();
    });

    it('pauses completion auto-dismiss while the expanded island is hovered', async () => {
        vi.useFakeTimers();
        const { act } = await import('react-test-renderer');
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel({
                    expanded: {
                        title: 'Actions',
                        rows: [],
                        cards: [createCompletionStateCard()],
                    },
                })}
                onOpenSession={() => {}}
                onHoverIn={() => {}}
                onHoverOut={() => {}}
            />,
        );

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-activity-overlay-expanded'), 'onHoverIn', {});
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(15000);
        });

        expect(screen.findByTestId('desktop-activity-overlay-completion-turn')).toBeTruthy();

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-activity-overlay-expanded'), 'onHoverOut', {});
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(15000);
        });

        expect(screen.findByTestId('desktop-activity-overlay-completion-turn')).toBeNull();
    });
});
