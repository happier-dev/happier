import { Counter, Gauge } from "prom-client";

import { getOrCreateMetric, register } from "./registry";

export type VoiceProviderIdentityBackfillEntity = "conversation" | "lease";
export type VoiceProviderIdentityBackfillFailureReason = "collision" | "database" | "unexpected";

export const voiceProviderIdentityBackfillRemainingGauge = getOrCreateMetric(
    "voice_provider_identity_backfill_remaining",
    () => new Gauge({
        name: "voice_provider_identity_backfill_remaining",
        help: "Rows still missing a provider conversation identity digest",
        labelNames: ["entity"] as const,
        registers: [register],
    }),
);

export const voiceProviderIdentityBackfillProcessedCounter = getOrCreateMetric(
    "voice_provider_identity_backfill_processed_total",
    () => new Counter({
        name: "voice_provider_identity_backfill_processed_total",
        help: "Rows updated by the provider conversation identity backfill",
        labelNames: ["entity"] as const,
        registers: [register],
    }),
);

export const voiceProviderIdentityBackfillCollisionsCounter = getOrCreateMetric(
    "voice_provider_identity_backfill_collisions_total",
    () => new Counter({
        name: "voice_provider_identity_backfill_collisions_total",
        help: "Fail-closed provider conversation identity collisions",
        registers: [register],
    }),
);

export const voiceProviderIdentityBackfillFailuresCounter = getOrCreateMetric(
    "voice_provider_identity_backfill_failures_total",
    () => new Counter({
        name: "voice_provider_identity_backfill_failures_total",
        help: "Provider conversation identity backfill failures by bounded reason",
        labelNames: ["reason"] as const,
        registers: [register],
    }),
);

export const voiceProviderIdentityBackfillLastSuccessGauge = getOrCreateMetric(
    "voice_provider_identity_backfill_last_success_unixtime_seconds",
    () => new Gauge({
        name: "voice_provider_identity_backfill_last_success_unixtime_seconds",
        help: "Unix timestamp of the last successful provider identity backfill pass",
        registers: [register],
    }),
);
