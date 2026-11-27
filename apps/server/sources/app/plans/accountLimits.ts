import { SESSION_ORGANIZATION_MAX_PINNED_SESSIONS } from "@happier-dev/protocol";
import type { AccountLimitsV1, PlanDefinitionV1, PlansConfigV1 } from "@happier-dev/protocol";

import { readPlansFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { readRetentionPolicyFromEnv } from "@/app/retention/config/readRetentionPolicyFromEnv";
import { readServerConfig } from "@happier-dev/protocol/serverConfig/serverConfigCodec";
import { FEATURE_CONFIG } from "@/app/features/catalog/featureServerConfig";

import { readPlansConfig } from "./plansConfig";
import { isSandboxPlanSource } from "./accountPlanState";

const DAY_MS = 24 * 60 * 60 * 1000;

function capPinLimit(limit: number | null): number | null {
    return limit === null ? null : Math.min(limit, SESSION_ORGANIZATION_MAX_PINNED_SESSIONS);
}

export const UNLIMITED_ACCOUNT_LIMITS: AccountLimitsV1 = Object.freeze({
    sessionRetentionDays: null,
    subagentRetentionDays: null,
    toolOutputRetentionDays: null,
    pinnedSessions: null,
    artifactStorageBytes: null,
});

/**
 * The one limit table every consumer reads: the base tier (from the existing owners of each
 * fact) plus the operator's plans, in configured order (lowest first).
 *
 * `ok: false` means the config or a base-tier key is unreadable. Consumers must then stop rather
 * than fall back to the base tier: for deletion that is the only safe direction.
 */
export type LimitTable =
    | Readonly<{
        ok: true;
        base: AccountLimitsV1;
        plans: ReadonlyMap<string, PlanDefinitionV1>;
        planOrder: readonly string[];
        graceDays: number;
        config: PlansConfigV1 | null;
    }>
    | Readonly<{ ok: false; error: string }>;

export type PlanStateColumns = Readonly<{
    plan: string | null;
    planEndsAt: Date | null;
    planSource?: string | null;
}>;

export type ResolvedAccountPlan = Readonly<{
    /** The live plan whose limits apply (in its paid period or its grace), or null. */
    plan: PlanDefinitionV1 | null;
    limits: AccountLimitsV1;
    /** Set only while the plan's paid period has ended and its grace still applies. */
    graceEndsAt: Date | null;
    /** Last grace deadline for a known, expired plan, used as a retention notice floor. */
    previousGraceEndsAt?: Date;
}>;

function readBaseLimits(env: NodeJS.ProcessEnv): AccountLimitsV1 {
    // `domains` is the configured policy, not the effective one (which reads keep-forever while
    // retention is disabled): limits describe the tier, the sweep still obeys `enabled`.
    const domains = readRetentionPolicyFromEnv(env).domains;
    return {
        sessionRetentionDays: domains.sessions.mode === "delete_inactive" ? domains.sessions.inactivityDays : null,
        subagentRetentionDays: domains.sessionSidechainMessages.mode === "delete_older_than" ? domains.sessionSidechainMessages.days : null,
        toolOutputRetentionDays: domains.toolOutputs.mode === "delete_older_than" ? domains.toolOutputs.days : null,
        pinnedSessions: capPinLimit(readPlansFeatureEnv(env).sessionPinsMax),
        artifactStorageBytes: readServerConfig(env, FEATURE_CONFIG.artifactAccountLimitBytes) ?? null,
    };
}

export function resolveLimitTable(env: NodeJS.ProcessEnv): LimitTable {
    const configRead = readPlansConfig(env);
    if (!configRead.ok) return { ok: false, error: configRead.error };
    let base: AccountLimitsV1;
    try {
        base = readBaseLimits(env);
    } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "retention configuration is invalid" };
    }
    const configured = configRead.config;
    const config = configured && {
        ...configured,
        plans: configured.plans.map((plan) => ({
            ...plan,
            limits: { ...plan.limits, pinnedSessions: capPinLimit(plan.limits.pinnedSessions) },
        })),
    };
    const plans = new Map((config?.plans ?? []).map((plan) => [plan.id, plan] as const));
    return {
        ok: true,
        base,
        plans,
        planOrder: (config?.plans ?? []).map((plan) => plan.id),
        graceDays: config?.graceDays ?? 0,
        config,
    };
}

/**
 * Resolves which limits apply to one Account. One truth table drives this function and
 * `accountTierWhere`:
 * 1. unreadable table → no limits (the session and sidechain rules do not run at all);
 * 2. a plan id absent from the table is unknown → no limits, with no expiry check;
 * 3. a known plan is live until `planEndsAt + graceDays` (`planEndsAt` null = no end);
 * 4. otherwise the base tier.
 */
export function resolveAccountPlan(input: Readonly<{
    account: PlanStateColumns;
    table: LimitTable;
    now: Date;
}>): ResolvedAccountPlan {
    const { account, table, now } = input;
    if (!table.ok) return { plan: null, limits: UNLIMITED_ACCOUNT_LIMITS, graceEndsAt: null };
    if (account.plan === null) return { plan: null, limits: table.base, graceEndsAt: null };
    const plan = table.plans.get(account.plan);
    if (!plan) return { plan: null, limits: UNLIMITED_ACCOUNT_LIMITS, graceEndsAt: null };
    if (account.planEndsAt === null) return { plan, limits: plan.limits, graceEndsAt: null };
    if (isSandboxPlanSource(account.planSource)) {
        return account.planEndsAt <= now
            ? { plan: null, limits: table.base, graceEndsAt: null }
            : { plan, limits: plan.limits, graceEndsAt: null };
    }
    const graceEndsAt = new Date(account.planEndsAt.getTime() + table.graceDays * DAY_MS);
    if (graceEndsAt.getTime() <= now.getTime()) {
        return { plan: null, limits: table.base, graceEndsAt: null, previousGraceEndsAt: graceEndsAt };
    }
    return {
        plan,
        limits: plan.limits,
        graceEndsAt: account.planEndsAt.getTime() <= now.getTime() ? graceEndsAt : null,
    };
}
