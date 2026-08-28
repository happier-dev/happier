import type { PluginCancellationOptions, PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';
import {
    MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
    type TriageEntryRefV1,
    type TriageLinkedSessionProjectionV1,
} from '@happier-dev/triage-protocol/v1';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import type { CorpusCollectionHandleV1 } from '../corpus/collections/handles.js';
import {
    CORPUS_SESSION_LINKS_INDEX_ID,
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
} from '../corpus/collections/ids.js';
import { fromCorpusStoredRow } from '../corpus/collections/rowCodec.js';
import type { CorpusSessionLinkRowV1 } from '../corpus/collections/rows.js';
import { findConfiguredSourceInstanceRow } from '../corpus/configuration/administerConfiguredSourceInstance.js';
import { deriveSessionLinkEntryTag } from '../corpus/identity/tags.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { isTriageSelfCaller } from './callerSource.js';
import type {
    TriageReadEntryDetailInputV1,
    TriageReadEntryDetailResultV1,
} from './entryDetailProtocol.js';

/**
 * The durable half of one mounted detail input.
 *
 * Everything a source detail body needs that the reader's own device-local
 * projection does not already hold: the exact configured instance the selected
 * row was observed through and that entry's Session links. Descriptor,
 * operation, and surface facts remain on the physical mount's exact targeted
 * snapshot. It writes nothing, reaches no provider, and needs no daemon.
 *
 * It is caller-bound to this target's own surfaces. The configured instance
 * carries the owning source's account binding and its source-private
 * configuration token, and the aggregate list Action deliberately withholds both
 * from its summaries; letting any plugin caller ask for one exactly would be the
 * way around that decision.
 */

const INVALID_CALLER: TriageReadEntryDetailResultV1 = Object.freeze({ kind: 'invalidCaller' });
const UNAVAILABLE: TriageReadEntryDetailResultV1 = Object.freeze({ kind: 'unavailable' });

/**
 * The generic Session facts one link may present.
 *
 * A Session the generic owner cannot currently answer for keeps its
 * `sessionId` and loses only the two presentation fields (`CONTRACT.md` §7): an
 * unavailable Session is not evidence that the link never existed, and a reader
 * that dropped the row would tell a person their work is not connected to
 * anything.
 */
export type TriageLinkedSessionSummaryReaderV1 = (
    sessionId: string,
    options?: PluginCancellationOptions,
) => Promise<Readonly<{ title?: string; updatedAtMs?: number }> | null>;

export type TriageReadEntryDetailDepsV1 = Readonly<{
    sourceInstances: Pick<CorpusCollectionHandleV1, 'query'>;
    sessionLinks: Pick<CorpusCollectionHandleV1, 'query' | 'identityTag'>;
    readSessionSummary: TriageLinkedSessionSummaryReaderV1;
    signal?: AbortSignal;
}>;

/**
 * One bounded page of this entry's links, over the declared `by-entry` index.
 *
 * The bound is one generic Collection page. The Collection cursor crosses only
 * this plugin-private Action and is returned untouched; the mounted reader may
 * hand it back, but neither side interprets or persists it.
 */
async function readLinkedSessions(
    entryRef: TriageEntryRefV1,
    deps: TriageReadEntryDetailDepsV1,
    cursor?: string,
    options?: PluginCancellationOptions,
): Promise<Readonly<{
    sessions: readonly TriageLinkedSessionProjectionV1[];
    nextCursor?: string;
}>> {
    const entryTag = await deriveSessionLinkEntryTag(deps.sessionLinks, entryRef, options);
    const page = await deps.sessionLinks.query({
        index: CORPUS_SESSION_LINKS_INDEX_ID.byEntry,
        prefix: [entryTag],
        order: 'asc',
        limit: MAX_TRIAGE_LINKED_SESSIONS_PAGE_SIZE_V1,
        ...(cursor === undefined ? {} : { cursor }),
    }, options);

    const projections: TriageLinkedSessionProjectionV1[] = [];
    for (const stored of page.rows) {
        const link = fromCorpusStoredRow<CorpusSessionLinkRowV1>(stored).value;
        let summary: Awaited<ReturnType<TriageLinkedSessionSummaryReaderV1>> = null;
        try {
            summary = await deps.readSessionSummary(link.sessionId, options);
        } catch {
            // The generic Session owner is a boundary. An unavailable answer
            // costs the two presentation fields and never the link itself.
            summary = null;
        }
        projections.push(Object.freeze({
            sessionId: link.sessionId,
            ...(summary?.title === undefined ? {} : { displayTitle: summary.title }),
            ...(summary?.updatedAtMs === undefined ? {} : { updatedAtMs: summary.updatedAtMs }),
        }));
    }
    return Object.freeze({
        sessions: Object.freeze(projections),
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
}

export async function readTriageEntryDetail(
    input: TriageReadEntryDetailInputV1,
    deps: TriageReadEntryDetailDepsV1,
): Promise<TriageReadEntryDetailResultV1> {
    const options: PluginCancellationOptions | undefined = deps.signal
        ? { signal: deps.signal }
        : undefined;
    const row = await findConfiguredSourceInstanceRow(
        deps.sourceInstances,
        input.sourceInstanceId,
        options,
    );
    // A retired row is not a connection a detail may be read through. It is kept
    // so an explicit reactivation stays possible, not so a mounted surface can
    // keep opening it.
    if (!row || row.value.lifecycle !== CORPUS_SOURCE_INSTANCE_LIFECYCLE.active) return UNAVAILABLE;

    const configured = row.value.configured;
    // The selection names the entry AND the connection, and the row must be the
    // one that observed that entry's source. A configured instance of a
    // different source could otherwise be handed to a renderer that would read
    // its own provider with somebody else's routing token.
    if (configured.instance.source.pluginId !== input.entryRef.source.pluginId
        || configured.instance.source.localId !== input.entryRef.source.localId) {
        return UNAVAILABLE;
    }

    const linkedSessionPage = await readLinkedSessions(
        input.entryRef,
        deps,
        input.linkedSessionsCursor,
        options,
    );

    return Object.freeze({
        kind: 'read',
        instance: configured,
        linkedSessions: linkedSessionPage.sessions,
        ...(linkedSessionPage.nextCursor === undefined
            ? {}
            : { linkedSessionsNextCursor: linkedSessionPage.nextCursor }),
    });
}

export function createTriageReadEntryDetailActionHandler(): ActionHandler<
    TriageReadEntryDetailInputV1,
    TriageReadEntryDetailResultV1
> {
    return async (input, context: PluginInvocationContext) => {
        if (!isTriageSelfCaller(context)) return INVALID_CALLER;
        const { sourceInstances, sessionLinks } = bindCorpusCollections(
            requireTriageAccountStorage(context),
        );
        return await readTriageEntryDetail(input, {
            sourceInstances,
            sessionLinks,
            readSessionSummary: async (sessionId, options) => {
                const handle = await context.services.sessions.get(sessionId, options);
                return handle === null ? null : await handle.summary(options);
            },
            ...(context.signal ? { signal: context.signal } : {}),
        });
    };
}
