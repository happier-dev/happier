import { markAccountsChanged, type AccountChangePublication } from "@/app/changes/markAccountChanged";
import type { Tx } from "@/storage/inTx";

export type SessionAccountChangeCursor = { accountId: string; cursor: number };
export type SessionAccountChangePublication = AccountChangePublication;

/** Resolve only from a transaction's explicit final projection or after commit. */
export function resolveSessionAccountChangePublications(
    publications: readonly SessionAccountChangePublication[],
): SessionAccountChangeCursor[] {
    return publications.map(publication => ({ accountId: publication.accountId, cursor: publication.resolveCursor() }));
}

/**
 * The generic Session AccountChange fanout.
 *
 * It knows only how to wake an explicit set of Accounts for one Session. Every
 * decision about *which* Accounts and *whether* a hint is safe for a given
 * recipient belongs to the caller above it, so transcript publication ceilings
 * cannot silently become the ceiling of an unrelated Session-owned domain.
 */
export async function markAccountChangesForSessionAccounts(params: {
    tx: Tx;
    sessionId: string;
    accountIds: readonly string[];
    hint?: unknown;
    hintForAccount?: (accountId: string) => { kind: "suppress" } | { kind: "publish"; value: unknown };
    currentViewForAccount?: (accountId: string) => boolean;
}): Promise<SessionAccountChangePublication[]> {
    const hints = new Map<string, unknown>();
    for (const accountId of params.accountIds) {
        const projected = params.hintForAccount
            ? params.hintForAccount(accountId)
            : { kind: "publish" as const, value: params.hint };
        if (projected.kind === "suppress") continue;
        hints.set(accountId, projected.value);
    }
    return markAccountsChanged(params.tx, {
        accountIds: [...hints.keys()], kind: "session", entityId: params.sessionId,
        hintForAccount: accountId => hints.get(accountId),
        currentViewForAccount: params.currentViewForAccount,
    });
}
