import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { UsageRecapExportResultSchema} from '@happier-dev/protocol/usage/usageRecap';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { standardCleanup } from '@/dev/testkit';
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
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema } from '@happier-dev/protocol/usage/usageSessionEvidence';

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
  const sessionBatch = createSessionReadBatchHttpBoundary(async request => (await route?.(request)) ?? (request.path === '/v2/usage/query'
    ? denied ? new Response('denied', { status: 403 }) : Response.json(accounting) : undefined));
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
    const caller = await context(false, async request => {
      if (request.path !== '/v1/account/public-profile/view') return undefined;
      if (retireOnRead) await signOutCapturedAccount();
      return Response.json({ kind: 'unavailable' });
    });
    const input = { source: { kind: 'public_profile' } };
    expect(await createDefaultActionExecutor().execute('usage.recap.compose', input, caller))
      .toMatchObject({ ok: true, result: { kind: 'unavailable', reason: 'public_profile_unavailable' } });
    expect(home!.requests.some(request => request.path === '/v2/usage/query')).toBe(false);
    retireOnRead = true;
    expect(await createDefaultActionExecutor().execute('usage.recap.compose', input, caller))
      .toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
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

  it('shares the progressing page Resource and leaves its subscriber alive after a one-shot Action settles', async () => {
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
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [input.query] }) });
    const release = entry.subscribe(() => {}, true);
    const read = () => entry.getSnapshot().value ? decodeUsageQueryResource(entry.getSnapshot().value!) : undefined;
    try {
      await vi.waitFor(() => expect(read()?.results[0]?.accounting).toBeDefined());
      const accountingReads = () => home!.requests.filter(request => request.path === '/v2/usage/query' || request.path === '/v2/usage/query-batch').length;
      const before = accountingReads();
      const executed = await createDefaultActionExecutor().execute('usage.query', { queries: [input.query] }, caller);
      expect(executed.ok).toBe(true);
      if (!executed.ok) throw new Error(executed.errorCode);
      const admitted = UsageQueryBatchResultSchema.parse(executed.result);
      expect(admitted.results[0]?.pending).toBe(true);
      const resource = UsageQueryBatchResultSchema.parse(read()).results[0]!;
      expect(admitted.results[0]).toMatchObject({ key: resource.key, requestedQuery: resource.requestedQuery,
        shownQuery: resource.shownQuery, accounting: { totals: resource.accounting?.totals,
          contributions: resource.accounting?.contributions }, sources: resource.sources,
        work: resource.work, howYouWork: resource.howYouWork, coach: resource.coach });
      // The Action delivers facts, not the Resource's retained tariff inventory.
      expect(admitted.results[0]?.accounting?.priceCatalog).toBeUndefined();
      expect(resource.accounting?.priceCatalog).toBeDefined();
      expect(accountingReads()).toBe(before);
      privateSession.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
      await vi.waitFor(() => expect(entry.getSnapshot().pending).toBe('idle'));
      expect(read()?.results[0]?.sources).not.toContainEqual({ source: 'how_you_work', status: 'pending' });
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

  it('returns the one-shot query snapshot without harvesting held private evidence', async () => {
    const privateSession = createDeferred<Response>();
    const caller = await context(false, request => request.path === '/v2/usage/query'
      ? Response.json({ ...accounting, contributions: [{ id: 'cost', observedAtMs: 500, sessionId: 'work-session',
        turnId: 'turn', agentId: null, modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null,
        tokens: accounting.totals.tokens, cost: accounting.totals.cost }] })
      : request.path === '/v2/sessions/work-session' ? privateSession.promise
        : request.path === '/v1/account/encryption/currentness' ? Response.json({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }) : undefined);
    const settled: ActionExecuteResult[] = [];
    const pending = createDefaultActionExecutor().execute('usage.query', { queries: [input.query] }, caller)
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
