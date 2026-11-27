import { markAccountChanged } from "@/app/changes/markAccountChanged";
import { type Tx } from "@/storage/inTx";

export const SANDBOX_PLAN_SOURCES = ["app_store_sandbox", "play_sandbox"] as const;
export type AccountPlanSource = "polar" | "app_store" | "play" | "manual" | "team" | typeof SANDBOX_PLAN_SOURCES[number];

export function isSandboxPlanSource(source: string | null | undefined): boolean {
    return SANDBOX_PLAN_SOURCES.some((candidate) => candidate === source);
}

export type AccountPlanColumns = Readonly<{
    plan: string | null;
    planSource: AccountPlanSource | null;
    planEndsAt: Date | null;
    planRenews: boolean;
    supporterRing: boolean;
}>;

/** The `AccountChange` entity for plan state; clients invalidate only the plan resource on it. */
export const ACCOUNT_PLAN_CHANGE_ENTITY_ID = "plan";

function sameDate(left: Date | null, right: Date | null): boolean {
    return (left?.getTime() ?? null) === (right?.getTime() ?? null);
}

/**
 * The only writer of an Account's plan columns and ring consent.
 *
 * Compares the requested columns with the stored row and writes only real differences: a replayed
 * provider webhook, or several provider events for one change, write nothing and publish nothing.
 * A real change writes once, records one `AccountChange` (`kind: account`, entity `plan`) and uses
 * the Account change feed to wake clients after commit.
 */
export async function writeAccountPlanStateInTx(
    tx: Tx,
    accountId: string,
    next: Partial<AccountPlanColumns>,
): Promise<Readonly<{ changed: boolean }>> {
    const current = await tx.account.findUnique({
        where: { id: accountId },
        select: { plan: true, planSource: true, planEndsAt: true, planRenews: true, supporterRing: true },
    });
    if (!current) return { changed: false };

    const data: { -readonly [K in keyof AccountPlanColumns]?: AccountPlanColumns[K] } = {};
    if (next.plan !== undefined && next.plan !== current.plan) data.plan = next.plan;
    if (next.planSource !== undefined && next.planSource !== current.planSource) data.planSource = next.planSource;
    if (next.planEndsAt !== undefined && !sameDate(next.planEndsAt, current.planEndsAt)) data.planEndsAt = next.planEndsAt;
    if (next.planRenews !== undefined && next.planRenews !== current.planRenews) data.planRenews = next.planRenews;
    if (next.supporterRing !== undefined && next.supporterRing !== current.supporterRing) data.supporterRing = next.supporterRing;
    if (Object.keys(data).length === 0) return { changed: false };

    await tx.account.update({ where: { id: accountId }, data });
    await markAccountChangedForPlanInTx(tx, accountId);
    return { changed: true };
}

/**
 * Records the plan `AccountChange` and pushes it after commit. Also used when the Account's
 * supporter record changes, since `GET /v1/account/plan` carries the supporter facts.
 */
export async function markAccountChangedForPlanInTx(tx: Tx, accountId: string): Promise<void> {
    await markAccountChanged(tx, {
        accountId,
        kind: "account",
        entityId: ACCOUNT_PLAN_CHANGE_ENTITY_ID,
        hint: { plan: true },
    });
}
