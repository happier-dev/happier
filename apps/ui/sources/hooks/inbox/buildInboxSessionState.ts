import type { Session } from '@/sync/domains/state/storageTypes';
import { deriveSessionAttentionState, deriveSessionAttentionFlags } from '@/sync/domains/session/attention/sessionAttention';
import { deriveSessionRuntimePresentationState } from '@/sync/domains/session/attention/runtimePresentation';
import { readStoredSessionMessagesFromStateLike } from '@/sync/domains/messages/readStoredSessionMessages';
import {
    deriveLatestPendingRequestObservedAtFromSession,
    derivePendingRequestFlagsFromSession,
} from '@/sync/domains/session/pending/listPendingSessionRequests';
import { listPendingPermissionRequests, listPendingUserActionRequests, type PendingPermissionRequest } from '@/utils/sessions/sessionUtils';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import {
    buildSessionFromListRenderable,
    isSessionListRenderableNewerThanSession,
} from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import type { SessionListAttentionRow } from '@/sync/domains/state/storage';
import type { StorageState } from '@/sync/store/types';
import { isVoiceConversationCustodySessionMetadata } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

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
        sessionMessagesById?: StorageState['sessionMessages'];
        nowMs?: number;
    }>;

function normalizeBuildInboxSessionStateInput(input: BuildInboxSessionStateInput): Readonly<{
    sessions: readonly Session[];
    sessionRows: readonly InboxUnreadSessionRow[];
    sessionMessagesById?: StorageState['sessionMessages'];
    nowMs: number;
}> {
    if ('sessions' in input) {
        return {
            sessions: input.sessions,
            sessionRows: normalizeInboxUnreadSessionRows(
                input.sessionRows && input.sessionRows.length > 0 ? input.sessionRows : input.sessions,
            ),
            sessionMessagesById: input.sessionMessagesById,
            nowMs: typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? input.nowMs : Date.now(),
        };
    }
    return { sessions: input, sessionRows: normalizeInboxUnreadSessionRows(input), nowMs: Date.now() };
}

function normalizeOptionalString(value: string | null | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized ? normalized : null;
}

function buildInboxSessionScopeKey(serverId: string | null | undefined, sessionId: string): string {
    return `${normalizeOptionalString(serverId) ?? 'local'}:${sessionId}`;
}

function getSessionServerId(session: InboxUnreadSession): string | null {
    return normalizeOptionalString('serverId' in session ? session.serverId as string | null | undefined : null);
}

function getInboxRowScopeKey(row: InboxUnreadSessionRow): string {
    return buildInboxSessionScopeKey(row.serverId, row.session.id);
}

function getSessionScopeKey(session: InboxUnreadSession): string {
    return buildInboxSessionScopeKey(getSessionServerId(session), session.id);
}

function isSessionListAttentionRow(input: InboxUnreadSessionInput): input is SessionListAttentionRow {
    return 'session' in input && input.session != null && typeof input.session === 'object';
}

function isInboxSessionListRenderable(
    session: InboxUnreadSession,
): session is SessionListRenderableSession {
    return !('agentState' in session);
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

function readMessagesForInboxSession(
    sessionMessagesById: StorageState['sessionMessages'] | undefined,
    sessionId: string,
) {
    return readStoredSessionMessagesFromStateLike(sessionMessagesById?.[sessionId]);
}

function hasFreshPendingInboxAttention(params: Readonly<{
    session: Session;
    messages: ReturnType<typeof readMessagesForInboxSession>;
    nowMs: number;
}>): boolean {
    const pendingFlags = derivePendingRequestFlagsFromSession(params.session, params.messages);
    if (!pendingFlags.hasPendingPermissionRequests && !pendingFlags.hasPendingUserActionRequests) return false;
    const runtimePresentation = deriveSessionRuntimePresentationState({
        active: params.session.active,
        activeAt: params.session.activeAt,
        presence: params.session.presence,
        thinking: params.session.thinking,
        thinkingAt: params.session.thinkingAt,
        latestTurnStatus: params.session.latestTurnStatus ?? null,
        latestTurnStatusObservedAt: params.session.latestTurnStatusObservedAt ?? null,
        meaningfulActivityAt: params.session.meaningfulActivityAt ?? null,
        lastRuntimeIssue: params.session.lastRuntimeIssue ?? null,
        hasPendingPermissionRequests: pendingFlags.hasPendingPermissionRequests,
        hasPendingUserActionRequests: pendingFlags.hasPendingUserActionRequests,
        pendingRequestObservedAt: deriveLatestPendingRequestObservedAtFromSession(
            params.session,
            params.messages,
        ),
        nowMs: params.nowMs,
    });
    return runtimePresentation.freshPermissionRequired || runtimePresentation.freshActionRequired;
}

function resolveInboxRowSession(
    row: InboxUnreadSessionRow,
    sessionsByScope: ReadonlyMap<string, Session>,
): InboxUnreadSession {
    const canonicalSession = sessionsByScope.get(getInboxRowScopeKey(row));
    if (!canonicalSession) return row.session;

    if (
        isInboxSessionListRenderable(row.session)
        && isSessionListRenderableNewerThanSession(row.session, canonicalSession)
    ) {
        return buildSessionFromListRenderable(row.session, {
            baseSession: canonicalSession,
            serverId: row.serverId,
        });
    }

    return canonicalSession;
}

function buildInboxAttentionSessions(
    sessions: readonly Session[],
    sessionRows: readonly InboxUnreadSessionRow[],
    sessionsByScope: ReadonlyMap<string, Session>,
): readonly Session[] {
    const attentionSessionsByScope = new Map(sessionsByScope);
    const seenRowKeys = new Set<string>();
    for (const row of sessionRows) {
        const rowKey = getInboxRowScopeKey(row);
        if (seenRowKeys.has(rowKey)) continue;
        seenRowKeys.add(rowKey);
        const session = resolveInboxRowSession(row, sessionsByScope);
        if (isInboxSessionListRenderable(session)) {
            if (session.metadataUnavailable === true) continue;
            attentionSessionsByScope.set(
                rowKey,
                buildSessionFromListRenderable(session, { serverId: row.serverId }),
            );
            continue;
        }
        attentionSessionsByScope.set(rowKey, session);
    }
    return Array.from(attentionSessionsByScope.values());
}

function isInboxCustodySession(session: InboxUnreadSession): boolean {
    if (isInboxSessionListRenderable(session)) {
        return (
            isUserFacingSession(session)
            || isVoiceConversationCustodySessionMetadata(session.metadata)
        );
    }
    const ownerMetadata = readSessionOwnerMetadataView(session);
    if (session.metadataLayoutVersion === 1 && ownerMetadata == null) {
        return false;
    }
    const ownerSession = {
        metadata: ownerMetadata,
    };
    return (
        isUserFacingSession(ownerSession)
        || isVoiceConversationCustodySessionMetadata(ownerMetadata)
    );
}

export function buildInboxSessionState(input: BuildInboxSessionStateInput): InboxSessionState {
    const {
        sessions,
        sessionRows,
        sessionMessagesById,
        nowMs,
    } = normalizeBuildInboxSessionStateInput(input);
    const sessionsByScope = new Map(sessions.map((session) => [getSessionScopeKey(session), session]));
    const sessionsNeedingAttention: InboxSessionAttentionEntry[] = [];
    const attentionSessionKeys = new Set<string>();
    const attentionSessions = buildInboxAttentionSessions(sessions, sessionRows, sessionsByScope);

    for (const session of attentionSessions) {
        if (!isInboxCustodySession(session)) continue;
        const messages = readMessagesForInboxSession(sessionMessagesById, session.id);
        const pendingPermissions = listPendingPermissionRequests(session, messages);
        const pendingUserActions = listPendingUserActionRequests(session, messages);
        if (!hasFreshPendingInboxAttention({
            session,
            messages,
            nowMs,
        })) continue;

        attentionSessionKeys.add(getSessionScopeKey(session));
        sessionsNeedingAttention.push({
            session,
            pendingPermissions,
            pendingUserActions,
        });
    }

    const unreadCandidates: InboxUnreadSessionRow[] = [];
    const candidateSessionKeys = new Set<string>();
    for (const row of sessionRows) {
        const key = getInboxRowScopeKey(row);
        if (candidateSessionKeys.has(key)) continue;
        candidateSessionKeys.add(key);
        unreadCandidates.push({
            ...row,
            session: resolveInboxRowSession(row, sessionsByScope),
        });
    }
    for (const session of sessions) {
        const key = getSessionScopeKey(session);
        if (candidateSessionKeys.has(key)) continue;
        candidateSessionKeys.add(key);
        unreadCandidates.push({
            session,
            serverId: getSessionServerId(session),
            serverName: null,
        });
    }

    const unreadSessions: InboxUnreadSessionRow[] = [];
    const unreadSessionKeys = new Set<string>();
    for (const row of unreadCandidates) {
        const key = getInboxRowScopeKey(row);
        if (!isInboxCustodySession(row.session)) continue;
        if (attentionSessionKeys.has(key)) continue;
        if (unreadSessionKeys.has(key)) continue;
        if (!hasUnreadSessionAttention(row.session)) continue;
        unreadSessionKeys.add(key);
        unreadSessions.push(row);
    }

    return {
        unreadSessions,
        sessionsNeedingAttention,
    };
}
