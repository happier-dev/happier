import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { invokeTestInstanceHandler, renderScreen } from '@/dev/testkit';
import { activityInstanceKey } from '@/sync/domains/session/sessionAddress';

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

// The Agent mark reads the machine-scoped Agent catalog (plugins, sync scope); this render test only needs
// its presence, so it draws a named leaf instead of loading that graph.
vi.mock('@/components/sessions/presentation/SessionAgentCatalogIdentityIcon', () => ({
    SessionAgentCatalogIdentityIcon: (props: Record<string, unknown>) => React.createElement('SessionAgentCatalogIdentityIcon', props),
}));

// Bot faces draw through Skia (a native graphics boundary): the canonical testkit mock, as the route tests use.
vi.mock('@shopify/react-native-skia', async () => (await import('@/dev/testkit/mocks/reactNativeSkia')).createReactNativeSkiaMock());
vi.mock('@/components/sessions/bots/face/BotFaceRasterView', async () => import('@/components/sessions/bots/face/BotFaceRasterView.web'));

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
    // The panel's first import transforms its whole graph (cards, Bot rows, menus) once; later imports reuse it.
    beforeAll(async () => { await import('./DesktopActivityOverlayExpanded'); }, 240_000);

    function createCollapsedModel(overrides: Partial<DesktopActivityOverlayUiModel['collapsed']> = {}): DesktopActivityOverlayUiModel['collapsed'] {
        return {
            title: 'Primary session',
            statusText: 'Needs attention',
            defaultTarget: 'open-primary-session',
            activity: 'needsYou',
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
        const card: PermissionRequestCard = {
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
        return {
            ...card,
            id: overrides.id ?? activityInstanceKey(
                { serverId: card.serverId, sessionId: card.sessionId },
                JSON.stringify(['permission_request', card.requestId]),
            ),
        };
    }

    function createUserQuestionCard(overrides: Partial<UserQuestionCard> = {}): UserQuestionCard {
        const card: UserQuestionCard = {
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
        return {
            ...card,
            id: overrides.id ?? activityInstanceKey(
                { serverId: card.serverId, sessionId: card.sessionId },
                JSON.stringify(['user_question', card.requestId]),
            ),
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
            generatedAt: 1,
            faces: { faces: [], overflowCount: 0 },
            conversation: null,
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
                        activity: 'needsYou',
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
                            activity: 'needsYou',
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
                        activity: 'needsYou',
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
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID(createPermissionRequestCard().id, 'open'))).toBeNull();
        const allowAction = screen.findByTestId(
            resolveDesktopActivityOverlayCardActionInstanceTestID(createPermissionRequestCard().id, 'allow'),
        );
        // The shared button owns its role; the island names the decision.
        expect(allowAction?.props.accessibilityLabel).toBe('Allow');

        screen.pressByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID(createPermissionRequestCard().id, 'allow'));

        expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
            actionIdentifier: 'approve-permission',
            data: { requestId: 'permission-1', sessionId: 'session-1', serverId: 'server-1', decision: 'allow' },
        }));
    });

    it('renders the Session permission choices regardless of risk and opens through the asker header', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const onOpenSession = vi.fn();

        // Desktop notch owner rulings 13–14: the asker header opens the Session; its owner decides every choice.
        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel({
                    expanded: {
                        title: 'Actions',
                        rows: [{ sessionId: 'session-1', serverId: 'server-1', title: 'Session One',
                            subtitle: null, statusText: null, previewText: null }],
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
                                        id: 'allow',
                                        label: 'Allow',
                                        actionIdentifier: 'approve-permission',
                                        data: { requestId: 'permission-high', sessionId: 'session-1', serverId: 'server-1', decision: 'allow' },
                                        tone: 'primary',
                                    },
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
                onOpenSession={onOpenSession}
            />,
        );

        expect(screen.getTextContent()).toContain('Always allow Read');
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID(
            createPermissionRequestCard({ requestId: 'permission-low' }).id,
            'always_allow',
        ))).toBeTruthy();
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID(
            createPermissionRequestCard({ requestId: 'permission-high' }).id,
            'allow',
        ))).toBeTruthy();
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID(
            createPermissionRequestCard({ requestId: 'permission-high' }).id,
            'deny',
        ))).toBeTruthy();
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID(
            createPermissionRequestCard({ requestId: 'permission-high' }).id,
            'open',
        ))).toBeNull();
        screen.pressByTestId('desktop-activity-overlay-session-row-session-1');
        expect(onOpenSession).toHaveBeenCalledExactlyOnceWith('session-1', 'server-1');
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
                        activity: 'needsYou',
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

        screen.pressByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID(createUserQuestionCard().id, 'production'));

        expect(onAction).toHaveBeenCalledWith(expect.objectContaining({
            actionIdentifier: 'answer-user-question',
            data: { requestId: 'question-1', sessionId: 'session-1', serverId: 'server-1', answers: ['production'] },
        }));
    });

    it('offers Other as a choice that opens its own answer field', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const onAction = vi.fn();
        const questionCard = createUserQuestionCard({
            actions: [
                {
                    id: 'option-1-production',
                    label: 'Production',
                    actionIdentifier: 'answer-user-question',
                    data: { requestId: 'question-1', sessionId: 'session-1', serverId: 'server-1', answers: ['production'] },
                    tone: 'secondary',
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
        });

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel({
                    expanded: {
                        title: 'Actions',
                        rows: [],
                        cards: [questionCard],
                    },
                })}
                onOpenSession={() => {}}
                onAction={onAction}
            />,
        );
        const otherInput = `desktop-activity-overlay-question-other-input-${questionCard.id}`;

        expect(screen.getTextContent()).toContain('Production');
        // The free answer waits behind its choice: no empty field under every question.
        expect(screen.findByTestId(otherInput)).toBeNull();

        await act(async () => {
            screen.pressByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID(questionCard.id, 'other'));
        });
        expect(screen.findByTestId(otherInput)).toBeTruthy();
        expect(onAction).not.toHaveBeenCalled();

        await act(async () => {
            screen.changeTextByTestId(otherInput, 'Canary');
        });
        await act(async () => {
            screen.pressByTestId(`desktop-activity-overlay-question-other-send-${questionCard.id}`);
        });

        expect(onAction).toHaveBeenCalledTimes(1);
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

    it('heads each ask with its Session and lists the other Sessions after it, once each', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const asking = {
            sessionId: 'session-2',
            serverId: 'server-1',
            title: 'Fix the token refresh race',
            subtitle: null,
            statusText: 'Needs you',
            previewText: null,
            tone: 'attention' as const,
            agentId: 'claude',
            machineId: null,
        };
        const working = { ...asking, sessionId: 'session-3', title: 'Speed up the Session list', statusText: 'Working', tone: 'neutral' as const };
        const questionCard = createUserQuestionCard({ sessionId: 'session-2', session: asking });

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="notch_integrated"
                model={createModel({
                    expanded: {
                        title: 'Sessions',
                        rows: [asking, working],
                        cards: [questionCard],
                    },
                })}
                onOpenSession={() => {}}
            />,
        );

        expect(screen.findAllHostsByTestId('desktop-activity-overlay-session-row-session-2')).toHaveLength(1);
        expect(screen.findAllHostsByTestId('desktop-activity-overlay-session-row-session-3')).toHaveLength(1);
        const text = screen.getTextContent();
        expect(text.indexOf('Fix the token refresh race')).toBeGreaterThanOrEqual(0);
        expect(text.indexOf('Fix the token refresh race')).toBeLessThan(text.indexOf('Which deployment target?'));
        expect(text.indexOf('Which deployment target?')).toBeLessThan(text.indexOf('Speed up the Session list'));
    });

    it('keeps who is asking in view: one header per Session, its context line rather than its preview, and the count of its asks', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const asking = {
            sessionId: 'session-2',
            serverId: 'server-1',
            title: 'Review and steward PR #828',
            subtitle: 'happier · devbox',
            statusText: 'Needs you',
            previewText: 'Looking at the review comments',
            tone: 'attention' as const,
            agentId: 'codex',
            machineId: null,
        };
        const permission = createPermissionRequestCard({ requestId: 'bash-1', sessionId: 'session-2', session: asking });
        const question = createUserQuestionCard({ sessionId: 'session-2', session: asking });

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="notch_integrated"
                model={createModel({ expanded: { title: 'Sessions', rows: [asking], cards: [permission, question] } })}
                onOpenSession={() => {}}
            />,
        );

        expect(screen.findAllHostsByTestId('desktop-activity-overlay-session-row-session-2')).toHaveLength(1);
        const text = screen.getTextContent();
        expect(text).toContain('happier · devbox');
        expect(text).not.toContain('Looking at the review comments');
        expect(screen.findByTestId('desktop-activity-overlay-session-row-session-2-ask-count')).toBeTruthy();
    });

    it('heads a Bot that asks with where it runs instead of its activity line, and no count for a single ask', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const face = {
            serverId: 'server-1',
            sessionId: 'session-4',
            face: { seed: 'session-4', face: null },
            name: 'Flake hunter',
            activity: 'needsYou' as const,
            currentLine: 'Wants to edit .github/quarantine.json',
            meaningfulActivityAt: 0,
            live: true,
            agentId: 'claude',
            machineId: null,
        };
        const row = {
            sessionId: 'session-4',
            serverId: 'server-1',
            title: 'Flake hunter',
            subtitle: 'happier · devbox',
            statusText: 'Needs you',
            previewText: null,
        };

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="notch_integrated"
                model={createModel({ expanded: { title: 'Sessions', rows: [row], cards: [createPermissionRequestCard({ sessionId: 'session-4' })] } })}
                bots={{ faces: [face], handlers: { onOpen: () => {}, onOpenIn: () => {} } }}
                onOpenSession={() => {}}
            />,
        );

        const text = screen.getTextContent();
        expect(text).toContain('happier · devbox');
        expect(text).not.toContain('Wants to edit .github/quarantine.json');
        expect(screen.findByTestId('desktop-activity-overlay-bot-row-session-4-ask-count')).toBeNull();
    });

    it('answers a decision in place: the chosen action replaces the buttons until the ask leaves', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const card = createPermissionRequestCard();
        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="notch_integrated"
                model={createModel({ expanded: { title: 'Actions', rows: [], cards: [card] } })}
                onOpenSession={() => {}}
                onAction={() => true}
            />,
        );

        await act(async () => {
            screen.pressByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID(card.id, 'allow'));
        });

        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID(card.id, 'allow'))).toBeNull();
        expect(screen.findByTestId(resolveDesktopActivityOverlayCardActionInstanceTestID(card.id, 'deny'))).toBeNull();
        expect(screen.findByTestId(`desktop-activity-overlay-card-answered-${card.id}`)).toBeTruthy();
        expect(screen.getTextContent()).toContain('Allow');
    });

    it('keeps the reply out of the open list: it lives in the pinned conversation', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="notch_integrated"
                model={createModel()}
                onOpenSession={() => {}}
            />,
        );

        expect(screen.findByTestId('desktop-activity-overlay-quick-reply-input')).toBeNull();
    });

    it('stops counting a status header once the panel no longer has one (a dock change from a side to the top)', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const onNaturalHeight = vi.fn();
        const element = (header: React.ReactNode) => (
            <DesktopActivityOverlayExpanded
                visualMode="notch_integrated"
                model={createModel()}
                header={header}
                onNaturalHeight={onNaturalHeight}
                onOpenSession={() => {}}
            />
        );
        const screen = await renderScreen(element(React.createElement('Text', null, 'Needs you')));
        const scroll = () => screen.findByTestId('desktop-activity-overlay-expanded-scroll');
        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-activity-overlay-expanded-header'), 'onLayout', { nativeEvent: { layout: { x: 0, y: 0, width: 440, height: 28 } } });
            (scroll()!.props.onContentSizeChange as (width: number, height: number) => void)(440, 200);
        });
        const withHeader = onNaturalHeight.mock.calls.at(-1)?.[0] as number;

        await screen.update(element(undefined));
        await act(async () => {
            (scroll()!.props.onContentSizeChange as (width: number, height: number) => void)(440, 200);
        });
        const withoutHeader = onNaturalHeight.mock.calls.at(-1)?.[0] as number;

        expect(withHeader - withoutHeader).toBeGreaterThanOrEqual(28);
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
                            activity: 'needsYou',
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

    it('falls back to the Session list instead of an empty panel once the last completion leaves', async () => {
        vi.useFakeTimers();
        const { act } = await import('react-test-renderer');
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel({
                    expanded: {
                        title: 'Sessions',
                        rows: [{
                            sessionId: 'session-1',
                            serverId: 'server-1',
                            title: 'Fix checkout flow',
                            subtitle: 'happier/app',
                            statusText: 'Finished',
                            previewText: null,
                        }],
                        cards: [createCompletionStateCard({ autoDismissMs: 15000, sticky: false })],
                    },
                })}
                onOpenSession={() => {}}
            />,
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(15000);
        });

        expect(screen.findByTestId('desktop-activity-overlay-completion-turn')).toBeNull();
        expect(screen.findByTestId('desktop-activity-overlay-session-row-session-1')).toBeTruthy();
        expect(screen.getTextContent()).toContain('Fix checkout flow');
    });

    it('does not hide a different qualified completion when one completion is dismissed', async () => {
        vi.useFakeTimers();
        const { act } = await import('react-test-renderer');
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const homeACard = createCompletionStateCard({
            id: activityInstanceKey({ serverId: 'server-a', sessionId: 'shared-session' }, 'completion'),
            sessionId: 'shared-session',
            serverId: 'server-a',
            title: 'Home A complete',
            autoDismissMs: 1,
        });
        const homeBCard = createCompletionStateCard({
            id: activityInstanceKey({ serverId: 'server-b', sessionId: 'shared-session' }, 'completion'),
            sessionId: 'shared-session',
            serverId: 'server-b',
            title: 'Home B complete',
            autoDismissMs: 0,
            sticky: true,
        });
        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel({
                    expanded: {
                        title: 'Actions',
                        rows: [],
                        cards: [homeACard, homeBCard],
                    },
                })}
                onOpenSession={() => {}}
            />,
        );

        await act(async () => {
            await vi.advanceTimersByTimeAsync(1);
        });

        expect(screen.getTextContent()).not.toContain('Home A complete');
        expect(screen.getTextContent()).toContain('Home B complete');
    });

    it('keeps the hover-only expanded shell out of the keyboard focus order', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const onHoverIn = vi.fn();
        const onHoverOut = vi.fn();

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel()}
                onOpenSession={() => {}}
                onHoverIn={onHoverIn}
                onHoverOut={onHoverOut}
            />,
        );
        const shell = screen.findByTestId('desktop-activity-overlay-expanded');

        // react-native-web renders `Pressable` with `tabindex="0"`, so a hover-only shell built on
        // one becomes a keyboard focus stop that performs nothing. The shell must stay a plain view.
        expect(shell?.type).toBe('View');
        expect(shell?.props.onPress).toBeUndefined();
        expect(shell?.props.accessibilityRole).toBeUndefined();
        expect(shell?.props.role).toBeUndefined();
        expect(shell?.props.focusable).toBeUndefined();

        await act(async () => {
            invokeTestInstanceHandler(shell, 'onPointerEnter', {});
        });
        await act(async () => {
            invokeTestInstanceHandler(
                screen.findByTestId('desktop-activity-overlay-expanded'),
                'onPointerLeave',
                {},
            );
        });

        expect(onHoverIn).toHaveBeenCalledTimes(1);
        expect(onHoverOut).toHaveBeenCalledTimes(1);
    });

    it('exposes actionable session rows as buttons named from the projected session display', async () => {
        const { DesktopActivityOverlayExpanded } = await import('./DesktopActivityOverlayExpanded');
        const onOpenSession = vi.fn();

        const screen = await renderScreen(
            <DesktopActivityOverlayExpanded
                visualMode="floating_overlay"
                model={createModel({
                    expanded: {
                        title: 'Sessions',
                        rows: [],
                        cards: [createSessionOverviewCard()],
                    },
                })}
                onOpenSession={onOpenSession}
            />,
        );
        const row = screen.findByTestId('desktop-activity-overlay-session-row-session-1');

        expect(row?.props.accessibilityRole).toBe('button');
        expect(row?.props.accessibilityLabel).toBe('Primary session. Agent on machine. Needs attention');
        // The preview repeats agent/session content; it stays visible but must not enter the name.
        expect(String(row?.props.accessibilityLabel)).not.toContain('Need your approval');

        screen.pressByTestId('desktop-activity-overlay-session-row-session-1');

        expect(onOpenSession).toHaveBeenCalledWith('session-1', 'server-1');
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

        expect(screen.findByTestId('desktop-activity-overlay-expanded')?.props.onPress).toBeUndefined();

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-activity-overlay-expanded'), 'onPointerEnter', {});
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(15000);
        });

        expect(screen.findByTestId('desktop-activity-overlay-completion-turn')).toBeTruthy();

        await act(async () => {
            invokeTestInstanceHandler(screen.findByTestId('desktop-activity-overlay-expanded'), 'onPointerLeave', {});
        });

        await act(async () => {
            await vi.advanceTimersByTimeAsync(15000);
        });

        expect(screen.findByTestId('desktop-activity-overlay-completion-turn')).toBeNull();
    });
});
