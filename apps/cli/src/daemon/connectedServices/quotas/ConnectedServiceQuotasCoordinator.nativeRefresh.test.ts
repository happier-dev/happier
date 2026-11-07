import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sealProviderAccountUsageSnapshot, openSealedProviderAccountUsageSnapshot, type SealedProviderAccountUsageSnapshotV1, type ProviderAccountUsageSnapshotV1 } from '@happier-dev/protocol';

import { createOpenAiCodexQuotaFetcher } from '@/backends/codex/connectedServices/quotaFetcher';
import { createClaudeSubscriptionQuotaFetcher } from '@/backends/claude/connectedServices/quotaFetcher';
import { createProviderAccountUsageStore } from '../accountUsage/store';
import { createProviderAccountUsagePersistenceScheduler } from '../accountUsage/persistence';
import { buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation } from '../accountUsage/fromConnectedServiceQuotaObservation';
import { buildNativeProviderAccountUsageSourceProfileId } from '../accountUsage/nativeSourceIdentity';
import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';

describe('native account usage refresh requests', () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it.each([
    ['plain', true], ['e2ee', true], ['plain', false], ['e2ee', false],
  ] as const)('queries the native Codex login and publishes its new figures (%s, cached=%s)', async (mode, cached) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-native-usage-'));
    directories.push(home);
    await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: {
      id_token: 'fixture-id', access_token: 'fixture-access', refresh_token: 'fixture-refresh', account_id: 'acct-native',
    } }));
    let now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const credentials = { token: 'test', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) } };
    const previous = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({ snapshot: {
      v: 1, serviceId: 'openai-codex', providerId: 'codex', activeAccountId: 'acct-native',
      profileId: buildNativeProviderAccountUsageSourceProfileId({ kind: 'providerSubject', providerId: 'codex', material: 'acct-native' }),
      fetchedAt: now - 10_000, staleAfterMs: 300_000, planLabel: null, accountLabel: null, source: 'runtime_event',
      meters: [{ meterId: 'session', label: 'Session', used: null, limit: null, unit: 'unknown', utilizationPct: 100, resetsAt: null, status: 'ok', details: {} }],
    } });
    const store = createProviderAccountUsageStore();
    if (cached) store.recordSnapshot(previous);
    let published: ProviderAccountUsageSnapshotV1 | undefined;
    let pendingAt = now;
    const network = vi.fn(async () => new Response(JSON.stringify({ rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: Math.trunc(now / 1000) + 1000 },
    } }), { status: 200 }));
    vi.stubGlobal('fetch', network);
    const api = {
      getAccountEncryptionMode: async () => mode,
      listProviderAccountUsageRefreshRequests: async () => pendingAt ? [previous.recordId] : [],
      getConnectedServiceQuotaSnapshotSealed: async () => null,
      getConnectedServiceCredentialSealed: async () => null,
      getProviderAccountUsageSnapshotPlain: async () => ({ content: { t: 'plain' as const, v: previous }, metadata: { fetchedAt: previous.fetchedAtMs, refreshRequestedAt: pendingAt, staleAfterMs: 300_000, status: 'ok' as const } }),
      getProviderAccountUsageSnapshotSealed: async () => ({ sealed: sealProviderAccountUsageSnapshot({ snapshot: previous, material: { type: 'legacy', secret: credentials.encryption.secret }, randomBytes }), metadata: { fetchedAt: previous.fetchedAtMs, refreshRequestedAt: pendingAt, staleAfterMs: 300_000, status: 'ok' as const } }),
      registerProviderAccountUsageSnapshotPlain: async (input: { content: { v: ProviderAccountUsageSnapshotV1 } }) => { published = input.content.v; pendingAt = 0; },
      registerProviderAccountUsageSnapshotSealed: async (input: { sealed: SealedProviderAccountUsageSnapshotV1 }) => {
        published = openSealedProviderAccountUsageSnapshot({ sealed: input.sealed, material: { type: 'legacy', secret: credentials.encryption.secret } }) ?? undefined;
        pendingAt = 0;
      },
    };
    const persistence = createProviderAccountUsagePersistenceScheduler({ api, credentials, randomBytes, now: () => now });
    const fetcher = createOpenAiCodexQuotaFetcher({ usageUrl: 'https://usage.test/codex', env: { CODEX_HOME: home } });
    const coordinator = new ConnectedServiceQuotasCoordinator({
      api, credentials, accountUsageStore: store, accountUsagePersistence: persistence,
      quotaFetchers: [fetcher],
      now: () => now, randomBytes,
    });
    try {
      await coordinator.tickOnce();
      await persistence.flush(1000);
      expect(published?.recordId).toBe(previous.recordId);
      expect(published?.meters[0]?.utilizationPct).toBe(25);
      expect(published?.fetchedAtMs).toBe(now);
      const queries = network.mock.calls.length;
      now += 1000;
      vi.setSystemTime(now);
      await coordinator.tickOnce();
      expect(network.mock.calls.length).toBe(queries);

      // A fresh read with unchanged percentages still acknowledges a new manual request.
      pendingAt = now;
      await coordinator.tickOnce();
      await persistence.flush(1000);
      expect(published?.fetchedAtMs).toBe(now);
      expect(pendingAt).toBe(0);
      const repeatedQueries = network.mock.calls.length;

      // A different currently signed-in account must not overwrite the requested account.
      await writeFile(join(home, 'auth.json'), JSON.stringify({ tokens: {
        id_token: 'other-id', access_token: 'other-access', refresh_token: 'other-refresh', account_id: 'other-account',
      } }));
      pendingAt = now;
      await coordinator.tickOnce();
      expect(network.mock.calls.length).toBe(repeatedQueries);
      expect(store.resolveRecordId(previous.recordId)?.meters[0]?.utilizationPct).toBe(25);
    } finally {
      coordinator.dispose();
      persistence.dispose();
    }
  });

  it.each(['local', 'organization', 'disabled'] as const)('refreshes native Claude %s evidence with endpoint and identity policy', async (subject) => {
    const home = await mkdtemp(join(tmpdir(), 'happier-claude-usage-'));
    directories.push(home);
    let now = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const scope = 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload';
    await writeFile(join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: {
      accessToken: 'claude-access', refreshToken: 'claude-refresh', expiresAt: now + 60_000, scopes: scope.split(' '),
    } }));
    const profileId = buildNativeProviderAccountUsageSourceProfileId({ kind: 'localCredential', providerId: 'claude', material: home });
    const previous = buildProviderAccountUsageSnapshotFromConnectedServiceQuotaObservation({ snapshot: {
      v: 1, providerId: 'claude', serviceId: 'claude-subscription', profileId,
      ...(subject === 'organization' ? { activeAccountId: 'claude-user', providerOrganizationId: 'claude-org' } : {}),
      fetchedAt: now - 10_000, staleAfterMs: 300_000, planLabel: null, accountLabel: null, source: 'runtime_event',
      meters: [{ meterId: 'five_hour', label: '5 hour', used: null, limit: null, unit: 'unknown', utilizationPct: 100, resetsAt: null, status: 'ok', details: {} }],
    } });
    let organization = 'claude-org';
    const reads: string[] = [];
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      reads.push(String(url));
      return Response.json(String(url).endsWith('/profile')
        ? { account: { uuid: 'claude-user' }, organization: { uuid: organization } }
        : { five_hour: { utilization: 60 }, seven_day: { utilization: 40 } });
    });
    const store = createProviderAccountUsageStore();
    let published: ProviderAccountUsageSnapshotV1 | undefined;
    let pending = true;
    const credentials = { token: 'test', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(9) } };
    const api = {
      getAccountEncryptionMode: async () => 'plain' as const,
      getConnectedServiceQuotaSnapshotSealed: async () => null,
      getConnectedServiceCredentialSealed: async () => null,
      listProviderAccountUsageRefreshRequests: async () => pending ? [previous.recordId] : [],
      getProviderAccountUsageSnapshotPlain: async () => ({ content: { t: 'plain' as const, v: previous },
        metadata: { fetchedAt: previous.fetchedAtMs, refreshRequestedAt: now, staleAfterMs: 300_000, status: 'ok' as const } }),
      registerProviderAccountUsageSnapshotPlain: async (input: { content: { v: ProviderAccountUsageSnapshotV1 } }) => { published = input.content.v; pending = false; },
    };
    const persistence = createProviderAccountUsagePersistenceScheduler({ api, credentials, now: () => now });
    const coordinator = new ConnectedServiceQuotasCoordinator({ api, credentials, accountUsageStore: store, accountUsagePersistence: persistence,
      quotaFetchers: [createClaudeSubscriptionQuotaFetcher({ usageUrl: subject === 'disabled' ? undefined : 'https://usage.test/claude',
        disablePrivateEndpoint: subject === 'disabled', env: { CLAUDE_CONFIG_DIR: home } })],
      now: () => now, randomBytes });
    try {
      await coordinator.tickOnce();
      await persistence.flush(1000);
      if (subject === 'disabled') {
        expect(published).toBeUndefined();
        expect(reads).toEqual([]);
        return;
      }
      expect(published).toMatchObject({ recordId: previous.recordId, fetchedAtMs: now });
      expect(published?.meters).toEqual(expect.arrayContaining([
        expect.objectContaining({ meterId: 'five_hour', utilizationPct: 60 }),
        expect.objectContaining({ meterId: 'seven_day', utilizationPct: 40 }),
      ]));
      if (subject === 'organization') {
        organization = 'other-org';
        now += 1000;
        vi.setSystemTime(now);
        pending = true;
        const usageReads = reads.filter((url) => !url.endsWith('/profile')).length;
        await coordinator.tickOnce();
        expect(reads.filter((url) => !url.endsWith('/profile'))).toHaveLength(usageReads);
        expect(published?.fetchedAtMs).toBe(now - 1000);
      }
    } finally { coordinator.dispose(); persistence.dispose(); }
  });
});
