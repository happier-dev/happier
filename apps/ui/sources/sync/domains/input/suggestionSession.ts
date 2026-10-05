import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { readSessionPresentationAgentId } from '@/sync/domains/session/presentation/readSessionPresentationAgentId';
import { storage } from '@/sync/domains/state/storage';
import { resolveServerIdForSessionIdFromLocalState } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { getSessionName } from '@/utils/sessions/sessionUtils';

/**
 * The `@session` picker's candidate source (D-7).
 *
 * The canonical session-list row projection already scopes renderables by server.
 * This is a narrow, imperative projection over that owner: it never reads a whole
 * Session record, transcript, thinking state, or presence. A candidate is a display
 * row, the opaque same-server session identity the structured-input writer persists,
 * and the exact Agent identity plus machine/server scope its machine-qualified Agent
 * mark resolves against.
 */
export type ComposerSessionSuggestionItem = Readonly<{
    id: string;
    title: string;
    workspaceLabel: string | null;
    agentLabel: string | null;
    /**
     * The session's exact declared Agent identity, or `null` when it declares none.
     *
     * The canonical Session presentation reader interprets the active metadata layout:
     * legacy owner metadata retains its supported Agent identity resolution, while
     * layout-v1 reads the strict shared Agent presentation envelope. The resulting exact
     * identity is carried to the machine-scoped catalog, which resolves the mark or uses
     * its neutral fallback.
     */
    agentId: string | null;
    /** The machine the session runs on, for machine-qualified catalog marks. */
    machineId: string | null;
    /** The exact server scope this row was projected for. */
    serverId: string;
    updatedAt: number;
    active: boolean;
}>;

/**
 * The current server resolver owns the ways a session acquires its scope. The
 * session-row map is then the one candidate source: selecting a row from another
 * server would make the relative `session:<id>` reference ambiguous.
 */
export type ComposerSessionSuggestionState = Readonly<
    Parameters<typeof resolveServerIdForSessionIdFromLocalState>[0]
    & {
        sessionListRowsByServerId?: Readonly<
            Record<string, Readonly<Record<string, SessionListRenderableSession>> | null | undefined>
        > | null | undefined;
    }
>;

/**
 * What the `@session` picker is scoped by.
 *
 * - `serverId` — declared by a host that has no session to derive one from (the new-session
 *   composer declares the server its session will spawn on). A host that has a session leaves
 *   it `null` and that session's server is used.
 * - `currentSessionId` — the session doing the referencing, excluded from the results. `null`
 *   when there is none, which excludes nothing: a message composed before its session exists
 *   has nothing to exclude. That is the honest answer, not a degraded one, and it replaces
 *   the `'__new_session__'` sentinel that used to fake a session for this call.
 */
export type ComposerSessionSuggestionScope = Readonly<{
    serverId: string | null;
    currentSessionId: string | null;
    /** A carried Session needs one live row, not a sorted picker catalog per pointer frame. */
    candidateSessionId?: string;
}>;

/** How many id characters the display token carries to disambiguate duplicate titles. */
export const COMPOSER_SESSION_TOKEN_ID_TAIL_LENGTH = 6;

const MAX_SESSION_TOKEN_SLUG_CHARS = 32;

function normalizeTrimmed(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function projectSession(
    session: SessionListRenderableSession,
    serverId: string,
): ComposerSessionSuggestionItem {
    const metadata = session.metadata ?? null;
    const path = normalizeTrimmed(metadata?.path);
    const flavor = normalizeTrimmed(metadata?.flavor);
    return {
        id: session.id,
        title: getSessionName(session, serverId),
        workspaceLabel: path ? formatPathRelativeToHome(path, metadata?.homeDir ?? undefined) : null,
        agentLabel: flavor,
        // Layout-specific identity interpretation belongs to the shared Session
        // presentation reader. In particular, layout-v1 reads only the strict
        // shared Agent presentation envelope rather than owner-only flavor data.
        agentId: readSessionPresentationAgentId(session),
        machineId: normalizeTrimmed(metadata?.machineId),
        serverId,
        updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : 0,
        active: session.active === true,
    };
}

/**
 * Same-server only (D-8): provider dispatch authenticates as the composing
 * session and receives no server override. The current session is excluded
 * because a message cannot usefully reference itself. Archived and hidden system
 * sessions are not user-facing candidates; inactive sessions remain referenceable.
 */
export function projectComposerSessionSuggestionItems(
    state: ComposerSessionSuggestionState,
    scope: ComposerSessionSuggestionScope,
): readonly ComposerSessionSuggestionItem[] {
    const currentSessionId = normalizeTrimmed(scope.currentSessionId);

    // A declared server wins: the host that declared it has already decided which server it
    // targets, and deriving a second answer here would make two owners of one question.
    const serverId = normalizeTrimmed(scope.serverId)
        ?? (currentSessionId ? resolveServerIdForSessionIdFromLocalState(state, currentSessionId) : null);
    if (!serverId) return [];

    const rows = state.sessionListRowsByServerId?.[serverId];
    if (!rows || typeof rows !== 'object') return [];

    const seen = new Set<string>();
    const projected: ComposerSessionSuggestionItem[] = [];
    const candidateSessionId = normalizeTrimmed(scope.candidateSessionId);
    const candidates = candidateSessionId ? [rows[candidateSessionId]] : Object.values(rows);
    for (const session of candidates) {
        if (!session) continue;
        const id = normalizeTrimmed(session?.id);
        if (!id || id === currentSessionId || seen.has(id)) continue;
        if (candidateSessionId && id !== candidateSessionId) continue;
        if (session.archivedAt != null || !isUserFacingSession(session)) continue;
        seen.add(id);
        projected.push(projectSession(session, serverId));
    }

    return projected.sort((left, right) => (right.updatedAt - left.updatedAt) || left.id.localeCompare(right.id));
}

export function readComposerSessionSuggestionItems(
    scope: ComposerSessionSuggestionScope,
): readonly ComposerSessionSuggestionItem[] {
    const state = storage.getState();
    return projectComposerSessionSuggestionItems(
        {
            sessions: state.sessions,
            sessionListIndexByServerId: state.sessionListIndexByServerId,
            sessionListRowsByServerId: state.sessionListRowsByServerId,
        },
        scope,
    );
}

/**
 * The display half of the token is `<slug>-<idTail>`. The full session id is
 * durable identity; the title-derived slug is advisory and changes on rename.
 */
export function buildComposerSessionTokenSlug(
    item: Pick<ComposerSessionSuggestionItem, 'id' | 'title'>,
): string {
    const slug = item.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, MAX_SESSION_TOKEN_SLUG_CHARS)
        .replace(/-+$/g, '');
    const idTail = item.id.slice(-COMPOSER_SESSION_TOKEN_ID_TAIL_LENGTH);
    return `${slug.length > 0 ? slug : 'session'}-${idTail}`;
}
