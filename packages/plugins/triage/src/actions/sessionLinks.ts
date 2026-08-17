import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { linkEntryToSession } from '../sessions/entrySessionLinks.js';
import type {
    TriageLinkEntryToSessionActionResultV1,
    TriageLinkEntryToSessionInputV1,
} from './sessionLinksProtocol.js';

/**
 * The registered `session-links` writer: the surface's only path to the one
 * canonical link owner.
 *
 * This is not a second authority. `linkEntryToSession` still owns the link's
 * derived address, its idempotency, the conditional tombstone rewrite, the
 * minted publication id and the conflict verdict; this module transports the
 * caller's intent to it and projects its answer back, discarding the storage
 * tag on the way out.
 */

export type TriageSessionLinksDepsV1 = Readonly<{
    /** The `session-links` Collection. It is the only Collection this Action touches. */
    collections: Pick<CorpusCollectionsV1, 'sessionLinks'>;
    nowMs: () => number;
    signal?: AbortSignal;
}>;

export async function linkTriageEntryToSession(
    input: TriageLinkEntryToSessionInputV1,
    deps: TriageSessionLinksDepsV1,
): Promise<TriageLinkEntryToSessionActionResultV1> {
    const result = await linkEntryToSession({
        collections: deps.collections,
        // Passed through exactly as the caller's projection produced it. The
        // link's address is derived from this reference and the Session id
        // alone, so a reference this Action rebuilt or normalized could address
        // a second row for one relationship — the duplicate the cockpit would
        // then show for a Session started twice from two devices.
        entryRef: input.entryRef,
        display: input.display,
        sessionId: input.sessionId,
        nowMs: deps.nowMs(),
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    // The writer's own verdict, minus the storage tag: a row id is plaintext
    // server metadata and nothing a surface renders needs one.
    return { v: 1, status: result.status };
}

export function createTriageLinkEntryToSessionActionHandler(): ActionHandler<
    TriageLinkEntryToSessionInputV1,
    TriageLinkEntryToSessionActionResultV1
> {
    return async (input, context: PluginInvocationContext) => await linkTriageEntryToSession(input, {
        collections: bindCorpusCollections(requireTriageAccountStorage(context)),
        nowMs: () => Date.now(),
        signal: context.signal,
    });
}
