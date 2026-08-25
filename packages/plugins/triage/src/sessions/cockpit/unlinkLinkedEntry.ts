import type { JsonValue, PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import { unlinkTriageEntryFromSession } from '../../actions/entrySession.js';
import type { CorpusCollectionsV1 } from '../../corpus/collections/bindCorpusCollections.js';
import {
    TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1,
    TriageUnlinkEntryFromSessionActionResultV1Schema,
    type TriageUnlinkEntryFromSessionActionResultV1,
} from '../../actions/entrySessionProtocol.js';

/**
 * The cockpit's path to the canonical link remover.
 *
 * Two transports, one owner. A mount that can reach the reader's Account
 * directly deletes through its own `session-links` handle, so **Unlink** keeps
 * working with no daemon reachable — a Session link is Account state, not
 * provider data. A mount that cannot invokes the published Action through a
 * daemon. Both reach `entrySessionLinks.ts#unlinkEntryFromSession`.
 *
 * It owns no state: there is no local removed set and no optimistic commitment,
 * because a link is durable Account state with no upstream owner to reconstruct
 * it from — the only honest thing to show is what the Account says after the
 * pager re-reads.
 *
 * The entry reference is passed through exactly as the private link row held
 * it. Nothing here rebuilds, normalizes or re-encodes it: the link's address is
 * derived from that reference and the mounted Session alone, so a reference this
 * module reshaped would address a row the user never linked — which for a
 * removal means deleting nothing while reporting success.
 */

/**
 * What an unlink needs from a mount: the ability to invoke this plugin's own
 * Action. Deliberately the narrowest capability rather than a whole Host API.
 */
export type TriageUnlinkHostV1 = Readonly<{
    executeAction(
        action: string,
        input: JsonValue,
        options?: PluginCancellationOptions,
    ): Promise<unknown>;
}>;

/**
 * The exact pair a removal names.
 *
 * Both members are required for the reason the writer states: an unlink
 * addressed by the entry alone would drop the same entry's link to a Session the
 * reader never touched, and one addressed by the Session alone would drop every
 * other entry's.
 */
export type TriageUnlinkLinkedEntryV1 = Readonly<{
    sessionId: string;
    entryRef: TriageEntryRefV1;
}>;

/**
 * The one removal a mounted surface performs, independent of how it reaches the
 * owner. The row holds one of these and never branches on transport.
 */
export type TriageUnlinkTransportV1 = Readonly<{
    unlink(
        target: TriageUnlinkLinkedEntryV1,
        options?: PluginCancellationOptions,
    ): Promise<TriageUnlinkEntryFromSessionActionResultV1>;
}>;

/** The direct transport: this mount's own `session-links` Collection handle. */
export function createDirectTriageUnlinkTransport(
    collections: Pick<CorpusCollectionsV1, 'sessionLinks'>,
): TriageUnlinkTransportV1 {
    return Object.freeze({
        unlink: async (target, options) => await unlinkTriageEntryFromSession({
            v: 1,
            sessionId: target.sessionId,
            entryRef: target.entryRef,
        }, {
            collections,
            ...(options?.signal ? { signal: options.signal } : {}),
        }),
    });
}

/** The daemon transport: the same owner, reached through the published Action. */
export function createActionTriageUnlinkTransport(
    host: TriageUnlinkHostV1,
): TriageUnlinkTransportV1 {
    return Object.freeze({
        unlink: async (target, options) => (
            await submitTriageUnlinkLinkedEntry(host, target, options)
        ),
    });
}

export async function submitTriageUnlinkLinkedEntry(
    host: TriageUnlinkHostV1,
    target: TriageUnlinkLinkedEntryV1,
    options?: PluginCancellationOptions,
): Promise<TriageUnlinkEntryFromSessionActionResultV1> {
    const result = await host.executeAction(
        TRIAGE_UNLINK_ENTRY_FROM_SESSION_ACTION_LOCAL_ID_V1,
        { v: 1, sessionId: target.sessionId, entryRef: target.entryRef },
        options,
    );
    // The Action crosses a JSON transport, so its own published result schema —
    // not a cast — is what admits the value a row's state is taken from.
    return TriageUnlinkEntryFromSessionActionResultV1Schema.parse(result);
}
