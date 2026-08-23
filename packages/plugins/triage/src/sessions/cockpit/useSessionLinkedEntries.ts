import * as React from 'react';
import {
    usePluginCollectionQuery,
    usePluginUiDataClient,
    type PluginUiCollectionQueryResult,
} from '@happier-dev/plugin-ui/data';

import { CORPUS_SESSION_LINKS_COLLECTION } from '../../corpus/collections/definitions.js';
import { fromCorpusStoredRow } from '../../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../../corpus/collections/rows.js';
import {
    TRIAGE_SESSION_LINKED_ENTRIES_COLLECTION_ID_V1,
    TRIAGE_SESSION_LINKED_ENTRIES_UI_QUERY_ID_V1,
    triageSessionLinkedEntriesParameters,
} from './linkedEntriesQuery.js';
import {
    projectTriageSessionLinkedEntries,
    triageSessionLinkHydrationTargets,
    type TriageSessionLinkedEntriesFailureCodeV1,
    type TriageSessionLinkHydrationMapV1,
    type TriageSessionLinkHydrationV1,
    type TriageSessionLinkQueryRowV1,
    type TriageSessionLinkedEntriesQueryStateV1,
    type TriageSessionLinkedEntriesViewV1,
} from './linkedEntryRows.js';

/**
 * The cockpit's one data consumer.
 *
 * Two tiers, both incumbent, and nothing else. The declared static UI query is
 * opened through the Data-owned pager, which keeps query validation, cursor
 * continuation, AccountChange wakeups, last-known-good rows and Account
 * currentness; the private half of each link row — the display path a linked row
 * is actually rendered from — is read through the same mount's Data client by
 * the host-stamped `rowId` the pager already returned.
 *
 * A mounted Plugin UI surface holds a `PluginUiHostApi` with no storage member,
 * so this is the only transport into an Account Collection from here, and it is
 * read-only: any durable write from a mounted surface needs an Action seam.
 *
 * It owns no poll, timer, watch cursor, provider request, source refresh,
 * Message scan, second entry store or alternate freshness decision.
 */

const EMPTY_HYDRATION: TriageSessionLinkHydrationMapV1 = Object.freeze(new Map());

const TYPED_QUERY_FAILURE_CODES: ReadonlySet<string> = new Set<TriageSessionLinkedEntriesFailureCodeV1>([
    'collection_query_invalid',
    'collection_cursor_invalid',
    'collection_unavailable',
    'collection_index_not_ready',
    'collection_content_mode_mismatch',
    'collection_contract_inconsistent',
]);

/**
 * The pager's failure surfaces as either the Data-owned typed error or a thrown
 * `Error` from opening it. Only the typed code carries a distinguishable
 * meaning; anything else is reported as the honest generic failure.
 */
function readFailureCode(
    error: PluginUiCollectionQueryResult['error'],
): TriageSessionLinkedEntriesFailureCodeV1 | null {
    if (error === undefined || error instanceof Error) return null;
    return TYPED_QUERY_FAILURE_CODES.has(error.error) ? error.error : null;
}

function toQueryRows(
    rows: PluginUiCollectionQueryResult['rows'],
): readonly TriageSessionLinkQueryRowV1[] {
    return rows.map((row) => Object.freeze({
        rowId: row.context.rowId,
        revision: row.context.revision,
        fields: row.fields,
    }));
}

/**
 * Same-plugin private hydration for the exact bounded page.
 *
 * One read per rendered row per revision, and never one per render: a settled
 * read is retained until the pager reports that row at a different revision, and
 * rows that leave the page leave the map with them. A refused read becomes a
 * stated row state rather than a retry loop — the Data pager already owns the
 * wakeups that would make a retry meaningful.
 */
function useLinkHydration(
    rows: readonly TriageSessionLinkQueryRowV1[],
): TriageSessionLinkHydrationMapV1 {
    const client = usePluginUiDataClient();
    const [hydration, setHydration] = React.useState<TriageSessionLinkHydrationMapV1>(EMPTY_HYDRATION);

    React.useEffect(() => {
        const wanted = new Map(rows.map((row) => [row.rowId, row.revision]));

        // The one invalidation owner. A row that left the page, and a row the
        // pager now reports at a different revision, both leave the map here —
        // so the map is bounded by the page rather than by how long this Session
        // stayed open, and "what is still known" is not decided twice.
        setHydration((previous) => {
            let changed = false;
            const next = new Map<string, TriageSessionLinkHydrationV1>();
            for (const [rowId, known] of previous) {
                if (wanted.get(rowId) === known.revision) next.set(rowId, known);
                else changed = true;
            }
            return changed ? Object.freeze(next) : previous;
        });

        const missing = rows.filter((row) => !hydration.has(row.rowId));
        if (missing.length === 0) return;

        const links = client.collection(CORPUS_SESSION_LINKS_COLLECTION);
        const controller = new AbortController();
        let retired = false;

        void (async () => {
            const settled = await Promise.all(missing.map(
                async (row): Promise<readonly [string, TriageSessionLinkHydrationV1]> => {
                    try {
                        const stored = await links.get(row.rowId, { signal: controller.signal });
                        if (stored === null) return [row.rowId, { kind: 'unlinked', revision: row.revision }];
                        const value = fromCorpusStoredRow<CorpusSessionLinkRowV1>(stored).value;
                        return [row.rowId, {
                            kind: 'ready',
                            revision: row.revision,
                            displayPath: value.displayPathAtLink,
                            // The reference the link was written from, passed on
                            // untouched: Unlink addresses the row derived from
                            // exactly this value and the mounted Session.
                            entryRef: value.entryRef,
                        }];
                    } catch {
                        return [row.rowId, { kind: 'unreadable', revision: row.revision }];
                    }
                },
            ));
            if (retired) return;
            setHydration((previous) => {
                const next = new Map(previous);
                for (const [rowId, known] of settled) {
                    // A row the page has since dropped is not adopted back in.
                    if (wanted.get(rowId) === known.revision) next.set(rowId, known);
                }
                return Object.freeze(next);
            });
        })();

        return () => {
            retired = true;
            controller.abort();
        };
    }, [client, hydration, rows]);

    return hydration;
}

export type TriageSessionLinkedEntriesV1 = Readonly<{
    view: TriageSessionLinkedEntriesViewV1;
    /** Re-reads the current page through the Data pager; reaches no provider. */
    refresh: () => Promise<void>;
}>;

/**
 * Read one exact Session's linked entries.
 *
 * `sessionId` is the host-stamped mounted target and nothing else. It is never a
 * launch input, a route value, a title lookup, the active or focused Session, or
 * a value read out of a Message.
 */
export function useTriageSessionLinkedEntries(sessionId: string): TriageSessionLinkedEntriesV1 {
    const parameters = React.useMemo(
        () => triageSessionLinkedEntriesParameters(sessionId),
        [sessionId],
    );
    const query = usePluginCollectionQuery(
        TRIAGE_SESSION_LINKED_ENTRIES_COLLECTION_ID_V1,
        TRIAGE_SESSION_LINKED_ENTRIES_UI_QUERY_ID_V1,
        parameters,
    );

    const queryState = React.useMemo<TriageSessionLinkedEntriesQueryStateV1>(() => Object.freeze({
        status: query.status,
        rows: toQueryRows(query.rows),
        hasMore: query.hasMore,
        failure: readFailureCode(query.error),
    }), [query.error, query.hasMore, query.rows, query.status]);

    const targets = React.useMemo(
        () => triageSessionLinkHydrationTargets(queryState),
        [queryState],
    );
    const hydration = useLinkHydration(targets);

    const view = React.useMemo(
        () => projectTriageSessionLinkedEntries({ query: queryState, hydration }),
        [hydration, queryState],
    );

    return React.useMemo(
        () => Object.freeze({ view, refresh: query.refresh }),
        [query.refresh, view],
    );
}
