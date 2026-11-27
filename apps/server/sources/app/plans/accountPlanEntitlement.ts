import type { Prisma } from '@prisma/client';

import type { Tx } from '@/storage/inTx';

import { resolveAccountPlan, resolveLimitTable, UNLIMITED_ACCOUNT_LIMITS, type LimitTable } from './accountLimits';

type ResolvedLimitTable = Extract<LimitTable, { ok: true }>;
const DAY_MS = 86_400_000;

function paidTeamWhere(table: ResolvedLimitTable, now: Date): Prisma.TeamWhereInput {
    return {
        archivedAt: null,
        paidSeats: { gt: 0 },
        OR: [{ planEndsAt: null }, { planEndsAt: { gt: new Date(now.getTime() - table.graceDays * DAY_MS) } }],
    };
}

export async function readAccountPlanEntitlementInTx(tx: Tx, accountId: string, table: LimitTable, now: Date) {
    const account = await tx.account.findUnique({
        where: { id: accountId },
        select: { plan: true, planSource: true, planEndsAt: true, planRenews: true, supporterRing: true },
    });
    if (!account) return null;
    const resolved = resolveAccountPlan({ account, table, now });
    const teamTier = table.ok && table.config?.teams ? table.plans.get(table.config.teams.limitsFromPlanId) : undefined;
    if (!table.ok || !teamTier || resolved.plan || (account.plan && !resolved.previousGraceEndsAt)) {
        return { account, resolved, team: null };
    }
    const membership = await tx.teamMembership.findFirst({
        where: { accountId, status: 'active', team: paidTeamWhere(table, now) },
        orderBy: [{ team: { paidSeats: 'desc' } }, { teamId: 'asc' }],
        select: { team: { select: { id: true, paidSeats: true, planEndsAt: true } } },
    });
    if (!membership) return { account, resolved, team: null };
    const { team } = membership;
    const teamResolved = resolveAccountPlan({ account: { plan: teamTier.id, planEndsAt: team.planEndsAt }, table, now });
    return { account, resolved: teamResolved, team };
}

export async function readAccountLimitsInTx(tx: Tx, accountId: string, env: NodeJS.ProcessEnv, now = new Date()) {
    const result = await readAccountPlanEntitlementInTx(tx, accountId, resolveLimitTable(env), now);
    return result?.resolved.limits ?? UNLIMITED_ACCOUNT_LIMITS;
}

/** SQL projection of the plan precedence, used to select eligible sweep rows in bounded batches. */
export function accountTierWhere(tier: string | null, table: ResolvedLimitTable, now: Date): Prisma.AccountWhereInput {
    const graceCutoff = new Date(now.getTime() - table.graceDays * DAY_MS);
    const inheritedPlanId = table.config?.teams?.limitsFromPlanId;
    const paidMembership = inheritedPlanId && table.plans.has(inheritedPlanId)
        ? { status: 'active' as const, team: paidTeamWhere(table, now) }
        : null;
    const base: Prisma.AccountWhereInput = {
        OR: [{ plan: null }, { plan: { in: table.planOrder.slice() }, planEndsAt: { lte: graceCutoff } }],
    };
    if (tier === null) return {
        ...base,
        ...(paidMembership ? { teamMemberships: { none: paidMembership } } : {}),
    };
    const personal: Prisma.AccountWhereInput = {
        plan: tier,
        OR: [{ planEndsAt: null }, { planEndsAt: { gt: graceCutoff } }],
    };
    return tier === inheritedPlanId && paidMembership
        ? { OR: [personal, { ...base, teamMemberships: { some: paidMembership } }] }
        : personal;
}
