import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import { ConnectedServiceCredentialRevisionV1Schema } from '@happier-dev/protocol';
import {
    resolveClaudeUsageLimitResetTiming,
    type NormalizedProviderUsageLimitDetailsV1,
} from './mapClaudeRateLimitEventToUsageDetails';

function readRecord(value: unknown): Record<string, unknown> | null {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNonNegativeInteger(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    if (!/^\d+$/u.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function readSelectionGroupGeneration(selection: Record<string, unknown> | null, groupId: string | null): number | null {
    if (!selection || !groupId || readString(selection.groupId) !== groupId) return null;
    return readNonNegativeInteger(selection.groupGeneration ?? selection.generation);
}

function readSelectionCredentialRevision(selection: Record<string, unknown> | null) {
    const parsed = ConnectedServiceCredentialRevisionV1Schema.safeParse(selection?.credentialRevision);
    return parsed.success ? parsed.data : null;
}

function readClaudeConnectedServiceId(value: unknown): 'anthropic' | 'claude-subscription' {
    return readString(value) === 'anthropic' ? 'anthropic' : 'claude-subscription';
}

function readStatus(value: unknown): number | null {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
    if (typeof value !== 'string') return null;
    const parsed = Number(value.trim());
    return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : null;
}

function collectEvidenceText(value: unknown, output: string[]): void {
    if (typeof value === 'string') {
        output.push(value);
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectEvidenceText(item, output);
        return;
    }
    const record = readRecord(value);
    if (!record) return;
    for (const key of ['type', 'code', 'kind', 'error', 'errors', 'message', 'detail', 'details', 'description', 'subtype']) {
        collectEvidenceText(record[key], output);
    }
}

function collectStatuses(value: unknown, output: number[]): void {
    const record = readRecord(value);
    if (!record) return;
    for (const key of ['apiErrorStatus', 'api_error_status', 'errorStatus', 'error_status', 'status', 'statusCode', 'status_code']) {
        const status = readStatus(record[key]);
        if (status !== null) output.push(status);
    }
    for (const key of ['error', 'message', 'result', 'response']) {
        collectStatuses(record[key], output);
    }
}

export function isClaudeRuntimeAuthFailureEvidence(error: unknown): boolean {
    const statuses: number[] = [];
    collectStatuses(error, statuses);
    const textParts: string[] = [];
    collectEvidenceText(error, textParts);
    const text = textParts.join(' ').toLowerCase();

    return statuses.includes(401)
        || /\bauthentication_failed\b/u.test(text)
        || /\bauthentication_error\b/u.test(text)
        || /\binvalid authentication credentials\b/u.test(text)
        || /\bnot logged in\b/u.test(text)
        || /\bplease run \/login\b/u.test(text)
        || /\boauth token has expired\b/u.test(text)
        || /\bfailed to authenticate\b/u.test(text);
}

function classifyClaudeAuthFailure(params: Readonly<{
    error: unknown;
    selection?: unknown;
}>): ConnectedServiceRuntimeFailureClassification | null {
    if (!isClaudeRuntimeAuthFailureEvidence(params.error)) return null;
    const selection = readRecord(params.selection);
    const groupId = readString(selection?.groupId);
    const groupGeneration = readSelectionGroupGeneration(selection, groupId);
    const credentialRevision = readSelectionCredentialRevision(selection);
    return {
        kind: 'auth_expired',
        limitCategory: 'auth_invalid',
        serviceId: readClaudeConnectedServiceId(selection?.serviceId),
        profileId: readString(selection?.activeProfileId ?? selection?.profileId),
        groupId,
        ...(groupGeneration !== null ? { groupGeneration } : {}),
        ...(credentialRevision !== null ? { credentialRevision } : {}),
        resetsAtMs: null,
        retryAfterMs: null,
        quotaScope: 'account',
        providerLimitId: null,
        action: null,
        planType: null,
        rateLimits: null,
        source: 'stable_provider_message',
    };
}

export function classifyClaudeConnectedServiceRuntimeAuthFailure(params: Readonly<{
    details?: NormalizedProviderUsageLimitDetailsV1 | null;
    error?: unknown;
    selection?: unknown;
}>): ConnectedServiceRuntimeFailureClassification | null {
    if (!params.details) {
        return classifyClaudeAuthFailure({ error: params.error, selection: params.selection });
    }
    const selection = readRecord(params.selection);
    // RD-CLD-5: an explicit mapper category is authoritative; the sub-100 utilization heuristic
    // (cooldown-shaped rate limit) applies only when the mapper could not determine a category.
    const limitCategory =
        params.details.limitCategory !== undefined && params.details.limitCategory !== 'unknown'
            ? params.details.limitCategory
            : params.details.providerLimitId === 'transient'
                ? 'rate_limit'
            : params.details.utilization !== null && params.details.utilization < 100
                ? 'rate_limit'
                : 'usage_limit';
    const kind =
        params.details.providerLimitId === 'transient'
            ? 'temporary_throttle'
            : limitCategory === 'capacity'
            ? 'capacity'
            : limitCategory === 'rate_limit'
                ? 'rate_limit'
                : 'usage_limit';
    // INC-4: when the mapped details carry no timing, fall back to parsing the raw provider
    // payload so durable waits can use the true provider reset instead of rolling cooldowns.
    const fallbackTiming =
        params.details.resetAtMs === null && params.details.retryAfterMs === null && params.error !== undefined
            ? resolveClaudeUsageLimitResetTiming(params.error, Date.now())
            : null;
    const groupId = readString(selection?.groupId);
    const groupGeneration = readSelectionGroupGeneration(selection, groupId);
    const credentialRevision = readSelectionCredentialRevision(selection);
    return {
        kind,
        limitCategory,
        serviceId: readClaudeConnectedServiceId(selection?.serviceId),
        profileId: readString(selection?.activeProfileId ?? selection?.profileId),
        groupId,
        ...(groupGeneration !== null ? { groupGeneration } : {}),
        ...(credentialRevision !== null ? { credentialRevision } : {}),
        resetsAtMs: params.details.resetAtMs ?? fallbackTiming?.resetAtMs ?? null,
        retryAfterMs: params.details.retryAfterMs ?? fallbackTiming?.retryAfterMs ?? null,
        quotaScope: params.details.quotaScope,
        providerLimitId: params.details.providerLimitId ?? null,
        action: params.details.action,
        planType: params.details.planType,
        rateLimits: params.details,
        source: 'structured_provider_error',
    };
}
