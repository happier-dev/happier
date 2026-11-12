/**
 * Kill-switch env: HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT=1
 *
 * When set, the factory must produce a fetcher that skips the private endpoint
 * and returns a quota_unknown snapshot (X7 pattern) — falling back to stale-but-
 * usable via X8 if there is previous data, otherwise quota_unknown.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import { buildConnectedServiceCredentialRecord } from '@happier-dev/protocol';

import { createConnectedServiceQuotaFetchers } from './createConnectedServiceQuotaFetchers';

afterEach(() => {
  vi.restoreAllMocks();
});

function buildCodexRecord(now: number) {
  return buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'openai-codex',
    profileId: 'work',
    kind: 'oauth',
    expiresAt: now + 60_000,
    oauth: {
      accessToken: 'tok',
      refreshToken: 'rt',
      idToken: null,
      scope: null,
      tokenType: null,
      providerAccountId: null,
      providerEmail: null,
    },
  });
}

function buildClaudeRecord(now: number) {
  return buildConnectedServiceCredentialRecord({
    now,
    serviceId: 'claude-subscription',
    profileId: 'work',
    kind: 'oauth',
    expiresAt: now + 60_000,
    oauth: {
      accessToken: 'claude-at',
      refreshToken: 'claude-rt',
      idToken: null,
      scope: 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload',
      tokenType: null,
      providerAccountId: null,
      providerEmail: 'user@example.com',
    },
  });
}

describe('createConnectedServiceQuotaFetchers — kill-switch env', () => {
  it('skips the Codex private endpoint and returns quota_unknown when kill-switch env is set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const fetchers = createConnectedServiceQuotaFetchers({
      HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT: '1',
    });
    const codexFetcher = fetchers.find((f) => f.serviceId === 'openai-codex');
    expect(codexFetcher).toBeTruthy();

    const now = 1_000_000;
    const snapshot = await codexFetcher!.fetch({
      record: buildCodexRecord(now),
      now,
      signal: new AbortController().signal,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.meters.every((m) => m.status === 'unavailable')).toBe(true);
    expect(snapshot?.meters.every((m) => m.details?.code === 'quota_unknown')).toBe(true);
  });

  it('uses the private Codex endpoint by default when kill-switch env is absent', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ rate_limit: { primary_window: { used_percent: 30 } } }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const fetchers = createConnectedServiceQuotaFetchers({});
    const codexFetcher = fetchers.find((f) => f.serviceId === 'openai-codex');
    const now = 1_000_000;
    await codexFetcher!.fetch({
      record: buildCodexRecord(now),
      now,
      signal: new AbortController().signal,
    });

    expect(fetchMock).toHaveBeenCalledWith('https://chatgpt.com/backend-api/wham/usage', expect.anything());
  });

  it('per-call usageUrl override takes precedence over the kill-switch env', async () => {
    // The per-call usageUrl is configured at factory time via env
    // HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_USAGE_URL — this is the documented escape hatch.
    // Even with kill-switch set, a custom usageUrl should be honoured.
    const customUrl = 'https://corp-proxy.example.com/codex-usage';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ rate_limit: { primary_window: { used_percent: 10 } } }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const fetchers = createConnectedServiceQuotaFetchers({
      HAPPIER_CONNECTED_SERVICES_DISABLE_CODEX_QUOTA_ENDPOINT: '1',
      HAPPIER_CONNECTED_SERVICES_OPENAI_CODEX_USAGE_URL: customUrl,
    });
    const codexFetcher = fetchers.find((f) => f.serviceId === 'openai-codex');
    const now = 1_000_000;
    await codexFetcher!.fetch({
      record: buildCodexRecord(now),
      now,
      signal: new AbortController().signal,
    });

    // The usageUrl override takes precedence — the custom URL is called
    expect(fetchMock).toHaveBeenCalledWith(customUrl, expect.anything());
  });

  it('skips the Claude subscription private endpoint and returns quota_unknown when kill-switch env is set', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const fetchers = createConnectedServiceQuotaFetchers({
      HAPPIER_CONNECTED_SERVICES_DISABLE_CLAUDE_SUBSCRIPTION_QUOTA_ENDPOINT: '1',
    });
    const claudeFetcher = fetchers.find((f) => f.serviceId === 'claude-subscription');
    expect(claudeFetcher).toBeTruthy();

    const now = 1_000_000;
    const snapshot = await claudeFetcher!.fetch({
      record: buildClaudeRecord(now),
      now,
      signal: new AbortController().signal,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.meters.every((m) => m.status === 'unavailable')).toBe(true);
    expect(snapshot?.meters.every((m) => m.details?.code === 'quota_unknown')).toBe(true);
  });

  it('uses the private Claude subscription endpoint by default when kill-switch env is absent', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ five_hour: { utilization: 30 } }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const fetchers = createConnectedServiceQuotaFetchers({});
    const claudeFetcher = fetchers.find((f) => f.serviceId === 'claude-subscription');
    const now = 1_000_000;
    await claudeFetcher!.fetch({
      record: buildClaudeRecord(now),
      now,
      signal: new AbortController().signal,
    });

    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/api/oauth/usage?cedar_ember=1&at_wall=1', expect.anything());
  });

  it('Claude subscription usageUrl override takes precedence over the kill-switch env', async () => {
    const customUrl = 'https://corp-proxy.example.com/claude-usage';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ five_hour: { utilization: 10 } }),
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const fetchers = createConnectedServiceQuotaFetchers({
      HAPPIER_CONNECTED_SERVICES_DISABLE_CLAUDE_SUBSCRIPTION_QUOTA_ENDPOINT: '1',
      HAPPIER_CONNECTED_SERVICES_CLAUDE_SUBSCRIPTION_USAGE_URL: customUrl,
    });
    const claudeFetcher = fetchers.find((f) => f.serviceId === 'claude-subscription');
    const now = 1_000_000;
    await claudeFetcher!.fetch({
      record: buildClaudeRecord(now),
      now,
      signal: new AbortController().signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(`${customUrl}?cedar_ember=1&at_wall=1`, expect.anything());
  });
});
