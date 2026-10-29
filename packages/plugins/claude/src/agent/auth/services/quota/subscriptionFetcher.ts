import { normalizeClaudeOauthProfileEntitlement, readClaudeOauthCredentialOrganizationId } from '@happier-dev/protocol/providers/claude/oauth-profile';
import { resolveConnectedServiceQuotaMeterLabel } from '@happier-dev/plugin-sdk/connected-accounts';
import type {
    AgentAccountUsageMeter,
    AgentAccountUsageSnapshot,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    ConnectedAccountRuntime,
    OauthCredentialRecord,
    TokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';
import { QuotaFetchError as ConnectedServiceQuotaFetchError } from '@happier-dev/plugin-sdk/connected-accounts';
import { classifyClaudeCodeCredentialHealth } from '../native/health.js';
import { parseClaudeUsageLimitReset } from '../runtime/reset.js';
import { resolveClaudeUsageSubjectRef } from '../usage/identity.js';
import { mapClaudeProviderHttpUsageSnapshot } from '../usage/snapshot.js';
import { resolveClaudeCodeUsageUserAgent } from './userAgent.js';
import { parseClaudeQuotaResets, claudeResetRequestId } from './resets.js';
import type { ConnectedServiceQuotaRecoveryCreditV1 } from '@happier-dev/plugin-sdk/connected-accounts';

export const CLAUDE_DEFAULT_SUBSCRIPTION_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const DEFAULT_BETA_HEADER_VALUE = 'oauth-2025-04-20';

// The endpoint's established placeholder inventory is separate from display-label resolution.
const DEFAULT_USAGE_WINDOW_IDS = [
    'five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_sonnet', 'seven_day_opus', 'iguana_necktie',
] as const;

export type ClaudeRuntimeFetchRequest = Readonly<{
    url: string;
    method?: 'GET' | 'POST';
    headers?: Readonly<Record<string, string>>;
    body?: unknown;
    signal?: AbortSignal;
}>;

export type ClaudeRuntimeFetchResponse = Readonly<{
    ok: boolean;
    status: number;
    statusText?: string;
    headers: Readonly<Record<string, string>>;
    body?: unknown;
    text(): Promise<string>;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
}>;

export type ClaudeRuntimeFetch = (request: ClaudeRuntimeFetchRequest) => Promise<ClaudeRuntimeFetchResponse>;

export function createClaudeSubscriptionQuotaFetchError(input: Readonly<{
    status: number;
    statusText?: string;
    headers: Readonly<Record<string, string>>;
    body: string;
    nowMs: number;
}>): ConnectedServiceQuotaFetchError {
    let body: unknown;
    try {
        body = JSON.parse(input.body);
    } catch {
        body = input.body.trim();
    }
    const timing = parseClaudeUsageLimitReset({ nowMs: input.nowMs, headers: input.headers, body });
    if (input.status === 403) {
        const requiredScope = input.body.match(/scope requirement\s+([a-z0-9:_-]+)/i)?.[1]?.trim();
        if (requiredScope) {
            return new ConnectedServiceQuotaFetchError(
                `Claude quota fetch requires OAuth scope '${requiredScope}'. Reconnect Claude in Happier and retry.`,
                { status: 403, ...timing, quotaFetchErrorCode: 'auth_failure', providerCode: 'missing_claude_code_scope' },
            );
        }
    }
    return new ConnectedServiceQuotaFetchError(
        `Anthropic usage fetch failed (${input.status}): ${input.statusText || 'HTTP error'}`,
        { status: input.status, ...timing, quotaFetchErrorCode: input.status === 401 || input.status === 403 ? 'auth_failure' : 'provider_backoff' },
    );
}

export function parseClaudeSubscriptionConnectedAccountQuotaLimits(
    value: unknown,
): Awaited<ReturnType<NonNullable<ConnectedAccountRuntime['quota']>>>['limits'] {
    return parseClaudeSubscriptionUsageMeters(value).map((meter) => {
        const used = meter.used ?? meter.utilizationPct;
        const remaining = meter.limit !== null && used !== null
            ? Math.max(0, meter.limit - used)
            : meter.utilizationPct !== null ? Math.max(0, 100 - meter.utilizationPct) : null;
        return {
            id: meter.meterId,
            providerLimitId: meter.providerLimitId,
            label: meter.label,
            limit: meter.limit,
            unit: meter.unit,
            remainingPct: meter.remainingPct,
            utilizationPct: meter.utilizationPct,
            status: meter.status,
            isExhausted: meter.isExhausted,
            details: meter.details,
            confidence: meter.confidence,
            windowDurationMs: meter.windowDurationMs,
            modelId: meter.modelId,
            scope: meter.scope,
            limitScope: meter.limitScope,
            ...(used === null ? {} : { used }),
            ...(remaining === null ? {} : { remaining }),
            ...(meter.resetsAt === null ? {} : { resetsAtMs: meter.resetsAt }),
        };
    });
}

type ClaudeQuotaFetcher = Readonly<{
    consumeRecoveryCredit: (input: Readonly<{
        record: OauthCredentialRecord | TokenCredentialRecord; now: number; signal: AbortSignal;
        idempotencyKey: string; providerCreditId?: string; providerLimitIds?: readonly string[];
    }>) => Promise<ClaudeResetConsumeStatus>;
    serviceId: string;
    loadQuota: (params: Readonly<{
        record: OauthCredentialRecord | TokenCredentialRecord;
        now: number;
        signal: AbortSignal;
    }>) => Promise<AgentAccountUsageSnapshot | null>;
}>;

export type ClaudeQuotaFetcherDescriptor = Readonly<{
    id: string;
    createFetcher: (params: Readonly<{
        env: Readonly<Record<string, string | undefined>>;
        staleAfterMs: number;
        userAgent?: string;
    }>) => ClaudeQuotaFetcher;
    /**
     * Claude-specific quota `providerCode`s that must be classified as a terminal
     * (reconnect-required) auth failure by the daemon's `ConnectedServiceQuotasCoordinator`.
     * These are Claude Code OAuth-scope failures, not standard OAuth2 codes, so they live
     * here (provider-owned) rather than as a core/daemon hardcode.
     */
    terminalAuthFailureProviderCodes?: readonly string[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePct(value: unknown): number | null {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.max(0, Math.min(100, numeric));
}

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function resolveConnectedServiceQuotaAccountLabel(record: OauthCredentialRecord | TokenCredentialRecord): string | null {
    if (record.kind === 'oauth') {
        return normalizeNonEmptyString(record.oauth.providerEmail)
            ?? normalizeNonEmptyString(record.oauth.providerAccountId);
    }
    if (record.kind === 'token') {
        return normalizeNonEmptyString(record.token.providerEmail)
            ?? normalizeNonEmptyString(record.token.providerAccountId);
    }
    return null;
}

function resolveClaudeSubscriptionPlanLabel(record: OauthCredentialRecord | TokenCredentialRecord): string | null {
    if (record.kind !== 'oauth') return null;
    const raw = isRecord(record.oauth.raw) ? record.oauth.raw : null;
    const claudeAiOauth = isRecord(raw?.claudeAiOauth)
        ? raw.claudeAiOauth
        : isRecord(raw?.['claude.ai_oauth'])
            ? raw['claude.ai_oauth']
            : null;
    return resolveClaudeSubscriptionPlanLabelFromMetadata(claudeAiOauth);
}

/** Native and Connected Account probes project the same provider-declared fact. */
export function resolveClaudeSubscriptionPlanLabelFromMetadata(metadata: Readonly<{
    subscriptionType?: unknown;
    rateLimitTier?: unknown;
}> | null): string | null {
    return normalizeNonEmptyString(metadata?.subscriptionType)
        ?? normalizeNonEmptyString(metadata?.rateLimitTier);
}

function parseIsoDateMs(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

function parseResetAtMs(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        return Math.trunc(value);
    }
    return parseIsoDateMs(value);
}

const USAGE_WINDOW_CONTAINER_KEYS = new Set([
    'limits',
    'quota_limits',
    'quotaLimits',
    'quota_windows',
    'quotaWindows',
    'rate_limits',
    'rateLimits',
    'usage_limits',
    'usageLimits',
    'usage_windows',
    'usageWindows',
    'windows',
]);

const USAGE_WINDOW_ID_KEYS = [
    'kind',
    'meter_id',
    'meterId',
    'provider_limit_id',
    'providerLimitId',
    'limit_id',
    'limitId',
    'id',
    'key',
    'name',
    'rate_limit_type',
    'rateLimitType',
    'type',
] as const;

const USAGE_WINDOW_WINDOW_KEYS = [
    'group',
    'window',
    'period',
    'scope',
    'quota_scope',
    'quotaScope',
    'limit_scope',
    'limitScope',
    'limit_window',
    'limitWindow',
] as const;

const USAGE_WINDOW_MODEL_KEYS = [
    'model',
    'model_id',
    'modelId',
    'model_family',
    'modelFamily',
    'family',
    'category',
    'limit_type',
    'limitType',
] as const;

const USAGE_WINDOW_UTILIZATION_KEYS = [
    'utilization',
    'utilization_pct',
    'utilizationPct',
    'percent',
    'usage_pct',
    'usagePct',
    'used_pct',
    'usedPct',
    'percent_used',
    'percentUsed',
    'percentage',
] as const;

const USAGE_WINDOW_REMAINING_KEYS = [
    'remaining_pct',
    'remainingPct',
    'percent_remaining',
    'percentRemaining',
] as const;

const USAGE_WINDOW_RESET_KEYS = [
    'resets_at',
    'resetsAt',
    'reset_at',
    'resetAt',
    'reset_at_ms',
    'resetAtMs',
    'resets_at_ms',
    'resetsAtMs',
] as const;

const USAGE_WINDOW_USED_KEYS = [
    'used',
    'used_credits',
    'usedCredits',
    'usage',
    'current',
] as const;

const USAGE_WINDOW_LIMIT_KEYS = [
    'limit',
    'max',
    'quota',
    'monthly_limit',
    'monthlyLimit',
] as const;

const GENERIC_USAGE_WINDOW_IDS = new Set([
    'limit',
    'limits',
    'quota',
    'quota_limit',
    'quota_limits',
    'quota_window',
    'quota_windows',
    'rate_limit',
    'rate_limits',
    'usage',
    'usage_limit',
    'usage_limits',
    'usage_window',
    'usage_windows',
    'window',
    'windows',
]);

const USAGE_WINDOW_SEGMENT_ALIASES: ReadonlyArray<readonly [string, string]> = [
    ['five_hour', 'five_hour'],
    ['five_hours', 'five_hour'],
    ['5_hour', 'five_hour'],
    ['5_hours', 'five_hour'],
    ['5h', 'five_hour'],
    ['session', 'five_hour'],
    ['seven_day', 'seven_day'],
    ['seven_days', 'seven_day'],
    ['7_day', 'seven_day'],
    ['7_days', 'seven_day'],
    ['7d', 'seven_day'],
    ['weekly', 'seven_day'],
    ['week', 'seven_day'],
];

const QUOTA_UNITS = new Set([
    'count',
    'tokens',
    'credits',
    'usd',
    'requests',
    'unknown',
]);

function readNonEmptyStringProperty(
    record: Record<string, unknown>,
    keys: readonly string[],
): string | null {
    for (const key of keys) {
        const value = record[key];
        if (typeof value !== 'string') continue;
        const trimmed = value.trim();
        if (trimmed) return trimmed;
    }
    return null;
}

function readScopedUsageWindowModel(record: Record<string, unknown>): string | null {
    const direct = readNonEmptyStringProperty(record, USAGE_WINDOW_MODEL_KEYS);
    if (direct) return direct;
    for (const key of USAGE_WINDOW_MODEL_KEYS) {
        const value = record[key];
        if (isRecord(value)) {
            const nested = readNonEmptyStringProperty(value, [
                'display_name',
                'displayName',
                'name',
                'id',
            ]);
            if (nested) return nested;
        }
    }
    const scope = isRecord(record.scope) ? record.scope : null;
    if (!scope) return null;
    const scopedModel = scope.model;
    if (typeof scopedModel === 'string' && scopedModel.trim()) {
        return scopedModel.trim();
    }
    if (isRecord(scopedModel)) {
        return readNonEmptyStringProperty(scopedModel, [
            'display_name',
            'displayName',
            'name',
            'id',
        ]);
    }
    return readNonEmptyStringProperty(scope, [
        'model_display_name',
        'modelDisplayName',
        'model_name',
        'modelName',
        'model_id',
        'modelId',
    ]);
}

function readScopedUsageWindowModelId(record: Record<string, unknown>): string | null {
    const direct = readNonEmptyStringProperty(record, ['model_id', 'modelId']);
    if (direct) return direct;
    if (typeof record.model === 'string' && record.model.trim()) return record.model.trim();
    if (isRecord(record.model)) {
        const nestedId = readNonEmptyStringProperty(record.model, ['id', 'model_id', 'modelId']);
        if (nestedId) return nestedId;
    }
    const scope = isRecord(record.scope) ? record.scope : null;
    if (!scope) return null;
    const scopedDirect = readNonEmptyStringProperty(scope, ['model_id', 'modelId']);
    if (scopedDirect) return scopedDirect;
    if (typeof scope.model === 'string' && scope.model.trim()) return scope.model.trim();
    if (!isRecord(scope.model)) return null;
    return readNonEmptyStringProperty(scope.model, ['id', 'model_id', 'modelId']);
}

function readFiniteNumberProperty(
    record: Record<string, unknown>,
    keys: readonly string[],
): number | null {
    for (const key of keys) {
        const value = record[key];
        const numeric = typeof value === 'number' ? value : Number(value);
        if (Number.isFinite(numeric)) return numeric;
    }
    return null;
}

function readPctProperty(record: Record<string, unknown>, keys: readonly string[]): number | null {
    for (const key of keys) {
        const value = normalizePct(record[key]);
        if (value !== null) return value;
    }
    return null;
}

function resolveUsageWindowUtilizationPct(window: Record<string, unknown> | null): number | null {
    if (!window) return null;
    const utilizationPct = readPctProperty(window, USAGE_WINDOW_UTILIZATION_KEYS);
    if (utilizationPct !== null) return utilizationPct;
    const remainingPct = readPctProperty(window, USAGE_WINDOW_REMAINING_KEYS);
    if (remainingPct !== null) return Math.max(0, Math.min(100, 100 - remainingPct));
    const used = readFiniteNumberProperty(window, USAGE_WINDOW_USED_KEYS);
    const limit = readFiniteNumberProperty(window, USAGE_WINDOW_LIMIT_KEYS);
    if (used !== null && limit !== null && limit > 0) {
        return Math.max(0, Math.min(100, (used / limit) * 100));
    }
    return null;
}

function resolveUsageWindowResetAtMs(window: Record<string, unknown> | null): number | null {
    if (!window) return null;
    for (const key of USAGE_WINDOW_RESET_KEYS) {
        const parsed = parseResetAtMs(window[key]);
        if (parsed !== null) return parsed;
    }
    return null;
}

function normalizeUsageWindowSegment(value: string | null | undefined): string | null {
    const normalized = (value ?? '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');
    return normalized ? normalized : null;
}

function canonicalizeUsageWindowSegment(segment: string | null): string | null {
    if (!segment) return null;
    return USAGE_WINDOW_SEGMENT_ALIASES.find(([alias]) => alias === segment)?.[1] ?? segment;
}

function canonicalizeUsageWindowMeterId(meterId: string | null): string | null {
    if (!meterId) return null;
    for (const [alias, canonical] of USAGE_WINDOW_SEGMENT_ALIASES) {
        if (meterId === alias) return canonical;
        if (meterId.startsWith(`${alias}_`)) {
            return `${canonical}_${meterId.slice(alias.length + 1)}`;
        }
    }
    return meterId;
}

function isGenericUsageWindowId(value: string): boolean {
    return GENERIC_USAGE_WINDOW_IDS.has(value);
}

function deriveUsageWindowMeterId(
    fallbackKey: string | null,
    record: Record<string, unknown>,
): string | null {
    const windowSegment = canonicalizeUsageWindowSegment(
        normalizeUsageWindowSegment(readNonEmptyStringProperty(record, USAGE_WINDOW_WINDOW_KEYS)),
    );
    const modelSegment = normalizeUsageWindowSegment(readScopedUsageWindowModel(record));
    const explicitSegment = canonicalizeUsageWindowMeterId(
        normalizeUsageWindowSegment(readNonEmptyStringProperty(record, USAGE_WINDOW_ID_KEYS))
            ?? normalizeUsageWindowSegment(fallbackKey),
    );

    if (windowSegment && modelSegment && !isGenericUsageWindowId(modelSegment)) {
        return `${windowSegment}_${modelSegment}`;
    }
    if (windowSegment && explicitSegment && !isGenericUsageWindowId(explicitSegment)) {
        if (explicitSegment === windowSegment || explicitSegment.startsWith(`${windowSegment}_`)) {
            return explicitSegment;
        }
        return `${windowSegment}_${explicitSegment}`;
    }
    if (windowSegment) {
        return windowSegment;
    }
    if (explicitSegment && !isGenericUsageWindowId(explicitSegment)) {
        return explicitSegment;
    }
    return null;
}

function isUsageWindowRecord(value: unknown): value is Record<string, unknown> {
    if (!isRecord(value)) return false;
    return resolveUsageWindowUtilizationPct(value) !== null || resolveUsageWindowResetAtMs(value) !== null;
}

function resolveUsageWindowUnit(
    window: Record<string, unknown> | null,
): 'count' | 'tokens' | 'credits' | 'usd' | 'requests' | 'unknown' {
    const raw = typeof window?.unit === 'string' ? window.unit.trim().toLowerCase() : '';
    return QUOTA_UNITS.has(raw as 'count' | 'tokens' | 'credits' | 'usd' | 'requests' | 'unknown')
        ? raw as 'count' | 'tokens' | 'credits' | 'usd' | 'requests' | 'unknown'
        : 'unknown';
}

function buildUsageWindowMeter(
    meterId: string,
    window: Record<string, unknown> | null,
): AgentAccountUsageMeter {
    const utilizationPct = resolveUsageWindowUtilizationPct(window);
    const used = window ? readFiniteNumberProperty(window, USAGE_WINDOW_USED_KEYS) : null;
    const limit = window ? readFiniteNumberProperty(window, USAGE_WINDOW_LIMIT_KEYS) : null;
    return {
        meterId,
        label: resolveConnectedServiceQuotaMeterLabel(meterId),
        providerLimitId: window ? readNonEmptyStringProperty(window, ['provider_limit_id', 'providerLimitId', 'limit_id', 'limitId', 'id']) ?? meterId : meterId,
        ...(meterId === 'seven_day' || meterId.startsWith('seven_day_')
            ? { windowDurationMs: 7 * 24 * 60 * 60 * 1000 }
            : meterId === 'five_hour' || meterId.startsWith('five_hour_')
                ? { windowDurationMs: 5 * 60 * 60 * 1000 }
                : {}),
        modelId: window ? readScopedUsageWindowModelId(window) : null,
        used,
        limit,
        unit: resolveUsageWindowUnit(window),
        utilizationPct,
        resetsAt: resolveUsageWindowResetAtMs(window),
        status: utilizationPct === null ? 'unavailable' : 'ok',
        details: {
            ...(window
                ? {
                    rawScope: readNonEmptyStringProperty(window, USAGE_WINDOW_ID_KEYS) ?? undefined,
                }
                : {}),
        },
    };
}

function collectUsageWindowMeterEntries(
    data: Record<string, unknown>,
): ReadonlyArray<Readonly<{
    meterId: string;
    window: Record<string, unknown> | null;
}>> {
    const windowsByMeterId = new Map<string, Record<string, unknown> | null>();
    const setWindow = (meterId: string | null, window: Record<string, unknown> | null): void => {
        if (!meterId) return;
        const existing = windowsByMeterId.get(meterId);
        if (existing && window) return;
        windowsByMeterId.set(meterId, window);
    };

    for (const meterId of DEFAULT_USAGE_WINDOW_IDS) {
        setWindow(meterId, isRecord(data[meterId]) ? data[meterId] : null);
    }

    const visitContainer = (value: unknown, depth: number): void => {
        if (depth > 3) return;
        if (Array.isArray(value)) {
            for (const item of value) {
                if (!isRecord(item)) continue;
                if (isUsageWindowRecord(item)) {
                    setWindow(deriveUsageWindowMeterId(null, item), item);
                    continue;
                }
                visitContainer(item, depth + 1);
            }
            return;
        }
        if (!isRecord(value)) return;
        for (const [key, child] of Object.entries(value)) {
            if (isUsageWindowRecord(child)) {
                setWindow(deriveUsageWindowMeterId(key, child), child);
                continue;
            }
            if (USAGE_WINDOW_CONTAINER_KEYS.has(key)) {
                visitContainer(child, depth + 1);
            }
        }
    };

    for (const [key, value] of Object.entries(data)) {
        if (key === 'extra_usage') continue;
        if (isUsageWindowRecord(value)) {
            setWindow(deriveUsageWindowMeterId(key, value), value);
            continue;
        }
        if (USAGE_WINDOW_CONTAINER_KEYS.has(key)) {
            visitContainer(value, 1);
        }
    }
    return Array.from(windowsByMeterId, ([meterId, window]) => ({ meterId, window }));
}

export function parseClaudeSubscriptionUsageMeters(
    value: unknown,
): AgentAccountUsageMeter[] {
    const data = isRecord(value) ? value : {};
    const meters: AgentAccountUsageMeter[] =
        collectUsageWindowMeterEntries(data)
            .map(({ meterId, window }) => buildUsageWindowMeter(meterId, window));
    const extra = isRecord(data.extra_usage) ? data.extra_usage : null;
    if (extra?.is_enabled) {
        const utilizationPct = normalizePct(extra.utilization);
        meters.push({
            meterId: 'extra_usage',
            label: 'Extra usage',
            providerLimitId: 'extra_usage',
            modelId: null,
            used: typeof extra.used_credits === 'number' && Number.isFinite(extra.used_credits)
                ? extra.used_credits
                : null,
            limit: typeof extra.monthly_limit === 'number' && Number.isFinite(extra.monthly_limit)
                ? extra.monthly_limit
                : null,
            unit: 'credits',
            utilizationPct,
            resetsAt: null,
            status: utilizationPct === null ? 'unavailable' : 'ok',
            details: {},
        });
    }
    return meters;
}

function buildQuotaUnknownMeter(meterId: string, label: string): AgentAccountUsageMeter {
    return {
        meterId,
        label,
        providerLimitId: meterId,
        modelId: null,
        used: null,
        limit: null,
        unit: 'unknown',
        utilizationPct: null,
        resetsAt: null,
        status: 'unavailable',
        details: { code: 'quota_unknown' },
    };
}

function buildClaudeProviderHttpQuotaSnapshot(input: Readonly<{
    record: OauthCredentialRecord | TokenCredentialRecord;
    now: number;
    staleAfterMs: number;
    planLabel?: string | null;
    accountLabel?: string | null;
    meters: readonly AgentAccountUsageMeter[];
}>): AgentAccountUsageSnapshot {
    const providerAccountId = input.record.kind === 'oauth'
        ? input.record.oauth.providerAccountId
        : input.record.token.providerAccountId;
    return mapClaudeProviderHttpUsageSnapshot({
        subject: resolveClaudeUsageSubjectRef({
            providerAccountId,
            organizationId: input.record.kind === 'oauth' ? readClaudeOauthCredentialOrganizationId(input.record.oauth.raw) : null,
            provisionalDiscriminator: `${input.record.serviceId}:${input.record.profileId}`,
            accountLabel: input.accountLabel,
        }),
        observedAtMs: input.now,
        fetchedAtMs: input.now,
        staleAfterMs: input.staleAfterMs,
        planLabel: input.planLabel,
        accountLabel: input.accountLabel,
        meters: input.meters,
    });
}

function headersToRecord(headers: Headers | undefined): Readonly<Record<string, string>> {
    const record: Record<string, string> = {};
    if (!headers) return record;
    headers.forEach((value, key) => {
        record[key] = value;
    });
    return record;
}

type FetchBody = NonNullable<Parameters<typeof globalThis.fetch>[1]>['body'];

function toRequestBody(value: ClaudeRuntimeFetchRequest['body']): FetchBody | undefined {
    if (value === undefined || value === null) return undefined;
    if (
        typeof value === 'string'
        || value instanceof URLSearchParams
        || value instanceof ArrayBuffer
        || value instanceof Blob
        || value instanceof FormData
        || value instanceof ReadableStream
    ) {
        return value;
    }
    return JSON.stringify(value);
}

function defaultRuntimeFetch(): ClaudeRuntimeFetch {
    return async ({ url, method, headers, body, signal }): Promise<ClaudeRuntimeFetchResponse> => {
        const response = await globalThis.fetch(url, {
            method,
            headers,
            body: toRequestBody(body),
            signal,
        });
        return {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers: headersToRecord(response.headers),
            body: null,
            text: async () => await response.text(),
            json: async () => await response.json() as unknown,
            arrayBuffer: async () => await response.arrayBuffer(),
        };
    };
}

export function createClaudeSubscriptionQuotaFetcher(params?: Readonly<{
    usageUrl?: string;
    betaHeaderValue?: string;
    staleAfterMs?: number;
    userAgent?: string;
    disablePrivateEndpoint?: boolean;
    runtimeFetch?: ClaudeRuntimeFetch;
}>): ClaudeQuotaFetcher {
    const usageUrl = typeof params?.usageUrl === 'string' && params.usageUrl.trim().length > 0
        ? params.usageUrl.trim()
        : CLAUDE_DEFAULT_SUBSCRIPTION_USAGE_URL;
    const disablePrivateEndpoint = params?.disablePrivateEndpoint === true
        && usageUrl === CLAUDE_DEFAULT_SUBSCRIPTION_USAGE_URL;
    const betaHeaderValue = params?.betaHeaderValue ?? DEFAULT_BETA_HEADER_VALUE;
    const staleAfterMs =
        typeof params?.staleAfterMs === 'number' && Number.isFinite(params.staleAfterMs)
            ? Math.max(1, Math.trunc(params.staleAfterMs))
            : 300_000;
    const userAgent = resolveClaudeCodeUsageUserAgent({ configuredUserAgent: params?.userAgent });
    const runtimeFetch = params?.runtimeFetch ?? defaultRuntimeFetch();

    const client = createClaudeSubscriptionHttpClient({ usageUrl, betaHeaderValue, userAgent, runtimeFetch });

    return {
        serviceId: 'claude-subscription',
        consumeRecoveryCredit: async ({ record, now, signal, ...request }) => {
            if (record.kind !== 'oauth' || disablePrivateEndpoint) return 'not_available';
            if (classifyClaudeCodeCredentialHealth(record).status !== 'ok') {
                throw new ConnectedServiceQuotaFetchError('Claude OAuth scopes cannot redeem a reset.', {
                    quotaFetchErrorCode: 'auth_failure', recoveryCreditConsumeOutcomeUnknown: false,
                });
            }
            return client.consume({ ...request, accessToken: record.oauth.accessToken, now, signal,
                expectedProviderAccountId: record.oauth.providerAccountId,
                expectedProviderOrganizationId: readClaudeOauthCredentialOrganizationId(record.oauth.raw),
            });
        },
        loadQuota: async ({ record, now, signal }) => {
            if (record.kind !== 'oauth') return null;
            if (!usageUrl) return null;
            const planLabel = resolveClaudeSubscriptionPlanLabel(record);
            const credentialHealth = classifyClaudeCodeCredentialHealth(record);
            if (credentialHealth.status !== 'ok') {
                throw new ConnectedServiceQuotaFetchError(
                    'Claude subscription credentials cannot be used by Claude Code. Reconnect Claude in Happier and retry.',
                    {
                        quotaFetchErrorCode: 'auth_failure',
                        providerCode: credentialHealth.status === 'missing_required_scope'
                            ? 'missing_claude_code_scope'
                            : credentialHealth.status,
                    },
                );
            }
            if (disablePrivateEndpoint) {
                return buildClaudeProviderHttpQuotaSnapshot({
                    record,
                    now,
                    staleAfterMs,
                    planLabel,
                    accountLabel: resolveConnectedServiceQuotaAccountLabel(record),
                    meters: DEFAULT_USAGE_WINDOW_IDS.map((meterId) =>
                        buildQuotaUnknownMeter(meterId, resolveConnectedServiceQuotaMeterLabel(meterId)),
                    ),
                });
            }
            const accessToken = record.oauth.accessToken;

            const data = await client.readUsage({ accessToken, now, signal });
            const snapshot = buildClaudeProviderHttpQuotaSnapshot({
                record, now, staleAfterMs, planLabel,
                accountLabel: resolveConnectedServiceQuotaAccountLabel(record),
                meters: parseClaudeSubscriptionUsageMeters(data),
            });
            try {
                const inventory = (await client.readResets({ accessToken, now, signal })).inventory;
                if (!inventory) return snapshot;
                return { ...snapshot, ...inventory };
            } catch {
                return { ...snapshot, diagnostics: [...(snapshot.diagnostics ?? []), {
                    kind: 'provider_http', code: 'claude_reset_discovery_failed', observedAtMs: now,
                    message: 'Claude reset discovery failed; ordinary usage remains available.',
                }] };
            }
        },
    };
}

function readNonEmptyEnv(env: Readonly<Record<string, string | undefined>>, key: string): string | undefined {
    const value = env[key]?.trim();
    return value ? value : undefined;
}

function readBooleanEnv(env: Readonly<Record<string, string | undefined>>, key: string): boolean {
    const value = (env[key] ?? '').trim().toLowerCase();
    return value === '1' || value === 'true' || value === 'yes';
}

export const claudeSubscriptionQuotaFetcherDescriptor: ClaudeQuotaFetcherDescriptor = {
    id: 'claude-subscription',
    terminalAuthFailureProviderCodes: [
        'missing_claude_code_scope',
        'claude_subscription_missing_claude_code_scope',
    ],
    createFetcher: ({ env, staleAfterMs, userAgent }) => createClaudeSubscriptionQuotaFetcher({
        usageUrl: readNonEmptyEnv(env, 'HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_USAGE_URL')
            ?? readNonEmptyEnv(env, 'HAPPIER_CONNECTED_SERVICES_ANTHROPIC_USAGE_URL'),
        staleAfterMs,
        userAgent: resolveClaudeCodeUsageUserAgent({ env, configuredUserAgent: userAgent }),
        disablePrivateEndpoint: readBooleanEnv(
            env,
            'HAPPIER_CONNECTED_SERVICES_DISABLE_CLAUDE_SUBSCRIPTION_QUOTA_ENDPOINT',
        ),
    }),
};


type ClaudeResetConsumeStatus = 'consumed' | 'already_consumed' | 'nothing_to_reset' | 'not_available';

export function createClaudeSubscriptionHttpClient(params: Readonly<{
    runtimeFetch: ClaudeRuntimeFetch; usageUrl?: string; betaHeaderValue?: string; userAgent?: string;
}>) {
    const usageUrl = params.usageUrl ?? CLAUDE_DEFAULT_SUBSCRIPTION_USAGE_URL;
    const headers = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}`, Accept: 'application/json',
        'Content-Type': 'application/json', 'anthropic-beta': params.betaHeaderValue ?? DEFAULT_BETA_HEADER_VALUE,
        'User-Agent': resolveClaudeCodeUsageUserAgent({ configuredUserAgent: params.userAgent }) });
    type Input = Readonly<{ accessToken: string; now: number; signal: AbortSignal }>;
    async function get(url: string, input: Input, retryServerError = false): Promise<unknown> {
        input.signal.throwIfAborted();
        let response = await params.runtimeFetch({ url, method: 'GET', headers: headers(input.accessToken), signal: input.signal });
        if (retryServerError && response.status >= 500 && response.status < 600) {
            response = await params.runtimeFetch({ url, method: 'GET', headers: headers(input.accessToken), signal: input.signal });
        }
        if (!response.ok) throw createClaudeSubscriptionQuotaFetchError({ status: response.status,
            statusText: response.statusText, headers: response.headers, body: await response.text().catch(() => ''), nowMs: input.now });
        return response.json();
    }
    async function readProfileContext(input: Input & Readonly<{ expectedProviderAccountId?: string | null }>) {
        const profile = await get(new URL('./profile', usageUrl).toString(), input);
        const account = isRecord(profile) && isRecord(profile.account) ? profile.account : null;
        const providerAccountId = typeof account?.uuid === 'string' ? account.uuid.trim() : '';
        const providerEmail = typeof account?.email_address === 'string' ? account.email_address.trim()
            : typeof account?.email === 'string' ? account.email.trim() : '';
        const expected = input.expectedProviderAccountId?.trim();
        if (expected && !providerAccountId) return { status: 'unavailable' as const };
        if (expected && providerAccountId !== expected) return { status: 'identityMismatch' as const };
        return { status: 'accepted' as const, providerAccountId, providerEmail,
            metadata: normalizeClaudeOauthProfileEntitlement(profile)?.claudeAiOauth ?? {} };
    }
    async function readResets(input: Input) {
        const url = new URL(usageUrl);
        url.searchParams.set('cedar_ember', '1'); url.searchParams.set('at_wall', '1'); url.searchParams.set('skip_spend', '1');
        const payload = await get(url.toString(), input);
        return { payload, inventory: parseClaudeQuotaResets(payload, input.now) };
    }
    return {
        readUsage: (input: Input) => get(usageUrl, input, true),
        readResets,
        readProfileContext,
        async consume(input: Input & Readonly<{ idempotencyKey: string; providerCreditId?: string; providerLimitIds?: readonly string[]; expectedProviderAccountId?: string | null; expectedProviderOrganizationId?: string | null }>): Promise<ClaudeResetConsumeStatus> {
            let selected: ConnectedServiceQuotaRecoveryCreditV1 | undefined;
            let organizationId: string;
            try {
                const { payload, inventory } = await readResets(input);
                selected = inventory?.recoveryCredits.credits.find(credit => credit.status === 'available'
                    && (!input.providerCreditId || credit.id === input.providerCreditId));
                if (!selected?.id) return 'not_available';
                if (input.providerLimitIds !== undefined) {
                    const clears = inventory?.recoveryCreditDetails[selected.id]?.appliesToProviderLimitIds ?? [];
                    const exhausted = new Set(parseClaudeSubscriptionUsageMeters(payload)
                        .filter(meter => meter.utilizationPct !== null && meter.utilizationPct >= 100)
                        .map(meter => meter.providerLimitId ?? meter.meterId));
                    if (!input.providerLimitIds.some(id => clears.includes(id) && exhausted.has(id))) return 'not_available';
                }
                const profile = await readProfileContext(input);
                organizationId = profile.status === 'accepted' ? profile.metadata.organizationUuid ?? '' : '';
                if (!organizationId) throw new Error('Claude reset organization is unavailable');
                const expectedOrganizationId = input.expectedProviderOrganizationId?.trim();
                if (expectedOrganizationId && organizationId !== expectedOrganizationId) {
                    throw new Error('Claude reset organization changed from the selected credential context');
                }
                input.signal.throwIfAborted();
            } catch (error) {
                if (error instanceof ConnectedServiceQuotaFetchError) throw new ConnectedServiceQuotaFetchError(error.message, {
                    status: error.status, retryAfterMs: error.retryAfterMs, resetAtMs: error.resetAtMs,
                    providerCode: error.providerCode, quotaFetchErrorCode: error.quotaFetchErrorCode,
                    recoveryCreditConsumeOutcomeUnknown: false,
                });
                throw new ConnectedServiceQuotaFetchError('Claude reset preflight failed.', {
                    quotaFetchErrorCode: 'malformed', recoveryCreditConsumeOutcomeUnknown: false,
                });
            }
            let response: ClaudeRuntimeFetchResponse;
            try {
                response = await params.runtimeFetch({ url: new URL(`/api/organizations/${encodeURIComponent(organizationId)}/reset_rate_limits`, usageUrl).toString(),
                    method: 'POST', headers: headers(input.accessToken), signal: input.signal,
                    body: selected.providerResetType === 'cedar_ember'
                        ? { program: 'cedar_ember', grant_id: selected.id, request_id: claudeResetRequestId(input.idempotencyKey) }
                        : { program: 'juniper_tide' } });
            } catch {
                throw new ConnectedServiceQuotaFetchError('Claude reset outcome is unknown after a transport failure.', {
                    quotaFetchErrorCode: 'network', recoveryCreditConsumeOutcomeUnknown: true,
                });
            }
            if (!response.ok) {
                const failure = createClaudeSubscriptionQuotaFetchError({ status: response.status, statusText: response.statusText,
                    headers: response.headers, body: await response.text().catch(() => ''), nowMs: input.now });
                throw new ConnectedServiceQuotaFetchError('Claude reset request failed.', { status: failure.status,
                    retryAfterMs: failure.retryAfterMs, resetAtMs: failure.resetAtMs, quotaFetchErrorCode: failure.quotaFetchErrorCode,
                    recoveryCreditConsumeOutcomeUnknown: response.status !== 401 && response.status !== 403 && response.status !== 429 });
            }
            let result: unknown;
            try { result = await response.json(); } catch { result = null; }
            if (isRecord(result) && (result.reason === undefined || result.reason === null || typeof result.reason === 'string')
                && (result.cleared === undefined || (Array.isArray(result.cleared) && result.cleared.every(id => typeof id === 'string')))) {
                if (result.result === 'reset') return 'consumed';
                if (result.result === 'already_used') return 'already_consumed';
                if (result.result === 'not_limited') return 'nothing_to_reset';
                if (['ineligible', 'unavailable', 'cooldown'].includes(String(result.result))) return 'not_available';
            }
            throw new ConnectedServiceQuotaFetchError('Claude reset returned an unknown outcome.', {
                quotaFetchErrorCode: 'malformed', recoveryCreditConsumeOutcomeUnknown: true,
            });
        },
    };
}
