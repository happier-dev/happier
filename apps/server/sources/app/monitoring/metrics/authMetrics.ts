import { Counter, Histogram } from "prom-client";

import { getOrCreateMetric, register } from "./registry";

type LoginEligibilityCacheName = "positive_result" | "account_snapshot" | "inflight";
type LoginEligibilityCacheResult = "hit" | "miss";
type LoginEligibilityStage = "account_lookup" | "disabled_check" | "provider_checks" | "total";
type LoginEligibilityStageResult = "ok" | "error";

export const authLoginEligibilityCacheCounter = getOrCreateMetric("auth_login_eligibility_cache_total", () => new Counter({
    name: "auth_login_eligibility_cache_total",
    help: "Login eligibility cache outcomes by cache layer",
    labelNames: ["cache", "result"] as const,
    registers: [register],
}));

export const authLoginEligibilityStageDurationHistogram = getOrCreateMetric("auth_login_eligibility_stage_duration_seconds", () => new Histogram({
    name: "auth_login_eligibility_stage_duration_seconds",
    help: "Login eligibility duration by internal stage",
    labelNames: ["stage", "result"] as const,
    buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 5],
    registers: [register],
}));

export function recordLoginEligibilityCache(params: Readonly<{
    cache: LoginEligibilityCacheName;
    result: LoginEligibilityCacheResult;
}>): void {
    authLoginEligibilityCacheCounter.inc({
        cache: params.cache,
        result: params.result,
    });
}

export function observeLoginEligibilityStage(params: Readonly<{
    stage: LoginEligibilityStage;
    result: LoginEligibilityStageResult;
    durationMs: number;
}>): void {
    authLoginEligibilityStageDurationHistogram.observe(
        {
            stage: params.stage,
            result: params.result,
        },
        params.durationMs / 1000,
    );
}
