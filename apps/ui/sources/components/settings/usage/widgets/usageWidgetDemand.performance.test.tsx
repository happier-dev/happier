import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createUsageSessionEvidenceHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createSessionFixture, createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainSessionWithDisplayRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore, invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { storage } from '@/sync/domains/state/storage';
import { useUsageWidgetModel } from './usageWidgetBatch';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import * as workEvidence from '@/sync/domains/usage/usageWorkEvidence';
import * as storedSessionContent from '@/sync/runtime/readStoredSessionContent';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { Encryption } from '@/sync/encryption/encryption';
import { SessionEncryption } from '@/sync/encryption/sessionEncryption';
import { encodeBase64 } from '@/encryption/base64';
import { sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { createLegacyAccountEncryptionCurrentnessFixture, createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema } from '@happier-dev/protocol/usage/usageSessionEvidence';
import { SessionSystemRecordStoredUpsertRequestSchema } from '@happier-dev/protocol/sessions/system/records/sessionSystemRecordRoutes';

// HTTP serves these fake Homes; their Socket SDK must not dial the network
// and withdraw the Account observation while the demand measurement is active.
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;

function successfulUsageFactWrite(body: unknown): Response {
  const write = SessionSystemRecordStoredUpsertRequestSchema.parse(body);
  return Response.json({ record: { ...write, id: 'sysrec_1', revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ',
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } });
}

afterEach(async () => {
  standardCleanup();
  retireActiveServerAccountScopeLifetime();
  invalidateUsageQueryResources();
  await home?.dispose();
  home = undefined;
  vi.restoreAllMocks();
});

it.each([
  { widgetId: 'usage_period_summary', session: null },
  { widgetId: 'usage_session_value', session: null },
  { widgetId: 'usage_parallel', session: null },
  { widgetId: 'usage_session_value', session: ['session-0'] },
] as const)(
  'settles $widgetId with session=$session across 401 Sessions, reading only rendered evidence', async ({ widgetId, session }) => {
    const sessionCount = 401;
    const ids = Array.from({ length: sessionCount }, (_, index) => `session-${index}`);
    const messagesPerSession = 16;
    const sessionBatch = createUsageSessionEvidenceHttpBoundary(request => {
        if (request.path === '/v2/usage/query') return Response.json({ v: 1, totals: { eventCount: sessionCount,
          tokens: { input: sessionCount, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: sessionCount },
          cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
        if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        const sessionMatch = /^\/v2\/sessions\/(session-\d+)$/.exec(request.path);
        if (sessionMatch) return Response.json({ session: createPlainSessionWithDisplayRecordFixture({ id: sessionMatch[1]!,
          createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900, metadataVersion: 1, agentStateVersion: 1 }) });
        const turnsMatch = /^\/v1\/sessions\/([^/]+)\/turns$/.exec(request.path);
        if (turnsMatch) return Response.json({ v: 1, sessionId: turnsMatch[1]!, updatedAt: 900,
          turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 }] });
        if (request.path.endsWith('/messages')) return Response.json({ messages: Array.from({ length: messagesPerSession }, (_, index) => ({
          id: `message-${index}`, seq: index + 1, localId: null, createdAt: 300,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `${request.path}-${index}-${'x'.repeat(4096)}` } } },
        })), hasMore: false });
        return undefined;
      }, () => ids);
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-many-sessions.test', accountId: 'account-a' }],
      route: async request => await sessionBatch.handle(request)
        ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await sync.refreshSessions();
    await sync.refreshMachines();
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId: home.homes.a!.id, accountId: 'account-a' },
      profile: AccountProfileSchema.parse({ id: 'account-a' }), sessions: Object.fromEntries(ids.map(id => [id,
        createSessionFixture({ id, seq: 1, serverId: home!.homes.a!.id, encryptionMode: 'plain' })])) });
    let latest: UsageWidgetBodyModel | undefined;
    function Probe() {
      latest = useUsageWidgetModel({ period: { startMs: 0, endMs: 1000 }, agents: [], machines: [], projects: [],
        sources: [], session: session === null ? null : [...session], costBasis: 'auto', metric: 'tokens', breakdown: [] }, widgetId).model;
      return null;
    }
    // A warmed module graph and identical workload bracket both runs. These are
    // process heap/RSS observations, not browser retained-memory measurements.
    const before = process.memoryUsage();
    const started = performance.now();
    const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><Probe /></InjectedAuthProvider>);
    try {
      await expect.poll(async () => { await flushHookEffects({ cycles: 2 }); return latest?.slice ? latest.pending : undefined; }, { timeout: 120_000 }).toBe(false);
      // Summary output can settle before the shared custom-window conversion.
      // Observe that finite phase before measuring its request cost.
      const expectedTranscriptReads = session === null && widgetId === 'usage_session_value' ? 0 : session === null ? sessionCount : 1;
      await expect.poll(() => sessionBatch.componentRequests.filter(request => request.path.endsWith('/messages')).length,
        { timeout: 120_000 }).toBe(expectedTranscriptReads);
      const after = process.memoryUsage();
      const sessionIds = new Set(ids);
      const evidenceRequests = [...home.requests, ...sessionBatch.componentRequests];
      const sessionRequests = evidenceRequests.filter(request => {
        const match = /^\/v2\/sessions\/([^/]+)$/.exec(request.path);
        return match !== null && sessionIds.has(match[1]!);
      });
      const sessionReads = sessionRequests.length;
      const usageEvidenceRequests = evidenceRequests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH);
      const transcriptReads = evidenceRequests.filter(request => request.path.endsWith('/messages')).length;
      console.info('FA-LOGIC-2 many-session demand', JSON.stringify({ widgetId, session, sessionCount, messagesPerSession,
        elapsedMs: performance.now() - started, sessionReads, transcriptReads,
        heapUsedBefore: before.heapUsed, heapUsedAfter: after.heapUsed, rssBefore: before.rss, rssAfter: after.rss }));
      expect(latest?.slice?.accounting?.totals.tokens.total).toBe(sessionCount);
      if (widgetId !== 'usage_session_value' || session !== null)
        expect(latest?.slice?.howYouWork?.intervals?.agentTimeMs).toBe((session === null ? sessionCount : 1) * 300);
      // Custom windows open transcript evidence under the shared window policy;
      // the session-value body has no transcript demand when no Session is pinned.
      expect(transcriptReads).toBe(expectedTranscriptReads);
      // The HTTP boundary projects these source Sessions onto the canonical
      // evidence endpoint; only the demanded Session population may be read.
      expect([...new Set(sessionRequests.map(request => request.path.split('/').at(-1)))].sort()).toEqual(session !== null ? [...session]
        : widgetId === 'usage_session_value' ? [] : [...ids].sort());
      if (expectedTranscriptReads > 0) expect(usageEvidenceRequests.length).toBeGreaterThan(0);
      if (session !== null) expect(usageEvidenceRequests.some(request => {
        const input = UsageSessionEvidenceRequestSchema.parse(request.body);
        return input.requests.some(demand => demand.sessionIds?.join(',') === session.join(','));
      })).toBe(true);
      expect(latest?.slice?.sources.some(source => source.source === 'how_you_work:transcripts' && source.status === 'pending')).toBe(false);
    } finally { await screen.unmount(); }
  }, 180_000,
);

it('reuses 500 admitted Sessions across unrelated Resource wakes and refreshes only the changed Session for Coach', async () => {
  const { Session: InspectorSession } = await import('node:inspector');
  const stored = await import('@/sync/runtime/readStoredSessionContent');
  const read = stored.readStoredSessionMessage;
  const bodies: WeakRef<object>[] = [];
  // Observe the actual opener without substituting internal behavior. Remove
  // spy call/result history before measuring the live Resource's retention.
  const observation = vi.spyOn(stored, 'readStoredSessionMessage').mockImplementation(async (...args) => {
    const result = await read(...args);
    if (result) bodies.push(new WeakRef(result));
    return result;
  });
  const ids = Array.from({ length: 500 }, (_, index) => `evidence-${index}`);
  let changedSeq = 1;
  const sessionBatch = createUsageSessionEvidenceHttpBoundary(request => {
      if (request.path === '/v2/usage/query') return Response.json({ v: 1, totals: { eventCount: ids.length,
        tokens: { input: ids.length, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: ids.length },
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
      const detail = /^\/v2\/sessions\/(evidence-\d+)$/.exec(request.path);
      if (detail) return Response.json({ session: createPlainSessionWithDisplayRecordFixture({ id: detail[1]!,
        createdAt: 1, updatedAt: 900, seq: detail[1] === ids[0] ? changedSeq : 1,
        active: true, activeAt: 900, metadataVersion: 1, agentStateVersion: 1 }) });
      const turns = /^\/v1\/sessions\/(evidence-\d+)\/turns$/.exec(request.path);
      if (turns) return Response.json({ v: 1, sessionId: turns[1]!, updatedAt: 900, turns: [
        { turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 },
      ] });
      if (/^\/v1\/sessions\/evidence-\d+\/messages$/.test(request.path)) return Response.json({ messages: [{
        id: 'input', seq: 1, localId: 'accepted-input', createdAt: 200,
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private-body-'.repeat(512) } } },
        deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: {
          v: 1, acceptedAtMs: 200, delivery: { kind: 'steer', turnId: 'turn' },
        } } },
      }], hasMore: false });
      return undefined;
    }, () => ids);
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-session-reuse.test', accountId: 'account-a' }],
    route: async request => await sessionBatch.handle(request)
      ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
  publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
  const captured = captureUiUsageQueryAccountContext(credentials)!;
  const { sync } = await import('@/sync/sync');
  await sync.resumeSync('manual');
  storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: 'account-a' }),
    sessions: Object.fromEntries(ids.map(id => [id, createSessionFixture({ id, seq: 1,
      serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' })])) });
  const store = getUsageQueryResourceStore(captured);
  const summary = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({
    period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false, includeTranscriptEvidence: false,
  })] }) });
  const coach = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({
    period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false,
  })] }) });
  const readCounts = () => {
    const requests = [...home!.requests, ...sessionBatch.componentRequests];
    return {
      evidence: requests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH).length,
      detail: requests.filter(request => /^\/v2\/sessions\/evidence-\d+$/.test(request.path)).length,
      turns: requests.filter(request => /^\/v1\/sessions\/evidence-\d+\/turns$/.test(request.path)).length,
      messages: requests.filter(request => /^\/v1\/sessions\/evidence-\d+\/messages$/.test(request.path)).length,
      writes: requests.filter(request => request.method === 'PUT' && request.path.endsWith('/system-records')).length,
    };
  };
  const started = performance.now();
  const release = summary.subscribe(() => {}, false);
  try {
    await summary.refresh();
    // Custom windows convert unrecorded evidence even for summary output
    // (the shared window rule added in 2d29685e1f). Wait for that finite phase.
    await expect.poll(() => bodies.length, { timeout: 120_000 }).toBe(ids.length);
    await flushHookEffects({ cycles: 2 });
    const initial = readCounts();
    for (let pass = 0; pass < 5; pass++) {
      publishHomeAccountChange(captured.accountLifetime.scope.serverId, ['unrelated-friend'], { changeKinds: ['friends'] });
      await summary.refresh();
    }
    const unchanged = readCounts();
    console.info('USAGE-SESSION-EVIDENCE unchanged', JSON.stringify({ initial, unchanged, elapsedMs: performance.now() - started }));
    expect(unchanged).toEqual(initial);
    // Both the summary and transcript phases carry their admitted Session
    // context on today's evidence wire; private bodies open only once.
    // Active Sessions are not durable compact-fact subjects; the finite
    // Resource retains their witnesses without attempting a record write.
    expect(initial).toEqual({ evidence: 2, detail: 1000, turns: 1000, messages: 500, writes: 0 });
    await coach.refresh();
    expect(readCounts()).toEqual(initial);
    const facts = decodeUsageQueryResource(coach.getSnapshot().value!).results[0]!;
    expect(facts.howYouWork?.inputs).toMatchObject({ acceptedCount: 500, steeringCount: 500 });
    expect(facts.howYouWork?.intervals?.agentTimeMs).toBe(150_000);
    expect(facts.coach).toBeDefined();
    expect(JSON.stringify(facts)).not.toContain('private-body-');
    for (let pass = 0; pass < 3; pass++) await coach.refresh();
    expect(readCounts()).toEqual(initial);
    changedSeq++;
    storage.setState({ sessions: { ...storage.getState().sessions,
      [ids[0]!]: { ...storage.getState().sessions[ids[0]!]!, seq: changedSeq } } });
    publishHomeAccountChange(captured.accountLifetime.scope.serverId, [ids[0]!], { changeKinds: ['session'] });
    await coach.refresh();
    expect(readCounts()).toEqual({ evidence: 4, detail: 1002, turns: 1002, messages: 501, writes: 0 });
    console.info('USAGE-SESSION-EVIDENCE changed', JSON.stringify({ reads: readCounts(), elapsedMs: performance.now() - started }));
    expect(bodies).toHaveLength(501);
    observation.mockRestore();
    const inspector = new InspectorSession();
    inspector.connect();
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
      const retained = bodies.filter(body => body.deref() !== undefined).length;
      console.info('USAGE-SESSION-EVIDENCE 500-session retention', JSON.stringify({ opened: bodies.length, retained, ...process.memoryUsage() }));
      expect(retained).toBe(0);
      expect(decodeUsageQueryResource(coach.getSnapshot().value!).results[0]?.howYouWork?.inputs)
        .toMatchObject({ acceptedCount: 500, steeringCount: 500 });
    } finally { inspector.disconnect(); }
  } finally { observation.mockRestore(); release(); }
}, 180_000);

it('publishes cold 600-Session evidence by source phase and re-admits incomplete Coach evidence on refresh', async () => {
  const ids = Array.from({ length: 600 }, (_, index) => `cold-${index}`);
  let encryptedAccount = false;
  const messagesGate = createDeferred<void>();
  const lastMessageGate = createDeferred<void>();
  const sessionBatch = createUsageSessionEvidenceHttpBoundary(async request => {
      if (request.path === '/v2/usage/query') return Response.json({ v: 1, totals: { eventCount: ids.length,
        tokens: { input: ids.length, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: ids.length },
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
      const detail = /^\/v2\/sessions\/(cold-\d+)$/.exec(request.path);
      if (detail) return Response.json({ session: createPlainSessionWithDisplayRecordFixture({ id: detail[1]!,
        createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900, metadataVersion: 1, agentStateVersion: 1 }) });
      const turns = /^\/v1\/sessions\/(cold-\d+)\/turns$/.exec(request.path);
      if (turns) return Response.json({ v: 1, sessionId: turns[1]!, updatedAt: 900,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 }] });
      const messages = /^\/v1\/sessions\/(cold-\d+)\/messages$/.exec(request.path);
      if (messages) {
        await messagesGate.promise;
        if (messages[1] === ids.at(-1)) await lastMessageGate.promise;
        return Response.json({ messages: [{ id: messages[1] + '-input', seq: 1, localId: 'accepted-input', createdAt: 200,
          content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'private-cold-body' } } },
          deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'plain', v: {
            v: 1, acceptedAtMs: 200, delivery: { kind: 'steer', turnId: 'turn' },
          } } },
        }], hasMore: true });
      }
      return undefined;
    }, () => ids);
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-cold-phases.test', accountId: 'account-a',
    encryptionCurrentness: () => encryptedAccount
      ? createLegacyAccountEncryptionCurrentnessFixture({ secret: new Uint8Array(32).fill(9) })
      : createPlainAccountEncryptionCurrentnessFixture(),
  }],
    route: async request => await sessionBatch.handle(request)
      ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
  publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
  const captured = captureUiUsageQueryAccountContext(credentials)!;
  const { sync } = await import('@/sync/sync');
  // Settle bootstrap/recovery so Settings and Todo currentness reads do not
  // enter the finite Usage batch's one-observation count below.
  await sync.awaitBootstrapForegroundAcquisition();
  await sync.resumeSync('server-reachable');
  storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: 'account-a' }),
    sessions: Object.fromEntries(ids.map(id => [id, createSessionFixture({ id, seq: 1,
      serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'plain' })])) });
  const project = vi.spyOn(workEvidence, 'projectUsageQueryWorkEvidence');
  const opened = vi.spyOn(storedSessionContent, 'readStoredSessionMessage');
  // Count this Usage owner's real HTTP port. Sync's Settings and authoring
  // memory readers also acquire exact Account witnesses on the same Home.
  let usageCurrentnessReads = 0;
  const request: typeof captured.request = (path, ...args) => {
    if (path === '/v1/account/encryption/currentness') usageCurrentnessReads++;
    return captured.request(path, ...args);
  };
  const entry = getUsageQueryResourceStore({ ...captured, request }).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [normalizeUsageQuery({
    period: { startMs: 0, endMs: 1000 }, includeWorkEvidence: false,
  })] }) });
  const reading = createDeferred<void>();
  const release = entry.subscribe(() => { if (entry.getSnapshot().pending === 'idle') reading.resolve(); }, false);
  const slice = () => entry.getSnapshot().value ? decodeUsageQueryResource(entry.getSnapshot().value!).results[0] : undefined;
  const messageReads = () => [...home!.requests, ...sessionBatch.componentRequests]
    .filter(request => /^\/v1\/sessions\/cold-\d+\/messages$/.test(request.path)).length;
  try {
    await expect.poll(messageReads, { timeout: 120_000 }).toBe(ids.length);
    await expect.poll(() => slice()?.howYouWork?.intervals?.agentTimeMs).toBe(ids.length * 300);
    expect(usageCurrentnessReads,
      'the admitted cold batch must share one Account-currentness observation across all Sessions and phases').toBe(1);
    const summaryPasses = project.mock.calls.length;
    messagesGate.resolve();
    await flushHookEffects({ cycles: 20 });
    // The last component holds the HTTP batch response. Earlier components
    // must not open private bodies or reproject an unadmitted evidence phase.
    expect(opened.mock.calls).toHaveLength(0);
    expect(project.mock.calls.length, 'intermediate Session completions must not reproject the entire corpus').toBe(summaryPasses);
    expect(slice()?.howYouWork?.intervals?.agentTimeMs).toBe(ids.length * 300);
    lastMessageGate.resolve();
    await reading.promise;
    expect(slice()?.howYouWork?.inputs).toMatchObject({ acceptedCount: ids.length, steeringCount: ids.length });
    expect(slice()?.sources.find(source => source.source === 'how_you_work:transcripts')?.status).toBe('partial');
    expect(JSON.stringify(slice())).not.toContain('private-cold-body');
    for (let pass = 0; pass < 3; pass++) await entry.refresh();
    // Paged-history completion (cfda1a3d3f1) keeps partial facts visible but
    // re-admits incomplete evidence when the person requests a refresh.
    expect(messageReads()).toBe(ids.length * 4);
    expect(slice()?.howYouWork?.inputs).toMatchObject({ acceptedCount: ids.length, steeringCount: ids.length });
    const beforeInvalidation = usageCurrentnessReads;
    invalidateAccountEncryptionModeCache();
    await entry.refresh();
    expect(usageCurrentnessReads - beforeInvalidation,
      'Account encryption invalidation must re-admit retained Session evidence through a fresh observation').toBe(1);
    expect(messageReads()).toBe(ids.length * 5);
    encryptedAccount = true;
    invalidateAccountEncryptionModeCache();
    await entry.refresh();
    expect(entry.getSnapshot().error?.code).toBe('plugin_resource_context_unavailable');
    expect(entry.getSnapshot().value).toBeUndefined();
    expect(slice()?.howYouWork?.intervals ?? null,
      'a changed Account mode must freshly admit the Session instead of reviving retained plain evidence').toBeNull();
    expect(slice()?.howYouWork?.inputs ?? null).toBeNull();
    expect(messageReads(), 'refused Session admission must not open transcript pages').toBe(ids.length * 5);
    console.info('USAGE-FREEZE-ROOT cold work', JSON.stringify({ sessions: ids.length, summaryPasses,
      projectionPasses: project.mock.calls.length, messageReads: messageReads() }));
  } finally { messagesGate.resolve(); lastMessageGate.resolve(); await reading.promise; release(); }
}, 180_000);

it('shares opened E2EE pages across mounted Overview and Coach consumers and unchanged refreshes', async () => {
  const secret = new Uint8Array(32).fill(4);
  const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`,
    secret: encodeBase64(secret, 'base64url') };
  const author = await Encryption.create(secret);
  const ids = ['legacy-owner', 'standalone-key'];
  const standaloneKey = new Uint8Array(32).fill(7);
  await author.initializeSessions(new Map(ids.map(id => [id, id === 'legacy-owner' ? null : standaloneKey])));
  const envelope = encodeBase64(await author.encryptEncryptionKey(standaloneKey), 'base64');
  const rows = new Map(await Promise.all(ids.map(async id => {
    const cipher = author.getSessionEncryption(id)!;
    const base = createPlainSessionCurrentProjectionRecordFixture({ id, seq: 2, createdAt: 1, updatedAt: 900 });
    if (base.ownerMetadata?.t !== 'plain' || typeof base.metadata !== 'string') throw new Error('Expected plain author fixture');
    return [id, { ...base, encryptionMode: 'e2ee' as const, dataEncryptionKey: id === 'legacy-owner' ? null : envelope,
      metadata: await cipher.encryptRaw(JSON.parse(base.metadata)),
      ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret },
        ownerMetadata: base.ownerMetadata.v, randomBytes: getRandomBytes }),
      agentState: await cipher.encryptRaw({}),
    }] as const;
  })));
  const messages = new Map(await Promise.all(ids.map(async id => {
    const cipher = author.getSessionEncryption(id)!;
    return [id, await Promise.all([0, 1].map(async index => ({ id: id + '-input-' + index, seq: index + 1, localId: 'accepted-input-' + index, createdAt: 200 + index,
      content: { t: 'encrypted' as const, c: await cipher.encryptRaw({ role: 'user', content: { type: 'text', text: 'private-e2ee-body' } }) },
      deliveryResolution: { v: 1, kind: 'provider_accepted', content: { t: 'encrypted', c: await cipher.encryptRaw({
        v: 1, acceptedAtMs: 200 + index, delivery: { kind: 'steer', turnId: 'turn' },
      }) } },
    })))] as const;
  })));
  const sessionBatch = createUsageSessionEvidenceHttpBoundary(request => {
      if (request.method === 'PUT' && /^\/v2\/sessions\/[^/]+\/system-records$/.test(request.path)) return successfulUsageFactWrite(request.body);
      if (request.path === '/v2/usage/query') return Response.json({ v: 1, totals: { eventCount: ids.length,
        tokens: { input: ids.length, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: ids.length },
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
      const detail = /^\/v2\/sessions\/([^/]+)$/.exec(request.path);
      if (detail && rows.has(detail[1]!)) return Response.json({ session: rows.get(detail[1]!) });
      const turns = /^\/v1\/sessions\/([^/]+)\/turns$/.exec(request.path);
      if (turns && rows.has(turns[1]!)) return Response.json({ v: 1, sessionId: turns[1], updatedAt: 900,
        turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 }] });
      const page = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(request.path);
      if (page && messages.has(page[1]!)) return Response.json({ messages: messages.get(page[1]!), hasMore: false });
      return undefined;
    }, () => ids);
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-encrypted-reuse.test', accountId: 'account-a',
    accountMode: 'e2ee', credentials, encryptionCurrentness: () => createLegacyAccountEncryptionCurrentnessFixture({ secret }) }],
    route: async request => await sessionBatch.handle(request)
      ?? createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
  publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
  const captured = captureUiUsageQueryAccountContext(credentials)!;
  const { sync } = await import('@/sync/sync');
  await sync.resumeSync('manual');
  storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: 'account-a' }),
    sessions: Object.fromEntries(ids.map(id => [id, createSessionFixture({ id, seq: 2,
      serverId: captured.accountLifetime.scope.serverId, encryptionMode: 'e2ee' })])) });
  const input = { period: { startMs: 0, endMs: 1000 }, agents: [], machines: [], projects: [], sources: [], session: null,
    costBasis: 'auto' as const, metric: 'tokens' as const, breakdown: [] };
  let overview: UsageWidgetBodyModel | undefined;
  let coach: UsageWidgetBodyModel | undefined;
  function Consumers() {
    overview = useUsageWidgetModel(input, 'usage_period_summary').model;
    coach = useUsageWidgetModel(input, 'usage_coach').model;
    return null;
  }
  const reads = () => [...home!.requests, ...sessionBatch.componentRequests]
    .filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH
      && UsageSessionEvidenceRequestSchema.parse(request.body).requests.some(demand => demand.query.includeTranscriptEvidence === true)).length;
  // Call-through observation of the existing crypto batching owner: one page
  // must not become a separate native/worker dispatch for each message.
  const openedBatches = vi.spyOn(SessionEncryption.prototype, 'decryptMessages');
  const readMessage = storedSessionContent.readStoredSessionMessage;
  const bodies: WeakRef<object>[] = [];
  const openedBodies = vi.spyOn(storedSessionContent, 'readStoredSessionMessage').mockImplementation(async params => {
    const result = await readMessage(params);
    if (result) bodies.push(new WeakRef(result));
    return result;
  });
  const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><Consumers /></InjectedAuthProvider>);
  try {
    await expect.poll(async () => {
      await flushHookEffects({ cycles: 2 });
      return overview?.slice?.pending === false && coach?.slice?.pending === false;
    }, { timeout: 120_000 }).toBe(true);
    const initialReads = reads();
    await act(async () => { await coach!.refresh(); await overview!.refresh(); });
    expect(reads(), 'unchanged encrypted pages must be reused by every consumer').toBe(initialReads);
    expect(initialReads).toBe(1);
    expect(coach?.slice?.howYouWork?.inputs).toMatchObject({ acceptedCount: ids.length * 2, steeringCount: ids.length * 2 });
    expect(openedBatches.mock.calls.map(([messages]) => messages.length)).toEqual([2, 2]);
    expect(overview?.slice?.howYouWork?.intervals?.agentTimeMs).toBe(ids.length * 300);
    expect(JSON.stringify(coach?.slice)).not.toContain('private-e2ee-body');
    expect(bodies).toHaveLength(ids.length * 2);
    // Both call-through spies otherwise retain their arguments and decrypted
    // results, hiding whether the real scoped cipher and its message cache die.
    openedBodies.mockRestore();
    openedBatches.mockRestore();
    const { Session: InspectorSession } = await import('node:inspector');
    const inspector = new InspectorSession();
    inspector.connect();
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>((resolve, reject) => inspector.post('HeapProfiler.collectGarbage', error => error ? reject(error) : resolve()));
      expect(bodies.filter(body => body.deref() !== undefined)).toHaveLength(0);
      expect(coach?.slice?.howYouWork?.inputs?.acceptedCount).toBe(ids.length * 2);
    } finally { inspector.disconnect(); }
  } finally { openedBodies.mockRestore(); openedBatches.mockRestore(); await screen.unmount(); }
}, 180_000);
