import { VoiceProviderConversationIdentityCollisionError } from "@/app/api/routes/voice/voiceProviderConversationIdentity";
import {
    voiceProviderIdentityBackfillCollisionsCounter,
    voiceProviderIdentityBackfillFailuresCounter,
    voiceProviderIdentityBackfillLastSuccessGauge,
    voiceProviderIdentityBackfillProcessedCounter,
    voiceProviderIdentityBackfillRemainingGauge,
    type VoiceProviderIdentityBackfillFailureReason,
} from "@/app/monitoring/metrics/voiceProviderIdentityBackfillMetrics";
import { maybeCaptureSentryMonitorCheckIn } from "@/app/monitoring/sentryMonitors";
import type { DbProvider } from "@/storage/db";
import { acquireGlobalLock } from "@/storage/globalLock";

import { readVoiceProviderIdentityBackfillPolicy, type VoiceProviderIdentityBackfillPolicy } from "./config";
import { VOICE_PROVIDER_IDENTITY_BACKFILL_LOCK_KEY } from "./constants";
import {
    logVoiceProviderIdentityBackfillCompleted,
    logVoiceProviderIdentityBackfillFailure,
    logVoiceProviderIdentityBackfillLocked,
} from "./logging";
import { runVoiceProviderIdentityBackfill, type VoiceProviderIdentityBackfillRunResult } from "./run";

function classifyFailure(error: unknown): VoiceProviderIdentityBackfillFailureReason {
    if (error instanceof VoiceProviderConversationIdentityCollisionError) return "collision";
    if (error && typeof error === "object" && /^P\d{4}$/.test(String((error as { code?: unknown }).code ?? ""))) {
        return "database";
    }
    return "unexpected";
}

function recordRun(result: VoiceProviderIdentityBackfillRunResult): void {
    voiceProviderIdentityBackfillRemainingGauge.set(
        { entity: "conversation" },
        result.remainingConversations,
    );
    voiceProviderIdentityBackfillRemainingGauge.set(
        { entity: "lease" },
        result.remainingLeases,
    );
    if (result.stopReason !== "aborted") {
        voiceProviderIdentityBackfillLastSuccessGauge.set(Date.now() / 1_000);
    }
}

export type VoiceProviderIdentityBackfillWorkerPassResult =
    | Readonly<{ status: "not_applicable" | "disabled" | "locked" }>
    | Readonly<{ status: "completed"; result: VoiceProviderIdentityBackfillRunResult }>
    | Readonly<{ status: "failed"; reason: VoiceProviderIdentityBackfillFailureReason }>;

export function assertVoiceProviderIdentityBackfillMonitorSuccess(
    result: VoiceProviderIdentityBackfillWorkerPassResult,
): void {
    if (result.status === "failed") {
        // The pass already emitted privacy-safe logs and fixed-cardinality metrics.
        // Throw only this bounded reason so the Sentry monitor records the failed
        // check-in without receiving raw database/provider diagnostics.
        throw new Error(`voice_provider_identity_backfill_failed:${result.reason}`);
    }
}

export async function runVoiceProviderIdentityBackfillWorkerPass(params: Readonly<{
    provider: DbProvider;
    policy: VoiceProviderIdentityBackfillPolicy;
    reason: "startup" | "interval";
    signal?: AbortSignal;
}>): Promise<VoiceProviderIdentityBackfillWorkerPassResult> {
    if (params.provider === "mysql") return { status: "not_applicable" };
    if (!params.policy.enabled) return { status: "disabled" };

    let lock: Awaited<ReturnType<typeof acquireGlobalLock>>;
    try {
        lock = await acquireGlobalLock({
            key: VOICE_PROVIDER_IDENTITY_BACKFILL_LOCK_KEY,
            ttlMs: params.policy.lockTtlMs,
        });
    } catch (error) {
        const reason = classifyFailure(error);
        voiceProviderIdentityBackfillFailuresCounter.inc({ reason });
        logVoiceProviderIdentityBackfillFailure({ reason: params.reason, failureKind: reason });
        return { status: "failed", reason };
    }
    if (!lock) {
        logVoiceProviderIdentityBackfillLocked(params.reason);
        return { status: "locked" };
    }

    try {
        const result = await runVoiceProviderIdentityBackfill({
            batchSize: params.policy.batchSize,
            timeBudgetMs: params.policy.timeBudgetMs,
            batchDelayMs: params.policy.batchDelayMs,
            signal: params.signal,
            onBatchCompleted: async (batch) => {
                voiceProviderIdentityBackfillProcessedCounter.inc(
                    { entity: "conversation" },
                    batch.conversationsUpdated,
                );
                voiceProviderIdentityBackfillProcessedCounter.inc(
                    { entity: "lease" },
                    batch.leasesUpdated,
                );
                if (!await lock.renew({ ttlMs: params.policy.lockTtlMs })) {
                    throw new Error("voice_provider_identity_backfill_lock_ownership_lost");
                }
            },
        });
        recordRun(result);
        logVoiceProviderIdentityBackfillCompleted({ reason: params.reason, result });
        return { status: "completed", result };
    } catch (error) {
        const reason = classifyFailure(error);
        voiceProviderIdentityBackfillFailuresCounter.inc({ reason });
        if (reason === "collision") {
            voiceProviderIdentityBackfillCollisionsCounter.inc();
        }
        logVoiceProviderIdentityBackfillFailure({ reason: params.reason, failureKind: reason });
        return { status: "failed", reason };
    } finally {
        await lock.release();
    }
}

export function startVoiceProviderIdentityBackfillWorker(params: Readonly<{
    provider: DbProvider;
    env: NodeJS.ProcessEnv;
}>): { stop: () => Promise<void> } | null {
    const policy = readVoiceProviderIdentityBackfillPolicy(params.env, params.provider);
    if (!policy.enabled || params.provider === "mysql") return null;

    const controller = new AbortController();
    let stopped = false;
    let halted = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active: Promise<void> | null = null;

    const schedule = () => {
        if (stopped || halted) return;
        timer = setTimeout(() => {
            timer = null;
            void trigger("interval");
        }, policy.intervalMs);
        timer.unref?.();
    };

    const trigger = async (reason: "startup" | "interval"): Promise<void> => {
        if (stopped || active) return;
        active = maybeCaptureSentryMonitorCheckIn({
            env: params.env,
            monitorSlug: "server.voiceProviderIdentityBackfill",
            intervalMs: policy.intervalMs,
            run: async () => {
                const result = await runVoiceProviderIdentityBackfillWorkerPass({
                    provider: params.provider,
                    policy,
                    reason,
                    signal: controller.signal,
                });
                if (result.status === "failed" && result.reason === "collision") {
                    halted = true;
                }
                assertVoiceProviderIdentityBackfillMonitorSuccess(result);
            },
        }).catch(() => {
            // `runVoiceProviderIdentityBackfillWorkerPass` already records the
            // bounded failure and the monitor wrapper records the failed check-in.
            // Keep database failures retryable while collision failures stay halted.
        });
        await active;
        active = null;
        schedule();
    };

    void trigger("startup");

    return {
        stop: async () => {
            if (stopped) return;
            stopped = true;
            controller.abort();
            if (timer) clearTimeout(timer);
            timer = null;
            await active;
        },
    };
}
