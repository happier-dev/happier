import { resolveAgentIdFromFlavor, type AgentId } from '@/agents/registry/registryCore';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { storage } from '@/sync/domains/state/storage';
import { resolveServerIdForSessionIdFromLocalState } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { getSessionName } from '@/utils/sessions/sessionUtils';

/**
 * The `@session` picker's candidate source (D-7).
 *
 * The canonical session-list row projection already scopes renderables by server.
 * This is a narrow, imperative projection over that owner: it never reads a whole
 * Session record, transcript, thinking state, presence, or a machine identity.
 * A candidate is therefore only a display row plus the opaque same-server session
 * identity the structured-input writer persists.
 */
export type ComposerSessionSuggestionItem = Readonly<{
    id: string;
    title: string;
    workspaceLabel: string | null;
    agentLabel: string | null;
    /**
     * The provider the picker row draws a logo for, resolved from the same
     * `metadata.flavor` that `agentLabel` carries raw.
     *
     * Resolved HERE rather than at the row, because this projection is the only
     * module that knows the string came from `flavor` — and because `AgentIcon`
     * needs a registry-validated id, so an unresolvable flavor has to stay
     * distinguishable. `null` means this build has no entry for that provider and
     * the row keeps the kind's generic glyph.
     */
    agentId: AgentId | null;
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
        sessionListRowStateByServerId?: Readonly<
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
}>;

/** How many id characters the display token carries to disambiguate duplicate titles. */
export const COMPOSER_SESSION_TOKEN_ID_TAIL_LENGTH = 6;

const MAX_SESSION_TOKEN_SLUG_CHARS = 32;

function normalizeTrimmed(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function projectSession(session: SessionListRenderableSession): ComposerSessionSuggestionItem {
    const metadata = session.metadata ?? null;
    const path = normalizeTrimmed(metadata?.path);
    const flavor = normalizeTrimmed(metadata?.flavor);
    return {
        id: session.id,
        title: getSessionName(session),
        workspaceLabel: path ? formatPathRelativeToHome(path, metadata?.homeDir ?? undefined) : null,
        agentLabel: flavor,
        agentId: resolveAgentIdFromFlavor(flavor),
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

    const rows = state.sessionListRowStateByServerId?.[serverId];
    if (!rows || typeof rows !== 'object') return [];

    const seen = new Set<string>();
    const projected: ComposerSessionSuggestionItem[] = [];
    for (const session of Object.values(rows)) {
        const id = normalizeTrimmed(session?.id);
        if (!id || id === currentSessionId || seen.has(id)) continue;
        if (session.archivedAt != null || !isUserFacingSession(session)) continue;
        seen.add(id);
        projected.push(projectSession(session));
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
            concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
            sessionListRowStateByServerId: state.sessionListRowStateByServerId,
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
