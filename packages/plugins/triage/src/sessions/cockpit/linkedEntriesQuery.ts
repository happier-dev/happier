import {
    CORPUS_SESSION_LINKS_COLLECTION_ID,
    CORPUS_SESSION_LINKS_FIELD,
    CORPUS_SESSION_LINKS_UI_QUERY_ID,
    CORPUS_SESSION_LINKS_UI_QUERY_PAGE_SIZE,
} from '../../corpus/collections/ids.js';

/**
 * The one static UI query the Session cockpit opens.
 *
 * There is exactly one, because there is exactly one durable collection behind a
 * linked entry. The link row is durable Account state; the *entry* it points at
 * is not stored anywhere, so there is no second query and no second row to
 * hydrate — the link's own private `displayPathAtLink` is the ordinary render
 * path (`core/CORPUS.md` §2.2, `core/SESSIONS.md` §5.1).
 *
 * The identifiers below are the surface's half of that contract. The declaring
 * half lives with the Collection owner (`corpus/collections/definitions.ts`),
 * which is where an index and a query become admitted server metadata; this
 * module never re-declares a schema, an index or a disclosure.
 */

/** `session-links.linked-for-session`, over the declared `by-session` index. */
export const TRIAGE_SESSION_LINKED_ENTRIES_UI_QUERY_ID_V1 =
    CORPUS_SESSION_LINKS_UI_QUERY_ID.linkedForSession;

/** The one query parameter: the exact host-stamped mounted `SessionId`. */
export const TRIAGE_SESSION_LINKED_ENTRIES_PARAMETER_ID_V1 = CORPUS_SESSION_LINKS_FIELD.sessionId;

/**
 * The declared page size. The Data pager appends one page at a time and owns the
 * accumulated bounded query window; the cockpit must not apply this value again
 * as a presentation ceiling or links after page one become unreachable.
 */
export const MAX_TRIAGE_SESSION_LINKED_ENTRY_ROWS_V1 = CORPUS_SESSION_LINKS_UI_QUERY_PAGE_SIZE;

/** The collection the query and the private row hydration both address. */
export const TRIAGE_SESSION_LINKED_ENTRIES_COLLECTION_ID_V1 = CORPUS_SESSION_LINKS_COLLECTION_ID;

/** The exact parameters for one mounted Session. */
export function triageSessionLinkedEntriesParameters(
    sessionId: string,
): Readonly<Record<string, string>> {
    return Object.freeze({ [TRIAGE_SESSION_LINKED_ENTRIES_PARAMETER_ID_V1]: sessionId });
}
