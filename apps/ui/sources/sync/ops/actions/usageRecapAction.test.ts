import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery, resolveUsageQueryPeriod } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryBatchRequestSchema, UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryBatchResponse, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { UsageRecapExportResultSchema} from '@happier-dev/protocol/usage/usageRecap';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { standardCleanup } from '@/dev/testkit';
import { createAccountKvHttpFixture } from '@/dev/testkit/fixtures/accountKvHttpFixture';
import { createPlainSessionWithDisplayRecordFixture } from '@/dev/testkit/fixtures/sessionDisplayFixtures';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createDefaultActionExecutor } from './defaultActionExecutor';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore } from '@/sync/api/account/usageQueryResource';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createHomeDomainActionExecutorForScope } from '@/sync/api/home/homeDomainActions';
import { DEFAULT_PUBLIC_PROFILE_POLICY_V1 } from '@happier-dev/protocol/account/publicProfile';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resolveAuthCredentialsScopeKey } from '@/auth/storage/resolveAuthCredentialsScopeKey';
import { buildProviderAccountUsageScopeKey } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageLoadRoute';
import { updateProviderAccountUsageCacheEntries } from '@/sync/domains/connectedServices/accountUsage/providerAccountUsageCache';
import { DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1, PublicProfileReadResultV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, type UsageSessionEvidenceResponse } from '@happier-dev/protocol/usage/usageSessionEvidence';

const clipboard = vi.hoisted(() => ({ image: vi.fn(async (_base64: string) => {}) }));
// The operating-system clipboard is the boundary; captured Account, Action admission,
// real Usage Resource, composition and delivery wiring stay real.
vi.mock('expo-clipboard', () => ({ setImageAsync: clipboard.image }));

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
async function signOutCapturedAccount() {
  const target = home?.homes.a;
  if (!target) throw new Error('Expected captured Home fixture');
  await TokenStorage.removeCredentialsForServerUrl(target.serverUrl, { serverId: target.id });
}
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); await home?.dispose(); home = undefined; clipboard.image.mockClear(); });
const accounting: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
  tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 },
  cost: { reportedUsd: 99, estimatedUsd: 0, currency: 'USD' } },
  breakdowns: { model: [{ key: 'private-id', label: 'Private Model', eventCount: 1,
    tokens: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 12 }, cost: { reportedUsd: 99, estimatedUsd: 0, currency: 'USD' } }] } };
async function context(denied = false, route?: Parameters<typeof serveAccountHomes>[0]['route']) {
  const sessionBatch = createSessionReadBatchHttpBoundary(async request => (await route?.(request))
    ?? (denied && request.path === '/v2/usage/query-batch' ? new Response('denied', { status: 403 })
      : request.path === '/v2/usage/query' ? Response.json(accounting) : undefined));
  home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://recap-export.test', accountId: 'account-a' }],
    route: sessionBatch.handle });
  const focused = home.homes.a!;
  publishAppliedActiveServerSnapshot({ serverId: focused.id, serverUrl: focused.serverUrl, generation: 0 });
  return { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const }, serverId: focused.id, expectedAccountId: 'account-a' };
}
const input = { query: normalizeUsageQuery({ period: { startMs: 100, endMs: 900 } }), style: 'holo', format: 'square', selectedFields: ['tokens', 'modelMix'] };

describe('recap export through the real captured UI Account Action', () => {
  it.each([400, 404])('refuses Happier-only composition on an unsupported %s query without broadening through legacy transport', async status => {
    // Endpoint refusal is distinct from a batch slice's privacy-preserving not_found.
    const caller = await context(false, request => request.path === '/v2/usage/query-batch'
      ? Response.json({ error: 'unsupported query' }, { status }) : undefined);
    const result = await createDefaultActionExecutor().execute('usage.recap.private.compose', { ...input, sourceSelection: 'happier_only' }, caller);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'accounting_unavailable' } });
    expect(home!.requests.some(request => request.path === '/v1/usage/query')).toBe(false);
    const requests = home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch');
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) expect(request.body).toHaveProperty('queries.0.filters.execution', 'happier');
  });
  it('uses one independent witnessed source selection for compose, export and device delivery', async () => {
    const requests: unknown[] = [];
    const caller = await context(false, request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const body = UsageAnalyticsQueryRequestSchema.parse(request.body);
      requests.push(body);
      const total = body.filters?.execution === 'happier' ? 8 : 12;
      const tokens = { ...accounting.totals.tokens, input: total - 2, total };
      return Response.json({ ...accounting, totals: { ...accounting.totals,
        tokens }, breakdowns: { model: accounting.breakdowns?.model?.map(row => ({ ...row, tokens })) },
        coverage: { status: 'partial', reasons: ['unknown_source'], sources: [], missingDimensions: [],
          range: { startMs: 100, endMs: 900, complete: false }, ranked: [] } });
    });
    const rendered: unknown[] = [];
    const executor = createDefaultActionExecutor({ usageRecapRender: async compose => {
      rendered.push(compose);
      return { kind: 'rendered', base64: 'iVBORw==' };
    } });
    for (const [sourceSelection, total] of [['whole_usage', 12], ['happier_only', 8]] as const) {
      const selected = { ...input, query: normalizeUsageQuery({ ...input.query, sources: ['native'], execution: 'outside' }), sourceSelection };
      const preview = await executor.execute('usage.recap.private.compose', selected, caller);
      expect(preview).toMatchObject({ ok: true, result: { kind: 'composed', sourceSelection,
        facts: { tokens: { total }, modelMix: [{ tokens: total }] }, coverage: { accounting: { reasons: ['unknown_source'] } } } });
      const exported = await executor.execute('usage.recap.private.export', selected, caller);
      expect(exported).toMatchObject({ ok: true, result: { kind: 'exported', compose: preview.ok ? preview.result : null } });
      const delivered = await executor.execute('usage.recap.private.deliver', { ...selected, intent: 'copy' }, caller);
      expect(delivered).toMatchObject({ ok: true, result: { kind: 'delivered', compose: preview.ok ? preview.result : null } });
      expect(rendered.slice(-2)).toEqual([preview.ok ? preview.result : null, preview.ok ? preview.result : null]);
    }
    expect(requests.length).toBeGreaterThan(0);
    for (const raw of requests) expect(raw).not.toHaveProperty('filters.sources');
    expect(requests).toEqual(expect.arrayContaining([expect.objectContaining({ filters: expect.objectContaining({ execution: 'happier' }) })]));
  });
  it.each(['updated', 'outcome_unknown', 'unavailable'] as const)('separates public views before, during and after an issued %s publication mutation', async outcome => {
    const heldReads = createDeferred<void>();
    const heldWrite = createDeferred<void>();
    const writeIssued = createDeferred<void>();
    let published = true;
    const publicView = PublicProfileReadResultV1Schema.parse({ kind: 'published', view: {
      v: 1, handle: 'public-person', indexable: false, state: 'published', identity: {}, metadata: {},
      service: { displayName: 'Test Home', publicBaseUrl: 'https://public.test' },
      snapshot: { v: 1, computedAtMs: 500, period: { startMs: 100, endMs: 900, timeZoneOffsetMinutes: 0 },
        coverage: { status: 'complete_for_supplied_facts', method: 'runtime' }, fieldCoverage: {}, facts: { tokens: 12 } },
      layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
      urls: { page: 'https://public.test/person', json: 'https://public.test/person.json', badgeBase: 'https://public.test/badge',
        card: 'https://public.test/card', og: 'https://public.test/og', report: 'https://public.test/report' },
    } });
    const caller = await context(false, async request => {
      if (request.path === '/v1/account/public-profile/view') {
        const view = published ? publicView : { kind: 'unavailable' };
        await heldReads.promise;
        return Response.json(view);
      }
      if (request.method !== 'GET' && request.path.startsWith('/v1/account/public-profile')) {
        writeIssued.resolve();
        await heldWrite.promise;
        if (outcome !== 'unavailable') published = false;
        if (outcome === 'outcome_unknown') throw new TypeError('Response lost after mutation dispatch');
        return Response.json(outcome === 'updated' ? { kind: 'updated', record: null }
          : { kind: 'unavailable', reason: 'feature_disabled' });
      }
      return undefined;
    });
    const executor = createDefaultActionExecutor();
    const recap = () => executor.execute('usage.recap.compose', { source: { kind: 'public_profile' } }, caller);
    const reads = () => home!.requests.filter(request => request.path === '/v1/account/public-profile/view');
    const before = recap();
    const pending: Promise<unknown>[] = [before];
    try {
      await vi.waitFor(() => expect(reads()).toHaveLength(1));
      // This is the real Home family mutation transport, below independent Action admission.
      const mutation = createHomeDomainActionExecutorForScope({ serverId: caller.serverId, accountId: 'account-a' })({
        actionId: 'account.public_profile.unpublish', input: {}, context: caller,
      });
      pending.push(mutation);
      await writeIssued.promise;
      const during = recap();
      pending.push(during);
      await vi.waitFor(() => expect(reads()).toHaveLength(2));
      heldWrite.resolve();
      expect(await mutation).toMatchObject(outcome === 'updated' ? { kind: 'updated', record: null }
        : outcome === 'unavailable' ? { kind: 'unavailable', reason: 'feature_disabled' }
          : { ok: false, errorCode: 'outcome_unknown' });
      const after = recap();
      pending.push(after);
      await vi.waitFor(() => expect(reads()).toHaveLength(3));
      heldReads.resolve();
      const [beforeResult, duringResult, afterResult] = await Promise.all([before, during, after]);
      for (const result of [beforeResult, duringResult]) expect(result).toMatchObject({ ok: true,
        result: { kind: 'composed', source: 'public_profile', publicSnapshot: { facts: { tokens: 12 } } } });
      expect(afterResult).toMatchObject(outcome === 'unavailable' ? { ok: true,
        result: { kind: 'composed', source: 'public_profile', publicSnapshot: { facts: { tokens: 12 } } } }
        : { ok: true, result: { kind: 'unavailable', reason: 'public_profile_unavailable' } });
    } finally { heldReads.resolve(); heldWrite.resolve(); await Promise.allSettled(pending); }
  });

  it('shares public-view acquisition after independent recap admission while cancellation stays private', async () => {
    const held = createDeferred<void>();
    const caller = await context(false, async request => {
      if (request.path !== '/v1/account/public-profile/view') return undefined;
      await held.promise;
      return Response.json({ kind: 'unavailable' });
    });
    const executor = createDefaultActionExecutor();
    const input = { source: { kind: 'public_profile' } };
    const abort = new AbortController();
    const departed = executor.execute('usage.recap.compose', input, { ...caller, signal: abort.signal });
    void departed.catch(() => {});
    const live = executor.execute('usage.recap.compose', input, caller);
    const reads = () => home!.requests.filter(request => request.path === '/v1/account/public-profile/view');
    try {
      await vi.waitFor(() => expect(reads().length).toBeGreaterThan(0));
      await flushHookEffects({ cycles: 20 });
      expect(reads()).toHaveLength(1);
      abort.abort();
      held.resolve();
      await expect(departed).rejects.toMatchObject({ name: 'AbortError' });
      expect(await live).toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'public_profile_unavailable' } });
      expect(home!.requests.some(request => request.path === '/v2/usage/query')).toBe(false);
      await executor.execute('usage.recap.compose', input, caller);
      expect(reads()).toHaveLength(2);
    } finally { held.resolve(); await Promise.allSettled([departed, live]); }
  });

  it('reads only the current captured public view and refuses its response after Account retirement', async () => {
    let retireOnRead = false;
    let refusal: 'credential_scope_denied' | 'present_user_required' | undefined;
    const caller = await context(false, async request => {
      if (request.path !== '/v1/account/public-profile/view') return undefined;
      if (retireOnRead) await signOutCapturedAccount();
      if (refusal) return Response.json({ error: refusal }, { status: 403 });
      return Response.json({ kind: 'unavailable' });
    });
    const input = { source: { kind: 'public_profile' } };
    expect(await createDefaultActionExecutor().execute('usage.recap.compose', input, caller))
      .toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'public_profile_unavailable' } });
    expect(home!.requests.some(request => request.path === '/v2/usage/query')).toBe(false);
    refusal = 'credential_scope_denied';
    expect(await createDefaultActionExecutor().execute('usage.recap.compose', input, caller))
      .toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    refusal = 'present_user_required';
    expect(await createDefaultActionExecutor().execute('usage.recap.compose', input, caller))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    refusal = undefined;
    retireOnRead = true;
    expect(await createDefaultActionExecutor().execute('usage.recap.compose', input, caller))
      .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
  });
  it.each([
    { name: 'default all-time', query: {} },
    { name: 'start-only', query: { period: { startMs: 100 } } },
  ])('delivers private recap for an open $name period using admitted accounting bounds', async ({ query }) => {
    const caller = await context(false, request => request.path === '/v2/usage/query'
      ? Response.json({ ...accounting,
        insights: { activeDays: 1, longestStreakDays: 1, sessionsUsed: 1, messagesUsed: 1, modelsTried: 1, favoriteModelChangeCount: 0 },
        coverage: { status: 'partial', reasons: [], sources: [], missingDimensions: [], ranked: [],
          range: { startMs: 100, endMs: 900, complete: false } } }) : undefined);
    // Rasterization and the OS clipboard are boundaries; the Action, Resource and composition stay real.
    const executor = createDefaultActionExecutor({ usageRecapRender: async () => ({ kind: 'rendered', base64: 'iVBORw==' }) });
    const delivered = await executor.execute('usage.recap.private.deliver', { query, sourceSelection: 'whole_usage',
      style: 'daybreak', format: 'square', selectedFields: ['tokens', 'activeDays'], intent: 'copy' }, caller);
    expect(delivered, JSON.stringify(delivered))
      .toMatchObject({ ok: true, result: { kind: 'delivered', compose: { kind: 'composed',
        period: { startMs: 100, endMs: 900 }, facts: { tokens: { total: 12 }, activeDays: 1 } } } });
    expect(clipboard.image.mock.calls).toEqual([['iVBORw==']]);
  });
  it('delivers admitted rendered facts through the real clipboard port and refuses a retired capture', async () => {
    const caller = await context();
    const executor = createDefaultActionExecutor({ usageRecapRender: async () => ({ kind: 'rendered', base64: 'iVBORw==' }) });
    expect(await executor.execute('usage.recap.private.deliver', { ...input, intent: 'copy' }, caller))
      .toMatchObject({ ok: true, result: { kind: 'delivered', compose: { kind: 'composed' } } });
    expect(clipboard.image.mock.calls).toEqual([['iVBORw==']]);
    clipboard.image.mockClear();
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
    const settings = storage.getState().settings;
    storage.setState({ settings: { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
      v: 1, actions: { 'usage.recap.private.deliver': { enabled: false } },
    }) } });
    expect(await executor.execute('usage.recap.private.deliver', { ...input, intent: 'copy' }, caller)).toMatchObject({ ok: false });
    expect(clipboard.image.mock.calls).toEqual([]);
    storage.setState({ settings });
    const stale = createDefaultActionExecutor({ usageRecapRender: async () => {
      await signOutCapturedAccount();
      return { kind: 'rendered', base64: 'iVBORw==' };
    } });
    const retired = await stale.execute('usage.recap.private.deliver', { ...input, intent: 'copy' }, caller);
    expect(retired, JSON.stringify(retired))
      .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    expect(clipboard.image.mock.calls).toEqual([]);
  });
  it.each(['cancelled', 'retired'] as const)('reports the acknowledged clipboard effect when its caller is %s during completion', async departure => {
    const caller = await context();
    const controller = new AbortController();
    clipboard.image.mockImplementationOnce(async () => {
      if (departure === 'cancelled') controller.abort();
      else await signOutCapturedAccount();
    });
    const executor = createDefaultActionExecutor({ usageRecapRender: async () => ({ kind: 'rendered', base64: 'iVBORw==' }) });
    const result = await executor.execute('usage.recap.private.deliver', { ...input, intent: 'copy' },
      { ...caller, signal: controller.signal });
    expect(clipboard.image.mock.calls).toEqual([['iVBORw==']]);
    expect(result).toMatchObject({ ok: true, result: { kind: 'delivered' } });
    expect(JSON.stringify(result)).not.toContain('iVBORw==');
  });
  it('refuses unavailable shared Resource admission without starting a separate read', async () => {
    const caller = await context();
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home!.homes.a!.serverUrl))!;
    const captured = captureUiUsageQueryAccountContext(credentials)!;
    getUsageQueryResourceStore(captured).dispose();
    const settled: ActionExecuteResult[] = [];
    const controller = new AbortController();
    const pending = createDefaultActionExecutor().execute('usage.query', { queries: [input.query] }, { ...caller, signal: controller.signal })
      .then(result => { settled.push(result); });
    try {
      await vi.waitFor(() => expect(settled[0]).toMatchObject({ ok: false, errorCode: 'plugin_surface_retired' }));
      expect(home!.requests.some(request => request.path === '/v2/usage/query')).toBe(false);
    } finally {
      controller.abort();
      await pending.catch(error => {
        if (!(error instanceof Error && error.name === 'AbortError')) throw error;
      });
    }
  });

  it('admits a one-shot query without replacing an unrelated settled page accounting read', async () => {
    const caller = await context();
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home!.homes.a!.serverUrl))!;
    const captured = captureUiUsageQueryAccountContext(credentials)!;
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 900 }, includeSessionEvidence: false,
      includeTranscriptEvidence: false, includeWorkEvidence: false, includeQuotaHistory: false });
    const store = getUsageQueryResourceStore(captured);
    const page = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    let release = page.subscribe(() => {}, true);
    const accountingReads = () => home!.requests.filter(request => request.path === '/v2/usage/query'
      || request.path === '/v2/usage/query-batch').length;
    try {
      await vi.waitFor(() => expect(page.getSnapshot().pending).toBe('idle'));
      expect(page.getSnapshot().value).toBeDefined();
      release();
      const before = accountingReads();
      const other = normalizeUsageQuery({ ...query, period: { startMs: 100, endMs: 800 } });
      expect(await createDefaultActionExecutor().execute('usage.query', { queries: [other] }, caller)).toMatchObject({ ok: true });
      expect(accountingReads() - before).toBe(1);
      release = page.subscribe(() => {}, true);
      await flushHookEffects();
      await vi.waitFor(() => expect(page.getSnapshot().pending).toBe('idle'));
      expect(accountingReads() - before).toBe(1);
      expect(decodeUsageQueryResource(page.getSnapshot().value!).results[0]?.accounting?.totals.tokens.total).toBe(12);
    } finally { release(); }
  });

  it.each(['comparison missing', 'current first', 'comparison first'] as const)('waits for both requested Accounting operands (%s)', async order => {
    const finish = createDeferred<void>();
    const period = { startMs: 2000, endMs: 3000 };
    const query = normalizeUsageQuery({ period, includeComparison: true, includeQuota: false, includeCoach: false,
      includeWorkEvidence: false, includeSessionEvidence: false, includeTranscriptEvidence: false });
    const caller = await context(false, request => {
      if (request.path !== '/v2/usage/query-batch') return undefined;
      const { queries } = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
      const current = queries.find(row => row.dateRange?.startMs === period.startMs)!;
      const comparison = queries.find(row => row.dateRange?.endMs === period.startMs)!;
      const chunk = (operand: typeof current, eventCount: number) => new TextEncoder().encode(JSON.stringify({
        v: 1, results: [{ query: operand, value: { ...accounting, totals: { ...accounting.totals, eventCount } } }],
      }) + '\n');
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(order === 'comparison first' ? chunk(comparison, 7) : chunk(current, 3));
        },
        async pull(controller) {
          await finish.promise;
          if (order === 'comparison first') controller.enqueue(chunk(current, 3));
          else if (order === 'current first') controller.enqueue(chunk(comparison, 7));
          controller.close();
        },
      }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home!.homes.a!.serverUrl))!;
    const captured = captureUiUsageQueryAccountContext(credentials)!;
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    const settled: ActionExecuteResult[] = [];
    const pending = createDefaultActionExecutor().execute('usage.query', { queries: [query] }, caller)
      .then(result => { settled.push(result); return result; });
    try {
      await vi.waitFor(() => expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]).toMatchObject(
        order === 'comparison first' ? {
          sources: expect.arrayContaining([expect.objectContaining({ source: 'accounting', status: 'pending' })]),
          comparison: { source: { status: 'available' }, accounting: { totals: { eventCount: 7 } } },
        } : {
          accounting: { totals: { eventCount: 3 } },
          comparison: { source: { status: 'pending' } },
        }));
      await flushHookEffects();
      expect.soft(settled).toEqual([]);
      finish.resolve();
      const result = await pending;
      if (order === 'comparison missing') {
        expect(result).toMatchObject({ ok: false, errorCode: 'usage_query_result_invalid',
          details: { issues: [{ code: 'incomplete_batch', path: ['results'] }] } });
        await vi.waitFor(() => {
          const snapshot = entry.getSnapshot();
          expect(decodeUsageQueryResource(snapshot.value!).results[0]).toMatchObject({
            accounting: { totals: { eventCount: 3 } }, pending: false,
            comparison: { source: { status: 'error', errorCode: 'usage_query_result_invalid' } },
          });
        });
      } else {
        expect(result).toMatchObject({ ok: true, result: { results: [{
          accounting: { totals: { eventCount: 3 } },
          comparison: { source: { status: 'available' }, accounting: { totals: { eventCount: 7 } } },
        }] } });
      }
    } finally {
      finish.resolve();
      await pending;
      release();
    }
  });

  const comparisonMatrix = (['fixed', 'rolling'] as const).flatMap(window =>
    (['succeeds', 'fails', 'held'] as const).flatMap(current =>
      (['not requested', 'succeeds', 'fails with body', 'fails without body', 'held'] as const)
        .map(comparison => ({ window, current, comparison, priorFailure: false, wireFault: undefined }))));

  it.each([
    ...comparisonMatrix,
    { window: 'rolling', current: 'fails', comparison: 'succeeds', priorFailure: true, wireFault: undefined },
    { window: 'rolling', current: 'fails', comparison: 'held', priorFailure: false, wireFault: 'incomplete_batch' },
    { window: 'fixed', current: 'succeeds', comparison: 'succeeds', priorFailure: false, wireFault: 'result_membership' },
  ] as const)(
    'settles the mounted Action on $window refresh: current $current, comparison $comparison (prior failure: $priorFailure, wire fault: $wireFault)', async ({
    window, current, comparison, priorFailure, wireFault,
  }) => {
    const W0 = Date.UTC(2026, 9, 12, 12);
    const W1 = W0 + 86_400_000;
    let now = W0;
    const query = normalizeUsageQuery({
      period: window === 'fixed' ? { startMs: W0 - 86_400_000, endMs: W0 } : { relative: '7days' },
      includeComparison: comparison !== 'not requested', includeQuota: false, includeCoach: false,
      includeWorkEvidence: false, includeSessionEvidence: false, includeTranscriptEvidence: false,
    });
    const currentPeriod = (atMs: number) => resolveUsageQueryPeriod(query, atMs);
    const priorPeriod = (atMs: number) => {
      const { startMs, endMs } = currentPeriod(atMs);
      return { startMs: 2 * startMs! - endMs!, endMs: startMs };
    };
    const errorCode = 'usage_query_failed';
    const failure = { status: 'error', errorCode };
    const holds = current === 'held' || comparison === 'held';
    const admit = createDeferred<void>();
    const releaseHeld = createDeferred<void>();
    let transportIssued = false;
    let phase: 'initial' | 'old error with body' | 'refresh' = 'initial';
    const caller = await context(false, request => {
      if (request.path !== '/v2/usage/query-batch') return undefined;
      const { queries } = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
      const rows = queries.map(operand => {
        const comparisonOperand = operand.dateRange?.endMs === currentPeriod(now).startMs;
        const failed = comparisonOperand ? priorFailure && phase === 'initial' || comparison === 'fails without body'
          || comparison === 'fails with body' && phase !== 'initial' : current === 'fails' && phase === 'refresh';
        const held = phase === 'refresh' && (comparisonOperand ? comparison === 'held' : current === 'held');
        const eventCount = (phase === 'refresh' ? 30 : 10) + (comparisonOperand ? 1 : 0);
        const value: UsageAnalyticsQueryBatchResponse['results'][number] = failed ? { query: operand, error: errorCode }
          : { query: operand, value: { ...accounting, totals: { ...accounting.totals, eventCount },
            coverage: { status: 'complete', reasons: [], sources: [], missingDimensions: [],
              range: { ...operand.dateRange, complete: true }, ranked: [] } } };
        return { value, held };
      });
      if (phase !== 'refresh') return Response.json({ v: 1, results: rows.map(row => row.value) });
      const chunk = (held: boolean) => new TextEncoder().encode(JSON.stringify({
        v: 1, results: rows.filter(row => row.held === held).map(row => row.value),
      }) + '\n');
      transportIssued = true;
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          await admit.promise;
          if (rows.some(row => !row.held)) controller.enqueue(chunk(false));
          await releaseHeld.promise;
          if (wireFault === 'result_membership') controller.enqueue(chunk(false));
          else if (wireFault !== 'incomplete_batch' && rows.some(row => row.held)) controller.enqueue(chunk(true));
          controller.close();
        },
      }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home!.homes.a!.serverUrl))!;
    const captured = captureUiUsageQueryAccountContext(credentials)!;
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const read = () => {
      const value = entry.getSnapshot().value;
      return value && decodeUsageQueryResource(value).results[0];
    };
    const release = entry.subscribe(() => {}, true);
    const actionLifetime = new AbortController();
    let refresh: ReturnType<typeof entry.refresh> | undefined;
    let action: Promise<void> | undefined;
    let result: ActionExecuteResult | undefined;
    try {
      await vi.waitFor(() => expect(read()?.accounting?.totals.eventCount).toBe(10));
      await vi.waitFor(() => expect(entry.getSnapshot()).toMatchObject({ pending: 'idle' }));
      if (window === 'rolling' && comparison === 'fails with body') {
        phase = 'old error with body';
        await entry.refresh();
        expect(read()?.comparison).toMatchObject({ query: { period: priorPeriod(W0) }, source: failure,
          accounting: { totals: { eventCount: 11 } } });
      }

      phase = 'refresh';
      now = window === 'rolling' ? W1 : W0;
      refresh = entry.refresh();
      await vi.waitFor(() => expect(transportIssued).toBe(true));
      action = createDefaultActionExecutor().execute('usage.query', { queries: [query] }, { ...caller, signal: actionLifetime.signal })
        .then(settled => { result = settled; });
      await flushHookEffects();
      expect(result).toBeUndefined();
      const startingPage = read();
      expect(startingPage?.sources.find(source => source.source === 'accounting')?.status).toMatch(/^(pending|available|stale|error)$/);
      if (comparison !== 'not requested') expect(startingPage?.comparison?.source.status).toMatch(/^(pending|available|stale|error)$/);
      admit.resolve();

      const retainsOldWindow = window === 'rolling' && current === 'fails';
      const displayedWindow = retainsOldWindow ? W0 : now;
      const comparisonSummary = (slice: NonNullable<ReturnType<typeof read>>) => ({
        current: slice.sources.find(source => source.source === 'accounting')?.status,
        currentCause: slice.sources.find(source => source.source === 'accounting')?.errorCode,
        currentCount: slice.accounting?.totals.eventCount,
        currentWindow: slice.accounting?.coverage?.range?.endMs,
        comparison: slice.comparison?.source.status,
        comparisonCause: slice.comparison?.source.errorCode,
        comparisonCount: slice.comparison?.accounting?.totals.eventCount,
        comparisonPeriod: slice.comparison?.query.period,
      });
      const failedComparison = comparison === 'fails with body' || comparison === 'fails without body';
      if (holds) {
        await vi.waitFor(() => {
          const page = comparisonSummary(read()!);
          expect(page.current).toBe(current === 'held' ? 'pending' : current === 'fails' ? 'error' : 'available');
          if (comparison === 'not requested') {
            expect(page.comparison).toBeUndefined();
          } else if (window === 'rolling' && current === 'held') {
            // While current has no W1 body the page can only compare its W0 facts.
            expect(page.comparisonPeriod).toEqual(priorPeriod(W0));
            expect(page.comparison).toBe(failedComparison ? 'error' : 'pending');
            expect(page.comparisonCause).toBe(failedComparison ? errorCode : undefined);
          } else {
            const status = failedComparison ? 'error' : comparison === 'succeeds' ? 'available'
              : retainsOldWindow ? 'stale' : 'pending';
            expect(page.comparison).toBe(status);
            expect(page.comparisonCause).toBe(failedComparison ? errorCode : undefined);
          }
        });
        await flushHookEffects();
        // The selected W0 pair does not make an issued W1 operand optional.
        expect.soft(result).toBeUndefined();
      }
      if (wireFault === 'result_membership') {
        await vi.waitFor(() => expect(result).toMatchObject({ ok: true }));
        await vi.waitFor(() => expect(entry.getSnapshot()).toMatchObject({ pending: 'idle' }));
      }
      releaseHeld.resolve();
      await refresh;
      const comparisonCount = comparison === 'not requested' || comparison === 'fails without body' || priorFailure ? undefined
        : retainsOldWindow ? 11
          : failedComparison ? (window === 'fixed' ? 11 : undefined)
            : 31;
      const expected = {
        current: current === 'fails' ? 'error' : 'available',
        currentCause: current === 'fails' ? errorCode : undefined,
        currentCount: current === 'fails' ? 10 : 30,
        currentWindow: displayedWindow,
        comparison: comparison === 'not requested' ? undefined : failedComparison || priorFailure ? 'error' : retainsOldWindow ? 'stale' : 'available',
        comparisonCause: failedComparison || priorFailure ? errorCode : undefined,
        comparisonCount,
        comparisonPeriod: comparison === 'not requested' ? undefined : priorPeriod(displayedWindow),
      };
      expect.soft(comparisonSummary(read()!)).toEqual(expected);
      await vi.waitFor(() => expect(result).toBeDefined());
      if (wireFault === 'incomplete_batch') {
        expect(result).toMatchObject({ ok: false, errorCode: 'usage_query_result_invalid',
          details: { issues: [{ code: wireFault, path: ['results'] }] } });
        expect(entry.getSnapshot().pending).toBe('idle');
        expect(entry.getSnapshot().error).toMatchObject({ code: 'usage_query_result_invalid',
          details: { issues: [{ code: 'incomplete_batch', path: ['results'] }] } });
        return;
      }
      expect(result).toMatchObject({ ok: true });
      if (!result?.ok) throw new Error('Expected admitted Accounting source states');
      const batch = UsageQueryBatchResultSchema.parse(result.result);
      expect(comparisonSummary(batch.results[0]!)).toEqual(expected);
      expect(entry.getSnapshot().pending).toBe('idle');
    } finally {
      admit.resolve();
      releaseHeld.resolve();
      actionLifetime.abort();
      await action?.catch(error => { if (error?.name !== 'AbortError') throw error; });
      await refresh;
      release();
      clock.mockRestore();
    }
  });

  it.each(['cold single', 'two entries', 'duplicate within first frame', 'duplicate while Work waits for current'] as const)(
    'shares only settled operands across entry reads (%s)', async scenario => {
    const end = createDeferred<void>();
    const period = { startMs: 2000, endMs: 3000 };
    const duplicate = scenario === 'duplicate within first frame' || scenario === 'duplicate while Work waits for current';
    const single = normalizeUsageQuery({ period, includeComparison: false, includeQuota: false, includeCoach: false,
      includeWorkEvidence: scenario === 'duplicate while Work waits for current', includeSessionEvidence: false,
      includeTranscriptEvidence: false, includeActivity: false });
    const paired = normalizeUsageQuery({ ...single, includeComparison: true });
    const executorInput = { queries: [scenario === 'two entries' ? paired : single] };
    let requests = 0;
    const caller = await context(false, request => {
      if (request.path !== '/v2/usage/query-batch') return undefined;
      requests++;
      const { queries } = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
      const current = queries.find(row => row.dateRange?.startMs === period.startMs)!;
      const row = { query: current, value: { ...accounting, totals: { ...accounting.totals, eventCount: 3 } } };
      return new Response(new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({
            v: 1, results: duplicate ? [row, row] : [row],
          }) + '\n'));
          await end.promise;
          controller.close();
        },
      }), { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home!.homes.a!.serverUrl))!;
    const captured = captureUiUsageQueryAccountContext(credentials)!;
    const store = getUsageQueryResourceStore(captured);
    const page = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(executorInput) });
    const release = page.subscribe(() => {}, true);
    const executor = createDefaultActionExecutor();
    let result: ActionExecuteResult | undefined;
    const action = executor.execute('usage.query', executorInput, caller).then(reply => { result = reply; });
    const view = () => {
      const content = page.getSnapshot().value;
      return content && decodeUsageQueryResource(content).results[0];
    };
    const failure = (code: string) => ({ errorCode: 'usage_query_result_invalid', details: { issues: [{ code, path: ['results'] }] } });
    const success = { ok: true, result: { results: [{ accounting: { totals: { eventCount: 3 } } }] } };
    try {
      if (duplicate) {
        await vi.waitFor(() => expect(result).toMatchObject({ ok: false, ...failure('result_membership') }));
        expect(page.getSnapshot()).toMatchObject({ pending: 'idle', error: { code: 'usage_query_result_invalid',
          details: failure('result_membership').details } });
        expect(view()?.accounting).toBeUndefined();
        expect(view()?.sources).toContainEqual(expect.objectContaining({ source: 'accounting', status: 'error',
          errorCode: 'usage_query_result_invalid' }));
        if (scenario === 'duplicate while Work waits for current') {
          expect(view()?.pending).toBe(false);
          expect(view()?.sources).toContainEqual(expect.objectContaining({ source: 'work', status: 'error',
            errorCode: 'usage_query_result_invalid' }));
        }
        return;
      }
      await vi.waitFor(() => expect(view()?.accounting?.totals.eventCount).toBe(3));
      if (scenario === 'cold single') {
        await vi.waitFor(() => expect(result).toMatchObject(success));
        expect(page.getSnapshot()).toMatchObject({ pending: 'idle' });
      } else {
        const siblingInput = { queries: [single] };
        const sibling = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(siblingInput) });
        const stopSibling = sibling.subscribe(() => {}, true);
        try {
          expect(await executor.execute('usage.query', siblingInput, caller)).toMatchObject(success);
          expect(sibling.getSnapshot()).toMatchObject({ pending: 'idle' });
          expect(requests).toBe(1);
          expect(view()?.comparison?.source.status).toBe('pending');
          expect.soft(result).toBeUndefined();
          end.resolve();
          await action;
          expect(result).toMatchObject({ ok: false, ...failure('incomplete_batch') });
          expect(page.getSnapshot()).toMatchObject({ pending: 'idle', error: { code: 'usage_query_result_invalid',
            details: failure('incomplete_batch').details } });
          expect(view()?.accounting?.totals.eventCount).toBe(3);
          expect(sibling.getSnapshot().error).toBeUndefined();
        } finally { stopSibling(); }
      }
    } finally {
      end.resolve();
      await action;
      release();
    }
  });

  it.each([false, true])('hands off a withdrawn Session while detail is held (includeCoach: %s)', async includeCoach => {
    const detail = createDeferred<Response>();
    const detailStarted = createDeferred<void>();
    const releasePreferences = createDeferred<void>();
    const sessionId = 'handoff-withdrawal';
    const original = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 }, session: [sessionId],
      includeComparison: false, includeQuota: false, includeCoach, includeWorkEvidence: false,
      includeSessionEvidence: true, includeTranscriptEvidence: false });
    const refusal = normalizeUsageQuery({ ...original, period: { startMs: 3000, endMs: 4000 }, includeSessionEvidence: false });
    const kv = createAccountKvHttpFixture();
    const caller = await context(false, async request => {
      if (request.path === '/v1/kv/bulk' && request.accountId !== null) {
        await releasePreferences.promise;
        return (await kv.handleFetch(request.url, { method: request.method, body: JSON.stringify(request.body) })) ?? undefined;
      }
      if (request.path === '/v2/usage/query-batch') {
        const { queries } = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
        return Response.json({ v: 1, results: queries.map(query => query.dateRange?.startMs === 3000
          ? { query, error: 'not_found' } : { query, value: accounting }) });
      }
      if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
        detailStarted.resolve();
        return detail.promise;
      }
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      return undefined;
    });
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home!.homes.a!.serverUrl))!;
    const owner = getUsageQueryResourceStore(captureUiUsageQueryAccountContext(credentials)!);
    const first = { queries: [original] };
    const entry = owner.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(first) });
    const release = entry.subscribe(() => {}, true);
    const executor = createDefaultActionExecutor();
    const withdrawn = { sources: expect.arrayContaining([expect.objectContaining({ source: 'accounting', errorCode: 'denied' })]) };
    const abort = new AbortController();
    let action: Promise<ActionExecuteResult> | undefined;
    try {
      await detailStarted.promise;
      await vi.waitFor(() => expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]?.accounting?.totals.eventCount).toBe(1));
      expect(await executor.execute('usage.query', { queries: [refusal] }, caller)).toMatchObject({ ok: true,
        result: { results: [withdrawn] } });
      const page = decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
      expect(page).toMatchObject(withdrawn);
      expect(page.accounting).toBeUndefined();
      let reply: ActionExecuteResult | undefined;
      action = executor.execute('usage.query', first, { ...caller, signal: abort.signal }).then(result => { reply = result; return result; });
      await vi.waitFor(() => expect(reply).toMatchObject({ ok: true, result: { results: [withdrawn] } }));
      const settled = await action;
      if (settled.ok) expect(UsageQueryBatchResultSchema.parse(settled.result).results[0]?.accounting).toBeUndefined();
    } finally {
      abort.abort();
      detail.resolve(Response.json({ error: 'unavailable' }, { status: 503 }));
      releasePreferences.resolve();
      await action?.catch(error => { if (error?.name !== 'AbortError') throw error; });
      release();
    }
  });

  it.each([
    { includeCoach: true, preferences: 'immediate', standalone: false },
    { includeCoach: true, preferences: 'immediate', standalone: true },
    { includeCoach: undefined, preferences: 'immediate', standalone: false },
    { includeCoach: true, preferences: 'held success', standalone: false },
    { includeCoach: true, preferences: 'held failure', standalone: false },
  ] as const)('uses settled same-window Coach evidence ($includeCoach, preferences: $preferences, standalone: $standalone)', async ({ includeCoach, preferences, standalone }) => {
    const sessionId = 'coach-approval-pairs';
    const period = { startMs: 1000, endMs: 2000 };
    const query = normalizeUsageQuery({ period, session: sessionId, includeCoach, includeComparison: false,
      includeQuota: false, includeWorkEvidence: false, includeSessionEvidence: true, includeTranscriptEvidence: true });
    const transcriptStarted = createDeferred<void>();
    const releaseTranscript = createDeferred<void>();
    const preferencesStarted = createDeferred<void>();
    const releasePreferences = createDeferred<void>();
    const kv = createAccountKvHttpFixture();
    const caller = await context(false, async request => {
      if (request.path === '/v2/usage/query-batch') {
        const { queries } = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
        return Response.json({ v: 1, results: queries.map(query => ({ query, value: accounting })) });
      }
      if (request.path === '/v1/kv/bulk' && request.accountId !== null) {
        preferencesStarted.resolve();
        if (preferences !== 'immediate') await releasePreferences.promise;
        if (preferences === 'held failure') return Response.json({ error: 'unavailable' }, { status: 503 });
        return (await kv.handleFetch(request.url, { method: request.method, body: JSON.stringify(request.body) })) ?? undefined;
      }
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      if (request.path !== USAGE_SESSION_EVIDENCE_PATH) return undefined;
      const { requests } = UsageSessionEvidenceRequestSchema.parse(request.body);
      const transcripts = requests.some(demand => demand.query.includeTranscriptEvidence);
      if (transcripts) {
        transcriptStarted.resolve();
        await releaseTranscript.promise;
      }
      return Response.json({ requests: requests.map(({ query }) => ({ query, sessionIds: [sessionId] })),
        results: [{
          sessionId,
          detail: { status: 200, body: { session: createPlainSessionWithDisplayRecordFixture({
            id: sessionId, seq: 1, createdAt: 1100, updatedAt: 1900, active: true,
          }) } },
          turns: { status: 200, body: { v: 1, sessionId, updatedAt: 1900, turns: [] } },
          stateEvidence: { waits: [], permissions: (transcripts ? [1200, 1400] : [1200]).map(requestedAtMs => ({
            requestId: String(requestedAtMs), workId: JSON.stringify([sessionId, null]), requestedAtMs,
            decidedAtMs: requestedAtMs + 100, toolId: 'Bash', answeringClientCategory: null,
          })) },
          ...(transcripts ? { messageEvidence: { acceptedInputs: [] }, messagesComplete: true } : {}),
        }],
      } satisfies UsageSessionEvidenceResponse);
    });
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home!.homes.a!.serverUrl))!;
    const demand = { queries: [query] };
    const entry = getUsageQueryResourceStore(captureUiUsageQueryAccountContext(credentials)!)
      .getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(demand) });
    const pageSlice = () => decodeUsageQueryResource(entry.getSnapshot().value!).results[0]!;
    const { createElement } = await import('react');
    const { renderScreen } = await import('@/dev/testkit');
    const { createMountedCurrentUiContextWrapper } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
    const { UsageCoachWidget } = await import('@/components/settings/usage/widgets/UsageCoachWidget');
    const { SurfaceFreshnessLine } = await import('@/components/ui/surfaces/SurfaceFreshnessLine');
    const wrapper = await createMountedCurrentUiContextWrapper();
    const widget = () => {
      const slice = pageSlice();
      return createElement(UsageCoachWidget, { id: 'usage_coach', testID: 'mounted-coach', query, slice,
        serverId: caller.serverId, model: { refresh: async () => { await entry.refresh(); } } });
    };
    let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
    const release = standalone ? undefined : entry.subscribe(() => {}, true);
    const abort = new AbortController();
    let reply: ActionExecuteResult | undefined;
    const action = createDefaultActionExecutor().execute('usage.query', demand, { ...caller, signal: abort.signal })
      .then(result => { reply = result; return result; });
    try {
      await transcriptStarted.promise;
      await vi.waitFor(() => expect(pageSlice()).toMatchObject({ requestedQuery: { period }, pending: true,
        accounting: { totals: { eventCount: 1 } },
        howYouWork: { permissions: { pairedDecisionCount: 1 } },
        sources: expect.arrayContaining([expect.objectContaining({ source: 'how_you_work:transcripts', status: 'pending' })]),
      }));
      await flushHookEffects({ cycles: 15 });
      expect.soft(reply, 'the Action must wait for the Coach evidence for this window').toBeUndefined();
      releaseTranscript.resolve();
      if (preferences !== 'immediate') {
        await preferencesStarted.promise;
        await vi.waitFor(() => expect(pageSlice()).toMatchObject({
          howYouWork: { permissions: { pairedDecisionCount: 2 } },
          sources: expect.arrayContaining([expect.objectContaining({ source: 'how_you_work:transcripts', status: 'available' })]),
        }));
        await flushHookEffects({ cycles: 15 });
        expect.soft(reply, 'settled transcripts do not settle the Coach preference read').toBeUndefined();
        screen = await renderScreen(widget(), { wrapper });
        expect.soft(Boolean(screen.findHostByTestId('mounted-coach.loading')), 'widget shows Reading').toBe(true);
        expect.soft(Boolean(screen.findHostByTestId('mounted-coach.unavailable')), 'widget does not claim unavailability').toBe(false);
      }
      releasePreferences.resolve();
      const result = await action;
      if (!result.ok) throw new Error(result.errorCode);
      const answer = UsageQueryBatchResultSchema.parse(result.result).results[0]!;
      const coverage = (slice: typeof answer) => slice.sources.filter(({ source }) =>
        source === 'how_you_work:sessions' || source === 'how_you_work:transcripts' || source === 'how_you_work:coach');
      expect(coverage(answer)).toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'how_you_work:sessions', status: 'available' }),
        expect.objectContaining({ source: 'how_you_work:transcripts', status: 'available' }),
      ]));
      if (!standalone) {
        await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
        expect(coverage(answer)).toEqual(coverage(pageSlice()));
        expect(answer.howYouWork).toEqual(pageSlice().howYouWork);
      }
      if (preferences === 'held failure') {
        const failure = expect.objectContaining({ source: 'how_you_work:coach', status: 'error', errorCode: 'http_error' });
        expect(pageSlice().sources).toContainEqual(failure);
        await screen!.update(widget());
        const coverage = screen!.findAllByType(SurfaceFreshnessLine)
          .filter(line => line.props.testID === 'mounted-coach.coverage')
          .map(line => ({ tone: line.props.tone, retry: typeof line.props.action?.onPress === 'function' }));
        expect.soft(coverage, 'widget shows the Coach failure with Retry').toEqual([{ tone: 'warning', retry: true }]);
        expect(result).toMatchObject({ ok: true, result: { results: [{
          howYouWork: { permissions: { pairedDecisionCount: 2 } }, sources: expect.arrayContaining([failure]),
        }] } });
        return;
      }
      expect(result).toMatchObject({ ok: true, result: { results: [{
        requestedQuery: { period }, pending: false, howYouWork: { permissions: { pairedDecisionCount: 2 } },
        coach: { findings: expect.arrayContaining([expect.objectContaining({ detectorId: 'approval_friction',
          measurements: expect.arrayContaining([expect.objectContaining({ metric: 'permission_requests', value: 2 })]),
        })]) },
      }] } });
      if (!standalone) expect(answer.coach).toEqual(pageSlice().coach);
      if (screen) {
        await screen.update(widget());
        expect(Boolean(screen.findHostByTestId('mounted-coach.loading'))).toBe(false);
        expect(Boolean(screen.findHostByTestId('mounted-coach.unavailable'))).toBe(false);
      }
    } finally {
      await screen?.unmount();
      abort.abort();
      releaseTranscript.resolve();
      releasePreferences.resolve();
      await action.catch(() => undefined);
      release?.();
    }
  });

  it.each(['coach_evidence', 'public_profile'] as const)(
    'returns a terminal %s error after successful Accounting and a new page fallback',
    async usageQueryReadiness => {
      const coach = usageQueryReadiness === 'coach_evidence';
      const sessionId = 'terminal-evidence';
      const detail = createDeferred<Response>();
      const privateRead = createDeferred<void>();
      const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 }, session: [sessionId],
        includeComparison: false, includeQuota: false, includeCoach: coach, includeWorkEvidence: false,
        includeSessionEvidence: true, includeTranscriptEvidence: false });
      const kv = createAccountKvHttpFixture();
      const caller = await context(false, async request => {
        if (request.path === '/v2/usage/query-batch') {
          const { queries } = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
          return Response.json({ v: 1, results: queries.map(query => ({ query, value: accounting })) });
        }
        if (request.path === '/v1/kv/bulk' && request.accountId !== null) {
          return (await kv.handleFetch(request.url, { method: request.method, body: JSON.stringify(request.body) })) ?? undefined;
        }
        if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
          privateRead.resolve();
          return detail.promise.then(response => response.clone());
        }
        if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        return undefined;
      });
      const credentials = (await TokenStorage.getCredentialsForServerUrl(home!.homes.a!.serverUrl))!;
      const input = { queries: [query] };
      const entry = getUsageQueryResourceStore(captureUiUsageQueryAccountContext(credentials)!)
        .getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport(input) });
      const release = entry.subscribe(() => {}, true);
      const executor = createDefaultActionExecutor();
      const abort = new AbortController();
      let evidenceResult: ActionExecuteResult | undefined;
      const wanted = executor.execute('usage.query', input, { ...caller, usageQueryReadiness, signal: abort.signal })
        .then(result => { evidenceResult = result; });
      try {
        await privateRead.promise;
        await vi.waitFor(() => expect(decodeUsageQueryResource(entry.getSnapshot().value!).results[0]).toMatchObject({
          pending: true, accounting: { totals: { eventCount: 1 } },
        }));
        expect(evidenceResult).toBeUndefined();
        const progress = entry.getSnapshot().value;
        detail.resolve(Response.json({ requests: [], results: [] }));
        await vi.waitFor(() => expect(entry.getSnapshot()).toMatchObject({
          pending: 'idle', error: { code: 'usage_query_failed' },
        }));
        const failed = entry.getSnapshot();
        expect(failed.value).toBeDefined();
        expect(failed.value).not.toBe(progress);
        expect(decodeUsageQueryResource(failed.value!).results[0]).toMatchObject({ pending: false,
          accounting: { totals: { eventCount: 1 } },
          sources: expect.arrayContaining([expect.objectContaining({
            source: 'how_you_work', status: 'error', errorCode: 'usage_query_failed',
          })]),
        });
        await flushHookEffects({ cycles: 15 });
        expect(evidenceResult).toMatchObject({ ok: false, errorCode: failed.error?.code });
      } finally {
        abort.abort();
        detail.resolve(Response.json({ error: 'unavailable' }, { status: 503 }));
        await wanted.catch(() => undefined);
        release();
      }
    });

  it('shares the progressing page Resource and leaves its subscriber alive after a one-shot Action settles', async () => {
    const query = normalizeUsageQuery({ ...input.query, includeWorkEvidence: false, includeCoach: false, includeQuota: false });
    const privateSession = createDeferred<Response>();
    const caller = await context(false, request => request.path === '/v2/usage/query'
      ? Response.json({ ...accounting, contributions: [{ id: 'cost', observedAtMs: 500, sessionId: 'work-session',
        turnId: 'turn', agentId: null, modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null,
        tokens: accounting.totals.tokens, cost: accounting.totals.cost }] })
      : request.path === USAGE_SESSION_EVIDENCE_PATH ? privateSession.promise.then(async detail => Response.json({
        requests: UsageSessionEvidenceRequestSchema.parse(request.body).requests.map(demand => ({ query: demand.query, sessionIds: ['work-session'] })),
        results: [{ sessionId: 'work-session', detail: { status: detail.status, body: await detail.json() } }],
      }))
        : request.path === '/v1/account/encryption/currentness' ? Response.json({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }) : undefined);
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home!.homes.a!.serverUrl))!;
    const captured = captureUiUsageQueryAccountContext(credentials)!;
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = entry.subscribe(() => {}, true);
    const read = () => entry.getSnapshot().value ? decodeUsageQueryResource(entry.getSnapshot().value!) : undefined;
    try {
      await vi.waitFor(() => expect(read()?.results[0]?.accounting).toBeDefined());
      const accountingReads = () => home!.requests.filter(request => request.path === '/v2/usage/query' || request.path === '/v2/usage/query-batch').length;
      const before = accountingReads();
      const executed = await createDefaultActionExecutor().execute('usage.query', { queries: [query] }, caller);
      expect(executed.ok).toBe(true);
      if (!executed.ok) throw new Error(executed.errorCode);
      const admitted = UsageQueryBatchResultSchema.parse(executed.result);
      expect(admitted.results[0]?.pending).toBe(true);
      const resource = UsageQueryBatchResultSchema.parse(read()).results[0]!;
      expect(admitted.results[0]).toMatchObject({ key: resource.key, requestedQuery: resource.requestedQuery,
        shownQuery: resource.shownQuery, accounting: { totals: resource.accounting?.totals }, sources: resource.sources });
      expect(admitted.results[0]?.accounting?.contributions).toEqual(resource.accounting?.contributions);
      expect(admitted.results[0]?.howYouWork).toEqual(resource.howYouWork);
      expect(admitted.results[0]?.coach).toEqual(resource.coach);
      expect(admitted.results[0]?.sources).toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'pending' }));
      // The Action delivers facts, not the Resource's retained tariff inventory.
      expect(admitted.results[0]?.accounting?.priceCatalog).toBeUndefined();
      expect(resource.accounting?.priceCatalog).toBeDefined();
      expect(accountingReads()).toBe(before);
      privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
      await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
      expect(read()?.results[0]?.sources).not.toContainEqual(expect.objectContaining({ source: 'how_you_work', status: 'pending' }));
      expect(entry.getSnapshot().subscription).toBe('live');
      expect(admitted.results[0]?.pending).toBe(true);
    } finally { privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 })); release(); }
  });

  it('keeps public preview waiting for requested private evidence through an unrelated provider quota publication', async () => {
    const privateSession = createDeferred<Response>();
    const observedAtMs = Date.now() - 1000;
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'preview-quota' };
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    const quota = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs,
      fetchedAtMs: observedAtMs, staleAfterMs: 60_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
    let accountingReads = 0;
    let privateReads = 0;
    let privateAborts = 0;
    const caller = await context(false, request => {
      if (request.path === '/v1/account/public-profile') return Response.json({ kind: 'absent', context: {
        handle: 'public-person', identity: {}, service: null, urls: null,
      } });
      if (request.path === '/v2/usage/query') {
        accountingReads++;
        const range = UsageAnalyticsQueryRequestSchema.parse(request.body).dateRange!;
        return Response.json({ ...accounting, contributions: [{ id: 'cost', observedAtMs, sessionId: 'preview-session',
          turnId: 'turn', agentId: null, modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null,
          tokens: accounting.totals.tokens, cost: accounting.totals.cost }],
          coverage: { status: 'complete', reasons: [], sources: [{ source: 'runtime', path: 'runtime', status: 'available',
            eventCount: 1, asOfMs: observedAtMs, historyComplete: true }], missingDimensions: [],
            range: { ...range, complete: true }, ranked: [] } });
      }
      if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
        privateReads++;
        expect(request.signal?.aborted).toBe(false);
        request.signal?.addEventListener('abort', () => { privateAborts++; }, { once: true });
        return privateSession.promise.then(async detail => Response.json({
          requests: UsageSessionEvidenceRequestSchema.parse(request.body).requests.map(demand => ({ query: demand.query, sessionIds: ['preview-session'] })),
          results: [{ sessionId: 'preview-session', detail: { status: detail.status, body: await detail.json() } }],
        }));
      }
      if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
      return undefined;
    });
    storage.setState({ profileScope: { serverId: caller.serverId, accountId: 'account-a' }, profile: AccountProfileSchema.parse({
      id: 'account-a', connectedAccountsV4: [{ ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [] }],
    }) });
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home!.homes.a!.serverUrl))!;
    const providerScope = buildProviderAccountUsageScopeKey({ serverId: caller.serverId,
      generation: getActiveServerSnapshot().generation, credentialScope: resolveAuthCredentialsScopeKey(credentials) });
    const settled: ActionExecuteResult[] = [];
    const pending = createDefaultActionExecutor().execute('account.public_profile.preview', {
      policy: { indexable: false, fields: Object.fromEntries(Object.keys(DEFAULT_PUBLIC_PROFILE_POLICY_V1.fields)
        .map(field => [field, field === 'tokens' || field === 'agentTime'])) },
      metadataSelection: {}, query: normalizeUsageQuery({ period: { relative: '90days' } }),
      layout: { v: 1, items: [] }, appearance: DEFAULT_PUBLIC_PROFILE_APPEARANCE_V1,
    }, caller).then(result => { settled.push(result); });
    try {
      await vi.waitFor(() => expect(privateReads).toBe(1));
      expect(accountingReads).toBe(1);
      expect(settled).toEqual([]);
      updateProviderAccountUsageCacheEntries(providerScope, entries => ({ ...entries, [quota.recordId]: {
        snapshot: quota, loading: false, hadError: false, nextFetchAtMs: observedAtMs + 60_000,
      } }));
      await flushHookEffects({ cycles: 30 });
      expect({ accountingReads, privateReads, privateAborts }).toEqual({ accountingReads: 1, privateReads: 1, privateAborts: 0 });
      expect(settled).toEqual([]);
      // A typed missing Session completes the requested private phase; public
      // accounting remains useful without inventing an agent-time fact.
      privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
      await pending;
      expect(settled, JSON.stringify(settled)).toMatchObject([{ ok: true, result: { kind: 'ready', view: { snapshot: { facts: { tokens: 12 } } } } }]);
      expect(settled[0]).not.toHaveProperty('result.view.snapshot.facts.agentTimeMs');
      expect({ accountingReads, privateReads, privateAborts }).toEqual({ accountingReads: 1, privateReads: 1, privateAborts: 0 });
    } finally {
      privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
      await pending;
      updateProviderAccountUsageCacheEntries(providerScope, entries => {
        const next = { ...entries };
        delete next[quota.recordId];
        return next;
      });
    }
  });

  it('returns Accounting for a non-Coach query while Session evidence is held', async () => {
    const privateSession = createDeferred<Response>();
    const caller = await context(false, request => request.path === '/v2/usage/query'
      ? Response.json({ ...accounting, contributions: [{ id: 'cost', observedAtMs: 500, sessionId: 'work-session',
        turnId: 'turn', agentId: null, modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null,
        tokens: accounting.totals.tokens, cost: accounting.totals.cost }] })
      : request.path === '/v2/sessions/work-session' ? privateSession.promise
        : request.path === '/v1/account/encryption/currentness' ? Response.json({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }) : undefined);
    const settled: ActionExecuteResult[] = [];
    const pending = createDefaultActionExecutor().execute('usage.query', { queries: [normalizeUsageQuery({ ...input.query, includeCoach: false })] }, caller)
      .then(result => { settled.push(result); });
    try {
      await vi.waitFor(() => expect(settled[0]?.ok).toBe(true));
      const executed = settled[0]!;
      if (!executed.ok) throw new Error('Expected useful snapshot');
      const result = UsageQueryBatchResultSchema.parse(executed.result).results[0]!;
      expect(result.accounting?.totals.tokens.total).toBe(12);
      expect(result.pending).toBe(true);
      expect(result.howYouWork?.intervals).toBeNull();
      expect(result.sources).toContainEqual({ source: 'how_you_work', status: 'pending' });
      const exported = await createDefaultActionExecutor({ usageRecapRender: async compose => {
        expect(compose.coverage.pending).toBe(true);
        expect(compose.unavailableFields).toContain('parallel');
        return { kind: 'rendered', base64: 'iVBORw==' };
      } }).execute('usage.recap.private.export', { ...input, selectedFields: ['tokens', 'parallel'] }, caller);
      expect(exported.ok).toBe(true);
      if (!exported.ok) throw new Error(exported.errorCode);
      expect(UsageRecapExportResultSchema.parse(exported.result)).toMatchObject({ kind: 'exported',
        compose: { coverage: { pending: true }, unavailableFields: ['parallel'] } });
    } finally { privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 })); await pending; }
  });

  it('renders the authorized selected query and delivers the same strict PNG result used by local surfaces', async () => {
    const caller = await context();
    let painted: unknown;
    // Rasterization is the client/platform boundary, never substituted Usage or Action logic.
    const executor = createDefaultActionExecutor({ usageRecapRender: async compose => {
      painted = compose;
      return { kind: 'rendered', base64: 'iVBORw==' };
    } });
    const executed = await executor.execute('usage.recap.private.export', input, caller);
    expect(executed.ok).toBe(true);
    if (!executed.ok) throw new Error(executed.errorCode);
    const result = UsageRecapExportResultSchema.parse(executed.result);
    expect(result).toMatchObject({ kind: 'exported', compose: painted,
      file: { mediaType: 'image/png', base64: 'iVBORw==', selectedFields: ['tokens', 'modelMix'] } });
    expect(JSON.stringify(result)).not.toMatch(/Private Model|private-id|reportedUsd|USD/);
  });
  it('withdraws PNG bytes if the real Account lifetime retires while rendering', async () => {
    const caller = await context();
    const executor = createDefaultActionExecutor({ usageRecapRender: async () => {
      await signOutCapturedAccount();
      return { kind: 'rendered', base64: 'iVBORw==' };
    } });
    const executed = await executor.execute('usage.recap.private.export', input, caller);
    expect(executed).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    expect(JSON.stringify(executed)).not.toContain('iVBORw==');
  });
  it('does not render or return file bytes for an accounting permission denial', async () => {
    const caller = await context(true);
    const executor = createDefaultActionExecutor({ usageRecapRender: async () => { throw new Error('denied facts must not render'); } });
    const executed = await executor.execute('usage.recap.private.export', input, caller);
    expect(executed).toMatchObject({ ok: false, errorCode: 'denied' });
    expect(JSON.stringify(executed)).not.toContain('base64');
  });
});
