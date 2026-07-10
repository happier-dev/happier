import type {
    ConnectedServiceCredentialRecordV1,
    ConnectedServiceId,
    ConnectedServiceQuotaMeterV1,
    ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/plugin-sdk/experimental/cloud/auth';
import { ConnectedServiceQuotaFetchError } from '@happier-dev/plugin-sdk/experimental/cloud/auth';
import type {
    FetchRuntimeRequestV1,
    FetchRuntimeResponseV1,
    FetchRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

import { classifyClaudeCodeCredentialHealth } from '../native/health.js';
import { parseClaudeUsageLimitReset } from '../runtime/reset.js';
import { resolveClaudeCodeUsageUserAgent } from './userAgent.js';

export const CLAUDE_DEFAULT_SUBSCRIPTION_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

const DEFAULT_BETA_HEADER_VALUE = 'oauth-2025-04-20';

type ClaudeQuotaFetcher = Readonly<{
    serviceId: ConnectedServiceId;
    loadQuota: (params: Readonly<{
        record: ConnectedServiceCredentialRecordV1;
        now: number;
        signal: AbortSignal;
    }>) => Promise<ConnectedServiceQuotaSnapshotV1 | null>;
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

function resolveConnectedServiceQuotaAccountLabel(record: ConnectedServiceCredentialRecordV1): string | null {
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

function resolveClaudeSubscriptionPlanLabel(record: ConnectedServiceCredentialRecordV1): string | null {
    if (record.kind !== 'oauth') return null;
    const raw = isRecord(record.oauth.raw) ? record.oauth.raw : null;
    const claudeAiOauth = isRecord(raw?.claudeAiOauth)
        ? raw.claudeAiOauth
        : isRecord(raw?.['claude.ai_oauth'])
            ? raw['claude.ai_oauth']
            : null;
    return normalizeNonEmptyString(claudeAiOauth?.subscriptionType)
        ?? normalizeNonEmptyString(claudeAiOauth?.rateLimitTier);
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

const WINDOW_LABELS: Readonly<Record<string, string>> = Object.freeze({
    five_hour: '5-hour',
    seven_day: 'Weekly',
    seven_day_oauth_apps: 'Weekly (OAuth apps)',
    seven_day_sonnet: 'Weekly (Sonnet)',
    seven_day_opus: 'Weekly (Opus)',
    iguana_necktie: 'Unknown',
});

const WINDOW_LABEL_PREFIXES: ReadonlyArray<Readonly<{
    prefix: string;
    label: string;
}>> = [
    { prefix: 'five_hour_', label: '5-hour' },
    { prefix: 'seven_day_', label: 'Weekly' },
];

const WINDOW_LABEL_TOKEN_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
    api: 'API',
    fable: 'Fable',
    mcp: 'MCP',
    oauth: 'OAuth',
    opus: 'Opus',
    sonnet: 'Sonnet',
});

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

const QUOTA_UNITS = new Set<ConnectedServiceQuotaMeterV1['unit']>([
    'count',
    'tokens',
    'credits',
    'usd',
    'requests',
    'unknown',
]);

function formatWindowLabelSuffix(raw: string): string {
    return raw
        .split('_')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean)
        .map((part) => WINDOW_LABEL_TOKEN_OVERRIDES[part] ?? `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
        .join(' ');
}

function resolveUsageWindowLabel(meterId: string): string {
    const known = WINDOW_LABELS[meterId];
    if (known) return known;
    for (const { prefix, label } of WINDOW_LABEL_PREFIXES) {
        if (meterId.startsWith(prefix)) {
            const suffix = formatWindowLabelSuffix(meterId.slice(prefix.length));
            return suffix ? `${label} (${suffix})` : label;
        }
    }
    return formatWindowLabelSuffix(meterId) || meterId;
}

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

function resolveUsageWindowUnit(window: Record<string, unknown> | null): ConnectedServiceQuotaMeterV1['unit'] {
    const raw = typeof window?.unit === 'string' ? window.unit.trim().toLowerCase() : '';
    return QUOTA_UNITS.has(raw as ConnectedServiceQuotaMeterV1['unit'])
        ? raw as ConnectedServiceQuotaMeterV1['unit']
        : 'unknown';
}

function buildUsageWindowMeter(
    meterId: string,
    window: Record<string, unknown> | null,
): ConnectedServiceQuotaMeterV1 {
    const utilizationPct = resolveUsageWindowUtilizationPct(window);
    const used = window ? readFiniteNumberProperty(window, USAGE_WINDOW_USED_KEYS) : null;
    const limit = window ? readFiniteNumberProperty(window, USAGE_WINDOW_LIMIT_KEYS) : null;
    return {
        meterId,
        label: resolveUsageWindowLabel(meterId),
        used,
        limit,
        unit: resolveUsageWindowUnit(window),
        utilizationPct,
        resetsAt: resolveUsageWindowResetAtMs(window),
        status: utilizationPct === null ? 'unavailable' : 'ok',
        details: {},
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

    for (const meterId of Object.keys(WINDOW_LABELS)) {
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

function buildQuotaUnknownMeter(meterId: string, label: string): ConnectedServiceQuotaMeterV1 {
    return {
        meterId,
        label,
        used: null,
        limit: null,
        unit: 'unknown',
        utilizationPct: null,
        resetsAt: null,
        status: 'unavailable',
        details: { code: 'quota_unknown' },
    };
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

function toRequestBody(value: FetchRuntimeRequestV1['body']): FetchBody | undefined {
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

function defaultRuntimeFetch(): FetchRuntimeServiceV1 {
    return async ({ url, method, headers, body, signal }): Promise<FetchRuntimeResponseV1> => {
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
    runtimeFetch?: FetchRuntimeServiceV1;
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

    async function fetchUsage(input: Readonly<{
        usageUrl: string;
        accessToken: string;
        betaHeaderValue: string;
        userAgent: string;
        signal: AbortSignal;
    }>): Promise<FetchRuntimeResponseV1> {
        return runtimeFetch({
            url: input.usageUrl,
            method: 'GET',
            headers: {
                Authorization: `Bearer ${input.accessToken}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'anthropic-beta': input.betaHeaderValue,
                'User-Agent': input.userAgent,
            },
            signal: input.signal,
        });
    }

    function parseQuotaErrorBodyEvidence(text: string): unknown {
        const trimmed = text.trim();
        if (!trimmed) return null;
        try {
            return JSON.parse(trimmed) as unknown;
        } catch {
            return trimmed;
        }
    }

    async function throwUsageError(response: FetchRuntimeResponseV1, now: number): Promise<never> {
        const body = await response.text().catch(() => '');
        const timing = parseClaudeUsageLimitReset({
            nowMs: now,
            headers: response.headers,
            body: parseQuotaErrorBodyEvidence(body),
        });
        if (response.status === 403) {
            const scopeMatch = body.match(/scope requirement\s+([a-z0-9:_-]+)/i);
            const requiredScope = scopeMatch?.[1] ? String(scopeMatch[1]).trim() : '';
            if (requiredScope) {
                throw new ConnectedServiceQuotaFetchError(
                    `Claude quota fetch requires OAuth scope '${requiredScope}'. Reconnect Claude in Happier and retry.`,
                    {
                        status: 403,
                        quotaFetchErrorCode: 'auth_failure',
                        providerCode: 'missing_claude_code_scope',
                    },
                );
            }
        }
        throw new ConnectedServiceQuotaFetchError(
            `Anthropic usage fetch failed (${response.status}): ${response.statusText || 'HTTP error'}`,
            {
                status: response.status,
                retryAfterMs: timing.retryAfterMs,
                resetAtMs: timing.resetAtMs,
                quotaFetchErrorCode: response.status === 401 || response.status === 403
                    ? 'auth_failure'
                    : 'provider_backoff',
            },
        );
    }

    return {
        serviceId: 'claude-subscription',
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
                return {
                    v: 1,
                    serviceId: record.serviceId,
                    profileId: record.profileId,
                    fetchedAt: now,
                    staleAfterMs,
                    planLabel,
                    accountLabel: resolveConnectedServiceQuotaAccountLabel(record),
                    meters: Object.entries(WINDOW_LABELS).map(([meterId, label]) =>
                        buildQuotaUnknownMeter(meterId, label),
                    ),
                };
            }
            const accessToken = record.oauth.accessToken;

            let response = await fetchUsage({
                usageUrl,
                accessToken,
                betaHeaderValue,
                userAgent,
                signal,
            });

            if (!response.ok && response.status >= 500 && response.status < 600) {
                response = await fetchUsage({
                    usageUrl,
                    accessToken,
                    betaHeaderValue,
                    userAgent,
                    signal,
                });
            }

            if (!response.ok) await throwUsageError(response, now);

            const json: unknown = await response.json();
            const data = isRecord(json) ? json : {};

            const meters: ConnectedServiceQuotaSnapshotV1['meters'] = collectUsageWindowMeterEntries(data)
                .map(({ meterId, window }) => buildUsageWindowMeter(meterId, window));

            const extra = isRecord(data.extra_usage) ? data.extra_usage : null;
            if (extra?.is_enabled) {
                const utilizationPct = normalizePct(extra.utilization);
                meters.push({
                    meterId: 'extra_usage',
                    label: 'Extra usage',
                    used: typeof extra.used_credits === 'number' && Number.isFinite(extra.used_credits) ? extra.used_credits : null,
                    limit: typeof extra.monthly_limit === 'number' && Number.isFinite(extra.monthly_limit) ? extra.monthly_limit : null,
                    unit: 'credits',
                    utilizationPct,
                    resetsAt: null,
                    status: utilizationPct === null ? 'unavailable' : 'ok',
                    details: {},
                });
            }

            return {
                v: 1,
                serviceId: record.serviceId,
                profileId: record.profileId,
                fetchedAt: now,
                staleAfterMs,
                planLabel,
                accountLabel: resolveConnectedServiceQuotaAccountLabel(record),
                meters,
            };
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
