import type { PluginDynamicResourceRuntime } from '@happier-dev/plugin-sdk/resources';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import { readTaskOriginError, readTaskOriginReview } from '../corpus/marks/setPinned.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { TriageReadTaskOriginErrorInputV1Schema, type TriageTaskOriginResourceResultV1Schema } from './taskOriginProtocol.js';

/** Account relationships need the mounted requester's storage, not a Machine Action. */
export const TRIAGE_TASK_ORIGIN_RESOURCE_RUNTIME: PluginDynamicResourceRuntime = {
    async read(options) {
        const input = TriageReadTaskOriginErrorInputV1Schema.parse(
            options.context.kind === 'surface' ? options.context.launchInput : undefined,
        );
        const collections = bindCorpusCollections(requireTriageAccountStorage({
            services: { storage: { account: options.accountStorage } },
        }));
        const read = { entryRef: input.entryRef, collections, signal: options.signal };
        const [originError, originReview] = await Promise.all([readTaskOriginError(read), readTaskOriginReview(read)]);
        return JSON.stringify({ v: 1, originError, originReview } satisfies ReturnType<typeof TriageTaskOriginResourceResultV1Schema.parse>);
    },
    // The Task detail reads on open and explicit refresh, as before.
    observe: () => ({ dispose() {} }),
};
