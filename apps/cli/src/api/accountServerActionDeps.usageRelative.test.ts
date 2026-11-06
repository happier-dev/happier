import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { afterEach, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { z } from 'zod/mini';
import { createActionExecutor } from '@happier-dev/protocol';
import { normalizeUsageQuery, resolveUsageQueryPeriod } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { resolveUsagePageAggregation, UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createAccountServerActionDeps } from './accountServerActionDeps';

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; vi.restoreAllMocks(); });

it.each(['cli', 'mcp'] as const)('uses Account night hours for the %s recorded activity query without private Session reads', async surface => {
  const app = fastify();
  let hours: { startHour: number; endHour: number } | null = { startHour: 23, endHour: 7 };
  const reads: string[] = [];
  app.addHook('preHandler', async request => { reads.push(request.url.split('?')[0]!); });
  app.post('/v2/usage/query', async () => ({ v: 1, totals: { eventCount: 10,
    tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } }, activity: {
      weekdayHourBuckets: [{ weekday: 5, hour: 0, eventCount: 7 }, { weekday: 5, hour: 12, eventCount: 3 }],
    } }));
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
  app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: { usageNightHoursV1: hours } }, version: 1 }));
  app.get('/v1/account/profile', async () => ({ id: 'account', connectedAccountsV4: [], connectedAccountGroupsV4: [] }));
  cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage-night.test' });
  const credentials = { token: 'owner-token', encryption: null };
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({
    token: credentials.token, credentials, serverId: 'home', serverHttpBaseUrl: 'http://usage-night.test',
  }), isActionApprovalRequired: () => false });
  const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 86_400_000 }, timeZoneOffsetMinutes: 120,
    includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
  const readNight = async () => {
    const result = await executor.execute('usage.query', { queries: [query] }, { surface, serverId: 'home' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const slice = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results[0]!;
    const ui = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: slice.accounting, status: 'available' }],
      nightHours: hours });
    expect(slice.howYouWork?.nightShift).toEqual(ui.results[0]?.howYouWork?.nightShift);
    return slice.howYouWork?.nightShift;
  };
  expect(await readNight()).toEqual({ startHour: 23, endHour: 7, recordedActivityCount: 7, observedBusyMs: null });
  hours = { startHour: 9, endHour: 17 };
  expect(await readNight()).toEqual({ startHour: 9, endHour: 17, recordedActivityCount: 3, observedBusyMs: null });
  hours = null;
  expect(await readNight()).toBeNull();
  expect(reads.filter(path => /^\/v[12]\/sessions(?:\/|$)/.test(path))).toEqual([]);
  await app.close();
});

it.each([true, false])('uses one relative read range through the CLI HTTP boundary with accounting demand=%s', async includeAccounting => {
  const nowMs = Date.UTC(2026, 9, 12, 12);
  let readClockMs = nowMs;
  vi.spyOn(Date, 'now').mockImplementation(() => readClockMs);
  const query = normalizeUsageQuery({ period: { relative: '7days' }, includeAccounting });
  const period = resolveUsageQueryPeriod(query, nowMs);
  const source = { bindingKind: 'account' as const, ref: { service: { pluginId: 'example.usage', localId: 'quota' }, accountId: 'work' } };
  const key = { providerId: 'test', accountSubjectId: 'subject', subjectKind: 'account' as const, quotaScope: 'account' as const };
  const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(key), recordKey: key,
    providerId: 'test', accountSubject: { kind: 'providerSubject', id: 'subject' }, observedAtMs: nowMs - 1, fetchedAtMs: nowMs - 1,
    staleAfterMs: 1000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] });
  const record = { content: { t: 'plain', v: snapshot }, metadata: { fetchedAt: nowMs - 1, staleAfterMs: 1000, status: 'ok' }, sources: [source] };
  const requests: ReturnType<typeof UsageAnalyticsQueryRequestSchema.parse>[] = [];
  const historyRanges: unknown[] = [];
  const app = fastify();
  app.post('/v2/usage/query', async request => {
    const input = UsageAnalyticsQueryRequestSchema.parse(request.body);
    requests.push(input);
    // Downstream private/history reads must not resolve relative intent again.
    readClockMs = nowMs + 60_000;
    return { v: 1, totals: { eventCount: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }, contributions: [], coverage: { status: 'complete', reasons: [],
      sources: [], missingDimensions: [], range: { ...input.dateRange, complete: true }, ranked: [] } };
  });
  app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
  app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
  app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
  app.get('/v1/account/profile', async () => ({ id: 'account', connectedAccountsV4: [{ ref: source.ref, status: 'connected',
    authenticationModeId: null, revisionSemantics: 'revisioned', credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz',
    configurationReady: true, configurationRevision: '1', scopes: [] }], connectedAccountGroupsV4: [] }));
  app.get('/v4/connect/qualified/provider-account-usage/sources/resolve', async () => ({ source, recordId: snapshot.recordId,
    providerAccountId: 'subject', fetchedAt: nowMs - 1, staleAfterMs: 1000 }));
  app.get('/v4/connect/qualified/provider-account-usage/record', async () => record);
  app.get('/v4/connect/qualified/provider-account-usage/history', async request => {
    const encoded = z.object({ query: z.string() }).parse(request.query);
    const historyRequest = z.looseObject({ history: z.looseObject({ range: z.object({ startAtMs: z.number(), endAtMs: z.number() }) }) }).parse(JSON.parse(encoded.query));
    historyRanges.push(historyRequest.history.range);
    return { entries: [{ id: 'history', observedAtMs: nowMs - 1, record }], nextCursor: null };
  });
  app.post('/v2/pending/reset-starts/read', async () => ({ entries: [] }));
  cleanup = installAxiosFastifyAdapter({ app, origin: 'http://usage-relative.test' });
  const credentials = { token: 'owner-token', encryption: null };
  const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...createAccountServerActionDeps({ token: credentials.token, credentials,
    serverId: 'home', serverHttpBaseUrl: 'http://usage-relative.test' }), isActionApprovalRequired: () => false });
  const result = await executor.execute('usage.query', { queries: [query] }, { surface: 'cli', serverId: 'home' });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  const slice = UsageQueryBatchResultSchema.parse(result.ok ? result.result : undefined).results[0]!;
  expect(requests.map(request => request.dateRange)).toEqual(includeAccounting ? [period,
    { startMs: period.startMs! - (period.endMs! - period.startMs!), endMs: period.startMs }] : []);
  expect(historyRanges).toEqual([{ startAtMs: period.startMs, endAtMs: period.endMs }]);
  expect(slice.requestedQuery.period).toEqual({ relative: '7days' });
  expect(slice.shownQuery.period).toEqual({ relative: '7days' });
  expect(slice.quota?.[0]?.history?.entries).toHaveLength(1);
  if (includeAccounting) expect(slice.comparison?.query.period).toEqual(requests[1]!.dateRange);
  else expect(slice).not.toHaveProperty('comparison');
});
