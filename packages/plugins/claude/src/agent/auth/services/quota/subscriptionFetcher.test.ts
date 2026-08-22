import { describe, expect, it, vi } from 'vitest';

import {
    QuotaFetchError as ConnectedServiceQuotaFetchError,
} from '@happier-dev/plugin-sdk/connected-accounts';
import {
    buildConnectedServiceCredentialRecord,
} from '@happier-dev/protocol';

import {
    claudeSubscriptionQuotaFetcherDescriptor,
    createClaudeSubscriptionQuotaFetcher,
} from './subscriptionFetcher.js';

function buildClaudeOAuthRecord(now: number, overrides?: Readonly<{
    scope?: string;
    expiresAt?: number;
    raw?: Readonly<{
        claudeAiOauth?: Readonly<{
            subscriptionType?: string;
            rateLimitTier?: string;
        }>;
    }>;
}>) {
    return buildConnectedServiceCredentialRecord({
        now,
        serviceId: 'claude-subscription',
        profileId: 'work',
        kind: 'oauth',
        expiresAt: overrides?.expiresAt ?? now + 60_000,
        oauth: {
            accessToken: 'at',
            refreshToken: 'rt',
            idToken: null,
            scope: overrides?.scope ?? 'user:inference user:profile user:sessions:claude_code',
            tokenType: null,
            providerAccountId: null,
            providerEmail: 'user@example.com',
            raw: overrides?.raw ?? null,
        },
    });
}

function headersFromFetchCall(call: ReadonlyArray<unknown>): Record<string, unknown> {
    const init = call[1];
    if (!init || typeof init !== 'object' || !('headers' in init)) return {};
    const headers = (init as { headers?: unknown }).headers;
    return headers && typeof headers === 'object' && !Array.isArray(headers)
        ? headers as Record<string, unknown>
        : {};
}

describe('createClaudeSubscriptionQuotaFetcher', () => {
    it('uses the Claude-owned private Anthropic OAuth usage endpoint by default', async () => {
        const now = 1_000_000;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => ({
                five_hour: { utilization: 18, resets_at: '2026-02-16T00:00:00Z' },
            }),
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
        } as Response));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = createClaudeSubscriptionQuotaFetcher({ staleAfterMs: 300_000 });

        const snapshot = await fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now, {
                raw: {
                    claudeAiOauth: {
                        subscriptionType: 'max',
                        rateLimitTier: 'max_20x',
                    },
                },
            }),
            now,
            signal: new AbortController().signal,
        });

        expect(snapshot?.meters.some((meter) => meter.meterId === 'five_hour')).toBe(true);
        expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/api/oauth/usage');
    });

    it('allows the Claude-owned private Anthropic OAuth usage endpoint when configured', async () => {
        const now = 1_000_000;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => ({
                five_hour: { utilization: 18, resets_at: '2026-02-16T00:00:00Z' },
                seven_day: { utilization: 26, resets_at: '2026-02-23T00:00:00Z' },
            }),
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
        } as Response));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = createClaudeSubscriptionQuotaFetcher({
            usageUrl: 'https://api.anthropic.com/api/oauth/usage',
            staleAfterMs: 300_000,
        });

        const snapshot = await fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now),
            now,
            signal: new AbortController().signal,
        });

        expect(snapshot?.meters.some((meter) => meter.meterId === 'five_hour')).toBe(true);
        expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/api/oauth/usage');
    });

    it('fetches and parses Claude subscription OAuth usage into a quota snapshot', async () => {
        const now = 1_000_000;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => ({
                five_hour: { utilization: 10, resets_at: '2026-02-16T00:00:00Z' },
                seven_day: { utilization: 25, resets_at: '2026-02-23T00:00:00Z' },
                extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 20, utilization: 20 },
            }),
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
        } as Response));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = createClaudeSubscriptionQuotaFetcher({
            usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
            staleAfterMs: 300_000,
        });

        expect(fetcher.serviceId).toBe('claude-subscription');
        const snapshot = await fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now, {
                raw: {
                    claudeAiOauth: {
                        subscriptionType: 'max',
                        rateLimitTier: 'max_20x',
                    },
                },
            }),
            now,
            signal: new AbortController().signal,
        });

        expect(snapshot).toMatchObject({
            providerId: 'claude',
            recordKey: {
                providerId: 'claude',
                subjectKind: 'unknown',
                quotaScope: 'account',
            },
            accountSubject: { kind: 'provisionalLocalSubject' },
            source: 'providerHttp',
            planLabel: 'max',
            meters: expect.arrayContaining([
                expect.objectContaining({ meterId: 'five_hour' }),
                expect.objectContaining({ meterId: 'seven_day' }),
                expect.objectContaining({ meterId: 'extra_usage' }),
            ]),
        });
        expect(snapshot).not.toHaveProperty('recordId');
        expect(snapshot).not.toHaveProperty('serviceId');
        expect(snapshot).not.toHaveProperty('profileId');

        const headers = headersFromFetchCall(fetchMock.mock.calls[0] ?? []);
        expect(headers.Authorization).toBe('Bearer at');
        expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
        expect(String(headers['User-Agent'])).toMatch(/^claude-code\//);
    });

    it('preserves new Anthropic usage windows instead of dropping unknown meter keys', async () => {
        const now = 1_000_000;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => ({
                five_hour: { utilization: 10, resets_at: '2026-02-16T00:00:00Z' },
                seven_day: { utilization: 25, resets_at: '2026-02-23T00:00:00Z' },
                seven_day_fable: { utilization: 50, resets_at: '2026-02-24T00:00:00Z' },
                ignored_metadata: { name: 'not a quota window' },
            }),
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
        } as Response));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = createClaudeSubscriptionQuotaFetcher({
            usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
            staleAfterMs: 300_000,
        });

        const snapshot = await fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now),
            now,
            signal: new AbortController().signal,
        });

        const fable = snapshot?.meters.find((meter) => meter.meterId === 'seven_day_fable');
        expect(fable).toMatchObject({
            label: 'Weekly (Fable)',
            utilizationPct: 50,
            resetsAt: Date.parse('2026-02-24T00:00:00Z'),
            status: 'ok',
        });
        expect(snapshot?.meters.some((meter) => meter.meterId === 'ignored_metadata')).toBe(false);
    });

    it('preserves model-specific Anthropic usage windows from nested usage collections', async () => {
        const now = 1_000_000;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => ({
                five_hour: { utilization: 10, resets_at: '2026-02-16T00:00:00Z' },
                seven_day: { utilization: 25, resets_at: '2026-02-23T00:00:00Z' },
                usage_windows: [
                    {
                        window: 'seven_day',
                        model: 'fable',
                        utilization_pct: 61,
                        reset_at: '2026-02-24T00:00:00Z',
                    },
                ],
                rate_limits: {
                    sonnetFiveHour: {
                        rate_limit_type: 'sonnet',
                        window: 'five_hour',
                        remaining_pct: 7,
                        reset_at_ms: Date.parse('2026-02-16T01:00:00Z'),
                    },
                },
                ignored_metadata: {
                    usage_windows: 'not-a-collection',
                },
            }),
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
        } as Response));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = createClaudeSubscriptionQuotaFetcher({
            usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
            staleAfterMs: 300_000,
        });

        const snapshot = await fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now),
            now,
            signal: new AbortController().signal,
        });

        expect(snapshot?.meters.find((meter) => meter.meterId === 'seven_day_fable')).toMatchObject({
            label: 'Weekly (Fable)',
            utilizationPct: 61,
            resetsAt: Date.parse('2026-02-24T00:00:00Z'),
            status: 'ok',
        });
        expect(snapshot?.meters.find((meter) => meter.meterId === 'five_hour_sonnet')).toMatchObject({
            label: '5-hour (Sonnet)',
            utilizationPct: 93,
            resetsAt: Date.parse('2026-02-16T01:00:00Z'),
            status: 'ok',
        });
        expect(snapshot?.meters.some((meter) => meter.meterId === 'sonnetFiveHour')).toBe(false);
    });

    it('preserves scoped model limits from the current Claude usage endpoint contract', async () => {
        const now = 1_000_000;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => ({
                five_hour: {
                    utilization: 63,
                    resets_at: '2026-07-02T13:59:59.747852+00:00',
                },
                seven_day: {
                    utilization: 12,
                    resets_at: '2026-07-07T19:59:59.747880+00:00',
                },
                limits: [
                    {
                        kind: 'session',
                        group: 'session',
                        percent: 63,
                        resets_at: '2026-07-02T13:59:59.747852+00:00',
                        scope: null,
                    },
                    {
                        kind: 'weekly_all',
                        group: 'weekly',
                        percent: 12,
                        resets_at: '2026-07-07T19:59:59.747880+00:00',
                        scope: null,
                    },
                    {
                        kind: 'weekly_scoped',
                        group: 'weekly',
                        percent: 22,
                        resets_at: '2026-07-07T19:59:59.748308+00:00',
                        scope: {
                            model: {
                                id: null,
                                display_name: 'Fable',
                            },
                            surface: null,
                        },
                    },
                ],
            }),
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
        } as Response));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = createClaudeSubscriptionQuotaFetcher({
            usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
            staleAfterMs: 300_000,
        });

        const snapshot = await fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now),
            now,
            signal: new AbortController().signal,
        });

        expect(snapshot?.meters.find((meter) => meter.meterId === 'seven_day_fable')).toMatchObject({
            label: 'Weekly (Fable)',
            utilizationPct: 22,
            resetsAt: Date.parse('2026-07-07T19:59:59.748308+00:00'),
            status: 'ok',
        });
        expect(snapshot?.meters.find((meter) => meter.meterId === 'five_hour')).toMatchObject({
            utilizationPct: 63,
        });
        expect(snapshot?.meters.find((meter) => meter.meterId === 'seven_day')).toMatchObject({
            utilizationPct: 12,
        });
        expect(snapshot?.meters.some((meter) => meter.meterId === 'weekly_scoped')).toBe(false);
    });

    it('canonicalizes common Anthropic usage-window aliases before labeling model limits', async () => {
        const now = 1_000_000;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => ({
                weekly_opus: {
                    utilization: 52,
                    resets_at: '2026-02-25T00:00:00Z',
                },
                usage_windows: [
                    {
                        window: 'weekly',
                        model: 'fable',
                        utilization: 44,
                        resets_at: '2026-02-24T00:00:00Z',
                    },
                    {
                        window: '5h',
                        model_family: 'sonnet',
                        remaining_pct: 12,
                        reset_at_ms: Date.parse('2026-02-16T01:00:00Z'),
                    },
                ],
            }),
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
        } as Response));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = createClaudeSubscriptionQuotaFetcher({
            usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
            staleAfterMs: 300_000,
        });

        const snapshot = await fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now),
            now,
            signal: new AbortController().signal,
        });

        expect(snapshot?.meters.find((meter) => meter.meterId === 'seven_day_fable')).toMatchObject({
            label: 'Weekly (Fable)',
            utilizationPct: 44,
            status: 'ok',
        });
        expect(snapshot?.meters.find((meter) => meter.meterId === 'five_hour_sonnet')).toMatchObject({
            label: '5-hour (Sonnet)',
            utilizationPct: 88,
            status: 'ok',
        });
        expect(snapshot?.meters.find((meter) => meter.meterId === 'seven_day_opus')).toMatchObject({
            label: 'Weekly (Opus)',
            utilizationPct: 52,
            status: 'ok',
        });
    });

    it('derives the plan label from legacy Claude OAuth raw metadata', async () => {
        const now = 1_000_000;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => ({
                five_hour: { utilization: 10, resets_at: '2026-02-16T00:00:00Z' },
            }),
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
        } as Response));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const record = buildClaudeOAuthRecord(now);
        if (record.kind !== 'oauth') throw new Error('fixture');
        const legacyRawRecord = {
            ...record,
            oauth: {
                ...record.oauth,
                raw: {
                    'claude.ai_oauth': {
                        subscriptionType: 'team',
                        rateLimitTier: 'team_5x',
                    },
                },
            },
        };

        const fetcher = createClaudeSubscriptionQuotaFetcher({
            usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
            staleAfterMs: 300_000,
        });

        const snapshot = await fetcher.loadQuota({
            record: legacyRawRecord,
            now,
            signal: new AbortController().signal,
        });

        expect(snapshot?.planLabel).toBe('team');
    });

    it('owns Claude subscription usage URL env mapping in the plugin descriptor', async () => {
        const now = 1_000_000;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => ({
                five_hour: { utilization: 10, resets_at: '2026-02-16T00:00:00Z' },
                seven_day: { utilization: 25, resets_at: '2026-02-23T00:00:00Z' },
            }),
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
        } as Response));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = claudeSubscriptionQuotaFetcherDescriptor.createFetcher({
            env: {
                HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_USAGE_URL: 'https://quota.happier.dev/anthropic/oauth/usage',
            },
            staleAfterMs: 123_000,
            userAgent: 'happier-test',
        });

        const snapshot = await fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now),
            now,
            signal: new AbortController().signal,
        });

        expect(snapshot?.staleAfterMs).toBe(123_000);
        expect(fetchMock.mock.calls[0]?.[0]).toBe('https://quota.happier.dev/anthropic/oauth/usage');
        expect(headersFromFetchCall(fetchMock.mock.calls[0] ?? [])['User-Agent']).not.toBe('happier-test');
    });

    it('uses a provider-owned Claude Code user agent from the descriptor environment', async () => {
        const now = 1_000_000;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => ({
                five_hour: { utilization: 10, resets_at: '2026-02-16T00:00:00Z' },
            }),
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
        } as Response));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = claudeSubscriptionQuotaFetcherDescriptor.createFetcher({
            env: {
                HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_USAGE_URL: 'https://quota.happier.dev/anthropic/oauth/usage',
                HAPPIER_CONNECTED_SERVICES_CLAUDE_CODE_USER_AGENT: 'claude-code/2.3.4',
            },
            staleAfterMs: 123_000,
            userAgent: 'generic-happier-agent',
        });

        await fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now),
            now,
            signal: new AbortController().signal,
        });

        expect(headersFromFetchCall(fetchMock.mock.calls[0] ?? [])['User-Agent']).toBe('claude-code/2.3.4');
    });

    it('fails closed before quota fetch when OAuth credentials lack Claude Code session scope', async () => {
        const now = 1_000_000;
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = createClaudeSubscriptionQuotaFetcher({
            usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
            staleAfterMs: 300_000,
        });

        await expect(fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now, { scope: 'user:inference user:profile' }),
            now,
            signal: new AbortController().signal,
        })).rejects.toMatchObject({
            quotaFetchErrorCode: 'auth_failure',
            providerCode: 'missing_claude_code_scope',
            status: null,
        });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not directly refresh OAuth tokens from the usage fetcher when usage is unauthorized', async () => {
        const now = 2_000_000;
        const fetchMock = vi.fn(async (input: unknown, init?: unknown) => {
            const url = String(input ?? '');
            if (url.includes('/anthropic/oauth/usage')) {
                return {
                    ok: false,
                    status: 401,
                    statusText: 'Unauthorized',
                    headers: new Headers(),
                    text: async () => 'unauthorized',
                    json: async () => ({}),
                    arrayBuffer: async () => new ArrayBuffer(0),
                } as Response;
            }
            if (url.includes('/v1/oauth/token')) {
                const body = init && typeof init === 'object' && 'body' in init
                    ? String((init as { body?: unknown }).body ?? '')
                    : '';
                expect(body).toContain('test-client-id');
                return {
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: new Headers(),
                    json: async () => ({
                        access_token: 'refreshed-access-token',
                        refresh_token: 'refreshed-refresh-token',
                        expires_in: 3600,
                    }),
                    text: async () => '',
                    arrayBuffer: async () => new ArrayBuffer(0),
                } as Response;
            }
            throw new Error(`Unexpected URL in test: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = createClaudeSubscriptionQuotaFetcher({
            usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
            staleAfterMs: 300_000,
        });
        await expect(fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now, { expiresAt: now - 1 }),
            now,
            signal: new AbortController().signal,
        })).rejects.toMatchObject({
            quotaFetchErrorCode: 'auth_failure',
            status: 401,
        });

        const tokenRefreshCalls = fetchMock.mock.calls.filter((call) => String(call[0] ?? '').includes('/v1/oauth/token'));
        expect(tokenRefreshCalls).toHaveLength(0);
    });

    it('preserves provider retry timing without leaking raw quota fetch error bodies', async () => {
        const now = 1_000_000;
        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            headers: new Headers({ 'retry-after': '90' }),
            body: null,
            json: async () => ({}),
            text: async () => 'raw-provider-body refresh_token=secret',
            arrayBuffer: async () => new ArrayBuffer(0),
        } as Response));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = createClaudeSubscriptionQuotaFetcher({
            usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
        });

        await expect(fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now),
            now,
            signal: new AbortController().signal,
        })).rejects.toMatchObject({
            message: 'Anthropic usage fetch failed (429): Too Many Requests',
            retryAfterMs: 90_000,
        });
        await expect(fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now),
            now,
            signal: new AbortController().signal,
        })).rejects.not.toThrow(/raw-provider-body|refresh_token=secret/);
    });

    it('surfaces a reconnect-required error when the token lacks usage scopes', async () => {
        const now = 3_000_000;
        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            headers: new Headers(),
            text: async () => JSON.stringify({
                error: {
                    type: 'permission_error',
                    message: 'OAuth token does not meet scope requirement user:profile',
                },
            }),
            json: async () => ({}),
            arrayBuffer: async () => new ArrayBuffer(0),
        } as Response));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = createClaudeSubscriptionQuotaFetcher({
            usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
            staleAfterMs: 300_000,
        });

        await expect(fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now),
            now,
            signal: new AbortController().signal,
        })).rejects.toMatchObject({
            quotaFetchErrorCode: 'auth_failure',
            providerCode: 'missing_claude_code_scope',
            status: 403,
        } satisfies Partial<ConnectedServiceQuotaFetchError>);
    });

    it('retries once when usage endpoint returns a transient server error', async () => {
        const now = 4_000_000;
        let usageCalls = 0;
        const fetchMock = vi.fn(async () => {
            usageCalls += 1;
            if (usageCalls === 1) {
                return {
                    ok: false,
                    status: 500,
                    statusText: 'Internal Server Error',
                    headers: new Headers(),
                    text: async () => 'internal error',
                    json: async () => ({}),
                    arrayBuffer: async () => new ArrayBuffer(0),
                } as Response;
            }
            return {
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: new Headers(),
                json: async () => ({
                    five_hour: { utilization: 8, resets_at: '2026-02-16T00:00:00Z' },
                    seven_day: { utilization: 15, resets_at: '2026-02-23T00:00:00Z' },
                }),
                text: async () => '',
                arrayBuffer: async () => new ArrayBuffer(0),
            } as Response;
        });
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = createClaudeSubscriptionQuotaFetcher({
            usageUrl: 'https://quota.happier.dev/anthropic/oauth/usage',
            staleAfterMs: 300_000,
        });
        const snapshot = await fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now),
            now,
            signal: new AbortController().signal,
        });

        expect(snapshot?.meters.length).toBeGreaterThan(0);
        expect(usageCalls).toBe(2);
    });

    it('returns quota_unknown without network IO when the Claude subscription quota endpoint is disabled', async () => {
        const now = 5_000_000;
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = claudeSubscriptionQuotaFetcherDescriptor.createFetcher({
            env: {
                HAPPIER_CONNECTED_SERVICES_DISABLE_CLAUDE_SUBSCRIPTION_QUOTA_ENDPOINT: '1',
            },
            staleAfterMs: 123_000,
            userAgent: 'happier-test',
        });

        const snapshot = await fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now),
            now,
            signal: new AbortController().signal,
        });

        expect(fetchMock).not.toHaveBeenCalled();
        expect(snapshot?.staleAfterMs).toBe(123_000);
        expect(snapshot?.meters.map((meter) => meter.meterId)).toEqual(expect.arrayContaining([
            'five_hour',
            'seven_day',
        ]));
        for (const meter of snapshot?.meters ?? []) {
            expect(meter.status).toBe('unavailable');
            expect(meter.utilizationPct).toBeNull();
            expect(meter.details).toMatchObject({ code: 'quota_unknown' });
        }
    });

    it('lets the explicit Claude subscription usage URL override take precedence over the kill switch', async () => {
        const now = 6_000_000;
        const fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            json: async () => ({
                five_hour: { utilization: 18, resets_at: '2026-02-16T00:00:00Z' },
            }),
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
        } as Response));
        vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

        const fetcher = claudeSubscriptionQuotaFetcherDescriptor.createFetcher({
            env: {
                HAPPIER_CONNECTED_SERVICES_DISABLE_CLAUDE_SUBSCRIPTION_QUOTA_ENDPOINT: '1',
                HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_USAGE_URL: 'https://quota.happier.dev/anthropic/oauth/usage',
            },
            staleAfterMs: 123_000,
            userAgent: 'happier-test',
        });

        const snapshot = await fetcher.loadQuota({
            record: buildClaudeOAuthRecord(now),
            now,
            signal: new AbortController().signal,
        });

        expect(fetchMock.mock.calls[0]?.[0]).toBe('https://quota.happier.dev/anthropic/oauth/usage');
        expect(snapshot?.meters.find((meter) => meter.meterId === 'five_hour')?.utilizationPct).toBe(18);
    });
});
