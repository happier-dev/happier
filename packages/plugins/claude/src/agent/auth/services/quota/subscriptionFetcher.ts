import type {
    ConnectedServiceCredentialRecordV1,
    ConnectedServiceId,
    ConnectedServiceQuotaSnapshotV1,
} from '@happier-dev/protocol';
import type {
    FetchRuntimeRequestV1,
    FetchRuntimeResponseV1,
    FetchRuntimeServiceV1,
} from '@happier-dev/plugin-sdk';

import { classifyClaudeCodeCredentialHealth } from '../native/health.js';
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

function parseIsoDateMs(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

const WINDOW_LABELS: Readonly<Record<string, string>> = Object.freeze({
    five_hour: '5-hour',
    seven_day: 'Weekly',
    seven_day_oauth_apps: 'Weekly (OAuth apps)',
    seven_day_sonnet: 'Weekly (Sonnet)',
    seven_day_opus: 'Weekly (Opus)',
    iguana_necktie: 'Unknown',
});

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
    runtimeFetch?: FetchRuntimeServiceV1;
}>): ClaudeQuotaFetcher {
    const usageUrl = typeof params?.usageUrl === 'string' && params.usageUrl.trim().length > 0
        ? params.usageUrl.trim()
        : CLAUDE_DEFAULT_SUBSCRIPTION_USAGE_URL;
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

    async function throwUsageError(response: FetchRuntimeResponseV1): Promise<never> {
        const body = await response.text().catch(() => '');
        if (response.status === 403) {
            const scopeMatch = body.match(/scope requirement\s+([a-z0-9:_-]+)/i);
            const requiredScope = scopeMatch?.[1] ? String(scopeMatch[1]).trim() : '';
            if (requiredScope) {
                throw new Error(
                    `Claude quota fetch requires OAuth scope '${requiredScope}'. Reconnect Claude in Happier and retry.`,
                );
            }
        }
        throw new Error(`Anthropic usage fetch failed (${response.status}): ${response.statusText || 'HTTP error'}`);
    }

    return {
        serviceId: 'claude-subscription',
        loadQuota: async ({ record, now, signal }) => {
            if (record.kind !== 'oauth') return null;
            if (!usageUrl) return null;
            const credentialHealth = classifyClaudeCodeCredentialHealth(record);
            if (credentialHealth.status !== 'ok') {
                throw new Error('Claude subscription credentials cannot be used by Claude Code. Reconnect Claude in Happier and retry.');
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

            if (!response.ok) await throwUsageError(response);

            const json: unknown = await response.json();
            const data = isRecord(json) ? json : {};

            const meters: ConnectedServiceQuotaSnapshotV1['meters'] = [];
            for (const [key, label] of Object.entries(WINDOW_LABELS)) {
                const window = isRecord(data[key]) ? data[key] : null;
                const utilizationPct = normalizePct(window?.utilization);
                meters.push({
                    meterId: key,
                    label,
                    used: null,
                    limit: null,
                    unit: 'unknown',
                    utilizationPct,
                    resetsAt: parseIsoDateMs(window?.resets_at),
                    status: utilizationPct === null ? 'unavailable' : 'ok',
                    details: {},
                });
            }

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
                planLabel: null,
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

export const claudeSubscriptionQuotaFetcherDescriptor: ClaudeQuotaFetcherDescriptor = {
    id: 'claude-subscription',
    createFetcher: ({ env, staleAfterMs, userAgent }) => createClaudeSubscriptionQuotaFetcher({
        usageUrl: readNonEmptyEnv(env, 'HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_USAGE_URL')
            ?? readNonEmptyEnv(env, 'HAPPIER_CONNECTED_SERVICES_ANTHROPIC_USAGE_URL'),
        staleAfterMs,
        userAgent: resolveClaudeCodeUsageUserAgent({ env, configuredUserAgent: userAgent }),
    }),
};
