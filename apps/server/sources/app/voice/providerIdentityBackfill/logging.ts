import { log, warn } from "@/utils/logging/log";

import type { VoiceProviderIdentityBackfillRunResult } from "./run";

export function logVoiceProviderIdentityBackfillCompleted(params: Readonly<{
    reason: "startup" | "interval" | "operator";
    result: VoiceProviderIdentityBackfillRunResult;
}>): void {
    log({
        module: "voice-provider-identity-backfill",
        reason: params.reason,
        stopReason: params.result.stopReason,
        batches: params.result.batches,
        conversationsProcessed: params.result.conversationsProcessed,
        leasesProcessed: params.result.leasesProcessed,
        remainingConversations: params.result.remainingConversations,
        remainingLeases: params.result.remainingLeases,
    }, "Voice provider identity backfill pass completed");
}

export function logVoiceProviderIdentityBackfillLocked(reason: "startup" | "interval" | "operator"): void {
    log({
        module: "voice-provider-identity-backfill",
        reason,
    }, "Voice provider identity backfill is already running on another replica");
}

export function logVoiceProviderIdentityBackfillFailure(params: Readonly<{
    reason: "startup" | "interval" | "operator";
    failureKind: "collision" | "database" | "unexpected";
}>): void {
    warn({
        module: "voice-provider-identity-backfill",
        reason: params.reason,
        failureKind: params.failureKind,
        operatorAction: params.failureKind === "collision"
            ? "Stop Phase-B rollout and inspect conflicting exact provider identities using restricted database access; never rewrite digest keys blindly."
            : "Inspect server/database health, keep Phase B blocked, and rerun the bounded operator after the root cause is fixed.",
    }, "Voice provider identity backfill pass failed");
}
