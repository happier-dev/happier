import {
    backfillVoiceProviderConversationIdentityBatch,
    countVoiceProviderConversationIdentityBackfillRemaining,
    type VoiceProviderConversationIdentityBackfillBatchResult,
    type VoiceProviderConversationIdentityBackfillRemaining,
} from "@/app/api/routes/voice/voiceProviderConversationIdentityBackfill";
import { delay } from "@/utils/runtime/delay";

export type VoiceProviderIdentityBackfillStopReason = "zero" | "time_budget" | "aborted";

export interface VoiceProviderIdentityBackfillRunResult {
    readonly stopReason: VoiceProviderIdentityBackfillStopReason;
    readonly batches: number;
    readonly conversationsProcessed: number;
    readonly leasesProcessed: number;
    readonly remainingConversations: number;
    readonly remainingLeases: number;
}

function toRunResult(params: Readonly<{
    stopReason: VoiceProviderIdentityBackfillStopReason;
    batches: number;
    conversationsProcessed: number;
    leasesProcessed: number;
    remaining: VoiceProviderConversationIdentityBackfillRemaining;
}>): VoiceProviderIdentityBackfillRunResult {
    return {
        stopReason: params.stopReason,
        batches: params.batches,
        conversationsProcessed: params.conversationsProcessed,
        leasesProcessed: params.leasesProcessed,
        remainingConversations: params.remaining.conversations,
        remainingLeases: params.remaining.leases,
    };
}

export async function runVoiceProviderIdentityBackfill(params: Readonly<{
    batchSize: number;
    timeBudgetMs: number;
    batchDelayMs: number;
    signal?: AbortSignal;
    nowMs?: () => number;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
    onBatchCompleted?: (batch: VoiceProviderConversationIdentityBackfillBatchResult) => Promise<void> | void;
}>): Promise<VoiceProviderIdentityBackfillRunResult> {
    const nowMs = params.nowMs ?? Date.now;
    const wait = params.wait ?? delay;
    const startedAt = nowMs();
    let batches = 0;
    let conversationsProcessed = 0;
    let leasesProcessed = 0;

    while (true) {
        if (params.signal?.aborted) {
            const remaining = await countVoiceProviderConversationIdentityBackfillRemaining();
            return toRunResult({
                stopReason: "aborted",
                batches,
                conversationsProcessed,
                leasesProcessed,
                remaining,
            });
        }
        if (batches > 0 && nowMs() - startedAt >= params.timeBudgetMs) {
            const remaining = await countVoiceProviderConversationIdentityBackfillRemaining();
            return toRunResult({
                stopReason: "time_budget",
                batches,
                conversationsProcessed,
                leasesProcessed,
                remaining,
            });
        }

        const batch = await backfillVoiceProviderConversationIdentityBatch({ batchSize: params.batchSize });
        batches += 1;
        conversationsProcessed += batch.conversationsUpdated;
        leasesProcessed += batch.leasesUpdated;
        await params.onBatchCompleted?.(batch);

        const remaining = await countVoiceProviderConversationIdentityBackfillRemaining();
        if (remaining.conversations === 0 && remaining.leases === 0) {
            return toRunResult({
                stopReason: "zero",
                batches,
                conversationsProcessed,
                leasesProcessed,
                remaining,
            });
        }
        if (nowMs() - startedAt >= params.timeBudgetMs) {
            return toRunResult({
                stopReason: "time_budget",
                batches,
                conversationsProcessed,
                leasesProcessed,
                remaining,
            });
        }
        if (params.batchDelayMs > 0) {
            try {
                await wait(params.batchDelayMs, params.signal);
            } catch (error) {
                if (!params.signal?.aborted) throw error;
                const abortedRemaining = await countVoiceProviderConversationIdentityBackfillRemaining();
                return toRunResult({
                    stopReason: "aborted",
                    batches,
                    conversationsProcessed,
                    leasesProcessed,
                    remaining: abortedRemaining,
                });
            }
        }
    }
}

export async function verifyVoiceProviderIdentityBackfillZero(params: Readonly<{
    stabilityMs: number;
    signal?: AbortSignal;
    wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}>): Promise<Readonly<{
    stableZero: boolean;
    first: VoiceProviderConversationIdentityBackfillRemaining;
    second: VoiceProviderConversationIdentityBackfillRemaining;
}>> {
    const first = await countVoiceProviderConversationIdentityBackfillRemaining();
    if (first.conversations !== 0 || first.leases !== 0) {
        return { stableZero: false, first, second: first };
    }
    await (params.wait ?? delay)(Math.max(0, params.stabilityMs), params.signal);
    const second = await countVoiceProviderConversationIdentityBackfillRemaining();
    return {
        stableZero: second.conversations === 0 && second.leases === 0,
        first,
        second,
    };
}
