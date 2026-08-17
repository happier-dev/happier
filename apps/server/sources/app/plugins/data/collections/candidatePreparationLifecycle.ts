import type { Tx } from "@/storage/inTx";

/**
 * The one physical retirement primitive for non-authoritative candidate
 * preparations. Callers supply only their canonical lifecycle scope; stages
 * never decide when they remain current themselves.
 */
export async function retirePluginCollectionCandidatePreparationStagesTx(input: Readonly<{
    tx: Tx;
    accountId: string;
    pluginId?: string;
    sourceRowDbIds?: readonly string[];
}>): Promise<void> {
    const sourceRowDbIds = input.sourceRowDbIds
        ? [...new Set(input.sourceRowDbIds)]
        : undefined;
    if (sourceRowDbIds?.length === 0) return;
    await input.tx.pluginCollectionCandidatePreparationStage.deleteMany({
        where: {
            accountId: input.accountId,
            ...(input.pluginId ? { pluginId: input.pluginId } : {}),
            ...(sourceRowDbIds ? { sourceRowDbId: { in: sourceRowDbIds } } : {}),
        },
    });
}
