import {
    resolveRecoverableTurnFailureRetryDecision,
    type RecoverableTurnFailureRetryDecision,
} from '@happier-dev/agents';

type ClaudeRuntimeAuthRetryDecision =
    | Extract<RecoverableTurnFailureRetryDecision, { action: 'await_provider_retry' }>
    | Readonly<{ action: 'surface' }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFiniteNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'string') return null;
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
}

function readPositiveInteger(value: unknown): number | null {
    const parsed = readFiniteNumber(value);
    if (parsed === null || parsed <= 0) return null;
    return Math.trunc(parsed);
}

function readNonNegativeInteger(value: unknown): number | null {
    const parsed = readFiniteNumber(value);
    if (parsed === null || parsed < 0) return null;
    return Math.trunc(parsed);
}

function readProviderWillRetry(record: Readonly<Record<string, unknown>>): boolean {
    if (record.willRetry === true || record.will_retry === true) return true;
    const attempt = readPositiveInteger(record.attempt ?? record.retryAttempt ?? record.retry_attempt);
    const maxRetries = readPositiveInteger(record.max_retries ?? record.maxRetries ?? record.maxRetryAttempts);
    return attempt !== null && maxRetries !== null && attempt < maxRetries;
}

function readFailureRetryAfterMs(record: Readonly<Record<string, unknown>>): number | null {
    return readNonNegativeInteger(
        record.retry_delay_ms
            ?? record.retryDelayMs
            ?? record.retry_after_ms
            ?? record.retryAfterMs,
    );
}

export function resolveClaudeAgentSdkRuntimeAuthRetryDecision(message: unknown): ClaudeRuntimeAuthRetryDecision {
    if (!isRecord(message) || !readProviderWillRetry(message)) return { action: 'surface' };
    const decision = resolveRecoverableTurnFailureRetryDecision({
        attemptCount: 0,
        maxRetries: 0,
        providerWillRetry: true,
        failureRetryAfterMs: readFailureRetryAfterMs(message),
        failedTurnHadMeaningfulActivity: false,
        promptMode: 'off',
        originalPrompt: '',
        continuationPrompt: '',
    });
    return decision.action === 'await_provider_retry' ? decision : { action: 'surface' };
}
