import type { Session } from '@/sync/domains/state/storageTypes';
import { deriveSessionAttentionState, deriveSessionAttentionFlags } from '@/sync/domains/session/attention/sessionAttention';
import { listPendingPermissionRequests, listPendingUserActionRequests, type PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListAttentionRow } from '@/sync/domains/state/storage';

export type InboxSessionAttentionEntry = Readonly<{
    session: Session;
    pendingPermissions: readonly PendingPermissionRequest[];
    pendingUserActions: readonly PendingPermissionRequest[];
}>;

export type InboxUnreadSession = Session | SessionListRenderableSession;
export type InboxUnreadSessionRow = Readonly<{
    session: InboxUnreadSession;
    serverId: string | null;
    serverName: string | null;
}>;

export type InboxSessionState = Readonly<{
    unreadSessions: InboxUnreadSessionRow[];
    sessionsNeedingAttention: InboxSessionAttentionEntry[];
}>;

type InboxUnreadSessionInput = InboxUnreadSession | SessionListAttentionRow;

type BuildInboxSessionStateInput =
    | readonly Session[]
    | Readonly<{
        sessions: readonly Session[];
        sessionRows?: readonly InboxUnreadSessionInput[];
    }>;

function normalizeBuildInboxSessionStateInput(input: BuildInboxSessionStateInput): Readonly<{
    sessions: readonly Session[];
    sessionRows: readonly InboxUnreadSessionRow[];
}> {
    if ('sessions' in input) {
        return {
            sessions: input.sessions,
            sessionRows: normalizeInboxUnreadSessionRows(
                input.sessionRows && input.sessionRows.length > 0 ? input.sessionRows : input.sessions,
            ),
        };
    }
    return { sessions: input, sessionRows: normalizeInboxUnreadSessionRows(input) };
}

function normalizeOptionalString(value: string | null | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized ? normalized : null;
}

function isSessionListAttentionRow(input: InboxUnreadSessionInput): input is SessionListAttentionRow {
    return 'session' in input && input.session != null && typeof input.session === 'object';
}

function normalizeInboxUnreadSessionRows(
    sessions: readonly InboxUnreadSessionInput[],
): InboxUnreadSessionRow[] {
    return sessions.map((input) => {
        if (isSessionListAttentionRow(input)) {
            return {
                session: input.session,
                serverId: normalizeOptionalString(input.serverId),
                serverName: normalizeOptionalString(input.serverName),
            };
        }

        return {
            session: input,
            serverId: normalizeOptionalString('serverId' in input ? input.serverId as string | null | undefined : null),
            serverName: null,
        };
    });
}

function hasUnreadSessionAttention(session: InboxUnreadSession): boolean {
    if ('metadataUnavailable' in session && session.metadataUnavailable === true) {
        return false;
    }
    const centralAttention = deriveSessionAttentionState({
        latestTurnStatus: 'latestTurnStatus' in session ? session.latestTurnStatus : null,
        lastRuntimeIssue: 'lastRuntimeIssue' in session ? session.lastRuntimeIssue : null,
    });
    if (centralAttention === 'failed') return true;
    if ('hasUnreadMessages' in session && typeof session.hasUnreadMessages === 'boolean') {
        return session.hasUnreadMessages;
    }
    if (!('agentState' in session)) {
        return false;
    }
    return deriveSessionAttentionFlags(session, {
        showPendingPermissionRequests: false,
        showPendingUserActionRequests: false,
        showQueuedUserInput: false,
    }).hasUnread;
}

export function buildInboxSessionState(input: BuildInboxSessionStateInput): InboxSessionState {
    const { sessions, sessionRows } = normalizeBuildInboxSessionStateInput(input);
    const sessionsById = new Map(sessions.map((session) => [session.id, session]));
    const sessionsNeedingAttention: InboxSessionAttentionEntry[] = [];
    const attentionSessionIds = new Set<string>();

    for (const session of sessions) {
        if (!isUserFacingSession(session)) continue;
        if (session.presence !== 'online') continue;
        const pendingPermissions = listPendingPermissionRequests(session);
        const pendingUserActions = listPendingUserActionRequests(session);
        if (pendingPermissions.length === 0 && pendingUserActions.length === 0) continue;

        attentionSessionIds.add(session.id);
        sessionsNeedingAttention.push({
            session,
            pendingPermissions,
            pendingUserActions,
        });
    }

    const unreadCandidates: InboxUnreadSessionRow[] = [];
    const candidateSessionIds = new Set<string>();
    for (const row of sessionRows) {
        const sessionId = row.session.id;
        if (candidateSessionIds.has(sessionId)) continue;
        candidateSessionIds.add(sessionId);
        unreadCandidates.push({
            ...row,
            session: sessionsById.get(sessionId) ?? row.session,
        });
    }
    for (const session of sessions) {
        if (candidateSessionIds.has(session.id)) continue;
        candidateSessionIds.add(session.id);
        unreadCandidates.push({
            session,
            serverId: normalizeOptionalString('serverId' in session ? session.serverId as string | null | undefined : null),
            serverName: null,
        });
    }

    const unreadSessions: InboxUnreadSessionRow[] = [];
    const unreadSessionIds = new Set<string>();
    for (const row of unreadCandidates) {
        const sessionId = row.session.id;
        if (!isUserFacingSession(row.session)) continue;
        if (attentionSessionIds.has(sessionId)) continue;
        if (unreadSessionIds.has(sessionId)) continue;
        if (!hasUnreadSessionAttention(row.session)) continue;
        unreadSessionIds.add(sessionId);
        unreadSessions.push(row);
    }

    return {
        unreadSessions,
        sessionsNeedingAttention,
    };
}
