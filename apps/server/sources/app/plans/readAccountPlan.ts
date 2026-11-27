import type { AccountPlanResponseV1 } from "@happier-dev/protocol";

import { readArtifactStorageUsageInTx } from "@/app/artifacts/artifactStorageService";
import { readAccountPlanEntitlementInTx } from "./accountPlanEntitlement";
import { readPolarConfig } from "@/app/billing/polarClient";
import { countAccountPinsInTx } from "@/app/session/organization/sessionPinLimit";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import type { Tx } from "@/storage/inTx";

import { resolveLimitTable, UNLIMITED_ACCOUNT_LIMITS } from "./accountLimits";
import { defaultSupporterOffer } from "./plansConfig";

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
    authentication: SessionAccessAuthentication;
    now?: Date;
}>): Promise<AccountPlanResponseV1 | null> {
    const now = params.now ?? new Date();
    const table = resolveLimitTable(params.env);
    const [entitlement, pinnedSessions, record] = await Promise.all([
        readAccountPlanEntitlementInTx(tx, params.accountId, table, now),
        countAccountPinsInTx(tx, params.accountId, params.authentication),
        tx.supporterRecord.findUnique({
            where: { accountId: params.accountId },
            select: { number: true, grantedAt: true, revokedAt: true },
        }),
    ]);
    if (!entitlement) return null;
    const { account, resolved, team } = entitlement;
    const endsAt = (team ? team.planEndsAt : account.planEndsAt)?.getTime() ?? null;
    const renews = !team && account.planRenews;
    const artifactUsage = resolved.limits.artifactStorageBytes === null
        ? null : await readArtifactStorageUsageInTx(tx, params.accountId, { env: params.env, entitlement });
    const supporterActive = record !== null && record.number !== null && record.revokedAt === null;
    const config = table.ok ? table.config : null;

    return {
        plan: resolved.plan
            ? {
                id: resolved.plan.id,
                name: resolved.plan.name,
                via: team ? "team" : "account",
                source: team ? "team" : account.planSource,
                endsAt,
                renews,
                graceEndsAt: resolved.graceEndsAt?.getTime() ?? null,
                overdue: renews && endsAt !== null && endsAt < now.getTime(),
            }
            : null,
        limits: table.ok ? { ...resolved.limits, artifactStorageBytes: artifactUsage?.limitBytes ?? null } : UNLIMITED_ACCOUNT_LIMITS,
        usage: { pinnedSessions, artifactStorageBytes: artifactUsage?.usedBytes ?? null },
        supporter: {
            active: supporterActive,
            since: supporterActive ? record.grantedAt?.getTime() ?? null : null,
            number: supporterActive ? record.number : null,
            recurringSince: null,
        },
        supporterRing: account.supporterRing,
        offers: {
            baseLimits: params.bits.plans && table.ok ? table.base : null,
            graceDays: table.ok ? table.graceDays : 0,
            plans: params.bits.plans ? (config?.plans ?? []) : [],
            teams: params.bits.plans && config?.teams
                ? { freeSeats: config.teams.freeSeats, seatPrices: config.teams.seatPrices } : null,
            supporter: params.bits.supporter ? (config?.supporter ?? defaultSupporterOffer()) : null,
            portalUrl: config?.portalUrl ?? null,
            billingReference: readPolarConfig(params.env) ? "account" : "supporter_code",
        },
    };
}
