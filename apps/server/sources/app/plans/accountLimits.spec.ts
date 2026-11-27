import { describe, expect, it } from "vitest";
import { SESSION_ORGANIZATION_MAX_PINNED_SESSIONS } from "@happier-dev/protocol";

import { resolveAccountPlan, resolveLimitTable } from "./accountLimits";
import { resolvePlansFeature } from "@/app/features/plansFeature";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-12-01T00:00:00.000Z");

const LITE = {
    id: "lite",
    name: "Happier Lite",
    limits: { sessionRetentionDays: 90, subagentRetentionDays: 14, toolOutputRetentionDays: null, pinnedSessions: 100, artifactStorageBytes: null },
    prices: [{ interval: "month", amountMinor: 299, currency: "usd" }],
} as const;
const PLUS = {
    id: "plus",
    name: "Happier Plus",
    limits: { sessionRetentionDays: 365, subagentRetentionDays: 30, toolOutputRetentionDays: null, pinnedSessions: 500, artifactStorageBytes: null },
    prices: [{ interval: "month", amountMinor: 699, currency: "usd" }],
} as const;

const CLOUD_ENV: NodeJS.ProcessEnv = {
    HAPPIER_PLANS__CONFIG: JSON.stringify({ v: 1, graceDays: 90, plans: [LITE, PLUS], teams: null, supporter: null }),
    HAPPIER_SESSION_PINS__MAX: "50",
    HAPPIER_SERVER_RETENTION__SESSIONS__MODE: "delete_inactive",
    HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: "60",
    HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__MODE: "delete_older_than",
    HAPPIER_SERVER_RETENTION__SESSION_SIDECHAIN_MESSAGES__DAYS: "7",
};

const FREE_LIMITS = { sessionRetentionDays: 60, subagentRetentionDays: 7, toolOutputRetentionDays: null, pinnedSessions: 50, artifactStorageBytes: null };
const ALL_NULL = { sessionRetentionDays: null, subagentRetentionDays: null, toolOutputRetentionDays: null, pinnedSessions: null, artifactStorageBytes: null };

function at(offsetDays: number): Date {
    return new Date(NOW.getTime() + offsetDays * DAY_MS);
}

describe("resolveAccountPlan truth table", () => {
    const table = resolveLimitTable(CLOUD_ENV);

    it("publishes and applies the organization pin ceiling to configured base and paid tiers", () => {
        const max = SESSION_ORGANIZATION_MAX_PINNED_SESSIONS;
        const table = resolveLimitTable({
            ...CLOUD_ENV,
            HAPPIER_SESSION_PINS__MAX: String(max + 1),
            HAPPIER_PLANS__CONFIG: JSON.stringify({
                v: 1, graceDays: 90,
                plans: [{ ...PLUS, limits: { ...PLUS.limits, pinnedSessions: max + 1 } }],
                teams: null, supporter: null,
            }),
        });
        expect(table.ok).toBe(true);
        if (!table.ok) throw new Error(table.error);
        expect(table.base.pinnedSessions).toBe(max);
        expect(table.config?.plans[0]?.limits.pinnedSessions).toBe(max);
        expect(resolveAccountPlan({
            account: { plan: "plus", planEndsAt: null }, table, now: NOW,
        }).limits.pinnedSessions).toBe(max);
    });

    it.each([
        { name: "no plan", plan: null, endsAt: null, limits: FREE_LIMITS, planId: null, graceEndsAt: null },
        { name: "plus active", plan: "plus", endsAt: at(20), limits: PLUS.limits, planId: "plus", graceEndsAt: null },
        { name: "plus manual grant without end", plan: "plus", endsAt: null, limits: PLUS.limits, planId: "plus", graceEndsAt: null },
        { name: "lite active", plan: "lite", endsAt: at(20), limits: LITE.limits, planId: "lite", graceEndsAt: null },
        { name: "plus in grace", plan: "plus", endsAt: at(-10), limits: PLUS.limits, planId: "plus", graceEndsAt: at(80) },
        { name: "plus past grace", plan: "plus", endsAt: at(-91), limits: FREE_LIMITS, planId: null, graceEndsAt: null },
        { name: "unknown id past its end", plan: "gold", endsAt: at(-400), limits: ALL_NULL, planId: null, graceEndsAt: null },
    ])("$name", ({ plan, endsAt, limits, planId, graceEndsAt }) => {
        const resolved = resolveAccountPlan({ account: { plan, planEndsAt: endsAt }, table, now: NOW });
        expect(resolved.limits).toEqual(limits);
        expect(resolved.plan?.id ?? null).toBe(planId);
        expect(resolved.graceEndsAt).toEqual(graceEndsAt);
    });

    it("an unreadable config stops every tiered limit instead of falling back to the base tier", () => {
        const broken = resolveLimitTable({ ...CLOUD_ENV, HAPPIER_PLANS__CONFIG: '{"v":1,"graceDays":90,"plans":[],"teems":null}' });
        expect(broken.ok).toBe(false);
        const resolved = resolveAccountPlan({ account: { plan: null, planEndsAt: null }, table: broken, now: NOW });
        expect(resolved.limits).toEqual(ALL_NULL);
    });

    it("an empty environment has no limits at all", () => {
        const resolved = resolveAccountPlan({ account: { plan: null, planEndsAt: null }, table: resolveLimitTable({}), now: NOW });
        expect(resolved.limits).toEqual(ALL_NULL);
    });
});

describe("plans and supporter gates", () => {
    it.each([
        { name: "default server", env: {}, plans: false, supporter: true },
        { name: "configured cloud", env: CLOUD_ENV, plans: true, supporter: true },
        { name: "base limit only", env: { HAPPIER_SESSION_PINS__MAX: "20" }, plans: true, supporter: true },
        { name: "operator hides both", env: { ...CLOUD_ENV, HAPPIER_FEATURE_PLANS__ENABLED: "0", HAPPIER_FEATURE_SUPPORTER__ENABLED: "0" }, plans: false, supporter: false },
        { name: "malformed config", env: { ...CLOUD_ENV, HAPPIER_PLANS__CONFIG: "{not json" }, plans: false, supporter: true },
    ])("$name", ({ env, plans, supporter }) => {
        const delta = resolvePlansFeature(env as NodeJS.ProcessEnv);
        expect(delta.features?.plans?.enabled).toBe(plans);
        expect(delta.features?.supporter?.enabled).toBe(supporter);
    });
});
