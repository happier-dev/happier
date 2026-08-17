import type { PluginCollectionHostReferenceAdapter } from "@/app/plugins/data/collections/hostReferences";

import { readMachineAvailabilityStateInTx } from "./machineStateGuards";

/**
 * Machine-owned Account identity/availability adapter for Data host relations.
 * It exposes no Machine mutation authority and deliberately hides replacement ids.
 */
export const machinePluginCollectionHostReferenceAdapter = Object.freeze({
    hostKind: "machine",
    async resolveInTx(input) {
        const state = await readMachineAvailabilityStateInTx({
            tx: input.tx,
            accountId: input.accountId,
            machineId: input.targetId,
        });
        if (state === "available") return Object.freeze({ status: "available" as const });
        if (state === "revoked" || state === "replaced") {
            return Object.freeze({ status: "tombstone" as const });
        }
        return Object.freeze({ status: "unavailable" as const });
    },
} satisfies PluginCollectionHostReferenceAdapter);
