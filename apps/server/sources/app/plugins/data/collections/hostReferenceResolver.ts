import { artifactPluginCollectionHostReferenceAdapter } from "@/app/artifacts/artifactHostReference";
import {
    connectedAccountPluginCollectionHostReferenceAdapter,
} from "@/app/api/routes/connect/qualifiedConnectedAccounts/pluginCollectionHostReferenceAdapter";
import { machinePluginCollectionHostReferenceAdapter } from "@/app/machines/pluginCollectionHostReferenceAdapter";
import {
    messagePluginCollectionHostReferenceAdapter,
    sessionPluginCollectionHostReferenceAdapter,
} from "@/app/session/pluginCollectionHostReferenceAdapter";

import { accountPluginCollectionHostReferenceAdapter } from "./accountHostReference";
import {
    createPluginCollectionHostReferenceResolver,
    type PluginCollectionHostReferenceAdapters,
} from "./hostReferences";

/**
 * The server mutation owner resolves host identities in its own transaction.
 * Domain adapters remain the only readers of their public Account-scoped
 * identities; absent domain adapters fail closed in the shared resolver.
 */
export const pluginCollectionHostReferenceResolver = createPluginCollectionHostReferenceResolver({
    account: accountPluginCollectionHostReferenceAdapter,
    machine: machinePluginCollectionHostReferenceAdapter,
    session: sessionPluginCollectionHostReferenceAdapter,
    message: messagePluginCollectionHostReferenceAdapter,
    artifact: artifactPluginCollectionHostReferenceAdapter,
    connectedAccount: connectedAccountPluginCollectionHostReferenceAdapter,
} satisfies PluginCollectionHostReferenceAdapters);
