import type { PluginCollectionHostReferenceAdapter } from "@/app/plugins/data/collections/hostReferences";

import {
    resolveQualifiedConnectedAccountHostReferenceInTx,
} from "./credentialRepository";

/**
 * Connected Accounts retain their own opaque row identity and visibility
 * rules. Data receives only the typed availability result and gains neither
 * credential contents nor a Connected Account capability.
 */
export const connectedAccountPluginCollectionHostReferenceAdapter = Object.freeze({
    hostKind: "connectedAccount",
    async resolveInTx({ tx, accountId, targetId }) {
        return await resolveQualifiedConnectedAccountHostReferenceInTx(
            tx,
            { accountId, targetId },
        );
    },
} satisfies PluginCollectionHostReferenceAdapter);
