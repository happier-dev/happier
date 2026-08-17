import { PLUGIN_ACCOUNT_STORAGE_KEY_PREFIX } from "@/app/kv/accountScopedKv";
import type { Tx } from "@/storage/inTx";
import { getActivePrismaRuntime } from "@/storage/prisma";

/**
 * Data's closed-participant PEP1 check. It names only currently persisted,
 * mode-bound Data content; it neither stages nor transforms any Data row.
 * The Account transition owner invokes it after taking its Account-first fence
 * in the same transaction that decides whether a transition may proceed.
 */
export type PluginAccountDataEncryptionTransitionCensus =
    | Readonly<{ status: "account_not_found" }>
    | Readonly<{ status: "empty" }>
    | Readonly<{
        status: "nonempty";
        accountStorage: boolean;
        collections: false | "live" | "invalid_tombstone";
        // Keep live-row presence independent from a residual tombstone. The
        // latter remains an invalid V4 participant, but it must not hide a
        // predecessor-visible Collection compatibility refusal.
        hasLiveCollection: boolean;
    }>;

export async function inspectPluginAccountDataForEncryptionTransitionInTx(
    tx: Tx,
    accountId: string,
): Promise<PluginAccountDataEncryptionTransitionCensus> {
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: { id: true },
    });
    if (!account) return { status: "account_not_found" };

    const [accountStorage, liveCollection, residualTombstone] = await Promise.all([
        tx.userKVStore.findFirst({
            where: {
                accountId,
                key: { startsWith: PLUGIN_ACCOUNT_STORAGE_KEY_PREFIX },
                value: { not: null },
            },
            select: { id: true },
        }),
        tx.pluginCollectionRow.findFirst({
            where: { accountId, deletedAt: null },
            select: { id: true },
        }),
        // Historical anti-resurrection rows participate only when they still
        // retain private content. Filtering all tombstones would hide a
        // malformed/unscrubbed envelope and permit an unsafe mode flip.
        tx.pluginCollectionRow.findFirst({
            where: {
                accountId,
                deletedAt: { not: null },
                contentEnvelope: { not: getActivePrismaRuntime().JsonNull },
            },
            select: { id: true },
        }),
    ]);
    if (!accountStorage && !liveCollection && !residualTombstone) {
        return { status: "empty" };
    }
    return {
        status: "nonempty",
        accountStorage: accountStorage !== null,
        collections: residualTombstone !== null
            ? "invalid_tombstone"
            : liveCollection !== null
                ? "live"
                : false,
        hasLiveCollection: liveCollection !== null,
    };
}
