import type { TriageDataActionContext, TriageDataActionHandler } from './dataContext.js';
import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import {
    type TriageAdmittedReviewV1,
    type TriageReviewSkipV1,
    type TriageEntryRefV1,
} from '@happier-dev/triage-protocol/v1';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { admitConfiguredEntrySourceRow, readConfiguredEntrySourceRow } from '../corpus/configuration/readConfiguredSourceRows.js';
import { indexTriageAdmittedSourcesV1, readAccountDataSourceRecordsV1 } from '../corpus/configuration/accountDataSources.js';
import { readReviewOutcome } from '../corpus/marks/setPinned.js';
import { createTriageSourceSessionRelations } from '../sessions/sourceSessionRelations.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { resolveTriageCallerSources } from './callerSource.js';
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
 * Every Account reader resolves the named admitted source and declared kind.
 * The configured instance must belong to that source; its binding and routing
 * token carry no credential material.
 */

const UNAVAILABLE: TriageReadEntryDetailResultV1 = Object.freeze({ kind: 'unavailable' });

export type TriageReadEntryDetailDepsV1 = Readonly<{
    sourceRelations: Pick<ReturnType<typeof createTriageSourceSessionRelations>, 'findConfiguredInstance' | 'read'>;
    /** The user-mark owner's recorded Review relation and latest skip for the entry; absent reads as none. */
    readReviewOutcome?: (entryRef: TriageEntryRefV1, options?: PluginCancellationOptions) => Promise<Readonly<{
        admittedReview?: TriageAdmittedReviewV1; reviewSkip?: TriageReviewSkipV1;
    }>>;
    signal?: AbortSignal;
}>;

export async function readTriageEntryDetail(
    input: TriageReadEntryDetailInputV1,
    deps: TriageReadEntryDetailDepsV1,
): Promise<TriageReadEntryDetailResultV1> {
    const options: PluginCancellationOptions | undefined = deps.signal
        ? { signal: deps.signal }
        : undefined;
    const row = admitConfiguredEntrySourceRow(
        await deps.sourceRelations.findConfiguredInstance(input.sourceInstanceId, input.entryRef),
        input.entryRef.source,
    );
    if (row === null) return UNAVAILABLE;

    const sourceLinks = await deps.sourceRelations.read({ entryRef: input.entryRef, sourceInstanceId: input.sourceInstanceId,
        paged: true, ...(input.linkedSessionsCursor === undefined ? {} : { cursor: input.linkedSessionsCursor }) });
    const { admittedReview, reviewSkip } = await deps.readReviewOutcome?.(input.entryRef, options) ?? {};
    return Object.freeze({
        kind: 'read',
        instance: row.value.configured,
        linkedSessions: Object.freeze(sourceLinks.links.map(({ sessionId }) => Object.freeze({ sessionId }))),
        ...(admittedReview === undefined ? {} : { admittedReview }),
        ...(reviewSkip === undefined ? {} : { reviewSkip }),
        ...(sourceLinks.kind !== 'complete' && sourceLinks.nextCursor === undefined
            ? { linkedSessionsAttention: true as const }
            : {}),
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
        const resolution = await resolveTriageCallerSources(context, { signal: context.signal }, input.entryRef.source);
        if (resolution.kind !== 'sources'
            || !resolution.callers[0]?.contribution.descriptor.kinds.some((kind) => kind.id === input.entryRef.kindId)) {
            return UNAVAILABLE;
        }
        const { sourceInstances, sessionLinks, userMarks } = bindCorpusCollections(
            requireTriageAccountStorage(context),
        );
        const sources = indexTriageAdmittedSourcesV1(resolution.callers.map(caller => caller.contribution));
        const record = await readConfiguredEntrySourceRow(sourceInstances, input, {
            signal: context.signal, accountDataSources: readAccountDataSourceRecordsV1(sources),
        });
        return await readTriageEntryDetail(input, {
            sourceRelations: createTriageSourceSessionRelations(context, { sourceInstances, sessionLinks }, {
                entryRef: input.entryRef, sources, record,
            }),
            readReviewOutcome: (entryRef, readOptions) => readReviewOutcome({ collections: { userMarks }, entryRef,
                ...(readOptions?.signal ? { signal: readOptions.signal } : {}) }),
            ...(context.signal ? { signal: context.signal } : {}),
        });
    };
}
