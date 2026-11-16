import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfileOwnerReadV1Schema, PublicProfileOwnerRecordV1Schema,
  PublicProfileRefreshBodyV1Schema, PublicProfileMutationResultV1Schema, type PublicProfileRefreshBodyV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { AccountProfileResponseSchema } from '@happier-dev/protocol/account/profile';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { normalizeUsageQuery, resolveUsageQueryPeriod } from '@happier-dev/protocol/inputs/usageQuery';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionsSettingsV1Schema, isActionEnabledByActionsSettings } from '@happier-dev/protocol/actions/actionSettings';
import axios, { type AxiosRequestConfig } from 'axios';
import fastify from 'fastify';
import { expect, vi } from 'vitest';

import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createDeferred } from '@/testkit/async/deferred';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createSessionReadBatchResponseFixture } from '@/testkit/backends/sessionFixtures';
import { createNativePublicProfileRefreshActions } from './nativePublicProfileRefreshActions';

/** Persisted remote owner state, not a substitute for snapshot computation. */
export function createPublicProfileRefreshOwner(computedAtMs: number | null) {
  const query = normalizeUsageQuery({ period: { relative: '90days' }, includeSessionEvidence: false,
    includeTranscriptEvidence: false, includeWorkEvidence: false, includeQuotaHistory: false });
  return PublicProfileOwnerReadV1Schema.parse({ kind: 'ready', context: {
    handle: 'ada', identity: { name: 'Ada' }, service: { displayName: 'Home', publicBaseUrl: 'https://home.test' },
    urls: { page: 'https://home.test/@ada', json: 'https://home.test/@ada/json', badgeBase: 'https://home.test/@ada/badge',
      card: 'https://home.test/@ada/card.svg', og: 'https://home.test/@ada/og.png', report: 'mailto:operator@home.test' },
  }, record: { state: 'published', policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, metadata: {}, projectSelections: [], query,
    snapshot: computedAtMs === null ? null : { v: 1, computedAtMs,
      period: { ...resolveUsageQueryPeriod(query, computedAtMs), timeZoneOffsetMinutes: query.timeZoneOffsetMinutes },
      coverage: { status: 'unknown', method: 'unknown' }, fieldCoverage: {}, facts: {} },
    layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
    updatedAtMs: 1, publishedAtMs: 1, restriction: null },
  });
}

/** Real native adapter, shared Action executor and captured Account HTTP binding.
 * Only the remote HTTP peer and clock are substituted. The real shared builder
 * consumes the Usage service's strict response to the public-population request.
 * Server-side known-Team exclusion is covered by usageQueryService integration,
 * not reimplemented or certified by this client fixture.
 */
export async function createNativePublicProfileRefreshFixture(options: {
  computedAtMs?: number | null;
  settings?: unknown;
} = {}) {
  const app = fastify();
  const origin = 'http://profile-home.test';
  let owner = createPublicProfileRefreshOwner(options.computedAtMs === undefined
    ? Date.now() - 24 * 60 * 60 * 1_000 : options.computedAtMs);
  let settings = ActionsSettingsV1Schema.parse(options.settings ?? { v: 1 });
  let current = true;
  let usageAvailable = true;
  let sourceLagMs = 0;
  const requests: Array<{ method: string; path: string }> = [];
  const refreshes: PublicProfileRefreshBodyV1[] = [];
  const releases = new Set<() => void>();
  let pendingRead: { accepted(): void; released: Promise<void> } | undefined;
  let pendingAck: { accepted(): void; released: Promise<void> } | undefined;
  app.addHook('onRequest', async request => {
    expect(request.headers.authorization).toBe('Bearer captured');
    requests.push({ method: request.method, path: request.url });
  });
  app.get('/v1/account/public-profile', async () => {
    const pending = pendingRead;
    pendingRead = undefined;
    if (pending) {
      pending.accepted();
      await pending.released;
    }
    return owner;
  });
  app.post('/v2/usage/query', async (request, reply) => {
    const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
    expect(query.population).toBe('public_eligible_personal');
    if (!usageAvailable) return reply.code(503).send({ error: 'usage_unavailable' });
    const startMs = query.dateRange?.startMs;
    const endMs = query.dateRange?.endMs;
    if (startMs === undefined || endMs === undefined) throw new Error('Expected resolved public Usage period');
    const tokens = { input: 8, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
    const cost = { reportedUsd: 98765, estimatedUsd: 87654, currency: 'USD' };
    const asOfMs = Date.now() - sourceLagMs;
    // Schema-valid admitted service response: no metadata-based local eligibility
    // shortcut, private-history fallback, or synthetic public snapshot.
    return UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1, tokens, cost },
      contributions: [{ id: 'private-request', observedAtMs: asOfMs - 1, sessionId: 'private-session', turnId: 'personal',
        agentId: 'codex', modelId: null, machineId: null, projectKey: 'private-project', workspaceId: null,
        source: 'personal', eventCount: 1, sourceContext: { path: 'runtime', execution: 'happier' }, tokens, cost }],
      coverage: { status: 'partial', reasons: ['incomplete_history'], missingDimensions: [], ranked: [],
        range: { startMs, endMs, complete: false }, sources: [{ source: 'personal', path: 'runtime', status: 'available',
          eventCount: 1, asOfMs, historyComplete: false }] },
    });
  });
  app.get('/v1/account/encryption/currentness', async () => AccountEncryptionCurrentnessResponseSchema.parse({
    mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
  }));
  app.post('/v2/sessions/read-batch', async request => createSessionReadBatchResponseFixture({
    request: request.body, sessions: [],
  }));
  app.get('/v2/account/settings', async () => AccountSettingsV2GetResponseSchema.parse({ content: { t: 'plain', v: {} }, version: 1 }));
  app.get('/v1/account/profile', async () => AccountProfileResponseSchema.parse({ id: 'account', username: 'ada' }));
  app.put('/v1/account/public-profile/snapshot', async request => {
    const body = PublicProfileRefreshBodyV1Schema.parse(request.body);
    refreshes.push(body);
    if (owner.kind !== 'ready') throw new Error('Expected published remote fixture');
    const record = PublicProfileOwnerRecordV1Schema.parse({ ...owner.record,
      query: body.query, snapshot: body.snapshot, updatedAtMs: Date.now(),
      ...(body.projectLinks ? { metadata: { ...owner.record.metadata, projects: body.projectLinks } } : {}),
    });
    owner = PublicProfileOwnerReadV1Schema.parse({ ...owner, record });
    const ack = PublicProfileMutationResultV1Schema.parse({ kind: 'updated', record });
    const pending = pendingAck;
    pendingAck = undefined;
    if (pending) { pending.accepted(); await pending.released; }
    return ack;
  });
  await app.ready();
  const restoreHttp = installAxiosFastifyAdapter({ app, origin });
  const request = axios.request.bind(axios);
  let requestSignal: AxiosRequestConfig['signal'];
  // Observe the genuine HTTP boundary without replacing the Account/Action logic.
  const requestSpy = vi.spyOn(axios, 'request').mockImplementation(config => {
    requestSignal = config.signal;
    return request(config);
  });
  const deps = createAccountServerActionDeps({ token: 'captured', serverId: 'home',
    serverHttpBaseUrl: origin, isCredentialCurrent: async () => current });
  const executor = createActionExecutor({
    ...createUnavailableActionTransportDeps(), ...deps,
    isActionEnabled: (id, context) => isActionEnabledByActionsSettings(id, settings, context),
    readActionsSettings: () => settings,
  });
  const actions = createNativePublicProfileRefreshActions({ executor, serverId: 'home' });
  const releaseReads = () => { for (const release of releases) release(); };
  return {
    actions, requests, refreshes, isCurrent: async () => current,
    readOwner: () => owner,
    getRequestSignal: () => requestSignal,
    retire: () => { current = false; },
    setComputedAt: (value: number | null) => { owner = createPublicProfileRefreshOwner(value); },
    pauseProfile: () => {
      if (owner.kind !== 'ready' || !owner.record) throw new Error('Expected published remote fixture');
      owner = PublicProfileOwnerReadV1Schema.parse({ ...owner, record: { ...owner.record, state: 'paused' } });
    },
    setSettings: (value: unknown) => { settings = ActionsSettingsV1Schema.parse(value); },
    setUsageAvailable: (value: boolean) => { usageAvailable = value; },
    setSourceLag: (value: number) => { sourceLagMs = value; },
    holdNextRead: () => {
      const accepted = createDeferred();
      const released = createDeferred();
      const release = () => { releases.delete(release); released.resolve(); };
      releases.add(release);
      pendingRead = { accepted: () => accepted.resolve(), released: released.promise };
      return { accepted: accepted.promise, release };
    },
    holdNextRefreshAck: () => {
      const accepted = createDeferred();
      const released = createDeferred();
      const release = () => { releases.delete(release); released.resolve(); };
      releases.add(release);
      pendingAck = { accepted: () => accepted.resolve(), released: released.promise };
      return { accepted: accepted.promise, release };
    },
    releaseReads,
    dispose: async () => {
      releaseReads();
      requestSpy.mockRestore();
      restoreHttp();
      await app.close();
    },
  };
}
