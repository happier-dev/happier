import type { Tx } from "@/storage/inTx";
import { buildSessionAccessWhere } from "./sessionAccessWhere";
import type { SessionAccessAuthentication } from "./sessionAccessAuthentication";
import { SESSION_ACCESS_SESSION_BATCH_SIZE } from "./sessionAccess";

/** Admit exact Session ids through the canonical access policy in the caller's snapshot. */
export async function readCurrentSessionIdsInTx(tx: Tx, input: Readonly<{
    accountId: string;
    sessionIds: readonly string[];
    authentication: SessionAccessAuthentication;
    accessMode?: "effective_access_v1" | "legacy_owner_or_direct";
}>): Promise<ReadonlySet<string>> {
    if (input.sessionIds.length === 0) return new Set();
    // The effective compiler retains credential/runtime-principal admission;
    // the released seam additionally narrows to its existing owner/direct corpus.
    const effectiveWhere = await buildSessionAccessWhere({ tx, accountId: input.accountId, capability: "readTranscript", mode: "effective_access_v1", authentication: input.authentication });
    const where = input.accessMode === "legacy_owner_or_direct" ? { AND: [effectiveWhere,
        buildSessionAccessWhere({ accountId: input.accountId, capability: "readTranscript", mode: "legacy_owner_or_direct" }),
    ] } : effectiveWhere;
    const result = new Set<string>();
    // Reuse the access owner's portable transport batch; never truncate the corpus.
    for (let offset = 0; offset < input.sessionIds.length; offset += SESSION_ACCESS_SESSION_BATCH_SIZE) {
        const rows = await tx.session.findMany({
            where: { AND: [where, { id: { in: input.sessionIds.slice(offset, offset + SESSION_ACCESS_SESSION_BATCH_SIZE) } }] },
            select: { id: true },
        });
        for (const row of rows) result.add(row.id);
    }
    return result;
}
