import { inTx } from "@/storage/inTx";
import { resolveVoiceQuotaWindow } from "./voiceQuotaWindow";

type PruneExpiredVoiceSessionLeasesParams = Readonly<{
    cutoff: Date;
    now?: Date;
    accountId?: string;
    limit?: number;
    dryRun?: boolean;
}>;

/**
 * Prunes expired Voice leases without losing completed or reserved quota usage.
 *
 * Current application cleanup paths converge here and copy the exact lease-owned grant
 * before deletion. The schema migration's deletion trigger is a bounded rolling-deploy
 * adapter for older binaries that cannot call this owner; it has the same exact source
 * value and a removal condition rather than a second quota decision.
 */
export async function pruneExpiredVoiceSessionLeases(
    params: PruneExpiredVoiceSessionLeasesParams,
): Promise<number> {
    const { periodKey, dayStart } = resolveVoiceQuotaWindow(params.now ?? new Date());
    return await inTx(async (tx) => {
        const where = {
            ...(params.accountId ? { accountId: params.accountId } : {}),
            expiresAt: { lt: params.cutoff },
            OR: [
                { conversation: { isNot: null } },
                // Unsettled leases remain the conservative quota source until both mint
                // windows exclude them. Expiry only releases concurrency, not usage.
                { periodKey: { lt: periodKey }, createdAt: { lt: dayStart } },
            ],
        };
        const leases = await tx.voiceSessionLease.findMany({
            where,
            orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
            ...(params.limit === undefined ? {} : { take: params.limit }),
            select: { id: true },
        });
        if (params.dryRun || leases.length === 0) {
            return leases.length;
        }

        const leaseIds = leases.map((lease) => lease.id);
        const completedWithoutGrant = await tx.voiceConversation.findMany({
            where: {
                leaseId: { in: leaseIds },
                OR: [
                    { grantedBy: null },
                    { grantPeriodKey: null },
                ],
            },
            select: {
                id: true,
                leaseId: true,
                grantedBy: true,
                grantPeriodKey: true,
                lease: {
                    select: {
                        grantedBy: true,
                        periodKey: true,
                    },
                },
            },
        });
        for (const conversation of completedWithoutGrant) {
            if (!conversation.leaseId || !conversation.lease) continue;
            await tx.voiceConversation.updateMany({
                where: {
                    id: conversation.id,
                    leaseId: conversation.leaseId,
                    OR: [
                        { grantedBy: null },
                        { grantPeriodKey: null },
                    ],
                },
                data: {
                    grantedBy: conversation.grantedBy ?? conversation.lease.grantedBy,
                    grantPeriodKey: conversation.grantPeriodKey ?? conversation.lease.periodKey,
                },
            });
        }

        const result = await tx.voiceSessionLease.deleteMany({
            where: {
                id: { in: leaseIds },
                // The selected cohort already passed quota-source admission.
                // Do not read VoiceConversation in this DELETE: MySQL's legacy
                // provenance trigger updates that table before detaching it.
                expiresAt: { lt: params.cutoff },
            },
        });
        return result.count;
    });
}
