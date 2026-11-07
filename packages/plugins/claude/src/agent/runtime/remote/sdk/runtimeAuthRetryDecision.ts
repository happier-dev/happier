import {
    resolveRecoverableTurnFailureRetryDecision,
    type RecoverableTurnFailureRetryDecision,
} from '@happier-dev/plugin-sdk/agents/runtime';

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
    const attempt = readPositiveInteger(readProviderRetryAttempt(record));
    const maxRetries = readPositiveInteger(record.max_retries ?? record.maxRetries ?? record.maxRetryAttempts);
    return attempt !== null && maxRetries !== null && attempt < maxRetries;
}

function readProviderRetryAttempt(record: Readonly<Record<string, unknown>>): number | null {
    return readFiniteNumber(record.attempt ?? record.retryAttempt ?? record.retry_attempt);
}

export function readClaudeAgentSdkRuntimeRetry(message: unknown): Readonly<{
    attempt: number | null;
    reason: 'rate_limited' | 'server_error' | 'unknown';
}> | null {
    if (!isRecord(message) || !readProviderWillRetry(message)) return null;
    if (!(message.type === 'system' && message.subtype === 'api_error')
        && !(message.type === 'assistant' && message.isApiErrorMessage === true)) return null;
    const attempt = readProviderRetryAttempt(message);
    const status = readFiniteNumber(message.error_status ?? message.apiErrorStatus);
    return {
        attempt: attempt !== null && Number.isSafeInteger(attempt) && attempt > 0 ? attempt : null,
        reason: status === 429 ? 'rate_limited'
            : status !== null && status >= 500 && status <= 599 ? 'server_error' : 'unknown',
    };
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
