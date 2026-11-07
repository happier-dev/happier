import type { TriageDataActionHandler } from './dataContext.js';
import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { readTaskOriginError, setTaskOriginError } from '../corpus/marks/setPinned.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import type {
    TriageSetTaskOriginErrorInputV1Schema, TriageSetTaskOriginErrorResultV1Schema,
    TriageReadTaskOriginErrorInputV1Schema, TriageReadTaskOriginErrorResultV1Schema,
} from './taskOriginProtocol.js';

export function createTriageSetTaskOriginErrorActionHandler(): TriageDataActionHandler<
    ReturnType<typeof TriageSetTaskOriginErrorInputV1Schema.parse>, ReturnType<typeof TriageSetTaskOriginErrorResultV1Schema.parse>
> {
    return async (input, context) => ({ v: 1, ...await setTaskOriginError({
        ...input, collections: bindCorpusCollections(requireTriageAccountStorage(context)),
        nowMs: context.invokedAtMs, signal: context.signal,
    }) });
}

export function createTriageReadTaskOriginErrorActionHandler(): TriageDataActionHandler<
    ReturnType<typeof TriageReadTaskOriginErrorInputV1Schema.parse>, ReturnType<typeof TriageReadTaskOriginErrorResultV1Schema.parse>
> {
    return async (input, context) => ({ v: 1, originError: await readTaskOriginError({
        entryRef: input.entryRef, collections: bindCorpusCollections(requireTriageAccountStorage(context)), signal: context.signal,
    }) });
}
