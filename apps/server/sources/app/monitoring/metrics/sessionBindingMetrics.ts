import { Histogram } from "prom-client";

import { getOrCreateMetric, register } from "./registry";

type SessionScopedBindingStage = "owner_session_lookup" | "machine_access_key_lookup";
type SessionScopedBindingResult = "ok" | "error";

export const sessionScopedBindingDurationHistogram = getOrCreateMetric("session_scoped_binding_duration_seconds", () => new Histogram({
    name: "session_scoped_binding_duration_seconds",
    help: "Session-scoped socket binding lookup duration by path",
    labelNames: ["stage", "result"] as const,
    buckets: [0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 5],
    registers: [register],
}));

export function observeSessionScopedBindingStage(params: Readonly<{
    stage: SessionScopedBindingStage;
    result: SessionScopedBindingResult;
    durationMs: number;
}>): void {
    sessionScopedBindingDurationHistogram.observe(
        {
            stage: params.stage,
            result: params.result,
        },
        params.durationMs / 1000,
    );
}
