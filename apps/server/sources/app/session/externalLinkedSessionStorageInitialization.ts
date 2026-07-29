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

export type ExternalLinkedSessionStorageInitializationResult =
    | Readonly<{ ok: true; session: ExternalLinkedSessionStorageRow }>
    | Readonly<{ ok: false; reason: "unsafe_authority" | "concurrent_change" }>;

/**
 * Narrow prepare-stage repair for rows created by a released server before it
 * could persist external-link storage authority. The conditional write is the
 * sole hosted -> machine_only transition; any server transcript/publication
 * authority makes reclassification unsafe.
 */
export async function initializeExternalLinkedSessionStorage(
    client: Pick<Tx, "session">,
    session: ExternalLinkedSessionStorageRow,
    accountId?: string,
): Promise<ExternalLinkedSessionStorageInitializationResult> {
    const isSafePredecessorLink =
        session.currentStorageState === "hosted"
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
            currentStorageState: "hosted",
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
