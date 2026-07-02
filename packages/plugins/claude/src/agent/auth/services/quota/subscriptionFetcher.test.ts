import { describe, expect, it, vi } from 'vitest';

import { ConnectedServiceQuotaSnapshotV1Schema, buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import {
    claudeSubscriptionQuotaFetcherDescriptor,
    createClaudeSubscriptionQuotaFetcher,
} from './subscriptionFetcher.js';

function buildClaudeOAuthRecord(now: number, overrides?: Readonly<{
    scope?: string;
    expiresAt?: number;
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
            record: buildClaudeOAuthRecord(now),
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
            record: buildClaudeOAuthRecord(now),
            now,
            signal: new AbortController().signal,
        });

        const parsed = ConnectedServiceQuotaSnapshotV1Schema.safeParse(snapshot);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
            expect(parsed.data.meters.map((meter) => meter.meterId)).toEqual(expect.arrayContaining([
                'five_hour',
                'seven_day',
                'extra_usage',
            ]));
        }

        const headers = headersFromFetchCall(fetchMock.mock.calls[0] ?? []);
        expect(headers.Authorization).toBe('Bearer at');
        expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
        expect(String(headers['User-Agent'])).toMatch(/^claude-code\//);
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
        })).rejects.toThrow(/reconnect claude/i);
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
        })).rejects.toThrow(/usage fetch failed \(401\)/i);

        const tokenRefreshCalls = fetchMock.mock.calls.filter((call) => String(call[0] ?? '').includes('/v1/oauth/token'));
        expect(tokenRefreshCalls).toHaveLength(0);
    });

    it('does not include raw provider error bodies in thrown quota fetch errors', async () => {
        const now = 1_000_000;
        const fetchMock = vi.fn(async () => ({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            headers: new Headers(),
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
        })).rejects.toThrow(/^Anthropic usage fetch failed \(429\): Too Many Requests$/);
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
        })).rejects.toThrow(/reconnect claude/i);
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
});
