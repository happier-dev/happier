import type { TriageDataActionContext, TriageDataActionHandler } from './dataContext.js';


import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { createTriageSourceSessionRelations } from '../sessions/sourceSessionRelations.js';
import type {
    TriageLinkEntryToSessionActionResultV1,
    TriageLinkEntryToSessionInputV1,
    TriageReadSourceSessionLinksInputV1,
    TriageReadSourceSessionLinksActionResultV1,
} from './sessionLinksProtocol.js';

/**
 * The registered source-neutral relationship transport.
 *
 * Source-declared roles own their relationships; `linkEntryToSession` owns external links'
 * derived address, its idempotency, the conditional tombstone rewrite, the
 * minted publication id and the conflict verdict; this module transports the
 * caller's intent to the selected owner and projects its answer back, discarding the storage
 * tag on the way out.
 */

export function createTriageLinkEntryToSessionActionHandler(): TriageDataActionHandler<
    TriageLinkEntryToSessionInputV1,
    TriageLinkEntryToSessionActionResultV1
> {
    return async (input, context: TriageDataActionContext) => {
        const collections = bindCorpusCollections(requireTriageAccountStorage(context));
        const result = await createTriageSourceSessionRelations(context, collections).write({ ...input, linked: true });
        return { v: 1, status: result.status === 'linked' ? 'linked' : 'failed' };
    };
}

export function createTriageReadSourceSessionLinksActionHandler(): TriageDataActionHandler<
    TriageReadSourceSessionLinksInputV1, TriageReadSourceSessionLinksActionResultV1
> {
    return async (input, context) => {
        const relations = createTriageSourceSessionRelations(context, bindCorpusCollections(requireTriageAccountStorage(context)));
        if ('entries' in input) return { kind: 'entries', entries: await relations.readEntries(input.entries) };
        return await relations.read(input);
    };
}
