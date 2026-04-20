import {
    desktopActivityOverlayQaCardSeedIds,
} from '../ui/shared/desktopActivityOverlaySelectors.mjs';

/** @typedef {import('./desktopActivityOverlayBridge').DesktopActivityOverlaySyncPayload} DesktopActivityOverlaySyncPayload */

export const desktopActivityOverlayQaSeedModes = Object.freeze([
    'active_session',
    'attention_only',
    'idle',
    'permission_request',
    'user_question',
    'quota_summary',
    'multi_session_list',
    'completion_state',
]);

const DEFAULT_WINDOW = Object.freeze({
    collapsed: Object.freeze({ width: 336, height: 68 }),
    expanded: Object.freeze({ width: 408, height: 232 }),
});

function buildSessionOverviewRow(params) {
    return {
        sessionId: params.sessionId,
        title: params.title,
        subtitle: params.subtitle ?? null,
        statusText: params.statusText ?? null,
        previewText: params.previewText ?? null,
    };
}

function buildBasePayload(policy) {
    return {
        visible: true,
        expanded: true,
        policy,
        window: DEFAULT_WINDOW,
    };
}

/** @returns {DesktopActivityOverlaySyncPayload} */
export function buildDesktopActivityOverlayQaSyncPayload({ mode, policy }) {
    const base = buildBasePayload(policy);

    switch (mode) {
        case 'idle':
            return {
                ...base,
                model: {
                    visible: true,
                    isExpanded: true,
                    generatedAt: Date.now(),
                    collapsed: {
                        title: 'No active sessions',
                        statusText: null,
                        defaultTarget: 'open-inbox',
                        sessionCount: null,
                        primaryCardKind: 'idle_state',
                    },
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
                    window: DEFAULT_WINDOW,
                },
            };
        case 'permission_request':
            return {
                ...base,
                model: {
                    visible: true,
                    isExpanded: true,
                    generatedAt: Date.now(),
                    collapsed: {
                        title: 'Permission required',
                        statusText: 'Approval required',
                        defaultTarget: 'open-session:qa-session-permission',
                        sessionCount: 1,
                        primaryCardKind: 'permission_request',
                        accentText: 'Claude asks',
                    },
                    expanded: {
                        title: 'Actions',
                        rows: [],
                        cards: [
                            {
                                id: `permission:${desktopActivityOverlayQaCardSeedIds.permission_request}`,
                                kind: 'permission_request',
                                requestId: desktopActivityOverlayQaCardSeedIds.permission_request,
                                sessionId: 'qa-session-permission',
                                title: 'Edit src/auth/middleware.ts',
                                body: 'Approval is required before continuing.',
                                summary: 'Approval is required before continuing.',
                                badgeText: 'Claude asks',
                                statusText: 'Approval required',
                                toolLabel: 'Claude asks',
                                questionText: null,
                                count: 1,
                                openActionIdentifier: 'open-session:qa-session-permission',
                                allowActionIdentifier: 'session.permission.respond',
                                denyActionIdentifier: 'session.permission.respond',
                                actions: [
                                    {
                                        id: 'allow',
                                        label: 'Allow',
                                        actionIdentifier: 'session.permission.respond',
                                        data: {
                                            sessionId: 'qa-session-permission',
                                            requestId: desktopActivityOverlayQaCardSeedIds.permission_request,
                                            decision: 'allow',
                                        },
                                        tone: 'primary',
                                    },
                                    {
                                        id: 'deny',
                                        label: 'Deny',
                                        actionIdentifier: 'session.permission.respond',
                                        data: {
                                            sessionId: 'qa-session-permission',
                                            requestId: desktopActivityOverlayQaCardSeedIds.permission_request,
                                            decision: 'deny',
                                        },
                                        tone: 'danger',
                                    },
                                    {
                                        id: 'open',
                                        label: 'Open',
                                        actionIdentifier: 'open-session:qa-session-permission',
                                        data: {
                                            sessionId: 'qa-session-permission',
                                            requestId: desktopActivityOverlayQaCardSeedIds.permission_request,
                                        },
                                        tone: 'secondary',
                                    },
                                ],
                            },
                        ],
                    },
                    window: DEFAULT_WINDOW,
                },
            };
        case 'user_question':
            return {
                ...base,
                model: {
                    visible: true,
                    isExpanded: true,
                    generatedAt: Date.now(),
                    collapsed: {
                        title: 'Claude asks',
                        statusText: 'Question waiting',
                        defaultTarget: 'open-session:qa-session-question',
                        sessionCount: 1,
                        primaryCardKind: 'user_question',
                        accentText: 'AskUserQuestion',
                    },
                    expanded: {
                        title: 'Questions',
                        rows: [],
                        cards: [
                            {
                                id: `question:${desktopActivityOverlayQaCardSeedIds.user_question}`,
                                kind: 'user_question',
                                requestId: desktopActivityOverlayQaCardSeedIds.user_question,
                                sessionId: 'qa-session-question',
                                title: 'Which deployment target?',
                                body: 'Choose the target before continuing.',
                                summary: 'Choose the target before continuing.',
                                questionText: 'Which deployment target?',
                                badgeText: 'AskUserQuestion',
                                toolLabel: 'Claude asks',
                                count: 3,
                                openActionIdentifier: 'open-session:qa-session-question',
                                actions: [
                                    {
                                        id: 'production',
                                        label: 'Production',
                                        actionIdentifier: 'session.user_action.answer',
                                        data: {
                                            sessionId: 'qa-session-question',
                                            requestId: desktopActivityOverlayQaCardSeedIds.user_question,
                                            answers: [
                                                {
                                                    question: 'Which deployment target?',
                                                    answer: 'Production',
                                                },
                                            ],
                                        },
                                        tone: 'primary',
                                    },
                                    {
                                        id: 'staging',
                                        label: 'Staging',
                                        actionIdentifier: 'session.user_action.answer',
                                        data: {
                                            sessionId: 'qa-session-question',
                                            requestId: desktopActivityOverlayQaCardSeedIds.user_question,
                                            answers: [
                                                {
                                                    question: 'Which deployment target?',
                                                    answer: 'Staging',
                                                },
                                            ],
                                        },
                                        tone: 'primary',
                                    },
                                    {
                                        id: 'open',
                                        label: 'Open',
                                        actionIdentifier: 'open-session:qa-session-question',
                                        data: {
                                            sessionId: 'qa-session-question',
                                            requestId: desktopActivityOverlayQaCardSeedIds.user_question,
                                        },
                                        tone: 'primary',
                                    },
                                ],
                            },
                        ],
                    },
                    window: DEFAULT_WINDOW,
                },
            };
        case 'quota_summary':
            return {
                ...base,
                model: {
                    visible: true,
                    isExpanded: true,
                    generatedAt: Date.now(),
                    collapsed: {
                        title: 'Quota update',
                        statusText: 'Usage summary',
                        defaultTarget: 'open-inbox',
                        sessionCount: null,
                        primaryCardKind: 'quota_summary',
                    },
                    expanded: {
                        title: 'Usage',
                        rows: [],
                        cards: [
                            {
                                kind: 'quota_summary',
                                id: desktopActivityOverlayQaCardSeedIds.quota_summary,
                                title: '5h left today',
                                body: '7% remaining in the rolling window.',
                                summary: '7% remaining in the rolling window.',
                            },
                        ],
                    },
                    window: DEFAULT_WINDOW,
                },
            };
        case 'multi_session_list': {
            const rows = [
                buildSessionOverviewRow({
                    sessionId: 'qa-session-alpha',
                    title: 'backend server',
                    subtitle: 'Needs review',
                    statusText: 'Running',
                    previewText: 'Waiting on a merge decision',
                }),
                buildSessionOverviewRow({
                    sessionId: 'qa-session-beta',
                    title: 'optimize queries',
                    subtitle: 'All green',
                    statusText: 'Ready',
                    previewText: 'Benchmarks improved by 18%',
                }),
                buildSessionOverviewRow({
                    sessionId: 'qa-session-gamma',
                    title: 'fix auth bug',
                    subtitle: 'Permission required',
                    statusText: 'Attention',
                    previewText: 'Approval is required before editing middleware',
                }),
            ];

            return {
                ...base,
                model: {
                    visible: true,
                    isExpanded: true,
                    generatedAt: Date.now(),
                    collapsed: {
                        title: '3 active sessions',
                        statusText: 'Inbox ready',
                        defaultTarget: 'open-inbox',
                        sessionCount: 3,
                        primaryCardKind: 'multi_session_list',
                    },
                    expanded: {
                        title: 'Inbox',
                        rows,
                        cards: [
                            {
                                kind: 'multi_session_list',
                                id: 'list',
                                title: 'Inbox',
                                rows,
                            },
                        ],
                    },
                    window: DEFAULT_WINDOW,
                },
            };
        }
        case 'completion_state':
            return {
                ...base,
                model: {
                    visible: true,
                    isExpanded: true,
                    generatedAt: Date.now(),
                    collapsed: {
                        title: 'Completed',
                        statusText: 'Work finished',
                        defaultTarget: 'open-inbox',
                        sessionCount: null,
                        primaryCardKind: 'completion_state',
                    },
                    expanded: {
                        title: 'Completed',
                        rows: [],
                        cards: [
                            {
                                kind: 'completion_state',
                                id: desktopActivityOverlayQaCardSeedIds.completion_state,
                                sessionId: 'qa-session-completed',
                                title: 'Task completed',
                                body: 'All requested changes were applied successfully.',
                                summary: 'All requested changes were applied successfully.',
                                openActionIdentifier: 'open-session:qa-session-completed',
                                actions: [
                                    {
                                        id: 'open',
                                        label: 'Open',
                                        actionIdentifier: 'open-session:qa-session-completed',
                                        data: {
                                            sessionId: 'qa-session-completed',
                                        },
                                        tone: 'primary',
                                    },
                                ],
                            },
                        ],
                    },
                    window: DEFAULT_WINDOW,
                },
            };
        default:
            throw new Error(`Unsupported desktop overlay QA fixture mode: ${String(mode)}`);
    }
}
