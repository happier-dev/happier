import { estimateUsageModelCost } from '@happier-dev/protocol';
import type { ClaudeUsageModelSource, ClaudeUsageObservation } from './types.js';

function asFiniteNonNegativeNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function isClaudeSdkUsageResult(value: unknown): boolean {
    const result = asRecord(value);
    if (result?.type !== 'result') return false;
    return result.subtype === 'success'
        || result.subtype === 'error_max_turns'
        || result.subtype === 'error_during_execution'
        || result.subtype === 'error_max_budget_usd'
        || result.subtype === 'error_max_structured_output_retries';
}

function readContextWindowFromModelUsageEntry(entry: unknown): number | null {
    const record = asRecord(entry);
    if (!record) return null;
    return asFiniteNonNegativeNumber(record.contextWindow);
}

function readContextWindowTokensFromModelUsage(params: Readonly<{
    modelUsage: unknown;
    modelId: string;
}>): number | null {
    const modelUsage = asRecord(params.modelUsage);
    if (!modelUsage) return null;

    return readContextWindowFromModelUsageEntry(modelUsage[params.modelId]);
}

function readLastMessageIterationContextTokens(usage: Record<string, unknown>): number | null {
    const iterations = usage.iterations;
    if (!Array.isArray(iterations)) return null;
    for (let index = iterations.length - 1; index >= 0; index -= 1) {
        const iteration = asRecord(iterations[index]);
        if (iteration?.type !== 'message') continue;
        const input = asFiniteNonNegativeNumber(iteration.input_tokens);
        const output = asFiniteNonNegativeNumber(iteration.output_tokens);
        const cacheRead = asFiniteNonNegativeNumber(iteration.cache_read_input_tokens);
        const cacheCreation = asFiniteNonNegativeNumber(iteration.cache_creation_input_tokens);
        if (input == null && output == null && cacheRead == null && cacheCreation == null) return null;
        return (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0);
    }
    return null;
}

export function buildClaudeSdkResultUsageObservation(params: Readonly<{
    modelId: string;
    modelSource?: ClaudeUsageModelSource;
    result: unknown;
    observedAtMs?: number;
}>): ClaudeUsageObservation | null {
    const result = asRecord(params.result);
    if (!result || !isClaudeSdkUsageResult(result)) return null;
    // Streaming result.usage describes the latest main-loop turn. Only modelUsage
    // witnesses whole-call counters, including subagents and resumed usage.
    const modelUsage = asRecord(result.modelUsage);
    const modelIds = modelUsage ? Object.keys(modelUsage) : [];
    if (!modelUsage || modelIds.length === 0) return null;
    const tokens: ClaudeUsageObservation['tokens'] = {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0,
    };
    for (const modelId of modelIds) {
        const entry = asRecord(modelUsage[modelId]);
        if (!entry || modelId.trim().length === 0) return null;
        const input = asFiniteNonNegativeNumber(entry.inputTokens);
        const output = asFiniteNonNegativeNumber(entry.outputTokens);
        const cacheRead = asFiniteNonNegativeNumber(entry.cacheReadInputTokens);
        const cacheWrite = asFiniteNonNegativeNumber(entry.cacheCreationInputTokens);
        if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;
        tokens.input += input;
        tokens.output += output;
        tokens.cacheRead += cacheRead;
        tokens.cacheWrite += cacheWrite;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (!Object.values(tokens).every(Number.isFinite)) return null;
    const modelId = modelIds.length === 1 ? modelIds[0]! : null;
    const total = tokens.total;
    const usage = asRecord(result.usage);
    // The Claude SDK result does not establish what a provider-bound gateway charged.
    // Do not project its cost field as the selected Provider's reported billing amount.
    const reportedCost = params.modelSource === 'provider'
        ? null
        : asFiniteNonNegativeNumber(result.total_cost_usd);
    const contextWindowTokens = readContextWindowTokensFromModelUsage({
        modelUsage: result.modelUsage,
        modelId: params.modelId,
    });
    const contextUsedTokens = usage ? readLastMessageIterationContextTokens(usage) : null;
    const estimatedCost = params.modelSource === 'provider' || !modelId
        ? null
        : estimateUsageModelCost(modelId, tokens);
    const cost = reportedCost != null
        ? {
            reportedUsd: reportedCost,
            estimatedUsd: 0,
            billingContext: 'unknown' as const,
            // Claude computes this amount from its local API price table, not an invoice.
            costSource: 'provider_reported_api_equivalent' as const,
            currency: 'USD',
        }
        : estimatedCost
            ? {
                estimatedUsd: estimatedCost.total,
                ...(estimatedCost.breakdown ? { breakdown: estimatedCost.breakdown } : {}),
                reportedUsd: 0,
                billingContext: 'unknown' as const,
                costSource: 'pricing_estimate' as const,
                currency: 'USD',
            }
            : null;
    return {
        provider: 'claude',
        source: 'claude-sdk-result',
        scope: 'session_final',
        key: 'claude-session',
        ...(typeof result.uuid === 'string' && result.uuid.length > 0 ? { nativeRecordId: result.uuid } : {}),
        ...(typeof result.session_id === 'string' && result.session_id.length > 0 ? { nativeSessionId: result.session_id }
            : typeof result.sessionId === 'string' && result.sessionId.length > 0 ? { nativeSessionId: result.sessionId } : {}),
        ...(params.observedAtMs === undefined ? {} : { observedAtMs: params.observedAtMs }),
        modelId,
        tokens,
        cost,
        contextUsedTokens,
        contextWindowTokens,
        ...(contextUsedTokens != null ? {
            contextSnapshot: {
                v: 1,
                modelId: params.modelId,
                usedTokens: contextUsedTokens,
                windowTokens: contextWindowTokens,
                totalProcessedTokens: total,
                baselineTokens: null,
                isAutoCompactEnabled: null,
                categories: null,
                observedAtMs: params.observedAtMs ?? Date.now(),
                source: 'provider_turn',
            },
        } : {}),
    };
}
