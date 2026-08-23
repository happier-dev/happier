import type { Tx } from "@/storage/inTx";

export type ExternalLinkedSessionStorageRow = Readonly<{
    id: string;
    currentStorageState: string;
    seq: number;
    acceptedThroughServerSeq: number | null;
    materializationPublicationId: string | null;
    materializedThroughSourceAt: bigint | null;
    publishedThroughServerSeq: number | null;
}>;

/**
 * Predecessor states an owner machine may reconcile. Every other state already
 * carries positive server authority and must not be reinterpreted.
 */
const RECONCILABLE_PREDECESSOR_STORAGE_STATES: readonly string[] = [
    "hosted",
    "legacy_external_unknown",
];

export type ExternalLinkedSessionStorageInitializationResult =
    | Readonly<{ ok: true; session: ExternalLinkedSessionStorageRow }>
    | Readonly<{ ok: false; reason: "unsafe_authority" | "concurrent_change" }>;

/**
 * The one owner-machine reconciliation for predecessor external-link rows.
 *
 * Two predecessor shapes reach it: a row a released server created before it
 * could persist external-link storage authority (`hosted`), and a
 * `direct:v1:*` row the publication-authority migration failed closed to
 * `legacy_external_unknown`. Both carry the same evidence — no server
 * transcript, no publication tuple — and the owner machine relinking the tag
 * is the assertion that resolves it. The conditional write is the sole
 * transition into `machine_only`; any server transcript/publication authority
 * makes reclassification unsafe, so message presence never upgrades a row.
 */
export async function initializeExternalLinkedSessionStorage(
    client: Pick<Tx, "session">,
    session: ExternalLinkedSessionStorageRow,
    accountId?: string,
): Promise<ExternalLinkedSessionStorageInitializationResult> {
    const isSafePredecessorLink =
        RECONCILABLE_PREDECESSOR_STORAGE_STATES.includes(session.currentStorageState)
        && session.seq === 0
        && session.acceptedThroughServerSeq === null
        && session.materializationPublicationId === null
        && session.materializedThroughSourceAt === null
        && session.publishedThroughServerSeq === null;
    if (!isSafePredecessorLink) {
        return { ok: false, reason: "unsafe_authority" };
    }

    const repaired = await client.session.updateMany({
        where: {
            id: session.id,
            ...(accountId ? { accountId } : {}),
            currentStorageState: { in: [...RECONCILABLE_PREDECESSOR_STORAGE_STATES] },
            seq: 0,
            acceptedThroughServerSeq: null,
            materializationPublicationId: null,
            materializedThroughSourceAt: null,
            publishedThroughServerSeq: null,
        },
        data: { currentStorageState: "machine_only" },
    });
    if (repaired.count === 1) {
        return {
            ok: true,
            session: { ...session, currentStorageState: "machine_only" },
        };
    }

    const concurrent = await client.session.findFirst({
        where: {
            id: session.id,
            ...(accountId ? { accountId } : {}),
        },
        select: { currentStorageState: true },
    });
    if (concurrent?.currentStorageState === "machine_only") {
        return {
            ok: true,
            session: { ...session, currentStorageState: "machine_only" },
        };
    }
    return { ok: false, reason: "concurrent_change" };
}
