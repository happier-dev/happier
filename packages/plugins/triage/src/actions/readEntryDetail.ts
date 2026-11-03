import type { TriageDataActionContext, TriageDataActionHandler } from './dataContext.js';
import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import {
    type TriageLinkedSessionProjectionV1,
} from '@happier-dev/triage-protocol/v1';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import {
    CORPUS_SOURCE_INSTANCE_LIFECYCLE,
} from '../corpus/collections/ids.js';
import { createTriageSourceSessionRelations, type TriageSourceSessionLinkV1 } from '../sessions/sourceSessionRelations.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { isTriageAccountCaller, isTriageHostActionCaller, resolveTriageCallerSource } from './callerSource.js';
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
 * snapshot. External links read directly from Account data. Sources that declare
 * their own relation read supply it through the same source-neutral owner.
 *
 * It is caller-bound to this target's own surfaces and authenticated host Actions. The configured instance
 * carries the owning source's account binding and its source-private
 * configuration token, and the aggregate list Action deliberately withholds both
 * from its summaries; unrelated plugin callers remain refused. Host automated
 * callers must resolve a currently admitted source and declared kind first.
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
    readSessionSummary: TriageLinkedSessionSummaryReaderV1;
    sourceRelations: Pick<ReturnType<typeof createTriageSourceSessionRelations>, 'findConfiguredInstance' | 'read'>;
    signal?: AbortSignal;
}>;

/**
 * Project one admitted relationship page; ownership and acquisition stay with
 * sourceSessionRelations, including corpus paging and its opaque cursor.
 */
async function readLinkedSessions(
    deps: TriageReadEntryDetailDepsV1,
    sourceLinks: readonly TriageSourceSessionLinkV1[],
    options?: PluginCancellationOptions,
): Promise<Readonly<{
    sessions: readonly TriageLinkedSessionProjectionV1[];
    nextCursor?: string;
}>> {
    const projections: TriageLinkedSessionProjectionV1[] = [];
    for (const link of sourceLinks) {
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
    });
}

export async function readTriageEntryDetail(
    input: TriageReadEntryDetailInputV1,
    deps: TriageReadEntryDetailDepsV1,
): Promise<TriageReadEntryDetailResultV1> {
    const options: PluginCancellationOptions | undefined = deps.signal
        ? { signal: deps.signal }
        : undefined;
    const row = await deps.sourceRelations.findConfiguredInstance(input.sourceInstanceId);
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

    const sourceLinks = await deps.sourceRelations.read({ entryRef: input.entryRef, sourceInstanceId: input.sourceInstanceId,
        paged: true, readFailure: 'throw', ...(input.linkedSessionsCursor === undefined ? {} : { cursor: input.linkedSessionsCursor }) });
    const linkedSessionPage = await readLinkedSessions(
        deps,
        sourceLinks.links,
        options,
    );

    return Object.freeze({
        kind: 'read',
        instance: configured,
        linkedSessions: linkedSessionPage.sessions,
        ...(sourceLinks.nextCursor === undefined
            ? {}
            : { linkedSessionsNextCursor: sourceLinks.nextCursor }),
    });
}

export function createTriageReadEntryDetailActionHandler(): TriageDataActionHandler<
    TriageReadEntryDetailInputV1,
    TriageReadEntryDetailResultV1
> {
    return async (input, context: TriageDataActionContext) => {
        if (!isTriageAccountCaller(context)) return INVALID_CALLER;
        if (isTriageHostActionCaller(context)) {
            const resolution = await resolveTriageCallerSource(context, { signal: context.signal }, input.entryRef.source);
            if (resolution.kind !== 'source'
                || !resolution.caller.contribution.descriptor.kinds.some((kind) => kind.id === input.entryRef.kindId)) {
                return UNAVAILABLE;
            }
        }
        const { sourceInstances, sessionLinks } = bindCorpusCollections(
            requireTriageAccountStorage(context),
        );
        return await readTriageEntryDetail(input, {
            sourceRelations: createTriageSourceSessionRelations(context, { sourceInstances, sessionLinks }),
            // Portable Account execution has no Session service. These optional
            // display facts stay absent while authoritative links remain present.
            readSessionSummary: async () => null,
            ...(context.signal ? { signal: context.signal } : {}),
        });
    };
}
