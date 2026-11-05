import { describe, expect, it } from 'vitest';

import type { DesktopActivityOverlaySnapshot } from './buildDesktopActivityOverlaySnapshot';
import type { DesktopOverlayPolicy } from '@/activity/adapters/desktop/runtime/resolveDesktopOverlayPolicy';
import { activityInstanceKey, sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { resolveSessionPermissionBehavior } from '@/sync/ops/sessionPermissionAnswers';
import { resolveSessionPermissionChoices } from '@/sync/ops/sessionPermissionChoices';

import { buildDesktopActivityOverlayModel as buildModel } from './buildDesktopActivityOverlayModel';

const QUIET_ACTIVITY = { visible: false, activity: 'quiet', word: '', entries: [], tray: [] } as const;
function buildDesktopActivityOverlayModel(params: Omit<Parameters<typeof buildModel>[0], 'sharedActivity'>
    & Partial<Pick<Parameters<typeof buildModel>[0], 'sharedActivity'>>) {
    return buildModel({ ...params, sharedActivity: params.sharedActivity ?? QUIET_ACTIVITY });
}

type RequestSnapshotFixture = Omit<DesktopActivityOverlaySnapshot['permissionRequests'][number], 'activityInstanceId'>
    & Partial<Pick<DesktopActivityOverlaySnapshot['permissionRequests'][number], 'activityInstanceId'>>;
type SnapshotOverrides = Omit<Partial<DesktopActivityOverlaySnapshot>, 'permissionRequests' | 'userQuestions'> & Readonly<{
    permissionRequests?: readonly RequestSnapshotFixture[];
    userQuestions?: readonly RequestSnapshotFixture[];
}>;

function requestActivityInstanceId(request: RequestSnapshotFixture): string {
    return request.activityInstanceId ?? activityInstanceKey(
        { serverId: request.serverId, sessionId: request.sessionId },
        JSON.stringify([request.kind, request.requestId]),
    );
}

function createSnapshot(overrides: SnapshotOverrides = {}): DesktopActivityOverlaySnapshot {
    const base: DesktopActivityOverlaySnapshot = {
        version: 1,
        generatedAt: 1_700_000_000_000,
        bots: { faces: [], overflowCount: 0 },
        conversation: null,
        state: 'content',
        counts: {
            unread: 1,
            permissionRequired: 1,
            actionRequired: 0,
            thinking: 1,
            totalAttention: 2,
        },
        summaryCounts: {
            attentionCount: 2,
            runningCount: 1,
            permissionCount: 1,
        },
        permissionRequests: [],
        userQuestions: [],
        quotaSummaries: [],
        completionStates: [],
        primary: {
            serverId: 'server-1',
            sessionId: 'session-primary',
            title: 'Primary session',
            subtitle: 'agent on machine',
            statusText: 'Permission required',
            previewText: null,
            attentionState: 'permission_required',
            active: true,
            updatedAt: 10,
        },
        sessions: [
            {
                serverId: 'server-1',
                sessionId: 'session-primary',
                title: 'Primary session',
                subtitle: 'agent on machine',
                statusText: 'Permission required',
                previewText: null,
                attentionState: 'permission_required',
                active: true,
                updatedAt: 10,
            },
            {
                serverId: 'server-1',
                sessionId: 'session-secondary',
                title: 'Secondary session',
                subtitle: 'agent on machine',
                statusText: 'Running',
                previewText: null,
                attentionState: 'thinking',
                active: true,
                updatedAt: 9,
            },
        ],
        defaultTarget: 'open-primary-session',
        labels: {
            sessionsTitle: 'Sessions',
            emptyTitle: 'No active sessions',
        },
    };

    return {
        ...base,
        ...overrides,
        permissionRequests: (overrides.permissionRequests ?? base.permissionRequests).map((request) => ({
            ...request,
            permissionChoices: request.permissionChoices ?? resolveSessionPermissionChoices({ toolName: request.toolLabel,
                permissionBehavior: resolveSessionPermissionBehavior({ agentId: 'claude', metadata: { flavor: 'claude' }, accountScope: undefined }) }),
            activityInstanceId: requestActivityInstanceId(request),
        })),
        userQuestions: (overrides.userQuestions ?? base.userQuestions).map((request) => ({
            ...request,
            activityInstanceId: requestActivityInstanceId(request),
        })),
    };
}

function createPolicy(overrides: Partial<DesktopOverlayPolicy> = {}): DesktopOverlayPolicy {
    const base: DesktopOverlayPolicy = {
        enabled: true,
        visibilityMode: 'attention_only',

        alwaysOnTop: true,

        hoverExpandDelayMs: 500,

        dock: 'top',
        idle: 'tip',
        botConversationPresentation: 'overlay',

        quickReplyPhrases: ['Continue', 'OK', 'Explain', 'Retry'],
    };

    return {
        ...base,
        ...overrides,
    };
}

describe('buildDesktopActivityOverlayModel', () => {
    it('keeps an explicit conversation visible when privacy removes every ambient Session', () => {
        const snapshot = createSnapshot({ primary: null, sessions: [], state: 'idle', conversation: {
            serverId: 'server-1', accountId: 'account-1', sessionId: 'private', reachable: true, refreshing: false,
            reply: { state: 'ready', text: 'Explicitly opened content' },
        } });
        const model = buildDesktopActivityOverlayModel({ snapshot, policy: createPolicy() });
        expect(model.visible).toBe(true);
        expect(model.expanded.rows).toEqual([]);
        expect(model.conversation).toEqual(snapshot.conversation);
        expect(buildDesktopActivityOverlayModel({ snapshot, policy: createPolicy({ enabled: false }) }).visible).toBe(false);
    });

    it.each(['permission_request', 'user_question'] as const)('keeps identical %s asks distinct with Home-scoped Session identity', (kind) => {
        const request = {
            kind, requestId: 'question-1', serverId: 'server-1',
            title: 'Trust this folder?', summary: null, toolLabel: 'AskUserQuestion', questionText: 'Trust this folder?',
            count: 1, openActionIdentifier: 'open-primary-session', directOptions: [],
        };
        const sessions = createSnapshot().sessions;
        const snapshot = createSnapshot({
            sessions: [...sessions, { ...sessions[0]!, serverId: 'server-2', title: 'Other Home session' }],
            [kind === 'permission_request' ? 'permissionRequests' : 'userQuestions']: [
                { ...request, sessionId: 'session-primary' },
                { ...request, sessionId: 'session-secondary' },
                { ...request, sessionId: 'session-primary', serverId: 'server-2' },
            ],
        });
        const model = buildDesktopActivityOverlayModel({ snapshot, policy: createPolicy() });
        const cards = (model.expanded.cards ?? []).filter(card => card.kind === kind);
        expect(new Set(cards.map(card => card.id)).size).toBe(3);
        expect(cards).toMatchObject([
            { session: { title: 'Primary session', sessionId: 'session-primary', serverId: 'server-1' } },
            { session: { title: 'Secondary session', sessionId: 'session-secondary', serverId: 'server-1' } },
            { session: { title: 'Other Home session', sessionId: 'session-primary', serverId: 'server-2' } },
        ]);
    });

    it('consumes shared visibility and word without reconstructing triggers from cards', () => {
        const snapshot = createSnapshot({ counts: { unread: 0, permissionRequired: 0,
            actionRequired: 0, thinking: 0, totalAttention: 0 } });
        const sharedActivity = { ...QUIET_ACTIVITY, visible: true, activity: 'needsYou' as const, word: 'Needs you' };
        expect(buildDesktopActivityOverlayModel({ snapshot, policy: createPolicy(),
            sharedActivity })).toMatchObject({ visible: true, collapsed: { title: 'Needs you', activity: 'needsYou' } });
        expect(buildDesktopActivityOverlayModel({ snapshot, policy: createPolicy({ enabled: false }),
            sharedActivity }).visible).toBe(false);
    });
    it('keeps working non-Bots and quiet completion cards at rest without selected faces', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({ counts: { unread: 0, permissionRequired: 0, actionRequired: 0,
                thinking: 1, totalAttention: 0 }, permissionRequests: [], userQuestions: [] }),
            policy: createPolicy({ visibilityMode: 'active_sessions' }),
        });
        expect(model.visible).toBe(false);
    });
    it('uses one passive expanded composition without duplicating the primary session', () => {
        const singleSessionModel = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                sessions: [
                    {
                        sessionId: 'session-primary',
                        serverId: 'server-1',
                        title: 'Primary session',
                        subtitle: 'agent on machine',
                        statusText: 'Ready',
                        previewText: null,
                        attentionState: 'pending_input',
                        active: true,
                        updatedAt: 10,
                    },
                ],
            }),
            policy: createPolicy(),
        });
        const multiSessionModel = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy(),
        });

        expect(singleSessionModel.expanded.cards).toEqual([
            expect.objectContaining({
                kind: 'session_overview',
                sessionId: 'session-primary',
            }),
        ]);
        expect(multiSessionModel.expanded.cards).toEqual([
            expect.objectContaining({
                kind: 'multi_session_list',
                rows: [
                    expect.objectContaining({ sessionId: 'session-primary' }),
                    expect.objectContaining({ sessionId: 'session-secondary' }),
                ],
            }),
        ]);
    });

    it('publishes content without a second presentation or geometry decision', () => {
        const model = buildDesktopActivityOverlayModel({ snapshot: createSnapshot(), policy: createPolicy(), });
        expect(model).not.toHaveProperty('isExpanded');
        expect(model).not.toHaveProperty('window');
        expect(model.expanded.cards?.length).toBeGreaterThan(0);
    });

    it('stays hidden when disabled regardless of counts', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                enabled: false,
                visibilityMode: 'always_when_enabled',
            }),
        });

        expect(model.visible).toBe(false);
    });

    it('uses empty fallback copy when there is no primary session', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                state: 'idle',
                counts: {
                    unread: 0,
                    permissionRequired: 0,
                    actionRequired: 0,
                    thinking: 0,
                    totalAttention: 0,
                },
                permissionRequests: [],
                userQuestions: [],
                quotaSummaries: [],
                primary: null,
                sessions: [],
            }),
            policy: createPolicy({
                visibilityMode: 'always_when_enabled',
            }),
        });

        expect(model.visible).toBe(false);
        expect(model.collapsed.title).toBe('');
        expect(model.expanded.cards).toEqual([
            expect.objectContaining({
                kind: 'idle_state',
            }),
        ]);
        expect(model.expanded.rows).toHaveLength(0);
    });

    it('omits widget-only fields from the desktop overlay presentation contract', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot(),
            policy: createPolicy({
                visibilityMode: 'always_when_enabled',
            }),
        });

        expect(model.collapsed).not.toHaveProperty('subtitle');
        expect(model.collapsed).not.toHaveProperty('previewText');
        expect(model.collapsed).not.toHaveProperty('attentionCount');
        expect(model.expanded.rows[0]).not.toHaveProperty('route');
        expect(model.expanded.rows[0]).not.toHaveProperty('target');
        expect(model.expanded.rows[0]).not.toHaveProperty('attentionState');
    });

    it('does not auto-show for queued user input without real attention or completion state', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                counts: {
                    unread: 0,
                    permissionRequired: 0,
                    actionRequired: 0,
                    thinking: 0,
                    totalAttention: 0,
                },
                completionStates: [],
            }),
            policy: createPolicy({

            }),
        });

        expect(model.visible).toBe(false);
    });

    it('prioritizes permission request cards ahead of passive session overview cards', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                permissionRequests: [
                    {
                        kind: 'permission_request',
                        requestId: 'perm-1',
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Approve command',
                        summary: 'npm test',
                        toolLabel: 'Bash',
                        questionText: null,
                        count: 1,
                        openActionIdentifier: 'open-session:session-primary',
                        allowActionIdentifier: 'session.permission.respond',
                        denyActionIdentifier: 'session.permission.respond',
                        directOptions: [],
                    },
                ],
            }),
            policy: createPolicy(),
        });

        expect(model.expanded.cards?.[0]).toEqual(expect.objectContaining({
            kind: 'permission_request',
            id: activityInstanceKey(
                { serverId: 'server-1', sessionId: 'session-primary' },
                JSON.stringify(['permission_request', 'perm-1']),
            ),
        }));
    });

    it('preserves exact request instance identity across Homes, sessions, reorder, and delimiter-bearing ids', () => {
        const requestInstanceId = (serverId: string, sessionId: string, kind: 'permission_request' | 'user_question', requestId: string) => (
            activityInstanceKey({ serverId, sessionId }, JSON.stringify([kind, requestId]))
        );
        const permissionRequest = (serverId: string, sessionId: string, requestId: string) => ({
            kind: 'permission_request' as const,
            activityInstanceId: requestInstanceId(serverId, sessionId, 'permission_request', requestId),
            requestId,
            serverId,
            sessionId,
            title: `Approve on ${serverId}/${sessionId}`,
            summary: null,
            toolLabel: 'Bash',
            questionText: null,
            count: 1,
            openActionIdentifier: `open-session:${sessionId}?serverId=${serverId}`,
            allowActionIdentifier: 'session.permission.respond',
            denyActionIdentifier: 'session.permission.respond',
            directOptions: [],
        });
        const requests = [
            permissionRequest('home-a', 'session-x', 'shared-request'),
            permissionRequest('home-b', 'session-x', 'shared-request'),
            permissionRequest('home-a', 'session-y', 'shared-request'),
            permissionRequest('https://home.example/a', 'b:c', 'request:with:delimiters'),
            permissionRequest('https://home.example/a:b', 'c', 'request:with:delimiters'),
        ];
        const buildCards = (permissionRequests: typeof requests) => buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({ permissionRequests }),
            policy: createPolicy(),
        }).expanded.cards?.filter((card) => card.kind === 'permission_request') ?? [];

        const original = buildCards(requests);
        const reorderedAfterResolve = buildCards([requests[4], requests[2], requests[1], requests[3]]);
        const originalIds = original.map((card) => card.id);

        expect(new Set(originalIds).size).toBe(requests.length);
        expect(originalIds).toEqual(requests.map((request) => request.activityInstanceId));
        expect(reorderedAfterResolve.map((card) => card.id)).toEqual([
            requests[4].activityInstanceId,
            requests[2].activityInstanceId,
            requests[1].activityInstanceId,
            requests[3].activityInstanceId,
        ]);
        expect(original[1]).toEqual(expect.objectContaining({
            requestId: 'shared-request',
            serverId: 'home-b',
            sessionId: 'session-x',
            actions: expect.arrayContaining([
                expect.objectContaining({
                    actionIdentifier: 'session.permission.respond',
                    data: expect.objectContaining({
                        requestId: 'shared-request',
                        serverId: 'home-b',
                        sessionId: 'session-x',
                    }),
                }),
            ]),
        }));
    });

    it('surfaces permissions before user questions, quota summaries, and completion cards in priority order', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                permissionRequests: [
                    {
                        kind: 'permission_request',
                        requestId: 'permission-1',
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Approve deployment',
                        summary: 'Deploy to production',
                        toolLabel: 'Deploy',
                        questionText: null,
                        count: 1,
                        openActionIdentifier: 'open-session:session-primary',
                        allowActionIdentifier: 'session.permission.respond',
                        denyActionIdentifier: 'session.permission.respond',
                        directOptions: [],
                    },
                ],
                userQuestions: [
                    {
                        kind: 'user_question',
                        requestId: 'question-1',
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Which deployment target?',
                        summary: 'Choose a target',
                        toolLabel: 'AskUserQuestion',
                        questionText: 'Which deployment target?',
                        count: 1,
                        openActionIdentifier: 'open-session:session-primary',
                        directOptions: [
                            {
                                id: 'production',
                                label: 'Production',
                                description: 'Deploy to production',
                                actionIdentifier: 'session.user_action.answer',
                                answers: [
                                    {
                                        question: 'Which deployment target?',
                                        answer: 'Production',
                                    },
                                ],
                            },
                        ],
                    },
                ],
                quotaSummaries: [
                    {
                        id: 'claude:default',
                        title: 'Claude',
                        summary: '12% remaining',
                    },
                ],
                completionStates: [
                    {
                        sessionId: 'session-primary',
                        serverId: 'server-1',
                        title: 'Primary session',
                        summary: 'Turn finished. Open the session to continue.',
                        openActionIdentifier: 'open-session:session-primary',
                        variant: 'turn_complete',
                        autoDismissMs: 15000,
                        sticky: false,
                    },
                ],
            }),
            policy: createPolicy({
                visibilityMode: 'active_sessions',
            }),
        });

        expect(model.expanded.cards?.map((card) => card.kind)).toEqual([
            'permission_request',
            'user_question',
            'quota_summary',
            'completion_state',
        ]);
        expect(model.expanded.cards?.[0]).toEqual(expect.objectContaining({
            kind: 'permission_request',
            id: activityInstanceKey(
                { serverId: 'server-1', sessionId: 'session-primary' },
                JSON.stringify(['permission_request', 'permission-1']),
            ),
        }));
        expect(model.expanded.cards?.[1]).toEqual(expect.objectContaining({
            kind: 'user_question',
            id: activityInstanceKey(
                { serverId: 'server-1', sessionId: 'session-primary' },
                JSON.stringify(['user_question', 'question-1']),
            ),
            actions: expect.arrayContaining([
                expect.objectContaining({
                    actionIdentifier: 'session.user_action.answer',
                    data: expect.objectContaining({
                        requestId: 'question-1',
                        sessionId: 'session-primary',
                        serverId: 'server-1',
                    }),
                }),
                expect.objectContaining({
                    id: 'other',
                    inputKind: 'inline_text',
                }),
                expect.objectContaining({
                    actionIdentifier: 'open-session:session-primary',
                }),
            ]),
        }));
        expect(model.expanded.cards).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'quota_summary',
                id: 'quota:claude:default',
            }),
            expect.objectContaining({
                kind: 'completion_state',
                id: activityInstanceKey(
                    { serverId: 'server-1', sessionId: 'session-primary' },
                    'completion',
                ),
                variant: 'turn_complete',
                autoDismissMs: 15000,
                sticky: false,
            }),
        ]));
        expect(model.expanded.cards).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'session_overview' }),
            expect.objectContaining({ kind: 'multi_session_list' }),
        ]));
    });

    it('preserves the Session choices regardless of permission risk', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                permissionRequests: [
                    {
                        kind: 'permission_request',
                        requestId: 'perm-low',
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Read package.json',
                        summary: 'Read package.json',
                        toolLabel: 'Read',
                        questionText: null,
                        count: 1,
                        openActionIdentifier: 'open-session:session-primary',
                        allowActionIdentifier: 'session.permission.respond',
                        denyActionIdentifier: 'session.permission.respond',
                        directOptions: [],
                        risk: 'low',
                    },
                    {
                        kind: 'permission_request',
                        requestId: 'perm-high',
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Run deploy.sh',
                        summary: 'Run deploy.sh',
                        toolLabel: 'Bash',
                        questionText: null,
                        count: 1,
                        openActionIdentifier: 'open-session:session-primary',
                        allowActionIdentifier: 'session.permission.respond',
                        denyActionIdentifier: 'session.permission.respond',
                        directOptions: [],
                        risk: 'high',
                    },
                ],
            }),
            policy: createPolicy(),
        });

        const lowRiskCard = model.expanded.cards?.find((card) => card.kind === 'permission_request' && card.requestId === 'perm-low');
        const highRiskCard = model.expanded.cards?.find((card) => card.kind === 'permission_request' && card.requestId === 'perm-high');

        expect(lowRiskCard).toEqual(expect.objectContaining({
            kind: 'permission_request',
            risk: 'low',
            actions: expect.arrayContaining([
                expect.objectContaining({
                    id: 'always_allow',
                    // The card's title names the tool's kind; the button stays short and its name stays specific.
                    tone: 'quiet',
                    data: expect.objectContaining({ allowedTools: ['Read'] }),
                }),
            ]),
        }));
        expect(highRiskCard).toEqual(expect.objectContaining({
            kind: 'permission_request',
            risk: 'high',
            actions: expect.arrayContaining([
                expect.objectContaining({ id: 'allow' }),
                expect.objectContaining({ id: 'always_allow', data: expect.objectContaining({ allowedTools: ['Bash'] }) }),
                expect.objectContaining({ id: 'deny' }),
                expect.objectContaining({ id: 'stop' }),
            ]),
        }));
    });

    it('keeps completion cards distinct when two Homes reuse a session id', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                sessions: [
                    {
                        ...createSnapshot().sessions[0],
                        serverId: 'server-a',
                        sessionId: 'shared-session',
                        title: 'Home A session',
                    },
                    {
                        ...createSnapshot().sessions[0],
                        serverId: 'server-b',
                        sessionId: 'shared-session',
                        title: 'Home B session',
                    },
                ],
                completionStates: [
                    {
                        sessionId: 'shared-session',
                        serverId: 'server-a',
                        title: 'Home A session',
                        summary: 'Ready',
                        openActionIdentifier: 'open-session:shared-session?serverId=server-a',
                        variant: 'turn_complete',
                        autoDismissMs: 15_000,
                        sticky: false,
                    },
                    {
                        sessionId: 'shared-session',
                        serverId: 'server-b',
                        title: 'Home B session',
                        summary: 'Ready',
                        openActionIdentifier: 'open-session:shared-session?serverId=server-b',
                        variant: 'turn_complete',
                        autoDismissMs: 15_000,
                        sticky: false,
                    },
                ],
            }),
            policy: createPolicy({ visibilityMode: 'active_sessions' }),
        });

        const completionCards = model.expanded.cards?.filter((card) => card.kind === 'completion_state') ?? [];
        expect(completionCards).toHaveLength(2);
        expect(new Set(completionCards.map((card) => card.id)).size).toBe(2);
        expect(completionCards.map((card) => card.id)).toEqual([
            activityInstanceKey(
                { serverId: 'server-a', sessionId: 'shared-session' },
                'completion',
            ),
            activityInstanceKey(
                { serverId: 'server-b', sessionId: 'shared-session' },
                'completion',
            ),
        ]);
        expect(completionCards.map((card) => card.serverId)).toEqual(['server-a', 'server-b']);
    });

    it('keeps an unscoped legacy completion distinct from an exact tuple with colliding JSON text', () => {
        const exactAddress = { serverId: 'server-a', sessionId: 'shared-session' } as const;
        const legacySessionId = sessionAddressKey(exactAddress);
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                completionStates: [
                    {
                        sessionId: exactAddress.sessionId,
                        serverId: exactAddress.serverId,
                        title: 'Exact Home session',
                        summary: 'Ready',
                        openActionIdentifier: 'open-session:shared-session?serverId=server-a',
                        variant: 'turn_complete',
                        autoDismissMs: 15_000,
                        sticky: false,
                    },
                    {
                        sessionId: legacySessionId,
                        serverId: null,
                        title: 'Legacy unscoped session',
                        summary: 'Ready',
                        openActionIdentifier: 'open-session:legacy',
                        variant: 'turn_complete',
                        autoDismissMs: 15_000,
                        sticky: false,
                    },
                ],
            }),
            policy: createPolicy({ visibilityMode: 'active_sessions' }),
        });

        const completionCards = model.expanded.cards?.filter((card) => card.kind === 'completion_state') ?? [];
        expect(completionCards.map((card) => card.id)).toEqual([
            activityInstanceKey(exactAddress, 'completion'),
            activityInstanceKey({ serverId: null, sessionId: legacySessionId }, 'completion'),
        ]);
        expect(new Set(completionCards.map((card) => card.id)).size).toBe(2);
    });

    it('keys a current session overview by qualified identity, with legacy unscoped identity distinct', () => {
        const buildSessionCardId = (serverId: string | null, sessionId: string) => {
            const model = buildDesktopActivityOverlayModel({
                snapshot: createSnapshot({
                    permissionRequests: [],
                    userQuestions: [],
                    quotaSummaries: [],
                    completionStates: [],
                    sessions: [{
                        ...createSnapshot().sessions[0],
                        serverId,
                        sessionId,
                    }],
                }),
                policy: createPolicy({ visibilityMode: 'active_sessions' }),
            });
            return model.expanded.cards?.find((card) => card.kind === 'session_overview')?.id;
        };
        const collidingText = sessionAddressKey({ serverId: 'server-a', sessionId: 'shared-session' });

        expect(buildSessionCardId('server-a', 'shared-session')).toBe(
            activityInstanceKey({ serverId: 'server-a', sessionId: 'shared-session' }, 'session'),
        );
        expect(buildSessionCardId('server-a', 'shared-session')).not.toBe(
            buildSessionCardId('server-b', 'shared-session'),
        );
        expect(buildSessionCardId('server-a', collidingText)).not.toBe(
            buildSessionCardId(null, collidingText),
        );
    });

    it('keeps user-question choices in the asker\'s words and adds inline other for single-question flows', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                userQuestions: [
                    {
                        kind: 'user_question',
                        requestId: 'question-1',
                        serverId: 'server-1',
                        sessionId: 'session-primary',
                        title: 'Which deployment target?',
                        summary: 'Choose a target',
                        toolLabel: 'AskUserQuestion',
                        questionText: 'Which deployment target?',
                        count: 1,
                        openActionIdentifier: 'open-session:session-primary',
                        directOptions: [
                            {
                                id: 'production',
                                label: 'Production',
                                description: null,
                                actionIdentifier: 'session.user_action.answer',
                                answers: [{ question: 'Which deployment target?', answer: 'Production' }],
                            },
                            {
                                id: 'staging',
                                label: 'Staging',
                                description: null,
                                actionIdentifier: 'session.user_action.answer',
                                answers: [{ question: 'Which deployment target?', answer: 'Staging' }],
                            },
                        ],
                    },
                ],
            }),
            policy: createPolicy(),
        });

        expect(model.expanded.cards?.[0]).toEqual(expect.objectContaining({
            kind: 'user_question',
            actions: [
                expect.objectContaining({ id: 'option-1-production', label: 'Production' }),
                expect.objectContaining({ id: 'option-2-staging', label: 'Staging' }),
                expect.objectContaining({ id: 'other', inputKind: 'inline_text' }),
                expect.objectContaining({ id: expect.stringContaining('open') }),
            ],
        }));
    });

    it('does not crash when a legacy user-question snapshot is missing direct options', () => {
        const legacyUserQuestion = {
            kind: 'user_question',
            requestId: 'question-legacy',
            sessionId: 'session-primary',
            title: 'Which deployment target?',
            summary: 'Choose a target',
            toolLabel: 'AskUserQuestion',
            questionText: 'Which deployment target?',
            count: 1,
            openActionIdentifier: 'open-session:session-primary',
        };

        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                userQuestions: [
                    // Boundary fixture: live persisted/bridged payloads can omit fields despite the TS contract.
                    legacyUserQuestion as unknown as DesktopActivityOverlaySnapshot['userQuestions'][number],
                ],
            }),
            policy: createPolicy({
                visibilityMode: 'active_sessions',
            }),
        });

        expect(model.expanded.cards?.[0]).toEqual(expect.objectContaining({
            kind: 'user_question',
            id: activityInstanceKey(
                { serverId: null, sessionId: 'session-primary' },
                JSON.stringify(['user_question', 'question-legacy']),
            ),
            actions: [
                expect.objectContaining({
                    actionIdentifier: 'open-session:session-primary',
                }),
            ],
        }));
    });

    it('never repeats a request title as its body', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                permissionRequests: [{
                    kind: 'permission_request',
                    requestId: 'perm-1',
                    serverId: 'server-1',
                    sessionId: 'session-primary',
                    title: 'Run npm test',
                    summary: 'Run npm test',
                    toolLabel: 'Bash',
                    questionText: null,
                    count: 1,
                    openActionIdentifier: 'open-session:session-primary',
                    allowActionIdentifier: 'session.permission.respond',
                    denyActionIdentifier: 'session.permission.respond',
                    directOptions: [],
                }],
                userQuestions: [{
                    kind: 'user_question',
                    requestId: 'question-1',
                    serverId: 'server-1',
                    sessionId: 'session-secondary',
                    title: 'Which deployment target?',
                    summary: 'Which deployment target?',
                    toolLabel: 'AskUserQuestion',
                    questionText: 'Which deployment target?',
                    count: 1,
                    openActionIdentifier: 'open-session:session-secondary',
                    directOptions: [],
                }],
            }),
            policy: createPolicy(),
        });

        const [permission, question] = model.expanded.cards ?? [];
        expect(permission).toMatchObject({ kind: 'permission_request', title: 'Run npm test', body: null });
        expect(question).toMatchObject({ kind: 'user_question', title: 'Which deployment target?', body: null });
    });

    it('offers question choices as equal secondary actions, not a row of primaries', () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                userQuestions: [{
                    kind: 'user_question',
                    requestId: 'question-1',
                    serverId: 'server-1',
                    sessionId: 'session-primary',
                    title: 'Which deployment target?',
                    summary: null,
                    toolLabel: 'AskUserQuestion',
                    questionText: 'Which deployment target?',
                    count: 1,
                    openActionIdentifier: 'open-session:session-primary',
                    directOptions: [
                        { id: 'production', label: 'Production', description: null, actionIdentifier: 'session.user_action.answer', answers: [] },
                        { id: 'staging', label: 'Staging', description: null, actionIdentifier: 'session.user_action.answer', answers: [] },
                    ],
                }],
            }),
            policy: createPolicy(),
        });

        const tones = (model.expanded.cards?.[0]?.actions ?? []).filter((action) => action.id.startsWith('option-')).map((action) => action.tone);
        expect(tones).toEqual(['secondary', 'secondary']);
    });

    it("carries each row's state tone and Agent identity from the session snapshot", () => {
        const model = buildDesktopActivityOverlayModel({
            snapshot: createSnapshot({
                sessions: [
                    { ...createSnapshot().sessions[0]!, tone: 'attention', agentId: 'claude', machineId: 'machine-1' },
                    { ...createSnapshot().sessions[1]!, tone: 'neutral', agentId: 'codex', machineId: null },
                ],
            }),
            policy: createPolicy({ visibilityMode: 'active_sessions' }),
        });

        expect(model.expanded.rows.map((row) => [row.tone, row.agentId, row.machineId])).toEqual([
            ['attention', 'claude', 'machine-1'],
            ['neutral', 'codex', null],
        ]);
    });
});
