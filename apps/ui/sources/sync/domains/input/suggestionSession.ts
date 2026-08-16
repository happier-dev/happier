import { resolveAgentIdFromFlavor, type AgentId } from '@/agents/registry/registryCore';
import { resolveServerIdForSessionIdFromLocalState } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import { isUserFacingSession } from '@/sync/domains/session/listing/isUserFacingSession';
import { storage } from '@/sync/domains/state/storage';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';

/**
 * The `@session` picker's candidate source (D-7).
 *
 * It is a narrow projection over the session-listing store: seven declared fields, read
 * imperatively at query time exactly like the vendor-plugin and skill catalogs. It never
 * touches a whole `Session` record, and it reads no turn, thinking, presence, runtime-activity
 * or seq field — so the churn those produce cannot reach the composer.
 *
 * `collectVoiceSessionRows` was rejected as the source: it makes four full passes over four
 * different state maps, rebuilds a Map and re-sorts on every call, and it would run on every
 * keystroke here.
 *
 * `sessionListIndexSessionRows.ts#resolveSessionRowForIndexItem` is NOT reused: it maps a
 * *visible list index* item to a renderable through a `ResolveSessionListIndexRow` callback the
 * list shell owns. The by-server cache read below already holds the resolved renderable, so
 * going through the index would add the shell's visibility model — a different question from
 * "which sessions live on this server".
 */

/** The declared projection. A field outside this set must not be read from a session record. */
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

export type ComposerSessionSuggestionState = Readonly<{
    sessions?: Record<string, { serverId?: unknown } | null> | null;
    sessionListViewDataByServerId?: Record<string, SessionListViewItem[] | null> | null;
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
    // Deliberately the plain metadata path, not `getSessionSubtitle`: that resolves a
    // handed-off machine target through a second store read per row, and this label is
    // advisory row text the picker recomputes on every keystroke.
    const workspaceLabel = path ? formatPathRelativeToHome(path, metadata?.homeDir ?? undefined) : null;
    const flavor = normalizeTrimmed(metadata?.flavor);
    return {
        id: session.id,
        title: getSessionName(session),
        workspaceLabel,
        agentLabel: flavor,
        agentId: resolveAgentIdFromFlavor(flavor),
        updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : 0,
        active: session.active === true,
    };
}

/**
 * Which sessions a composer may reference.
 *
 * The two questions are separate, and only a host with a session can answer both from one id:
 *
 * - `serverId` — the server whose sessions are referenceable. A host that has no session yet
 *   (the new-session composer) declares the server its session will spawn on; a host that has
 *   one leaves it `null` and the current session's server is used.
 * - `currentSessionId` — the session doing the referencing, excluded from the results. `null`
 *   when there is none, which excludes nothing. That is not a degraded case: a message composed
 *   before its session exists has nothing to exclude.
 */
export type ComposerSessionSuggestionScope = Readonly<{
    serverId: string | null;
    currentSessionId: string | null;
}>;

/**
 * Same-server only (D-8): the agent action path authenticates with the CLI's own credentials
 * and takes no `serverId`, so a reference to another server's session could never be acted on.
 * The current session is excluded too — a message cannot usefully reference itself, and INV-7
 * forbids the client redirecting it.
 *
 * Archived sessions are excluded; inactive and offline ones are kept, because "the session I
 * was working in an hour ago" is the common case and its id stays valid.
 *
 * With no resolvable server this suggests nothing, deliberately: offering a session the agent
 * could never reach is worse than offering none, and "any server" is exactly what D-8 forbids.
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

    const items = state.sessionListViewDataByServerId?.[serverId];
    if (!Array.isArray(items)) return [];

    const seen = new Set<string>();
    const projected: ComposerSessionSuggestionItem[] = [];
    for (const item of items) {
        if (!item || item.type !== 'session') continue;
        const session = item.session;
        const id = normalizeTrimmed(session?.id);
        if (!id || id === currentSessionId || seen.has(id)) continue;
        if (session.archivedAt != null) continue;
        if (!isUserFacingSession(session)) continue;
        seen.add(id);
        projected.push(projectSession(session));
    }

    // Deterministic, and the order a user means by "the session I was just in". The order is
    // NOT snapshotted for the lifetime of an open picker: the resolver has no picker-lifecycle
    // signal, and INV-6 already makes selection follow candidate identity rather than index,
    // which is the harm a snapshot would have prevented.
    return projected.sort((left, right) => (right.updatedAt - left.updatedAt) || left.id.localeCompare(right.id));
}

export function readComposerSessionSuggestionItems(
    scope: ComposerSessionSuggestionScope,
): readonly ComposerSessionSuggestionItem[] {
    const state = storage.getState();
    return projectComposerSessionSuggestionItems(
        {
            sessions: state?.sessions ?? null,
            sessionListViewDataByServerId: state?.sessionListViewDataByServerId ?? null,
        },
        scope,
    );
}

/**
 * The display half of the token: `<slug>-<idTail>`.
 *
 * The id tail is what makes two identically titled sessions distinguishable on screen and what
 * keeps the token re-parsing to its own kind (INV-3). It is NOT identity — the reference
 * carries the full session id — so a rename changes the token a user sees next time without
 * invalidating anything already sent.
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
