import {
    desktopActivityOverlayQaCardSeedIds,
} from '../ui/shared/desktopActivityOverlaySelectors.mjs';

/** @typedef {Omit<import('../presentation/buildDesktopActivityOverlayModel').DesktopActivityOverlayModel, 'generatedAt'>} DesktopActivityOverlayQaModel */

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

const QA_SERVER_ID = 'qa-server';

function seedSession(params) {
    return {
        sessionId: params.sessionId,
        serverId: QA_SERVER_ID,
        title: params.title,
        subtitle: params.subtitle ?? null,
        statusText: params.statusText ?? null,
        previewText: params.previewText ?? null,
        tone: params.tone ?? 'neutral',
        agentId: params.agentId ?? 'claude',
        machineId: null,
    };
}

function seedCollapsed(params) {
    return {
        title: params.title,
        statusText: params.subtitle ?? null,
        defaultTarget: params.defaultTarget,
        sessionCount: params.sessionCount ?? null,
        primaryCardKind: params.primaryCardKind,
        activity: params.level === 'needs_you' ? 'needsYou' : params.level === 'running' ? 'working' : 'quiet',
    };
}

function seedModel(params) {
    return {
        visible: true,
        faces: { faces: [], overflowCount: 0 },
        conversation: null,
        collapsed: params.collapsed,
        expanded: {
            title: 'Sessions',
            rows: params.rows ?? [],
            cards: params.cards,
        },
    };
}

function openAction(sessionId, extra = {}) {
    return {
        id: 'open',
        label: 'Open',
        actionIdentifier: `open-session:${sessionId}`,
        data: { sessionId, serverId: QA_SERVER_ID, ...extra },
        tone: 'secondary',
    };
}

/**
 * QA seeds shaped like what `buildDesktopActivityOverlayModel` produces for real Sessions: the app's
 * status words, a body only when it adds a fact, one primary action per card, and rows that carry their
 * state tone and Agent. Card ids stay the stable QA ids the MCP QA plan selects.
 *
 * @returns {DesktopActivityOverlayQaModel}
 */
export function buildDesktopActivityOverlayQaModel(mode) {
    switch (mode) {
        case 'idle':
            return seedModel({
                collapsed: seedCollapsed({ title: 'Sessions', defaultTarget: 'open-inbox', primaryCardKind: 'idle_state', level: 'idle' }),
                cards: [{ id: 'idle', kind: 'idle_state', title: 'Sessions' }],
            });
        case 'active_session': {
            const session = seedSession({
                sessionId: 'qa-session-active',
                title: 'Speed up the Session list',
                subtitle: 'happier/app',
                statusText: 'Working',
                previewText: 'Profiling the row renderer with 2,000 Sessions',
            });
            return seedModel({
                collapsed: seedCollapsed({
                    title: 'Working',
                    subtitle: session.title,
                    defaultTarget: `open-session:${session.sessionId}`,
                    sessionCount: 1,
                    primaryCardKind: 'session_overview',
                    level: 'running',
                }),
                rows: [session],
                cards: [{
                    id: 'session:qa-session-active',
                    kind: 'session_overview',
                    ...session,
                    attentionState: 'thinking',
                    active: true,
                    updatedAt: 1,
                }],
            });
        }
        case 'attention_only': {
            const sessionId = 'qa-session-review';
            return seedModel({
                collapsed: seedCollapsed({
                    title: 'Needs you',
                    subtitle: 'Run rm -rf build/ dist/',
                    defaultTarget: `open-session:${sessionId}`,
                    sessionCount: 1,
                    primaryCardKind: 'permission_request',
                    level: 'needs_you',
                }),
                rows: [seedSession({ sessionId, title: 'Clean release artifacts', subtitle: 'happier/cli', statusText: 'Needs you', tone: 'attention' })],
                cards: [{
                    id: `permission:${desktopActivityOverlayQaCardSeedIds.permission_request}-review`,
                    kind: 'permission_request',
                    requestId: `${desktopActivityOverlayQaCardSeedIds.permission_request}-review`,
                    sessionId,
                    serverId: QA_SERVER_ID,
                    title: 'Run rm -rf build/ dist/',
                    body: 'Deletes two folders in happier/cli. Review it in the Session before allowing.',
                    summary: 'Run rm -rf build/ dist/',
                    toolLabel: 'Bash',
                    questionText: null,
                    count: 1,
                    risk: 'high',
                    openActionIdentifier: `open-session:${sessionId}`,
                    denyActionIdentifier: 'session.permission.respond',
                    actions: [
                        {
                            id: 'deny',
                            label: 'Deny',
                            actionIdentifier: 'session.permission.respond',
                            data: { sessionId, serverId: QA_SERVER_ID, requestId: `${desktopActivityOverlayQaCardSeedIds.permission_request}-review`, decision: 'deny' },
                            tone: 'danger',
                        },
                        openAction(sessionId),
                    ],
                }],
            });
        }
        case 'permission_request': {
            const sessionId = 'qa-session-permission';
            const requestId = desktopActivityOverlayQaCardSeedIds.permission_request;
            return seedModel({
                collapsed: seedCollapsed({
                    title: 'Needs you',
                    subtitle: 'Edit src/auth/middleware.ts',
                    defaultTarget: `open-session:${sessionId}`,
                    sessionCount: 1,
                    primaryCardKind: 'permission_request',
                    level: 'needs_you',
                }),
                rows: [seedSession({ sessionId, title: 'Fix the token refresh race', subtitle: 'happier/server', statusText: 'Needs you', tone: 'attention' })],
                cards: [{
                    id: `permission:${requestId}`,
                    kind: 'permission_request',
                    requestId,
                    sessionId,
                    serverId: QA_SERVER_ID,
                    title: 'Edit src/auth/middleware.ts',
                    body: 'Moves the refresh check before the session lookup (+12 −4).',
                    summary: 'Edit src/auth/middleware.ts',
                    statusText: 'Edit src/auth/middleware.ts',
                    badgeText: 'Edit',
                    toolLabel: 'Edit',
                    questionText: null,
                    count: 1,
                    risk: 'low',
                    openActionIdentifier: `open-session:${sessionId}`,
                    allowActionIdentifier: 'session.permission.respond',
                    denyActionIdentifier: 'session.permission.respond',
                    actions: [
                        {
                            id: 'deny',
                            label: 'Deny',
                            actionIdentifier: 'session.permission.respond',
                            data: { sessionId, serverId: QA_SERVER_ID, requestId, decision: 'deny' },
                            tone: 'danger',
                        },
                        {
                            id: 'allow',
                            label: 'Allow',
                            actionIdentifier: 'session.permission.respond',
                            data: { sessionId, serverId: QA_SERVER_ID, requestId, decision: 'allow' },
                            tone: 'primary',
                        },
                        openAction(sessionId, { requestId }),
                    ],
                }],
            });
        }
        case 'user_question': {
            const sessionId = 'qa-session-question';
            const requestId = desktopActivityOverlayQaCardSeedIds.user_question;
            const question = 'Which environment should the migration run against first?';
            const answer = (id, label) => ({
                id: `option-${id}`,
                label,
                actionIdentifier: 'session.user_action.answer',
                data: { sessionId, serverId: QA_SERVER_ID, requestId, answers: [{ question, answer: label }] },
                tone: 'secondary',
            });
            return seedModel({
                collapsed: seedCollapsed({
                    title: 'Needs you',
                    subtitle: question,
                    defaultTarget: `open-session:${sessionId}`,
                    sessionCount: 1,
                    primaryCardKind: 'user_question',
                    level: 'needs_you',
                }),
                rows: [seedSession({ sessionId, title: 'Add Account audit log', subtitle: 'happier/server', statusText: 'Needs you', tone: 'attention', agentId: 'codex' })],
                cards: [{
                    id: `question:${requestId}`,
                    kind: 'user_question',
                    requestId,
                    sessionId,
                    serverId: QA_SERVER_ID,
                    title: question,
                    body: null,
                    summary: question,
                    questionText: question,
                    badgeText: null,
                    toolLabel: 'Question',
                    count: 1,
                    openActionIdentifier: `open-session:${sessionId}`,
                    actions: [answer(1, 'Staging'), answer(2, 'Production'), openAction(sessionId, { requestId })],
                }],
            });
        }
        case 'quota_summary':
            return seedModel({
                collapsed: seedCollapsed({ title: 'Claude usage', subtitle: '7% left in this window', defaultTarget: 'open-inbox', primaryCardKind: 'quota_summary', level: 'idle' }),
                cards: [{
                    kind: 'quota_summary',
                    id: desktopActivityOverlayQaCardSeedIds.quota_summary,
                    title: 'Claude usage',
                    body: '7% left in this window. It resets at 18:00.',
                    summary: '7% left in this window. It resets at 18:00.',
                }],
            });
        case 'multi_session_list': {
            const rows = [
                seedSession({ sessionId: 'qa-session-alpha', title: 'Fix the token refresh race', subtitle: 'happier/server', statusText: 'Needs you', tone: 'attention' }),
                seedSession({ sessionId: 'qa-session-beta', title: 'Speed up the Session list', subtitle: 'happier/app', statusText: 'Working', agentId: 'codex' }),
                seedSession({ sessionId: 'qa-session-gamma', title: 'Release notes for 0.3', subtitle: 'happier/docs', statusText: 'Finished' }),
            ];
            return seedModel({
                collapsed: seedCollapsed({
                    title: 'Needs you',
                    subtitle: rows[0].title,
                    defaultTarget: 'open-inbox',
                    sessionCount: 3,
                    primaryCardKind: 'multi_session_list',
                    level: 'needs_you',
                }),
                rows,
                cards: [{ kind: 'multi_session_list', id: 'list', title: 'Sessions', rows }],
            });
        }
        case 'completion_state': {
            const sessionId = 'qa-session-completed';
            return seedModel({
                collapsed: seedCollapsed({
                    title: 'Finished',
                    subtitle: 'Release notes for 0.3',
                    defaultTarget: `open-session:${sessionId}`,
                    sessionCount: 1,
                    primaryCardKind: 'completion_state',
                    level: 'ready',
                }),
                rows: [seedSession({ sessionId, title: 'Release notes for 0.3', subtitle: 'happier/docs', statusText: 'Finished' })],
                cards: [{
                    kind: 'completion_state',
                    id: desktopActivityOverlayQaCardSeedIds.completion_state,
                    sessionId,
                    serverId: QA_SERVER_ID,
                    title: 'Release notes for 0.3',
                    body: 'Turn finished. Open the session to continue.',
                    summary: 'Turn finished. Open the session to continue.',
                    openActionIdentifier: `open-session:${sessionId}`,
                    variant: 'turn_complete',
                    autoDismissMs: 15_000,
                    sticky: false,
                    actions: [{ ...openAction(sessionId), tone: 'primary' }],
                }],
            });
        }
        default:
            throw new Error(`Unsupported desktop overlay QA fixture mode: ${String(mode)}`);
    }
}
