import type { DerivedBillingFacts } from "./reconcileBilling";
import type { RevenueCatSubscriber } from "./revenueCatClient";

export function combineBillingFacts(facts: readonly DerivedBillingFacts[], planOrder: readonly string[]): DerivedBillingFacts {
    const plans = facts.flatMap(({ plan }) => plan ? [plan] : []).sort((left, right) =>
        planOrder.indexOf(right.planId) - planOrder.indexOf(left.planId)
        || Number(left.source.endsWith("_sandbox")) - Number(right.source.endsWith("_sandbox"))
        || (right.endsAt?.getTime() ?? Infinity) - (left.endsAt?.getTime() ?? Infinity),
    );
    const support = facts.map(({ supporter }) => supporter);
    const earned = support.some((item) => item.earned);
    const dates = support.flatMap(({ firstPurchaseAt }) => firstPurchaseAt ? [firstPurchaseAt.getTime()] : []);
    const recurringDates = support.flatMap(({ latestRecurringPurchaseAt }) => latestRecurringPurchaseAt ? [latestRecurringPurchaseAt.getTime()] : []);
    return {
        plan: plans[0] ?? null,
        supporter: {
            earned,
            revoked: !earned && support.some((item) => item.revoked),
            recurringActive: support.some((item) => item.recurringActive),
            kind: support.find((item) => item.earned && item.kind === "supporter_monthly")?.kind
                ?? support.find((item) => item.earned && item.kind === "supporter_once")?.kind
                ?? support.find((item) => item.earned || item.revoked)?.kind ?? "plan",
            firstPurchaseAt: dates.length ? new Date(Math.min(...dates)) : null,
            latestRecurringPurchaseAt: recurringDates.length ? new Date(Math.max(...recurringDates)) : null,
        },
    };
}

/** Entitlement ids identify Happier products. Only production purchases earn a permanent number. */
export function deriveRevenueCatFacts(subscriber: RevenueCatSubscriber | null, planOrder: readonly string[], now: Date): DerivedBillingFacts {
    const facts: DerivedBillingFacts[] = [];
    for (const [kind, entitlement] of Object.entries(subscriber?.entitlements ?? {})) {
        const isPlan = planOrder.includes(kind);
        if (!isPlan && kind !== "supporter") continue;
        const subscription = subscriber?.subscriptions[entitlement.product_identifier];
        const purchases = (subscriber?.non_subscriptions[entitlement.product_identifier] ?? []).filter((item) => !item.is_sandbox);
        const expiry = subscription?.expires_date ? new Date(subscription.expires_date) : null;
        const grace = subscription?.grace_period_expires_date ? new Date(subscription.grace_period_expires_date) : null;
        const sandbox = subscription?.is_sandbox === true;
        const endsAt = !sandbox && grace && expiry && grace > expiry ? grace : expiry;
        const live = Boolean(subscription && !subscription.refunded_at && (endsAt ? endsAt > now : !sandbox));
        const store = subscription?.store === "play_store" ? "play" : "app_store";
        const productionSubscription = subscription && !sandbox ? subscription : null;
        const dates = purchases.map((item) => Date.parse(item.purchase_date));
        if (productionSubscription) dates.push(Date.parse(productionSubscription.purchase_date));
        facts.push({
            plan: isPlan && live ? {
                planId: kind,
                source: sandbox ? `${store}_sandbox` : store,
                endsAt,
                renews: !sandbox && !subscription?.unsubscribe_detected_at,
            } : null,
            supporter: {
                earned: Boolean(productionSubscription && !productionSubscription.refunded_at) || purchases.some((item) => !item.refunded_at),
                revoked: Boolean(productionSubscription?.refunded_at) || purchases.some((item) => item.refunded_at),
                recurringActive: live && !sandbox,
                kind: isPlan ? "plan" : subscription ? "supporter_monthly" : "supporter_once",
                firstPurchaseAt: dates.length ? new Date(Math.min(...dates)) : null,
                latestRecurringPurchaseAt: live && productionSubscription ? new Date(productionSubscription.purchase_date) : null,
            },
        });
    }
    return combineBillingFacts(facts, planOrder);
}
