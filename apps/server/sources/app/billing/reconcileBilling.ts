import type { SupporterKindV1 } from "@happier-dev/protocol";

import { resolveLimitTable } from "@/app/plans/accountLimits";
import { markAccountChangedForPlanInTx, writeAccountPlanStateInTx, type AccountPlanColumns, type AccountPlanSource } from "@/app/plans/accountPlanState";
import { inTx } from "@/storage/inTx";
import { isPrismaErrorCode } from "@/storage/db";

import type { PolarClient, PolarOrder, PolarSubscription } from "./polarClient";
import { applySupporterPurchaseFactsInTx, isSupporterCode, transferSupporterRecordInTx, type SupporterPurchaseFacts } from "./supporterRecords";
import type { RevenueCatClient } from "./revenueCatClient";
import { combineBillingFacts, deriveRevenueCatFacts } from "./revenueCatFacts";

/** Polar statuses that still grant access. `past_due` keeps paid state until Polar ends it. */
const LIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "past_due"]);
/** Orders whose money remains paid (a partial refund changes nothing). */
const PAID_ORDER_STATUSES = new Set(["paid", "partially_refunded"]);
const SUPPORTER_PRODUCT_KIND = "supporter";
const pendingReconciliations = new Map<string, Promise<Readonly<{ changed: boolean }>>>();

type ReconcileBillingDeps = Readonly<{
    polar?: PolarClient | null;
    revenueCat?: RevenueCatClient | null;
    env: NodeJS.ProcessEnv;
    now?: () => Date;
}>;

/** `ref` is what a purchase carries: an Account id (cuid) on Cloud, a supporter code otherwise. */
const ACCOUNT_ID_PATTERN = /^c[a-z0-9]{20,31}$/;

export function isBillingRef(ref: string): boolean {
    return ACCOUNT_ID_PATTERN.test(ref) || isSupporterCode(ref);
}

export type DerivedPlanFacts = Readonly<{ planId: string; source: AccountPlanSource; endsAt: Date | null; renews: boolean }>;

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
        const candidate = { planId: kind, source: "polar" as const, endsAt, renews: subscription.cancel_at_period_end !== true };
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
    const liveSubscriptionIds = new Set(liveSupportSubscriptions.map(({ id }) => id));
    const recurringOrderDates = paidOrders.flatMap((order) => {
        const date = order.subscription_id && liveSubscriptionIds.has(order.subscription_id) ? toDate(order.created_at) : null;
        return date ? [date.getTime()] : [];
    });
    const recurringDates = [
        ...recurringOrderDates,
        ...liveSupportSubscriptions.flatMap((subscription) => {
            const started = toDate(subscription.started_at);
            return started ? [started.getTime()] : [];
        }),
    ];

    return {
        plan,
        supporter: {
            earned: paidOrders.length > 0 || liveSupportSubscriptions.length > 0,
            revoked: refundedOrders.length > 0 && paidOrders.length === 0 && liveSupportSubscriptions.length === 0,
            recurringActive: liveSupportSubscriptions.length > 0,
            kind,
            firstPurchaseAt: purchaseDates.length > 0 ? new Date(Math.min(...purchaseDates.map((date) => date.getTime()))) : null,
            latestRecurringPurchaseAt: recurringDates.length > 0 ? new Date(Math.max(...recurringDates)) : null,
        },
    };
}

/**
 * The next plan columns for an Account from derived facts. Never writes `plan = null`: with no live
 * source, an existing provider plan ends now (`planEndsAt = min(existing, now)`, not renewing) so
 * grace and notice apply. `manual` and `team` plans are left alone unless a live source exists.
 */
function nextPlanColumns(current: Readonly<{ plan: string | null; planSource: string | null; planEndsAt: Date | null }>, plan: DerivedPlanFacts | null, now: Date): Partial<AccountPlanColumns> | null {
    if (plan) return { plan: plan.planId, planSource: plan.source, planEndsAt: plan.endsAt, planRenews: plan.renews };
    if (current.plan === null) return null;
    if (current.planSource === "manual" || current.planSource === "team") return null;
    const endsAt = current.planEndsAt && current.planEndsAt.getTime() < now.getTime() ? current.planEndsAt : now;
    return { planEndsAt: endsAt, planRenews: false };
}

/**
 * The only reader of provider state and the only writer of provider-derived plan and supporter
 * facts (plan 03 M3). Reads each configured provider before applying the derived state.
 * A transfer settles both sides in the same transaction.
 */
export async function reconcileBillingForRef(ref: string, deps: ReconcileBillingDeps, transferFrom: readonly string[] = []): Promise<Readonly<{ changed: boolean }>> {
    if (!isBillingRef(ref)) return { changed: false };
    const refs = [ref, ...new Set(transferFrom.filter((id) => id !== ref && isBillingRef(id)))];
    const previous = refs.flatMap((id) => pendingReconciliations.get(id) ?? []);
    // Queue the read as well as the write so a later reconciliation gets fresh provider state.
    const reconcile = () => readAndApplyBillingFacts(refs, deps);
    const pending = previous.length ? Promise.allSettled(previous).then(reconcile) : reconcile();
    for (const id of refs) pendingReconciliations.set(id, pending);
    try {
        return await pending;
    } finally {
        for (const id of refs) {
            if (pendingReconciliations.get(id) === pending) pendingReconciliations.delete(id);
        }
    }
}

async function readAndApplyBillingFacts(refs: readonly string[], deps: ReconcileBillingDeps) {
    const table = resolveLimitTable(deps.env);
    // An unreadable plan config must not turn paying people into unknown-plan rows or end their plan.
    if (!table.ok) throw new Error(`Billing reconciliation stopped: ${table.error}`);
    const now = deps.now?.() ?? new Date();
    const [destination, ...sources] = await Promise.all(refs.map(async (id) => {
        const [subscriptions, orders, subscriber] = await Promise.all([
            deps.polar?.listSubscriptionsForRef(id) ?? [],
            deps.polar?.listOrdersForRef(id) ?? [],
            deps.revenueCat?.readSubscriber(id) ?? null,
        ]);
        const polar = deriveBillingFacts({ subscriptions, orders, planOrder: table.planOrder });
        const revenueCat = deriveRevenueCatFacts(subscriber, table.planOrder, now);
        return { id, revenueCat, facts: combineBillingFacts([polar, revenueCat], table.planOrder) };
    }));

    const apply = async () => await inTx(async (tx) => {
        let movedFrom: string | null = null;
        if (destination.revenueCat.supporter.earned) {
            for (const source of sources) {
                if (!source.facts.supporter.earned && await transferSupporterRecordInTx(tx, source.id, destination.id)) {
                    movedFrom = source.id;
                    break;
                }
            }
        }
        let changed = movedFrom !== null;
        for (const { id, facts } of [destination, ...sources]) {
            const account = ACCOUNT_ID_PATTERN.test(id)
                ? await tx.account.findUnique({ where: { id }, select: { id: true, plan: true, planSource: true, planEndsAt: true } })
                : null;
            if (!account && !isSupporterCode(id)) continue;
            const supporter = await applySupporterPurchaseFactsInTx(tx, {
                accountId: account?.id ?? null,
                code: account ? null : id,
                facts: facts.supporter,
                now,
            });
            changed ||= supporter.changed;
            if (!account) continue;
            const planColumns = nextPlanColumns(account, facts.plan, now);
            const clearRing = supporter.revokedNow || id === movedFrom;
            const plan = await writeAccountPlanStateInTx(tx, account.id, {
                ...planColumns, ...(clearRing ? { supporterRing: false } : {}),
            });
            if (!plan.changed && (supporter.changed || (movedFrom !== null && (id === movedFrom || id === destination.id)))) {
                await markAccountChangedForPlanInTx(tx, account.id);
            }
            changed ||= plan.changed;
        }
        return { changed };
    });

    try {
        return await apply();
    } catch (error) {
        // Two first payments racing for the next supporter number: the loser re-reads once.
        if (isPrismaErrorCode(error, "P2002")) return await apply();
        throw error;
    }
}
