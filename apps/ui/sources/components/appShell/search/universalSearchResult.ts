import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import type { FileTargetAnchor } from '@/utils/url/sessionFileDeepLink';
import type { ReviewCommentSource } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { FileFindSeed as FindSeed } from '@/components/appShell/panes/fileFindSeedHandoff';

/**
 * The small UI-internal normalized boundary for built-in Universal Search rows.
 *
 * It exists for exactly one reason: to keep the EXACT target facts an activation
 * owner needs — which Home/server, which machine, which workspace root, which
 * session and sequence — out of the React option the list renders. It is not a
 * wire protocol, not a persisted model, not an SDK type, and deliberately
 * carries no score: cross-provider score comparison is impossible if no score
 * ever exists here.
 *
 * Plugin providers do NOT pass through this type. They already have their own
 * strict public schema and their own declared activation command, so routing
 * them through a second host-internal shape would only add a translation with
 * no owner.
 */

export type UniversalSearchTarget =
    /**
     * `serverId` is the Home the row was FOUND on, captured at request time. It
     * is never re-derived from focus at activation, so focusing Home A while a
     * Home B result is open cannot retarget the navigation.
     */
    | Readonly<{ kind: 'session'; serverId: string; accountId: string; sessionId: string; seq?: number }>
    | Readonly<{
        kind: 'project';
        workspaceRefId: string;
        serverId: string;
        accountId: string;
        machineId: string;
        rootPath: string;
    }>
    | Readonly<{ kind: 'settingsPage'; route: string }>
    /**
     * Workspace rows carry the whole `{ serverId, machineId, rootPath }` tuple
     * plus the saved WorkspaceRef or Session that addressed it. Saved projects
     * and Sessions share the canonical workspace details renderers, while a
     * machine id is only unique within its server.
     */
    | Readonly<{
        kind: 'workspaceFile';
        scope: WorkspaceScopeBase;
        path: string;
        anchor?: FileTargetAnchor;
        anchorSource?: ReviewCommentSource;
        find?: FindSeed;
        workspaceRefId: string | null;
        sessionId: string | null;
        serverId: string | null;
        accountId: string;
    }>
    | Readonly<{
        kind: 'workspaceCommit';
        scope: WorkspaceScopeBase;
        sha: string;
        workspaceRefId: string | null;
        sessionId: string | null;
        serverId: string | null;
        accountId: string;
    }>;

export type UniversalSearchResult = Readonly<{
    /** Stable within its own source AND its own scope; never unique on its own. */
    id: string;
    /**
     * The exact target the row was produced under — Home/server, machine,
     * workspace root, plugin generation. It is a REQUIRED part of the rendered
     * identity, not a convention: the same session id exists on two Homes, the
     * same repo-relative path exists in two checkouts, and the same commit SHA
     * exists in two clones. Without the scope in the id, publishing Home B's
     * rows while Home A's selection is held would move the selection onto a
     * different entity that merely shares a source-local id.
     */
    scopeKey: string;
    /** Host-owned, source-qualified section identity. */
    sourceId: string;
    /** Presentation discriminator only. */
    kind: string;
    title: string;
    subtitle?: string;
    searchText?: string;
    exactSearchText?: string;
    fileContent?: Readonly<{ path: string; line: number; column16: number; length16: number; text: string; before: readonly string[]; after: readonly string[] }>;
    target: UniversalSearchTarget;
}>;

/** Separates the host's section identity, the target scope and the row id. */
const UNIVERSAL_SEARCH_ROW_ID_SEPARATOR = '::';

/**
 * The rendered option id: source, then exact target scope, then source-local id.
 *
 * The source namespace lets the selected row survive a SIBLING section
 * publishing, erroring or reordering underneath it. The scope segment lets it
 * survive a TARGET change: a Home, machine, workspace or plugin-generation
 * switch produces different ids for the same source-local entity, so a stale
 * selection resolves to nothing instead of silently landing on another Home's
 * session. It composes one string — there is no identity registry to consult.
 */
export function buildUniversalSearchOptionId(
    sourceId: string,
    scopeKey: string,
    id: string,
): string {
    return [sourceId, scopeKey, id].join(UNIVERSAL_SEARCH_ROW_ID_SEPARATOR);
}

/** Compose a stable scope segment from the parts a target actually has. */
export function buildUniversalSearchScopeKey(
    parts: ReadonlyArray<string | number | null | undefined>,
): string {
    // Length-prefixed so `a|b` and `ab|` cannot collapse into one key.
    return parts
        .map((part) => (part === null || part === undefined ? '' : String(part)))
        .map((part) => `${part.length}:${part}`)
        .join('');
}

/** Key session display metadata by the same exact Home/session scope as its result. */
export function buildUniversalSearchSessionTitleKey(
    accountId: string,
    serverId: string,
    sessionId: string,
): string {
    return buildUniversalSearchScopeKey([accountId, serverId, sessionId]);
}

export const UNIVERSAL_SEARCH_SOURCE_IDS = Object.freeze({
    sessions: 'sessions',
    projects: 'projects',
    settings: 'settings',
    transcript: 'transcript',
    files: 'files',
    fileContent: 'fileContent',
    commits: 'commits',
} as const);
