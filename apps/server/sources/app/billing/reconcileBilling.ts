import type { SupporterKindV1 } from "@happier-dev/protocol";

import { resolveLimitTable } from "@/app/plans/accountLimits";
import { markAccountChangedForPlanInTx, writeAccountPlanStateInTx, type AccountPlanColumns } from "@/app/plans/accountPlanState";
import { inTx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/db";

import type { PolarClient, PolarOrder, PolarSubscription } from "./polarClient";
import { applySupporterPurchaseFactsInTx, isSupporterCode, type SupporterPurchaseFacts } from "./supporterRecords";

/** Polar statuses that still grant access. `past_due` keeps paid state until Polar ends it. */
const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);
/** Orders whose money remains paid (a partial refund changes nothing). */
const PAID_ORDER_STATUSES = new Set(["paid", "partially_refunded"]);
const SUPPORTER_PRODUCT_KIND = "supporter";
type ReconciliationResult = Readonly<{ changed: boolean }>;
type ReconciliationDeps = Readonly<{ polar: PolarClient; env: NodeJS.ProcessEnv; now?: () => Date }>;
const pendingByRef = new Map<string, Promise<ReconciliationResult>>();

/** `ref` is what a purchase carries: an Account id (cuid) on Cloud, a supporter code otherwise. */
const ACCOUNT_ID_PATTERN = /^c[a-z0-9]{20,31}$/;

export function isBillingRef(ref: string): boolean {
    return ACCOUNT_ID_PATTERN.test(ref) || isSupporterCode(ref);
}

export type DerivedPlanFacts = Readonly<{ planId: string; endsAt: Date | null; renews: boolean }>;

export type DerivedBillingFacts = Readonly<{
    /** Highest live plan across sources, or null when no plan source is live. */
    plan: DerivedPlanFacts | null;
    supporter: SupporterPurchaseFacts;
}>;

function productKind(item: PolarSubscription | PolarOrder): string | null {
    const kind = item.product?.metadata?.happier_kind;
    return typeof kind === "string" ? kind : null;
}

function toDate(value: string | null | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Derives the whole billing state of one `ref` from Polar's current subscriptions and orders.
 * Pure: the event that triggered the read contributes nothing but the `ref`, so duplicates,
 * reordering and replays converge.
 *
 * Plan: a plan is live if any source is live; with several, the highest plan in configured order
 * wins (M6), and its source ending last sets the end date. Supporter: a paid purchase or a live
 * paid subscription earns it (a paid plan includes the Supporter pack); a refund that leaves no
 * paid purchase revokes it.
 */
export function deriveBillingFacts(input: Readonly<{
    subscriptions: readonly PolarSubscription[];
    orders: readonly PolarOrder[];
    planOrder: readonly string[];
}>): DerivedBillingFacts {
    const isPlanKind = (kind: string | null) => kind !== null && input.planOrder.includes(kind);
    const isSupportKind = (kind: string | null) => kind === SUPPORTER_PRODUCT_KIND || isPlanKind(kind);

    let plan: DerivedPlanFacts | null = null;
    let planRank = -1;
    for (const subscription of input.subscriptions) {
        const kind = productKind(subscription);
        if (!kind || !isPlanKind(kind) || !LIVE_SUBSCRIPTION_STATUSES.has(subscription.status)) continue;
        const rank = input.planOrder.indexOf(kind);
        const endsAt = toDate(subscription.current_period_end);
        const candidate = { planId: kind, endsAt, renews: subscription.cancel_at_period_end !== true };
        const endsLater = plan !== null && (plan.endsAt?.getTime() ?? Infinity) < (endsAt?.getTime() ?? Infinity);
        if (rank > planRank || (rank === planRank && endsLater)) {
            plan = candidate;
            planRank = rank;
        }
    }

    const supportSubscriptions = input.subscriptions.filter((subscription) => isSupportKind(productKind(subscription)));
    const supportOrders = input.orders.filter((order) => isSupportKind(productKind(order)));
    const liveSupportSubscriptions = supportSubscriptions.filter((subscription) => LIVE_SUBSCRIPTION_STATUSES.has(subscription.status));
    const paidOrders = supportOrders.filter((order) => PAID_ORDER_STATUSES.has(order.status));
    const refundedOrders = supportOrders.filter((order) => order.status === "refunded");

    let kind: SupporterKindV1 = "plan";
    if (supportSubscriptions.some((subscription) => productKind(subscription) === SUPPORTER_PRODUCT_KIND)) kind = "supporter_monthly";
    else if (supportOrders.some((order) => productKind(order) === SUPPORTER_PRODUCT_KIND)) kind = "supporter_once";

    const purchaseDates = [
        ...supportOrders.map((order) => toDate(order.created_at)),
        ...supportSubscriptions.map((subscription) => toDate(subscription.started_at)),
    ].filter((date): date is Date => date !== null);

    return {
        plan,
        supporter: {
            earned: paidOrders.length > 0 || liveSupportSubscriptions.length > 0,
            revoked: refundedOrders.length > 0 && paidOrders.length === 0 && liveSupportSubscriptions.length === 0,
            recurringActive: liveSupportSubscriptions.length > 0,
            kind,
            firstPurchaseAt: purchaseDates.length > 0 ? new Date(Math.min(...purchaseDates.map((date) => date.getTime()))) : null,
        },
    };
}

/**
 * The next plan columns for an Account from derived facts. Never writes `plan = null`: with no live
 * source, an existing provider plan ends now (`planEndsAt = min(existing, now)`, not renewing) so
 * grace and notice apply. `manual` and `team` plans are left alone unless a live source exists.
 */
function nextPlanColumns(current: Readonly<{ plan: string | null; planSource: string | null; planEndsAt: Date | null }>, plan: DerivedPlanFacts | null, now: Date): Partial<AccountPlanColumns> | null {
    if (plan) return { plan: plan.planId, planSource: "polar", planEndsAt: plan.endsAt, planRenews: plan.renews };
    if (current.plan === null) return null;
    if (current.planSource === "manual" || current.planSource === "team") return null;
    const endsAt = current.planEndsAt && current.planEndsAt.getTime() < now.getTime() ? current.planEndsAt : now;
    return { planEndsAt: endsAt, planRenews: false };
}

/**
 * The only reader of provider state and the only writer of provider-derived plan and supporter
 * facts (plan 03 M3). Reads Polar for `ref` (outside any transaction), then applies the derived
 * state in one transaction through plan 01's compare-and-write writer. A failed provider read
 * throws `PolarRequestError` before anything is written, so an outage never downgrades anyone.
 */
export async function reconcileBillingForRef(ref: string, deps: ReconciliationDeps): Promise<ReconciliationResult> {
    if (!isBillingRef(ref)) return { changed: false };
    const previous = pendingByRef.get(ref);
    const reconcile = () => readAndApplyBillingFacts(ref, deps);
    const pending = previous ? previous.then(reconcile, reconcile) : reconcile();
    pendingByRef.set(ref, pending);
    try {
        return await pending;
    } finally {
        if (pendingByRef.get(ref) === pending) pendingByRef.delete(ref);
    }
}

async function readAndApplyBillingFacts(ref: string, deps: ReconciliationDeps): Promise<ReconciliationResult> {
    const table = resolveLimitTable(deps.env);
    // An unreadable plan config must not turn paying people into unknown-plan rows or end their plan.
    if (!table.ok) throw new Error(`Billing reconciliation stopped: ${table.error}`);
    const [subscriptions, orders] = await Promise.all([
        deps.polar.listSubscriptionsForRef(ref),
        deps.polar.listOrdersForRef(ref),
    ]);
    const facts = deriveBillingFacts({ subscriptions, orders, planOrder: table.planOrder });

    const apply = async () => await inTx(async (tx) => {
        const now = deps.now?.() ?? new Date();
        const account = ACCOUNT_ID_PATTERN.test(ref)
            ? await tx.account.findUnique({ where: { id: ref }, select: { id: true, plan: true, planSource: true, planEndsAt: true } })
            : null;
        if (!account && !isSupporterCode(ref)) return { changed: false };
        const supporter = await applySupporterPurchaseFactsInTx(tx, {
            accountId: account?.id ?? null,
            code: account ? null : ref,
            facts: facts.supporter,
            now,
        });
        if (!account) return { changed: supporter.changed };

        const planColumns = nextPlanColumns(account, facts.plan, now);
        const next = { ...planColumns, ...(supporter.revokedNow ? { supporterRing: false } : {}) };
        const plan = await writeAccountPlanStateInTx(tx, account.id, next);
        // The plan read carries the supporter facts, so a supporter-only change publishes once too.
        if (!plan.changed && supporter.changed) await markAccountChangedForPlanInTx(tx, account.id);
        return { changed: plan.changed || supporter.changed };
    });

    try {
        return await apply();
    } catch (error) {
        // Two first payments racing for the next supporter number: the loser re-reads once.
        if (isPrismaErrorCode(error, "P2002")) return await apply();
        throw error;
    }
}
