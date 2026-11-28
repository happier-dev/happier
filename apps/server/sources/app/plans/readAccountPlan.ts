import type { AccountPlanResponseV1 } from "@happier-dev/protocol";

import { readPolarConfig } from "@/app/billing/polarClient";
import { readRevenueCatConfig } from "@/app/billing/revenueCatClient";
import { countAccountPinsInTx } from "@/app/session/organization/sessionPinLimit";
import type { Tx } from "@/storage/inTx";

import { resolveAccountPlan, resolveLimitTable, UNLIMITED_ACCOUNT_LIMITS } from "./accountLimits";
import { defaultSupporterOffer, PUBLIC_SUPPORTER_PORTAL_URL } from "./plansConfig";

export type PlanDisplayBits = Readonly<{ plans: boolean; supporter: boolean }>;

/**
 * Builds `GET /v1/account/plan` for one Account: 1 Account read, 1 pin count, 1 supporter-record
 * read. Offers follow the display bits: plan offers only with `plans`, the Supporter offer only with
 * `supporter` (falling back to public defaults on a server with no configured offer).
 */
export async function readAccountPlanInTx(tx: Tx, params: Readonly<{
    accountId: string;
    env: NodeJS.ProcessEnv;
    bits: PlanDisplayBits;
    now?: Date;
}>): Promise<AccountPlanResponseV1 | null> {
    const now = params.now ?? new Date();
    const [account, pinnedSessions, record] = await Promise.all([
        tx.account.findUnique({
            where: { id: params.accountId },
            select: { plan: true, planSource: true, planEndsAt: true, planRenews: true, supporterRing: true },
        }),
        countAccountPinsInTx(tx, params.accountId),
        tx.supporterRecord.findUnique({
            where: { accountId: params.accountId },
            select: { number: true, grantedAt: true, revokedAt: true, recurringSince: true },
        }),
    ]);
    if (!account) return null;

    const table = resolveLimitTable(params.env);
    const resolved = resolveAccountPlan({ account, table, now });
    const endsAt = account.planEndsAt?.getTime() ?? null;
    const supporterActive = record !== null && record.number !== null && record.revokedAt === null;
    const config = table.ok ? table.config : null;
    const billingReference = readPolarConfig(params.env) || readRevenueCatConfig(params.env) ? "account" : "supporter_code";
    const publicSupporterCheckout = billingReference === "supporter_code" && !config?.supporter;
    const supporterOffer = params.bits.supporter
        ? config?.supporter ?? defaultSupporterOffer(publicSupporterCheckout)
        : null;

    return {
        plan: resolved.plan
            ? {
                id: resolved.plan.id,
                name: resolved.plan.name,
                via: "account",
                source: account.planSource === "app_store_sandbox" ? "app_store"
                    : account.planSource === "play_sandbox" ? "play" : account.planSource,
                endsAt,
                renews: account.planRenews,
                graceEndsAt: resolved.graceEndsAt?.getTime() ?? null,
                overdue: account.planRenews && endsAt !== null && endsAt < now.getTime(),
            }
            : null,
        limits: table.ok ? resolved.limits : UNLIMITED_ACCOUNT_LIMITS,
        usage: { pinnedSessions, artifactStorageBytes: null },
        supporter: {
            active: supporterActive,
            since: supporterActive ? record.grantedAt?.getTime() ?? null : null,
            number: supporterActive ? record.number : null,
            recurringSince: supporterActive ? record.recurringSince?.getTime() ?? null : null,
        },
        supporterRing: account.supporterRing,
        offers: {
            baseLimits: params.bits.plans && table.ok ? table.base : null,
            graceDays: table.ok ? table.graceDays : 0,
            plans: params.bits.plans ? (config?.plans ?? []) : [],
            teams: null,
            supporter: supporterOffer,
            portalUrl: config?.portalUrl ?? (supporterOffer && publicSupporterCheckout ? PUBLIC_SUPPORTER_PORTAL_URL : null),
            billingReference,
        },
    };
}
