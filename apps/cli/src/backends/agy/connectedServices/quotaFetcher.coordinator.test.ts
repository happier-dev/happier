import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGY_OAUTH_CLIENT_ID } from '@happier-dev/agents';
import { buildConnectedServiceCredentialRecord, ConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol';

import { invalidateConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore } from '@/daemon/connectedServices/accountGroups/quotas/ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore';
import { createProviderAccountUsageStore } from '@/daemon/connectedServices/accountUsage/store';
import { ConnectedServiceQuotasCoordinator } from '@/daemon/connectedServices/quotas/ConnectedServiceQuotasCoordinator';
import type { ConnectedServiceQuotaFetcher } from '@/daemon/connectedServices/quotas/types';
import { createAgyQuotaFetcher } from './quotaFetcher';

function fixture(quotaFetcher = createAgyQuotaFetcher({ staleAfterMs: 300_000 })) {
  const now = Date.now();
  const record = buildConnectedServiceCredentialRecord({
    now, serviceId: 'antigravity', profileId: 'work', kind: 'oauth', expiresAt: now + 3_600_000,
    oauth: { accessToken: 'test-access', refreshToken: 'test-refresh', idToken: null, tokenType: 'Bearer', scope: null,
      providerAccountId: 'account-a', providerEmail: 'a@example.test',
      raw: { antigravity: { clientId: AGY_OAUTH_CLIENT_ID, authMethod: 'oauth-personal', projectId: 'project-a' } } },
  });
  const store = createProviderAccountUsageStore();
  const runtimeQuotaSnapshots = new ConnectedServiceAuthGroupRuntimeQuotaSnapshotStore();
  const api = {
    getAccountEncryptionMode: async () => 'plain' as const,
    getAccountEncryptionModeUncached: async () => 'plain' as const,
    getConnectedServiceAuthGroup: async () => null,
    getConnectedServiceQuotaSnapshotPlain: async () => null,
    getConnectedServiceCredentialPlain: async () => ({ content: { t: 'plain' as const, v: record } }),
    registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
  };
  const coordinator = new ConnectedServiceQuotasCoordinator({
    // API and HTTP are external boundaries; quota collection, normalization and recording stay real.
    api: api as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'],
    credentials: { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
    quotaFetchers: [quotaFetcher], accountUsageStore: store, runtimeQuotaSnapshots,
    now: () => Date.now(), randomBytes: (length) => new Uint8Array(length), discoveryEnabled: false,
  });
  coordinator.registerSpawnTarget({ pid: 123, connectedServicesBindingsRaw: {
    v: 1, bindingsByServiceId: { antigravity: { source: 'connected', profileId: 'work' } },
  } });
  return { coordinator, store };
}

function installNetwork(stalledRpc?: string) {
  let stalledSignal: AbortSignal | null = null;
  const network = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith(`:${stalledRpc}`)) {
      stalledSignal = init?.signal ?? null;
      return await new Promise<Response>((_resolve, reject) => {
        stalledSignal?.addEventListener('abort', () => reject(stalledSignal?.reason), { once: true });
      });
    }
    return Response.json(url.endsWith(':retrieveUserQuota') ? { buckets: [{ modelId: 'gemini-pro', remainingFraction: .25 }] }
      : url.endsWith(':fetchAvailableModels') ? { models: { 'claude-opus': { quotaInfo: { remainingFraction: .8 } } } }
      : { groups: [{ displayName: 'Gemini Models', buckets: [
        { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: .7 },
      ] }] });
  });
  vi.stubGlobal('fetch', network);
  return { network, signal: () => stalledSignal };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); invalidateConnectedServiceAccountMode(); });

describe('AGY quota under the real coordinator deadline', () => {
  it.each(['fetchAvailableModels', 'retrieveUserQuotaSummary'])('records live quota when optional %s stalls until the shared deadline', async (rpc) => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = fixture();
    const network = installNetwork(rpc);
    try {
      const pending = f.coordinator.tickOnce();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(network.signal()?.aborted).toBe(false);
      expect(f.store.listSnapshots()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(network.signal()?.aborted).toBe(true);
      expect(f.store.listSnapshots()).toHaveLength(1);
      expect(f.store.listSnapshots()[0]?.meters).toEqual(expect.arrayContaining([
        expect.objectContaining({ meterId: 'family:gemini-pro', remainingPct: 25 }),
      ]));
      if (rpc === 'retrieveUserQuotaSummary') expect(f.store.listSnapshots()[0]?.meters).toEqual(expect.arrayContaining([
        expect.objectContaining({ meterId: 'family:claude-opus', remainingPct: 80 }),
      ]));
      expect(network.network.mock.calls.filter(([url]) => url.endsWith(`:${rpc}`))).toHaveLength(1);
    } finally { f.coordinator.dispose(); }
  });

  it('keeps a required quota request timeout unknown instead of fabricating a partial observation', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = fixture(); const network = installNetwork('retrieveUserQuota');
    try {
      const pending = f.coordinator.tickOnce();
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
      expect(network.signal()?.aborted).toBe(true);
      expect(f.store.listSnapshots()).toEqual([]);
      expect(network.network).toHaveBeenCalledTimes(1);
    } finally { f.coordinator.dispose(); }
  });

  it('propagates an optional authentication failure rather than publishing earlier live quota', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = fixture(); const network = installNetwork();
    const respond = network.network.getMockImplementation()!;
    network.network.mockImplementation(async (url, init) => url.endsWith(':fetchAvailableModels')
      ? Response.json({}, { status: 401 }) : respond(url, init));
    try {
      await f.coordinator.tickOnce();
      expect(f.store.listSnapshots()).toEqual([]);
      expect(network.network.mock.calls.some(([url]) => url.endsWith(':retrieveUserQuotaSummary'))).toBe(false);
    } finally { f.coordinator.dispose(); }
  });

  it('records the complete weekly enrichment when optional requests finish normally', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = fixture(); installNetwork();
    try {
      await f.coordinator.tickOnce();
      expect(f.store.listSnapshots()).toHaveLength(1);
      expect(f.store.listSnapshots()[0]?.meters).toEqual(expect.arrayContaining([
        expect.objectContaining({ providerLimitId: 'gemini-weekly', scope: 'weekly', remainingPct: 70 }),
        expect.objectContaining({ meterId: 'family:claude-opus', remainingPct: 80 }),
      ]));
    } finally { f.coordinator.dispose(); }
  });

  it('does not publish an acquired live reading when the containing group probe is cancelled', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    const f = fixture(); const network = installNetwork('fetchAvailableModels');
    try {
      const pending = f.coordinator.probeGroupQuotaSnapshots({
        serviceId: 'antigravity', groupId: 'team', profileIds: ['work'], deadlineAtMs: Date.now() + 100,
      });
      await vi.advanceTimersByTimeAsync(100);
      await expect(pending).resolves.toMatchObject({ status: 'incomplete', reason: 'deadline_exceeded' });
      expect(network.signal()?.aborted).toBe(true);
      expect(f.store.listSnapshots()).toEqual([]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(f.store.listSnapshots()).toEqual([]);
    } finally { f.coordinator.dispose(); }
  });
  it('validates partial publications and fences abort-time, late and earlier-invocation callbacks', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1_000_000);
    let publish: Parameters<ConnectedServiceQuotaFetcher['fetch']>[0]['onPartialSnapshot'];
    const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1, serviceId: 'antigravity', profileId: 'work', fetchedAt: Date.now(), staleAfterMs: 300_000, planLabel: null, accountLabel: null,
      meters: [{ meterId: 'live', label: 'Live quota', unit: 'unknown', used: null, limit: null,
        utilizationPct: 75, remainingPct: 25, resetsAt: null, status: 'ok' }],
    });
    // The registered provider hook is a boundary; this fixture supplies malformed and tardy publications.
    const provider: ConnectedServiceQuotaFetcher = {
      serviceId: 'antigravity', fetch: async ({ signal, onPartialSnapshot }) => {
        if (publish) {
          // A lingering hook from the previous request cannot create this request's partial result.
          publish({ ...snapshot, fetchedAt: Date.now(), meters: [{ ...snapshot.meters[0]!, remainingPct: 0, utilizationPct: 100 }] });
        } else {
          publish = onPartialSnapshot;
          publish?.(snapshot);
          publish?.({ ...snapshot, profileId: 'other' });
          publish?.({ ...snapshot, serviceId: 'openai-codex' });
          // Deliberately invalid provider payload, to prove runtime schema validation at ingress.
          publish?.({ ...snapshot, fetchedAt: Number.NaN });
        }
        return await new Promise<null>((_resolve, reject) => signal.addEventListener('abort', () => {
          publish?.({ ...snapshot, meters: [{ ...snapshot.meters[0]!, remainingPct: 1, utilizationPct: 99 }] });
          reject(signal.reason);
        }, { once: true }));
      },
    };
    const f = fixture(provider);
    try {
      const pending = f.coordinator.tickOnce();
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
      expect(f.store.listSnapshots()).toHaveLength(1);
      expect(f.store.listSnapshots()[0]?.meters[0]?.remainingPct).toBe(25);
      publish?.({ ...snapshot, meters: [{ ...snapshot.meters[0]!, remainingPct: 0, utilizationPct: 100 }] });
      expect(f.store.listSnapshots()[0]?.meters[0]?.remainingPct).toBe(25);
      vi.setSystemTime(1_300_000);
      const next = f.coordinator.tickOnce();
      await vi.advanceTimersByTimeAsync(15_000);
      await next;
      expect(f.store.listSnapshots()).toHaveLength(1);
      expect(f.store.listSnapshots()[0]?.fetchedAtMs).toBe(1_000_000);
      expect(f.store.listSnapshots()[0]?.meters[0]?.remainingPct).toBe(25);
    } finally { f.coordinator.dispose(); }
  });

});
