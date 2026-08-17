import type { PluginCollectionHostReferenceAdapter } from "@/app/plugins/data/collections/hostReferences";

import { artifactOrdinaryWhere } from "./artifactClassification";

const AVAILABLE = Object.freeze({ status: "available" as const });
const TOMBSTONE = Object.freeze({ status: "tombstone" as const });
const UNAVAILABLE = Object.freeze({ status: "unavailable" as const });

/**
 * Canonical Account-authorized Artifact reference admission for plugin data.
 *
 * A live Artifact is available. After its owning Account deletes it, the
 * incumbent Artifact change record remains as the deletion tombstone until its
 * own retention lifecycle removes it. Data never reads either Artifact table
 * directly and cannot turn a relation target into an Artifact capability.
 */
export const artifactPluginCollectionHostReferenceAdapter = {
    hostKind: "artifact",
    async resolveInTx({ tx, accountId, targetId }) {
        const artifact = await tx.artifact.findFirst({
            where: {
                id: targetId,
                accountId,
                ...artifactOrdinaryWhere,
            },
            select: { id: true },
        });
        if (artifact) return AVAILABLE;

        const change = await tx.accountChange.findUnique({
            where: {
                accountId_kind_entityId: {
                    accountId,
                    kind: "artifact",
                    entityId: targetId,
                },
            },
            select: { artifactId: true },
        });
        return change?.artifactId === null ? TOMBSTONE : UNAVAILABLE;
    },
} satisfies PluginCollectionHostReferenceAdapter;
