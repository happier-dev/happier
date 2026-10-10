import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConnectedServiceCredentialRecord, projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';
import { AGY_OAUTH_CLIENT_ID } from '@happier-dev/agents';
import { createAgyQuotaFetcher } from '@/backends/agy/connectedServices/quotaFetcher';
import { invalidateConnectedServiceAccountMode } from '@/cloud/connectedServices/resolveConnectedServiceAccountMode';
import { parseConnectedServiceProjectionSnapshot } from '../accountGroups/generation/connectedServiceProjectionSnapshot';
import { createProviderAccountUsageStore } from '../accountUsage/store';
import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';
import { startConnectedServiceQuotasLoop } from './startConnectedServiceQuotasLoop';
import { reconcileConnectedServiceProjectionWithQuotaDiscovery, scheduleConnectedServiceQuotaDiscoveryFromProjection } from './scheduleConnectedServiceQuotaDiscoveryFromProjection';

function fixture(options: { jitter?: boolean; discoveryEnabled?: boolean } = {}) {
  const now = 1_000_000;
  let profiles: Array<{ profileId: string; status: 'connected' }> = [];
  const store = createProviderAccountUsageStore();
  const api = {
    getAccountEncryptionMode: async () => 'plain' as const,
    listConnectedServiceProfiles: vi.fn(async () => ({ profiles })),
    getConnectedServiceQuotaSnapshotPlain: async ({ profileId }: { profileId: string }) => {
      const source = { serviceId: 'antigravity', profileId, bindingKind: 'profile' } as const;
      const existing = store.resolveBySource(source);
      if (!existing) return null;
      const snapshot = projectProviderAccountUsageSnapshotToConnectedServiceQuotaSnapshotV1({ source, snapshot: existing });
      if (!snapshot) return null;
      return { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: snapshot.fetchedAt, staleAfterMs: snapshot.staleAfterMs, status: 'ok' } };
    },
    getConnectedServiceCredentialPlain: async ({ profileId }: { profileId: string }) => ({ content: { t: 'plain', v: buildConnectedServiceCredentialRecord({
      now, serviceId: 'antigravity', profileId, kind: 'oauth', expiresAt: now + 3_600_000,
      oauth: { accessToken: 'test-access', refreshToken: 'test-refresh', idToken: null, tokenType: 'Bearer', scope: null, providerAccountId: `account-${profileId}`, providerEmail: null,
        raw: { antigravity: { clientId: AGY_OAUTH_CLIENT_ID, authMethod: 'oauth-personal', projectId: `project-${profileId}` } } },
    }) } }),
    registerProviderAccountUsageSnapshotPlain: vi.fn(async () => {}),
  };
  const coordinator = new ConnectedServiceQuotasCoordinator({
    // HTTP requests and timers are the boundaries; coordinator, loop and AGY fetcher are real.
    api: api as unknown as ConstructorParameters<typeof ConnectedServiceQuotasCoordinator>[0]['api'],
    credentials: { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
    quotaFetchers: [createAgyQuotaFetcher({ staleAfterMs: 300_000 })], accountUsageStore: store,
    now: () => now, randomBytes: (length) => new Uint8Array(length), discoveryIntervalMs: 60_000, discoveryEnabled: options.discoveryEnabled,
  });
  const network = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.endsWith(':retrieveUserQuota')
    ? { buckets: [{ modelId: 'gemini-model', remainingFraction: .8 }] }
    : url.endsWith(':fetchAvailableModels') ? { models: {} } : { groups: [] }));
  vi.stubGlobal('fetch', network);
  let scheduledTick = () => {};
  const loop = startConnectedServiceQuotasLoop({
    enabled: true, tickMs: 60_000, coordinator, onTickError: (error) => { throw error; },
    ...(options.jitter ? { tickJitterMs: 1_000, setTimeoutFn: (callback: () => void) => { scheduledTick = callback; return 1; }, clearTimeoutFn: () => {} }
      : { setIntervalFn: (callback: () => void) => { scheduledTick = callback; return 1; }, clearIntervalFn: () => {} }),
  });
  const projection = (profileIds: string[]) => {
    profiles = profileIds.map((profileId) => ({ profileId, status: 'connected' }));
    return parseConnectedServiceProjectionSnapshot({
      connectedServicesV2: [{ serviceId: 'antigravity', profiles, groups: [] }], connectedServiceCredentialRevisionsV1: [],
    });
  };
  const project = (profileIds: string[]) => {
    scheduleConnectedServiceQuotaDiscoveryFromProjection({ coordinator, loop, projection: projection(profileIds) });
  };
  return { coordinator, loop, store, api, network, project, projection, scheduledTick: () => scheduledTick(), dispose: async () => { await loop?.stop(); coordinator.dispose(); } };
}

describe('quota discovery from connected-service account projections', () => {
  afterEach(() => { vi.unstubAllGlobals(); invalidateConnectedServiceAccountMode(); });

  it('fetches a new inactive AGY profile immediately before the next discovery poll', async () => {
    const f = fixture();
    try {
      await f.coordinator.tickOnce();
      expect(f.store.listSnapshots()).toEqual([]);
      f.project(['new']);
      await vi.waitFor(() => expect(f.store.listSnapshots()).toHaveLength(1), { timeout: 250 });
      expect(f.store.listSnapshots()[0]?.meters).toEqual(expect.arrayContaining([expect.objectContaining({ modelId: 'gemini-model', remainingPct: 80 })]));
      expect(f.network).toHaveBeenCalledTimes(3);
      f.project(['new']);
      await Promise.resolve();
      expect(f.network).toHaveBeenCalledTimes(3);
    } finally { await f.dispose(); }
  });

  it('fetches a new profile even when existing live runtime auth application rejects', async () => {
    const f = fixture();
    const runtimeFailure = new Error('connected_service_refreshed_auth_application_failed:continuity_unsupported');
    try {
      await f.coordinator.tickOnce();
      await expect(reconcileConnectedServiceProjectionWithQuotaDiscovery({
        coordinator: f.coordinator, loop: f.loop, projection: f.projection(['new']),
        // Live auth application crosses the runtime IPC boundary; emulate its rejection.
        reconcile: async () => { throw runtimeFailure; },
      })).rejects.toBe(runtimeFailure);
      await vi.waitFor(() => expect(f.store.listSnapshots()).toHaveLength(1), { timeout: 250 });
      expect(f.store.listSnapshots()[0]?.meters[0]?.remainingPct).toBe(80);
      expect(f.network).toHaveBeenCalledTimes(3);
    } finally { await f.dispose(); }
  });

  it('starts first quota while an existing runtime auth application is pending', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reconciliation = reconcileConnectedServiceProjectionWithQuotaDiscovery({
      coordinator: f.coordinator, loop: f.loop, projection: f.projection(['new']),
      reconcile: async () => { await gate; return 'applied'; },
    });
    try {
      await vi.waitFor(() => expect(f.store.listSnapshots()).toHaveLength(1), { timeout: 250 });
      release();
      await expect(reconciliation).resolves.toBe('applied');
    } finally { release(); await reconciliation; await f.dispose(); }
  });

  it.each([false, true])('queues one wakeup during in-flight work without overlapping polls (jitter=%s)', async (jitter) => {
    const f = fixture({ jitter });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const respond = f.network.getMockImplementation()!;
    let active = 0;
    let peak = 0;
    let first = true;
    f.network.mockImplementation(async (url, init) => {
      active += 1;
      peak = Math.max(peak, active);
      try { if (first) { first = false; await gate; } return await respond(url, init); }
      finally { active -= 1; }
    });
    try {
      f.project(['one']);
      await vi.waitFor(() => expect(f.network).toHaveBeenCalledTimes(1), { timeout: 250 });
      f.project(['one', 'two']);
      f.project(['one', 'two']);
      await Promise.resolve();
      expect(f.network).toHaveBeenCalledTimes(1);
      release();
      await vi.waitFor(() => expect(f.store.listSnapshots()).toHaveLength(2), { timeout: 250 });
      expect(peak).toBe(1);
      expect(f.network).toHaveBeenCalledTimes(6);
    } finally { release(); await f.dispose(); }
  });

  it('preserves pause and stop ownership for immediate requests', async () => {
    const f = fixture({ jitter: true });
    try {
      f.loop?.pause();
      f.project(['one']);
      await Promise.resolve();
      expect(f.network).not.toHaveBeenCalled();
      f.loop?.resume();
      await vi.waitFor(() => expect(f.store.listSnapshots()).toHaveLength(1), { timeout: 250 });
      await f.loop?.stop();
      f.project(['one', 'two']);
      await Promise.resolve();
      expect(f.network).toHaveBeenCalledTimes(3);
    } finally { await f.dispose(); }
  });

  it('does not let a pending stale discovery response erase a new live profile', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.api.listConnectedServiceProfiles.mockImplementationOnce(async () => { await gate; return { profiles: [] }; });
    try {
      f.scheduledTick();
      await vi.waitFor(() => expect(f.api.listConnectedServiceProfiles).toHaveBeenCalledTimes(1), { timeout: 250 });
      f.project(['new']);
      release();
      await vi.waitFor(() => expect(f.store.listSnapshots()).toHaveLength(1), { timeout: 250 });
      expect(f.network).toHaveBeenCalledTimes(3);
    } finally { release(); await f.dispose(); }
  });

  it('respects disabled inactive-profile discovery', async () => {
    const f = fixture({ discoveryEnabled: false });
    try {
      f.project(['new']);
      await Promise.resolve();
      expect(f.network).not.toHaveBeenCalled();
      expect(f.store.listSnapshots()).toEqual([]);
    } finally { await f.dispose(); }
  });
});
