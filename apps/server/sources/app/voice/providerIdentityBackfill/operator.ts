import { VoiceProviderConversationIdentityCollisionError } from "@/app/api/routes/voice/voiceProviderConversationIdentity";
import type { DbProvider } from "@/storage/db";
import { acquireGlobalLock } from "@/storage/globalLock";

import { runVoiceProviderIdentityBackfill, verifyVoiceProviderIdentityBackfillZero } from "./run";
import { VOICE_PROVIDER_IDENTITY_BACKFILL_LOCK_KEY } from "./constants";
import {
    DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS,
    DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE,
    DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS,
} from "./config";

const DEFAULT_STABILITY_MS = 5_000;
const MIN_STABILITY_MS = 1_000;

export type VoiceProviderIdentityBackfillOperatorMode = "run" | "verify";

export interface VoiceProviderIdentityBackfillOperatorArgs {
    readonly mode: VoiceProviderIdentityBackfillOperatorMode;
    readonly batchSize: number;
    readonly timeBudgetMs: number;
    readonly batchDelayMs: number;
    readonly stabilityMs: number;
}

export function resolveVoiceProviderIdentityBackfillOperatorProvider(
    env: NodeJS.ProcessEnv,
    fallback: DbProvider,
): DbProvider {
    const raw = String(env.HAPPIER_DB_PROVIDER ?? env.HAPPY_DB_PROVIDER ?? "").trim().toLowerCase();
    if (!raw) return fallback;
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "pglite" || raw === "sqlite" || raw === "mysql") return raw;
    throw new Error(`Unsupported HAPPIER_DB_PROVIDER/HAPPY_DB_PROVIDER: ${raw}`);
}

function readBoundedFlag(params: Readonly<{
    raw: string;
    name: string;
    min: number;
    max: number;
}>): number {
    if (!/^\d+$/.test(params.raw)) {
        throw new Error(`--${params.name} must be an integer from ${params.min} to ${params.max}`);
    }
    const value = Number(params.raw);
    if (!Number.isSafeInteger(value) || value < params.min || value > params.max) {
        throw new Error(`--${params.name} must be an integer from ${params.min} to ${params.max}`);
    }
    return value;
}

export function parseVoiceProviderIdentityBackfillOperatorArgs(argv: readonly string[]): VoiceProviderIdentityBackfillOperatorArgs {
    const [mode, ...flags] = argv;
    if (mode !== "run" && mode !== "verify") {
        throw new Error("Voice provider identity backfill mode must be run or verify");
    }
    const result: {
        mode: VoiceProviderIdentityBackfillOperatorMode;
        batchSize: number;
        timeBudgetMs: number;
        batchDelayMs: number;
        stabilityMs: number;
    } = {
        mode,
        batchSize: DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE,
        timeBudgetMs: DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS,
        batchDelayMs: DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS,
        stabilityMs: DEFAULT_STABILITY_MS,
    };
    for (const flag of flags) {
        const separator = flag.indexOf("=");
        if (!flag.startsWith("--") || separator < 3) {
            throw new Error(`Unknown voice provider identity backfill argument: ${flag}`);
        }
        const name = flag.slice(2, separator);
        const raw = flag.slice(separator + 1);
        if (name === "batch-size") {
            result.batchSize = readBoundedFlag({ raw, name, min: 1, max: 1_000 });
        } else if (name === "time-budget-ms") {
            result.timeBudgetMs = readBoundedFlag({ raw, name, min: 1, max: 15 * 60_000 });
        } else if (name === "batch-delay-ms") {
            result.batchDelayMs = readBoundedFlag({ raw, name, min: 0, max: 60_000 });
        } else if (name === "stability-ms") {
            result.stabilityMs = readBoundedFlag({ raw, name, min: MIN_STABILITY_MS, max: 15 * 60_000 });
        } else {
            throw new Error(`Unknown voice provider identity backfill argument: --${name}`);
        }
    }
    return result;
}

export type VoiceProviderIdentityBackfillOperatorResult = Readonly<{
    exitCode: number;
    outcome: "completed" | "partial" | "verified_zero" | "nonzero" | "not_applicable" | "locked" | "collision" | "aborted" | "failed";
}>;

export async function runVoiceProviderIdentityBackfillOperator(params: Readonly<{
    mode: VoiceProviderIdentityBackfillOperatorMode;
    provider: DbProvider;
    batchSize?: number;
    timeBudgetMs?: number;
    batchDelayMs?: number;
    stabilityMs?: number;
    signal?: AbortSignal;
    writeResult: (value: unknown) => void;
}>): Promise<VoiceProviderIdentityBackfillOperatorResult> {
    if (params.provider === "mysql") {
        const result = { exitCode: 0, outcome: "not_applicable" as const };
        params.writeResult({ ...result, provider: "mysql", reason: "migration_finalized_identity_keys" });
        return result;
    }

    const lockTtlMs = Math.max(
        params.timeBudgetMs ?? DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS,
        params.stabilityMs ?? DEFAULT_STABILITY_MS,
    ) + 5 * 60_000;
    let lock: Awaited<ReturnType<typeof acquireGlobalLock>>;
    try {
        lock = await acquireGlobalLock({ key: VOICE_PROVIDER_IDENTITY_BACKFILL_LOCK_KEY, ttlMs: lockTtlMs });
    } catch {
        const result = { exitCode: 1, outcome: "failed" as const };
        params.writeResult({ ...result, reason: "lock_unavailable" });
        return result;
    }
    if (!lock) {
        const result = { exitCode: 4, outcome: "locked" as const };
        params.writeResult(result);
        return result;
    }

    try {
        if (params.mode === "verify") {
            const stabilityMs = Math.max(MIN_STABILITY_MS, params.stabilityMs ?? DEFAULT_STABILITY_MS);
            const verification = await verifyVoiceProviderIdentityBackfillZero({
                stabilityMs,
                signal: params.signal,
            });
            const result = verification.stableZero
                ? { exitCode: 0, outcome: "verified_zero" as const }
                : { exitCode: 2, outcome: "nonzero" as const };
            params.writeResult({
                ...result,
                phaseBReady: verification.stableZero,
                stabilityMs,
                verification,
            });
            return result;
        }

        const run = await runVoiceProviderIdentityBackfill({
            batchSize: params.batchSize ?? DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_SIZE,
            timeBudgetMs: params.timeBudgetMs ?? DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_TIME_BUDGET_MS,
            batchDelayMs: params.batchDelayMs ?? DEFAULT_VOICE_PROVIDER_IDENTITY_BACKFILL_BATCH_DELAY_MS,
            signal: params.signal,
            onBatchCompleted: async () => {
                if (!await lock.renew({ ttlMs: lockTtlMs })) {
                    throw new Error("voice_provider_identity_backfill_lock_ownership_lost");
                }
            },
        });
        const result = run.stopReason === "zero"
            ? { exitCode: 0, outcome: "completed" as const }
            : run.stopReason === "aborted"
                ? { exitCode: 130, outcome: "aborted" as const }
                : { exitCode: 0, outcome: "partial" as const };
        params.writeResult({
            ...result,
            ...(run.stopReason === "aborted" ? { phaseBReady: false } : { run }),
        });
        return result;
    } catch (error) {
        if (params.signal?.aborted) {
            const result = { exitCode: 130, outcome: "aborted" as const };
            params.writeResult({ ...result, phaseBReady: false });
            return result;
        }
        if (error instanceof VoiceProviderConversationIdentityCollisionError) {
            const result = { exitCode: 3, outcome: "collision" as const };
            params.writeResult({
                ...result,
                operatorAction: "Keep Phase B blocked and inspect conflicting exact identities using restricted database access.",
            });
            return result;
        }
        const result = { exitCode: 1, outcome: "failed" as const };
        params.writeResult({ ...result, reason: "runtime_failure" });
        return result;
    } finally {
        await lock.release();
    }
}
