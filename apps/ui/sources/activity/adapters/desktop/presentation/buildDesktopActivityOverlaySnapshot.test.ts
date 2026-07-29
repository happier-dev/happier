import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { resolveActivitySurfacePolicy } from '@/activity/attention/resolveActivitySurfacePolicy';
import { buildDesktopActivityOverlayModel } from '@/activity/adapters/desktop/presentation/buildDesktopActivityOverlayModel';
import type { DesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { ConnectedServiceQuotaSummary } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSummaries';

import { buildDesktopActivityOverlaySnapshot } from './buildDesktopActivityOverlaySnapshot';
import type { DesktopActivityOverlaySource } from '../runtime/useDesktopActivityOverlaySource';

function createDesktopPolicy(overrides: Partial<DesktopOverlayPolicy> = {}): DesktopOverlayPolicy {
    return {
        enabled: true,
        visibilityMode: 'attention_only',
        showWhenRunning: true,
        showWhenAttentionRequired: true,
        showWhenReady: true,
        alwaysOnTop: true,
        autoHideEnabled: true,
        autoHideDelayMs: 6000,
        hoverExpandDelayMs: 500,
        expandedBehavior: 'click',
        interactiveCollapsed: true,
        presentationMode: 'automatic',
        clickAction: 'expand_overlay',
        density: 'compact',
        compactStyle: 'pill',
        showSessionCount: true,
        showPreviewText: false,
        quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
        placementMode: 'anchored',
        anchor: 'top_center',
        offsetX: 0,
        offsetY: 0,
        enableDragReposition: false,
        lockPosition: true,
        ...overrides,
    };
}

function createOverlaySource(params: Readonly<{
    sessions: ReadonlyArray<ReturnType<typeof createSessionFixture>>;
    quotaSummaries?: ReadonlyArray<ConnectedServiceQuotaSummary>;
}>): DesktopActivityOverlaySource {
    return {
        isDataReady: true,
        sessionsById: Object.fromEntries(params.sessions.map((session) => [session.id, session])),
        sessionListRenderablesById: Object.fromEntries(
            params.sessions.map((session) => [session.id, buildSessionListRenderableFromSession(session)]),
        ),
        sessionListIndexByServerId: {
            'server-1': params.sessions.map((session) => ({
                type: 'session' as const,
                sessionId: session.id,
                serverId: 'server-1',
            })),
        },
        concurrentSessionListCacheByServerId: {},
        quotaSummaries: params.quotaSummaries ?? [],
    };
}

describe('buildDesktopActivityOverlaySnapshot', () => {
    it('keeps the activity snapshot focused on the selected desktop activity session', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                    createSessionFixture({
                        id: 'permission-without-companion-policy',
                        active: true,
                        presence: 'online',
                        pendingPermissionRequestCount: 1,
                    }),
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 1_000,
        });

        expect(snapshot.primary?.sessionId).toBe('permission-without-companion-policy');
        expect(snapshot.state).toBe('content');
    });

    it('keeps active-session overlays focused on active sessions even when auto-show triggers are disabled', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                createSessionFixture({
                    id: 'permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Permission work', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'thinking',
                    seq: 2,
                    lastViewedSessionSeq: 2,
                    active: true,
                    presence: 'online',
                    thinking: true,
                    thinkingAt: 950,
                    metadata: {
                        path: '/Users/tester/project/thinking',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Thinking work', updatedAt: 2 },
                    },
                }),
                createSessionFixture({
                    id: 'quiet-active',
                    seq: 3,
                    lastViewedSessionSeq: 3,
                    active: true,
                    presence: 'online',
                    metadata: {
                        path: '/Users/tester/project/quiet-active',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Quiet active work', updatedAt: 1 },
                    },
                }),
                createSessionFixture({
                    id: 'inactive-unread',
                    seq: 10,
                    lastViewedSessionSeq: 1,
                    active: false,
                    presence: 1,
                    metadata: {
                        path: '/Users/tester/project/inactive-unread',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Inactive unread work', updatedAt: 4 },
                    },
                }),
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
                showWhenRunning: false,
                showWhenAttentionRequired: false,
                showWhenReady: false,
            }),
            nowMs: 1_000,
        });

        const model = buildDesktopActivityOverlayModel({
            snapshot,
            policy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
                showWhenRunning: false,
                showWhenAttentionRequired: false,
                showWhenReady: false,
            }),
            isExpanded: false,
        });

        expect(snapshot.sessions.map((session) => session.sessionId)).toEqual([
            'permission',
            'thinking',
            'quiet-active',
        ]);
        expect(model.collapsed.sessionCount).toBe(3);
    });

    it('keeps desktop preview text in the snapshot when the overlay setting enables it', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                createSessionFixture({
                    id: 'preview-session',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    pendingRequestObservedAt: 950,
                    metadata: {
                        path: '/Users/tester/project/preview',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Need your approval', updatedAt: 3 },
                    },
                }),
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({
                activitySurfacePrivacyMode: 'include_preview',
            }),
            desktopPolicy: createDesktopPolicy({
                showPreviewText: true,
            }),
            nowMs: 1_000,
        });

        expect(snapshot.sessions[0]).toHaveProperty('previewText', 'Need your approval');
    });

    it('renders an explicit idle state in always-when-enabled mode when no active or attention-bearing sessions qualify', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                createSessionFixture({
                    id: 'quiet-inactive',
                    active: false,
                    presence: 'online',
                    thinking: false,
                    pendingPermissionRequestCount: 0,
                    pendingUserActionRequestCount: 0,
                    pendingCount: 0,
                    seq: 5,
                    lastViewedSessionSeq: 5,
                    metadata: {
                        path: '/Users/tester/project/quiet-inactive',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Quiet recent work', updatedAt: 5 },
                    },
                }),
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({
                activitySurfacePrivacyMode: 'include_preview',
            }),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'always_when_enabled',
                showWhenRunning: false,
                showWhenAttentionRequired: false,
                showWhenReady: false,
                showPreviewText: true,
            }),
            nowMs: 1_000,
        });

        expect(snapshot.state).toBe('idle');
        expect(snapshot.sessions).toEqual([]);
        expect(snapshot.primary).toBeNull();
        expect(snapshot.defaultTarget).toBe('open-inbox');
    });

    it('ignores detached sessions that are not present in the canonical session-list lookup owners', () => {
        const visibleSession = createSessionFixture({
            id: 'visible-session',
            active: true,
            presence: 'online',
            metadata: {
                path: '/Users/tester/project/visible',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Visible work', updatedAt: 3 },
            },
        });
        const detachedSession = createSessionFixture({
            id: 'detached-session',
            active: true,
            presence: 'online',
            pendingPermissionRequestCount: 1,
            metadata: {
                path: '/Users/tester/project/detached',
                host: 'tester.local',
                homeDir: '/Users/tester',
                summary: { text: 'Detached work', updatedAt: 5 },
            },
        });
        const source = createOverlaySource({
            sessions: [visibleSession, detachedSession],
        });

        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: {
                ...source,
                sessionListRenderablesById: {
                    [visibleSession.id]: source.sessionListRenderablesById[visibleSession.id]!,
                },
                sessionListIndexByServerId: {
                    'server-1': [
                        {
                            type: 'session',
                            sessionId: visibleSession.id,
                            serverId: 'server-1',
                        },
                    ],
                },
            },
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 1_000,
        });

        expect(snapshot.sessions.map((session) => session.sessionId)).toEqual(['visible-session']);
        expect(snapshot.permissionRequests).toEqual([]);
    });

    it('derives permission-request and user-question snapshots for selected overlay sessions', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                createSessionFixture({
                    id: 'session-permission',
                    active: true,
                    presence: 'online',
                    pendingPermissionRequestCount: 1,
                    agentState: {
                        requests: {
                            'perm-1': {
                                tool: 'Bash',
                                arguments: {
                                    command: 'npm test',
                                },
                                createdAt: 100,
                            },
                        },
                    },
                    metadata: {
                        path: '/Users/tester/project/permission',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Need approval', updatedAt: 3 },
                    },
                }),
                createSessionFixture({
                    id: 'session-question',
                    active: true,
                    presence: 'online',
                    pendingUserActionRequestCount: 1,
                    agentState: {
                        requests: {
                            'question-1': {
                                tool: 'AskUserQuestion',
                                kind: 'user_action',
                                arguments: {
                                    questions: [
                                        {
                                            question: 'Which deployment target?',
                                            options: [
                                                { label: 'Production', description: 'Deploy to production' },
                                                { label: 'Staging', description: 'Deploy to staging' },
                                            ],
                                            multiSelect: false,
                                        },
                                    ],
                                },
                                createdAt: 110,
                            },
                        },
                    },
                    metadata: {
                        path: '/Users/tester/project/question',
                        host: 'tester.local',
                        homeDir: '/Users/tester',
                        summary: { text: 'Question pending', updatedAt: 4 },
                    },
                }),
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 1_000,
        });

        expect(snapshot.state).toBe('content');
        expect(snapshot.permissionRequests).toEqual([
            expect.objectContaining({
                serverId: 'server-1',
                sessionId: 'session-permission',
                requestId: 'perm-1',
                kind: 'permission_request',
                allowActionIdentifier: 'session.permission.respond',
                denyActionIdentifier: 'session.permission.respond',
            }),
        ]);
        expect(snapshot.userQuestions).toEqual([
            expect.objectContaining({
                serverId: 'server-1',
                sessionId: 'session-question',
                requestId: 'question-1',
                kind: 'user_question',
                questionText: 'Which deployment target?',
                directOptions: [
                    expect.objectContaining({
                        label: 'Production',
                        actionIdentifier: 'session.user_action.answer',
                        answers: [
                            {
                                question: 'Which deployment target?',
                                answer: 'Production',
                            },
                        ],
                    }),
                    expect.objectContaining({
                        label: 'Staging',
                        actionIdentifier: 'session.user_action.answer',
                    }),
                ],
            }),
        ]);
    });

    it('preserves canonical permission identity when a newer unread renderable supplies attention', () => {
        const canonicalSession = createSessionFixture({
            id: 'hidden-global-permission',
            serverId: 'server-1',
            seq: 3,
            lastViewedSessionSeq: 3,
            active: true,
            presence: 'online',
            agentStateVersion: 7,
            pendingPermissionRequestCount: 1,
            pendingRequestObservedAt: 900,
            agentState: {
                requests: {
                    'canonical-request-42': {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: {
                            command: 'git status --short',
                        },
                        createdAt: 900,
                    },
                },
            },
            metadata: {
                path: '/Users/tester/project/hidden-global-permission',
                host: 'tester.local',
                homeDir: '/Users/tester',
                systemSessionV1: {
                    v: 1,
                    key: 'voice_conversation_retired',
                    hidden: true,
                },
            },
        });
        const source = createOverlaySource({
            sessions: [canonicalSession],
        });
        const newerUnreadRenderable = {
            ...source.sessionListRenderablesById[canonicalSession.id]!,
            seq: 4,
            updatedAt: 950,
            latestReadyEventSeq: 4,
            hasUnreadMessages: true,
            hasPendingPermissionRequests: true,
            pendingRequestObservedAt: 900,
            agentStateVersion: 7,
        };

        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: {
                ...source,
                sessionListRenderablesById: {
                    [canonicalSession.id]: newerUnreadRenderable,
                },
            },
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 1_000,
        });

        expect(snapshot.permissionRequests).toEqual([
            expect.objectContaining({
                requestId: 'canonical-request-42',
                sessionId: canonicalSession.id,
                serverId: 'server-1',
                toolLabel: 'Bash',
                summary: expect.stringContaining('git status --short'),
                allowActionIdentifier: 'session.permission.respond',
                denyActionIdentifier: 'session.permission.respond',
            }),
        ]);
    });

    it('keeps renderable-only request summaries openable without fabricating response actions', () => {
        const canonicalSession = createSessionFixture({
            id: 'hidden-summary-requests',
            serverId: 'server-1',
            seq: 4,
            lastViewedSessionSeq: 4,
            active: true,
            presence: 'online',
            agentStateVersion: 6,
            agentState: null,
            metadata: {
                path: '/Users/tester/project/hidden-summary-requests',
                host: 'tester.local',
                homeDir: '/Users/tester',
                systemSessionV1: {
                    v: 1,
                    key: 'voice_conversation_retired',
                    hidden: true,
                },
            },
        });
        const source = createOverlaySource({
            sessions: [canonicalSession],
        });

        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: {
                ...source,
                sessionListRenderablesById: {
                    [canonicalSession.id]: {
                        ...source.sessionListRenderablesById[canonicalSession.id]!,
                        agentStateVersion: 7,
                        hasPendingPermissionRequests: true,
                        hasPendingUserActionRequests: true,
                        pendingRequestObservedAt: 950,
                    },
                },
            },
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy(),
            nowMs: 1_000,
        });

        expect(snapshot.state).toBe('content');
        expect(snapshot.primary).toMatchObject({
            sessionId: canonicalSession.id,
            serverId: 'server-1',
            attentionState: 'permission_required',
        });
        expect(snapshot.permissionRequests).toEqual([]);
        expect(snapshot.userQuestions).toEqual([]);
    });

    it('derives permission risk from real request snapshots into model actions', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                    createSessionFixture({
                        id: 'session-edit',
                        active: true,
                        presence: 'online',
                        pendingPermissionRequestCount: 1,
                        agentState: {
                            requests: {
                                'perm-edit': {
                                    tool: 'Edit',
                                    arguments: {
                                        file_path: 'src/auth/middleware.ts',
                                    },
                                    createdAt: 100,
                                },
                            },
                        },
                    }),
                    createSessionFixture({
                        id: 'session-bash',
                        active: true,
                        presence: 'online',
                        pendingPermissionRequestCount: 1,
                        agentState: {
                            requests: {
                                'perm-bash': {
                                    tool: 'Bash',
                                    arguments: {
                                        command: 'git status --short',
                                    },
                                    createdAt: 110,
                                },
                            },
                        },
                    }),
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 1_000,
        });
        const model = buildDesktopActivityOverlayModel({
            snapshot,
            policy: createDesktopPolicy(),
            isExpanded: true,
        });

        expect(snapshot.permissionRequests).toEqual(expect.arrayContaining([
            expect.objectContaining({
                requestId: 'perm-edit',
                risk: 'high',
            }),
            expect.objectContaining({
                requestId: 'perm-bash',
                risk: 'low',
            }),
        ]));

        const cards = model.expanded.cards ?? [];
        const editCard = cards.find((card) => card.id === 'permission:perm-edit');
        const bashCard = cards.find((card) => card.id === 'permission:perm-bash');

        expect(editCard).toEqual(expect.objectContaining({
            kind: 'permission_request',
            risk: 'high',
            actions: [
                expect.objectContaining({ id: 'deny:perm-edit' }),
                expect.objectContaining({ id: 'open:perm-edit' }),
            ],
        }));
        expect(editCard).not.toEqual(expect.objectContaining({
            actions: expect.arrayContaining([
                expect.objectContaining({ id: 'always_allow' }),
                expect.objectContaining({ id: 'allow:perm-edit' }),
            ]),
        }));
        expect(bashCard).toEqual(expect.objectContaining({
            kind: 'permission_request',
            risk: 'low',
            actions: expect.arrayContaining([
                expect.objectContaining({ id: 'always_allow' }),
                expect.objectContaining({ id: 'allow:perm-bash' }),
            ]),
        }));
    });

    it('derives quota summaries and recent turn completion sessions into the snapshot contract', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                    Object.assign(createSessionFixture({
                        id: 'session-ready',
                        active: true,
                        presence: 'online',
                        seq: 5,
                        lastViewedSessionSeq: 5,
                        metadata: {
                            path: '/Users/tester/project/ready',
                            host: 'tester.local',
                            homeDir: '/Users/tester',
                            summary: { text: 'Ready session', updatedAt: 5 },
                        },
                    }), {
                        lastTurnCompletedAt: 990,
                    }),
                ],
                quotaSummaries: [
                    {
                        key: 'claude:default',
                        serviceId: 'anthropic',
                        profileId: 'default',
                        profileLabel: 'Claude',
                        planLabel: 'Pro',
                        primaryMeter: {
                            meterId: 'requests',
                            label: 'Requests',
                            remainingPct: 12,
                            utilizationPct: 88,
                            status: 'estimated',
                        },
                        meters: [
                            {
                                meterId: 'requests',
                                label: 'Requests',
                                remainingPct: 12,
                                utilizationPct: 88,
                                status: 'estimated',
                            },
                        ],
                    },
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 1_000,
        });

        expect(snapshot.quotaSummaries).toEqual([
            expect.objectContaining({
                id: 'claude:default',
                title: 'Claude',
                summary: expect.stringContaining('12%'),
            }),
        ]);
        expect(snapshot.completionStates).toEqual([
            expect.objectContaining({
                sessionId: 'session-ready',
                serverId: 'server-1',
                title: 'Ready session',
                summary: expect.any(String),
                variant: 'turn_complete',
                autoDismissMs: 15000,
                sticky: false,
            }),
        ]);
    });

    it('does not derive completion cards from stale completion timestamps or generic pending state', () => {
        const snapshot = buildDesktopActivityOverlaySnapshot({
            source: createOverlaySource({
                sessions: [
                    Object.assign(createSessionFixture({
                        id: 'stale-ready',
                        active: true,
                        presence: 'online',
                        pendingCount: 1,
                        seq: 5,
                        lastViewedSessionSeq: 5,
                        metadata: {
                            path: '/Users/tester/project/stale',
                            host: 'tester.local',
                            homeDir: '/Users/tester',
                            summary: { text: 'Stale ready', updatedAt: 5 },
                        },
                    }), {
                        lastTurnCompletedAt: 1_000,
                    }),
                ],
            }),
            activityPolicy: resolveActivitySurfacePolicy({}),
            desktopPolicy: createDesktopPolicy({
                visibilityMode: 'active_sessions',
            }),
            nowMs: 31_001,
        });

        expect(snapshot.completionStates).toEqual([]);
    });

});
