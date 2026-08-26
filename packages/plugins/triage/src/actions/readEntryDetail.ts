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
import { renderSourceQualifiedId } from '../corpus/identity/components.js';
import { deriveSessionLinkEntryTag } from '../corpus/identity/tags.js';
import { TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '../manifest.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { isTriageSelfCaller } from './callerSource.js';
import type {
    TriageReadEntryDetailInputV1,
    TriageReadEntryDetailResultV1,
} from './entryDetailProtocol.js';
import {
    indexTriageAdmittedSourcesV1,
    type TriageAdmittedSourceV1,
} from './listEntries.js';

/**
 * The durable half of one mounted detail input.
 *
 * Everything a source detail body needs that the reader's own device-local
 * projection does not already hold: the exact configured instance the selected
 * row was observed through, that entry's Session links, and — for the aggregate
 * header above the body — the entry source's own declared descriptor, taken
 * from the admitted snapshot exactly as the host already parsed it. It writes
 * nothing and reaches no provider.
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
    /**
     * The current admitted view of this target's own sources point.
     *
     * The entry's source declared its own name, and its own name for this entry
     * kind, in the descriptor the host already parsed with this target's
     * schema. Reading it here is what lets the one aggregate detail header say
     * both in the source's words instead of leaving them out; nothing in this
     * Action decodes that value, and nothing re-derives the kind vocabulary the
     * scan pass admits entries against.
     *
     * It holds no invalidation watch and never refuses on a moved admitted
     * view: these two strings are display, and a name one pass out of date is
     * advisory. What must fail closed on currentness is execution and mounting,
     * and both already do at their own owners.
     */
    readAdmittedSources: (
        options?: PluginCancellationOptions,
    ) => Promise<readonly TriageAdmittedSourceV1[]>;
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

    const [linkedSessionPage, admitted] = await Promise.all([
        readLinkedSessions(input.entryRef, deps, input.linkedSessionsCursor, options),
        deps.readAdmittedSources(options),
    ]);
    // Keyed on the entry's own source, never on the configured row's. The
    // refusal above proves the two equal, and reading the other one would make
    // a later relaxation of that refusal name the wrong source on screen
    // instead of failing where the check lives.
    const contribution = indexTriageAdmittedSourcesV1(admitted)
        .get(renderSourceQualifiedId(input.entryRef.source));

    return Object.freeze({
        kind: 'read',
        instance: configured,
        linkedSessions: linkedSessionPage.sessions,
        ...(linkedSessionPage.nextCursor === undefined
            ? {}
            : { linkedSessionsNextCursor: linkedSessionPage.nextCursor }),
        // A source with no currently admitted contribution loses the two names
        // rather than gaining an invented one.
        ...(contribution?.descriptor === undefined
            ? {}
            : { sourceDescriptor: contribution.descriptor }),
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
            readAdmittedSources: async (options) => {
                const observation = context.services.targetedContributions.observeForSelf(
                    TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1,
                    { onInvalidated: () => {} },
                );
                try {
                    return (await observation.readCurrent(options)).contributions;
                } finally {
                    observation.dispose();
                }
            },
            ...(context.signal ? { signal: context.signal } : {}),
        });
    };
}
