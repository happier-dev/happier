import { isServerFeatureEnabledForRequest, readHomeEffectiveEnv } from "@/app/features/catalog/serverFeatureGate";
import { acquireGlobalLock } from "@/storage/globalLock";
import { warn } from "@/utils/logging/log";
import { withWebLatencyProducerTrace } from "@/utils/webLatencyTrace";
import { DirectoryProjectionInvariantError } from "../directoryProjectionRepository";
import {
    runActiveWorkosDirectoryIncremental,
    runClaimedDirectoryProjectionReconcile,
    type DirectoryProjectionCatchUp,
    type DirectoryProjectionScan,
} from "../directoryReconciler";
import { catchUpDirectorySource, scanDirectorySource } from "../directorySourceScanner";
import {
    claimDirectorySourceFullReconcile,
    claimWorkosDirectorySourceIncremental,
    findNextDirectorySourceDueForSync,
    hasDirectorySourceDueForSync,
    markActiveWorkosDirectoryPollFailed,
    markDirectorySourceReconcileFailed,
} from "../directorySourceService";
import { registerEnterpriseIdentitySyncNudge } from "./directorySyncWake";
import { readEnterpriseIdentitySyncLockTtlMs } from "./directorySyncPolicy";

const DIRECTORY_WORKER_LOCK_KEY = "server.enterprise-identity.sync";
const DIRECTORY_WORKER_INTERVAL_MS = 60_000;

/**
 * What a thrown pass failure means for the source that raised it.
 *
 * A broken ownership invariant cannot be repaired by asking the provider again,
 * and `directory_sync_unavailable` is retryable, so classifying it that way is
 * what turned an invariant violation into an unbounded silent retry. It is a
 * non-retryable source refusal (`NON_RETRYABLE_DIRECTORY_ERRORS`), which stops
 * the selector from re-offering the source until an administrator acts.
 *
 * The cause is diagnosed here — and only here — because this is the one place
 * the error object still exists; the persisted row carries the safe code alone.
 * Only our own invariant messages (static literals) are logged verbatim; an
 * upstream failure contributes its constructor name, never a provider message
 * that could carry a URL, header or credential.
 */
function classifyThrownDirectorySyncFailure(
    cause: unknown,
    context: Readonly<{ sourceId: string; mode: "incremental" | "full" }>,
): "directory_source_identity_mismatch" | "directory_sync_unavailable" {
    const invariant = cause instanceof DirectoryProjectionInvariantError;
    warn(
        {
            module: "enterprise-identity-sync-worker",
            sourceId: context.sourceId,
            mode: context.mode,
            invariant,
            reason: invariant
                ? cause.message
                : cause instanceof Error ? cause.constructor.name : typeof cause,
        },
        "enterprise identity sync pass failed",
    );
    return invariant ? "directory_source_identity_mismatch" : "directory_sync_unavailable";
}

export type EnterpriseIdentitySyncWorkerPassResult =
    | Readonly<{ status: "disabled" | "idle" | "locked" | "stale" }>
    | Readonly<{ status: "completed" | "failed"; sourceId: string }>;

export async function runEnterpriseIdentitySyncWorkerPass(params: Readonly<{
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    scan?: DirectoryProjectionScan;
    catchUp?: DirectoryProjectionCatchUp;
}> = {}): Promise<EnterpriseIdentitySyncWorkerPassResult> {
    if (!await hasDirectorySourceDueForSync()) return { status: "idle" };
    // Each pass reads the Home-effective configuration, so a Home switch applies on the next pass.
    const env = await readHomeEffectiveEnv({ env: params.env });
    if (!isServerFeatureEnabledForRequest("teams", env)) return { status: "disabled" };
    const lockTtlMs = readEnterpriseIdentitySyncLockTtlMs(env);
    let lastResult: EnterpriseIdentitySyncWorkerPassResult = { status: "idle" };
    while (!params.signal?.aborted) {
        const lock = await acquireGlobalLock({
            key: DIRECTORY_WORKER_LOCK_KEY,
            ttlMs: lockTtlMs,
        });
        if (!lock) {
            return lastResult.status === "idle" ? { status: "locked" } : lastResult;
        }
        let leaseLost = false;
        const renewLease = async (): Promise<boolean> => {
            const renewed = await lock.renew({ ttlMs: lockTtlMs });
            if (!renewed) leaseLost = true;
            return renewed;
        };

        try {
            const due = await findNextDirectorySourceDueForSync();
            if (!due) return lastResult;
            if (due.mode === "incremental") {
                const claim = await claimWorkosDirectorySourceIncremental({ sourceId: due.id });
                if (!claim.ok) continue;
                if (!await renewLease()) return { status: "stale" };
                let result: Awaited<ReturnType<typeof runActiveWorkosDirectoryIncremental>>;
                try {
                    result = await runActiveWorkosDirectoryIncremental({
                        source: claim.source,
                        env,
                        catchUp: async (input) => {
                            const caughtUp = await (params.catchUp ?? catchUpDirectorySource)({ ...input, env });
                            if (!await renewLease()) return { ok: false, code: "stale_run" };
                            return caughtUp;
                        },
                        signal: params.signal,
                        beforeProjectionWrite: renewLease,
                    });
                } catch (cause) {
                    const errorCode = classifyThrownDirectorySyncFailure(cause, {
                        sourceId: claim.source.id,
                        mode: "incremental",
                    });
                    if (!await renewLease()) return { status: "stale" };
                    const expectedPosition = claim.source.eventCursor !== null
                        ? { eventCursor: claim.source.eventCursor } as const
                        : claim.source.eventRangeStart !== null
                            ? { eventCursor: null, eventRangeStart: claim.source.eventRangeStart } as const
                            : null;
                    if (expectedPosition) {
                        await markActiveWorkosDirectoryPollFailed({
                            sourceId: claim.source.id,
                            expectedPosition,
                            errorCode,
                            consecutiveFailureCount: claim.source.consecutiveFailureCount ?? 0,
                        });
                    }
                    lastResult = { status: "failed", sourceId: claim.source.id };
                    continue;
                }
                if (result.status === "stale") {
                    if (leaseLost) return { status: "stale" };
                    continue;
                }
                lastResult = { status: result.status, sourceId: claim.source.id };
                continue;
            }

            const claim = await claimDirectorySourceFullReconcile({ sourceId: due.id });
            if (!claim.ok) continue;
            if (!await renewLease()) return { status: "stale" };
            let result: Awaited<ReturnType<typeof runClaimedDirectoryProjectionReconcile>>;
            try {
                result = await runClaimedDirectoryProjectionReconcile({
                    source: claim.source,
                    env,
                    scan: async (input) => {
                        const scanned = await (params.scan ?? scanDirectorySource)({ ...input, env });
                        if (!await renewLease()) return { ok: false, code: "stale_run" };
                        return scanned;
                    },
                    catchUp: async (input) => {
                        const caughtUp = await (params.catchUp ?? catchUpDirectorySource)({ ...input, env });
                        if (!await renewLease()) return { ok: false, code: "stale_run" };
                        return caughtUp;
                    },
                    signal: params.signal,
                    beforeProjectionWrite: renewLease,
                });
            } catch (cause) {
                const errorCode = classifyThrownDirectorySyncFailure(cause, {
                    sourceId: claim.source.id,
                    mode: "full",
                });
                if (!await renewLease()) return { status: "stale" };
                await markDirectorySourceReconcileFailed({
                    sourceId: claim.source.id,
                    reconcileRunId: claim.source.reconcileRunId,
                    errorCode,
                    consecutiveFailureCount: claim.source.consecutiveFailureCount ?? 0,
                });
                lastResult = { status: "failed", sourceId: claim.source.id };
                continue;
            }
            if (result.status === "stale") {
                if (leaseLost) return { status: "stale" };
                continue;
            }
            lastResult = { status: result.status, sourceId: claim.source.id };
        } finally {
            await lock.release();
        }
    }
    return lastResult;
}

export function startEnterpriseIdentitySyncWorker(params: Readonly<{
    env?: NodeJS.ProcessEnv;
    scan?: DirectoryProjectionScan;
    catchUp?: DirectoryProjectionCatchUp;
}> = {}): Readonly<{ stop: () => Promise<void>; nudge: () => void }> | null {
    const env = params.env ?? process.env;
    // Only the deployment can keep the worker from starting; a Home switch is honoured per pass.
    if (!isServerFeatureEnabledForRequest("teams", env)) return null;

    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active: Promise<void> | null = null;

    const schedule = (delayMs: number) => {
        if (stopped || timer !== null) return;
        timer = setTimeout(() => {
            timer = null;
            void trigger();
        }, delayMs);
        timer.unref?.();
    };
    const trigger = async (): Promise<void> => {
        if (stopped || active) return;
        active = withWebLatencyProducerTrace("producer.team-directory", () => runEnterpriseIdentitySyncWorkerPass({
            env,
            signal: controller.signal,
            scan: params.scan,
            catchUp: params.catchUp,
        })).then(() => undefined, () => undefined);
        await active;
        active = null;
        schedule(DIRECTORY_WORKER_INTERVAL_MS);
    };

    const unregisterNudge = registerEnterpriseIdentitySyncNudge(() => schedule(0));
    schedule(0);
    return {
        nudge: () => schedule(0),
        stop: async () => {
            if (stopped) return;
            stopped = true;
            controller.abort();
            if (timer) clearTimeout(timer);
            timer = null;
            await active;
            unregisterNudge();
        },
    };
}
