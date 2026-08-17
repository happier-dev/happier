import type { PluginCollectionHostReferenceAdapter } from "./hostReferences";

const AVAILABLE = Object.freeze({ status: "available" as const });
const UNAVAILABLE = Object.freeze({ status: "unavailable" as const });

/**
 * The authenticated Collection Account is already admitted by the mutation
 * owner. An Account relation may name that exact root identity only; it never
 * performs Account discovery or exposes any Account capability.
 */
export const accountPluginCollectionHostReferenceAdapter = Object.freeze({
    hostKind: "account",
    async resolveInTx({ accountId, targetId }) {
        return targetId === accountId ? AVAILABLE : UNAVAILABLE;
    },
} satisfies PluginCollectionHostReferenceAdapter);
