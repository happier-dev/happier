import { PLUGIN_DECLARATIVE_SETTINGS_KEY_PREFIX } from "@/app/kv/accountScopedKv";
import type { Tx } from "@/storage/inTx";

/**
 * Persisted mode-bound Settings census. Declarative plugin Settings still
 * block conversion; history participates in the canonical Settings re-seal.
 * The empty-only PATCH has no history replacements and must refuse both.
 * This census never stages or transforms a Settings row.
 *
 * The Account transition owner invokes it after taking its Account-first
 * fence in the same transaction that decides whether a transition may proceed.
 */
export type AccountSettingsEncryptionTransitionCensus =
    | Readonly<{ status: "account_not_found" }>
    | Readonly<{ status: "empty" }>
    | Readonly<{
        status: "nonempty";
        declarativeSettings: boolean;
        history: boolean;
    }>;

export async function inspectAccountSettingsForEncryptionTransitionInTx(
    tx: Tx,
    accountId: string,
): Promise<AccountSettingsEncryptionTransitionCensus> {
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: { id: true },
    });
    if (!account) return { status: "account_not_found" };

    const [declarativeSettings, history] = await Promise.all([
        tx.userKVStore.findFirst({
            where: {
                accountId,
                key: { startsWith: PLUGIN_DECLARATIVE_SETTINGS_KEY_PREFIX },
                value: { not: null },
            },
            select: { id: true },
        }),
        tx.accountSettingsSnapshot.findFirst({
            where: {
                accountId,
            },
            select: { id: true },
        }),
    ]);
    if (!declarativeSettings && !history) return { status: "empty" };

    return {
        status: "nonempty",
        declarativeSettings: declarativeSettings !== null,
        history: history !== null,
    };
}
