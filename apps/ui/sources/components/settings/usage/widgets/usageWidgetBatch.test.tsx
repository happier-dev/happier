import { WidgetPresentationProvider, type WidgetPresentation } from '@happier-dev/plugin-ui';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { UsageAnalyticsQueryBatchRequestSchema, type UsageAnalyticsQueryBatchResponse } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { collectUsageAnalyticsBatchDelivery, projectUsageAnalyticsBatchDelivery, repriceUsageAnalyticsResponse } from '@happier-dev/protocol/usage/usageCost';
import type { UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { invalidateHomeAccountReadJoins } from '@/sync/runtime/orchestration/homeAccountChange';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import {
  UsageWidgetBatchProvider,
  useUsageWidgetBatchSlices,
  useUsageWidgetBatchInventorySlice,
  useUsageWidgetBatchCostBasis,
  type UsageWidgetCostBasis,
  useUsageWidgetModel,
  useUsageWidgetPageHasCoverageDetail,
  buildUsageWidgetQueryPlan,
} from './usageWidgetBatch';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { readUsageWidgetQueryOverrides, resolveUsageWidgetPageInitialQuery } from '../usageWidgetPageContext';
import { resolveUsagePageInitialFilters } from '../usageRouteParams';
import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import { UsageWidgetBody } from './UsageWidgetBody';
import { UsageBreakdownsWidget } from './UsageBreakdownsWidget';
import { storage } from '@/sync/domains/state/storage';
import { createPlainSessionCurrentProjectionRecordFixture, createSessionFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { HappierDataMetric, HappierDataRows, RankedRows, StackedSeriesChart, UsageBreakdownsBody } from '@happier-dev/plugin-ui/presentation';
import { useUsageAnalyticsView } from './usageBodyKit';
import { createUsageWidgetPresets } from '@happier-dev/protocol/widgets/usageWidgetPresetsV1';
import { flattenWidgetLayoutWidgetsV1, WidgetLayoutItemsV1Schema } from '@happier-dev/protocol/widgets';
import { USAGE_SESSION_EVIDENCE_PATH, UsageSessionEvidenceRequestSchema, UsageSessionEvidenceResponseSchema } from '@happier-dev/protocol/usage/usageSessionEvidence';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { WidgetFrameDemandContext, WidgetFrameInstanceIdContext } from '@/components/widgets/frame/widgetFrameDemand';
import { USAGE_COACH_SUPPRESSIONS_KV_KEY } from '@happier-dev/protocol/usage/coach/coachActions';
import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema } from '@happier-dev/protocol/connect/account-usage-primitives';
import { getServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';

const accounting: UsageAnalyticsQueryResponse = {
  v: 1,
  totals: {
    eventCount: 1,
    tokens: {
      input: 10,
      output: 5,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 15,
    },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' },
  },
};
const scope = {
  period: { startMs: 1000 },
  agents: [],
  machines: [],
  projects: [],
  sources: [],
  session: null,
  costBasis: 'auto',
} as const;
const clauses = readUsageWidgetQueryOverrides(normalizeUsageQuery({ granularity: 'day', timeZoneOffsetMinutes: 0 }));

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => {
  standardCleanup();
  retireActiveServerAccountScopeLifetime();
  invalidateUsageQueryResources();
  await home?.dispose();
  home = undefined;
  vi.restoreAllMocks();
});

/** The page chrome's view of the batch: one decoded Resource value for every mounted body. */
function BatchProbe(props: Readonly<{ batches: string[][] }>) {
  props.batches.push(useUsageWidgetBatchSlices().map((slice) => slice.key));
  return null;
}

function Body(
  props: Readonly<{
    name: string;
    metric: 'tokens' | 'cost';
    seen: Map<string, UsageWidgetBodyModel>;
    agent?: string;
  }>,
) {
  const { model } = useUsageWidgetModel({
    ...scope,
    agents: props.agent ? [props.agent] : [],
    metric: props.metric,
    breakdown: [],
  }, 'usage_daily');
  props.seen.set(props.name, model);
  return null;
}

describe('Usage page batch', () => {
  it('reuses admitted facts when switching the canonical Coach and How you work cohorts, and displays changed accounting', async () => {
    // Measurement only: the real evaluator still owns every finding and decision.
    const coachEvaluations = vi.spyOn(await import('@happier-dev/protocol/usage/coach/evaluateUsageCoach'), 'evaluateUsageCoach');
    const allowanceEvaluations = vi.spyOn(await import('@/sync/api/account/apiProviderAccountUsage'), 'getProviderAccountUsageQuota');
    let observeAdmission = false;
    let activityIssued = false;
    let inputsBeforeActivity = 0;
    let asynchronousSwitchInputs = 0;
    const sessionInputs = await import('@/sync/api/account/usageQuerySessionInputs');
    const createInputs = sessionInputs.createUsageQuerySessionInputs;
    // Count the real owner's reads at the HTTP boundary without replacing its decisions.
    vi.spyOn(sessionInputs, 'createUsageQuerySessionInputs').mockImplementation(input => {
      const owner = createInputs(input);
      return { ...owner, read: (...args) => {
        if (observeAdmission && !activityIssued) inputsBeforeActivity++;
        const result = owner.read(...args);
        if (observeAdmission && args[0] === 'switch-session' && result instanceof Promise) asynchronousSwitchInputs++;
        return result;
      } };
    });
    const nowMs = Date.UTC(2026, 10, 7, 12);
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    let eventCount = 1;
    let revision = 1;
    let agentTimeMs = 300;
    let denySession = false;
    let coachPreferenceReadsOnSwitch = 0;
    let quotaReadsOnSwitch = 0;
    let quotaReads = 0;
    const ref = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'work' };
    const source = { bindingKind: 'account' as const, ref };
    const recordKey = { providerId: 'codex', accountSubjectId: ref.accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    const record = ProviderAccountUsageSnapshotV1Schema.parse({ v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'codex', accountSubject: { kind: 'providerSubject', id: ref.accountId }, observedAtMs: nowMs, fetchedAtMs: nowMs,
      staleAfterMs: 600_000, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_empty', meters: [] });
    let visits = 0;
    const compactInput = await import('@/sync/api/account/usageCompactInput');
    const open = compactInput.openUsageCompactInput;
    const observedFacts = new WeakSet<object>();
    // Measurement only: preserve the real opener's object and every decision,
    // instrumenting admitted input rows instead of replacing an internal owner.
    const openings = vi.spyOn(compactInput, 'openUsageCompactInput').mockImplementation(async (...args) => {
      const result = await open(...args);
      for (const fact of result?.detail.facts ?? []) {
        if (observedFacts.has(fact)) continue;
        observedFacts.add(fact);
        const startMs = fact.startMs;
        Object.defineProperty(fact, 'startMs', { configurable: true, enumerable: true, get() { visits++; return startMs; } });
      }
      return result;
    });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-coach-switch.test', accountId: 'account-a' }],
      route: request => {
        if (observeAdmission && request.path === '/v1/kv/bulk' && request.body !== null && typeof request.body === 'object'
          && 'keys' in request.body && Array.isArray(request.body.keys) && request.body.keys.includes(USAGE_COACH_SUPPRESSIONS_KV_KEY)) {
          coachPreferenceReadsOnSwitch++;
        }
        if (request.path.startsWith('/v4/connect/qualified/provider-account-usage/')) {
          quotaReads++;
          if (observeAdmission) quotaReadsOnSwitch++;
        }
        if (request.path === '/v4/connect/qualified/provider-account-usage/sources/resolve') return Response.json({ source,
          recordId: record.recordId, providerAccountId: ref.accountId, fetchedAt: nowMs, staleAfterMs: 600_000 });
        if (request.path === '/v4/connect/qualified/provider-account-usage/record') return Response.json({ content: { t: 'plain', v: record },
          metadata: { fetchedAt: nowMs, staleAfterMs: 600_000, status: 'ok' }, sources: [source] });
        if (request.method === 'PUT' && request.path === '/v2/sessions/switch-session/system-records'
          && request.body !== null && typeof request.body === 'object' && 'address' in request.body && 'content' in request.body) {
          return Response.json({ record: { id: 'usage-facts', address: request.body.address, content: request.body.content,
            revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', createdAt: new Date(nowMs).toISOString(), updatedAt: new Date(nowMs).toISOString() } });
        }
        if (request.path === '/v1/features' || request.path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
          features: { connectedServices: { enabled: true, quotas: { enabled: true } } },
        }));
        if (request.path === '/v2/usage/query') {
          if (UsageAnalyticsQueryRequestSchema.parse(request.body).includeActivity) activityIssued = true;
          return Response.json({ ...accounting, totals: { ...accounting.totals, eventCount },
            activity: { calendarDays: [{ date: '2026-11-07', eventCount }], weekdayHourBuckets: [{ weekday: 6, hour: 23, eventCount }] } });
        }
        if (request.path === USAGE_SESSION_EVIDENCE_PATH) {
          const input = UsageSessionEvidenceRequestSchema.parse(request.body);
          const workFact = { v: 1, kind: 'work' as const, seq: revision, metadataVersion: 1, agentStateVersion: 1,
            session: { metadata: null, ownerMetadata: null, agentTarget: null },
            // Many overlapping native witnesses still describe one interval.
            // A retained revisit must stay independent of this population.
            evidence: { status: 'partial' as const, facts: Array.from({ length: 64 }, (_, index) => ({ workId: JSON.stringify(['switch-session', 'turn']),
              evidenceId: `turn-${index}`, agentId: 'codex', machineId: null, kind: 'busy' as const,
              startMs: nowMs - 900, endMs: nowMs - 900 + agentTimeMs })) } };
          const factRecords = (input.workFactKinds ?? ['work']).map(kind => kind === 'work'
            ? { kind, content: { t: 'plain' as const, v: workFact } }
            : { kind, content: { t: 'plain' as const, v: { v: 1 as const, kind: 'coach' as const, seq: revision,
              metadataVersion: 1, agentStateVersion: 1, evidence: { compositionCoverage: 'unknown' as const } } } });
          const rows = [
            { sessionId: 'switch-denied', detail: { status: 403 as const, body: { error: 'forbidden' } } },
            { sessionId: 'switch-session', workFacts: { session: {
                id: 'switch-session', seq: revision, createdAt: nowMs - 1_000, updatedAt: nowMs,
                active: false, metadataVersion: 1, agentStateVersion: 1, metadataLayoutVersion: 1,
                encryptionMode: 'plain' as const, dataEncryptionKey: null, viewerRole: 'owner' as const,
                access: { v: 1 as const, level: 'owner' as const, sources: [{ kind: 'owner' as const }], capabilities: createSessionAccessFixture().capabilities },
              }, records: factRecords },
              turns: { status: 200 as const, body: { v: 1 as const, sessionId: 'switch-session', updatedAt: nowMs, turns: [{
                turnId: 'turn', agentId: 'codex', status: 'completed' as const, startedAt: nowMs - 900,
                terminalAt: nowMs - 900 + agentTimeMs, updatedAt: nowMs,
              }] } } },
          ];
          return Response.json({ requests: input.requests.map(demand => ({ query: demand.query, sessionIds: demand.sessionIds ?? ['switch-denied', 'switch-session'] })),
            results: rows.filter(row => !input.requests[0]?.sessionIds || input.requests[0].sessionIds.includes(row.sessionId))
                .map(row => denySession && row.sessionId === 'switch-session'
                  ? { sessionId: row.sessionId, detail: { status: 403, body: { error: 'forbidden' } } } : row) });
        }
        return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
      } });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    storage.setState({ profileScope: { serverId: server.id, accountId: 'account-a' },
      settingsScope: { serverId: server.id, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a', connectedAccountsV4: [{
        ref, status: 'connected', authenticationModeId: 'manual', revisionSemantics: 'revisioned',
        credentialRevision: 'csr_abcdefghijklmnopqrstuvwxyz', configurationReady: false, configurationRevision: null, scopes: [],
      }] }) });
    await getServerFeaturesSnapshot({ serverId: server.id, force: true });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
    const originalNightHours = storage.getState().settings.usageNightHoursV1;
    const presets = createUsageWidgetPresets();
    const models = new Map<string, UsageWidgetBodyModel>();
    let renders = 0;
    let costChoiceRenders = 0;
    function CostChoiceProbe() {
      costChoiceRenders++;
      useUsageWidgetBatchCostBasis();
      return null;
    }
    const rendersByWidget = new Map<string, number>();
    const phasesByWidget = new Map<string, unknown[]>();
    const renderCountsSince = (previous: ReadonlyMap<string, number>) => Object.fromEntries([...rendersByWidget]
      .map(([id, count]) => [id, count - (previous.get(id) ?? 0)]));
    function Probe(props: Readonly<{ id: string; widgetId: Exclude<UsageBuiltinWidgetIdV1, 'usage_sources'>; input: Record<string, JsonValue> }>) {
      renders++;
      rendersByWidget.set(props.id, (rendersByWidget.get(props.id) ?? 0) + 1);
      const demand = React.useContext(WidgetFrameDemandContext);
      // The visual frame normally publishes placement before cohort admission.
      React.useLayoutEffect(() => demand?.place(props.id, props.widgetId, true), [demand, props.id, props.widgetId]);
      const model = useUsageWidgetModel(props.input, props.widgetId).model;
      models.set(props.id, model);
      const phases = phasesByWidget.get(props.id) ?? [];
      phases.push({ requested: model.requestedQuery !== null, shown: model.slice !== null, pending: model.pending, refreshing: model.refreshing });
      phasesByWidget.set(props.id, phases);
      React.useEffect(() => () => { models.delete(props.id); }, [props.id]);
      return null;
    }
    const page = (presetId: 'coach' | 'how-you-work', layoutReady = true) => {
      const widgets = flattenWidgetLayoutWidgetsV1(WidgetLayoutItemsV1Schema.parse(presets.find(preset => preset.id === presetId)!.items));
      return <InjectedAuthProvider credentials={credentials}>
      <UsageWidgetBatchProvider clauses={clauses} enabled={layoutReady}
        inventoryQuery={layoutReady ? normalizeUsageQuery({ period: { relative: '90days' } }) : undefined}
        queryWidgetIds={layoutReady ? widgets.map(row => row.instance.id) : undefined}>
        <CostChoiceProbe />
        {layoutReady && widgets.map(row => {
          if (row.instance.definition.kind !== 'builtin') throw new Error('Usage presets require builtin widgets');
          return <WidgetFrameInstanceIdContext.Provider key={row.instance.id} value={row.instance.id}><Probe id={row.instance.id}
            widgetId={row.instance.definition.id as Exclude<UsageBuiltinWidgetIdV1, 'usage_sources'>}
            input={{ ...scope, period: { relative: '90days' }, ...Object.fromEntries(Object.entries(row.instance.bindings)
              .flatMap(([key, binding]) => binding.kind === 'value' ? [[key, binding.value]] : [])) }} /></WidgetFrameInstanceIdContext.Provider>;
        })}
      </UsageWidgetBatchProvider></InjectedAuthProvider>;
    };
    const screen = await renderScreen(page('coach'));
    const settle = async (count: number) => {
      await expect.poll(async () => { await flushHookEffects({ cycles: 4 });
        return models.size === count && [...models.values()].every(model => model.slice && !model.pending);
      }).toBe(true);
    };
    const reads = () => home!.httpRequests.filter(request => request.path === '/v2/usage/query'
      || request.path === '/v2/usage/query-batch' || request.path === USAGE_SESSION_EVIDENCE_PATH).length;
    const evidenceReads = () => home!.httpRequests.filter(request => request.path === USAGE_SESSION_EVIDENCE_PATH).length;
    try {
      await settle(1);
      expect(coachEvaluations.mock.calls.length).toBeGreaterThan(0);
      expect([...models.values()][0]?.slice?.coach, 'Coach still publishes its admitted findings').toBeDefined();
      expect(quotaReads, 'Coach renders no provider allowance facts').toBe(0);
      expect(allowanceEvaluations.mock.calls.length, 'Coach never enters provider allowance projection').toBe(0);
      expect([...models.values()][0]?.slice?.howYouWork?.intervals?.agentTimeMs).toBe(300);
      visits = 0;
      const coldReads = reads();
      const coachEvidenceReads = evidenceReads();
      const coachOpenings = openings.mock.calls.length;
      const firstRenderStart = renders;
      const firstWidgetRenders = new Map(rendersByWidget);
      const coachCallsBeforeSwitch = coachEvaluations.mock.calls.length;
      const allowanceCallsBeforeSwitch = allowanceEvaluations.mock.calls.length;
      observeAdmission = true;
      activityIssued = false;
      // A newly selected document first renders its loading shell. The old
      // frame registrations still exist in the provider during that render.
      await screen.update(page('coach', false));
      expect.soft(coachEvaluations.mock.calls.length - coachCallsBeforeSwitch,
        'the selected layout loading shell never admits another outgoing Coach cohort').toBe(0);
      expect.soft(quotaReadsOnSwitch, 'a loading document cannot reacquire the outgoing allowance').toBe(0);
      await screen.update(page('how-you-work'));
      await settle(8);
      observeAdmission = false;
      expect(activityIssued).toBe(true);
      expect.soft(inputsBeforeActivity, 'new accounting dispatch precedes retained Session input work').toBe(0);
      expect.soft(asynchronousSwitchInputs, 'admitted Session inputs need no asynchronous continuations on a warm view switch').toBe(0);
      expect.soft(coachEvaluations.mock.calls.length - coachCallsBeforeSwitch,
        'a non-Coach view switch evaluates zero Coach detectors').toBe(0);
      expect.soft(coachPreferenceReadsOnSwitch, 'a non-Coach switch does not acquire Coach preferences').toBe(0);
      expect.soft(quotaReadsOnSwitch, 'How you work acquires no unused provider allowance').toBe(0);
      expect.soft(allowanceEvaluations.mock.calls.length - allowanceCallsBeforeSwitch,
        'How you work never enters provider allowance acquisition, even with a warm transport').toBe(0);
      const admittedReads = reads();
      const firstSwitchVisits = visits;
      console.info('USAGE-COACH-SWITCH first', JSON.stringify({ firstSwitchReads: admittedReads - coldReads,
        firstSwitchEvidenceReads: evidenceReads() - coachEvidenceReads, firstSwitchOpenings: openings.mock.calls.length - coachOpenings,
        firstSwitchVisits, firstSwitchRenders: renders - firstRenderStart,
        firstSwitchRendersByWidget: renderCountsSince(firstWidgetRenders),
        skyPhases: phasesByWidget.get('how-you-work:group:0:widget:0') }));
      expect.soft(evidenceReads() - coachEvidenceReads,
        'How you work consumes the Session and transcript facts already admitted by Coach').toBe(0);
      expect.soft(firstSwitchVisits, 'the first view switch reuses the already folded compact evidence rows').toBe(0);
      expect(openings.mock.calls.length - coachOpenings, 'a view switch cannot decrypt a compact record without opening it').toBe(0);
      const admittedOpenings = openings.mock.calls.length;
      const settledRenders = renders;
      const settledWidgetRenders = new Map(rendersByWidget);
      await flushHookEffects({ cycles: 4 });
      expect(renders - settledRenders, 'settled evidence creates no further render publications').toBe(0);
      for (const [id, count] of Object.entries(renderCountsSince(settledWidgetRenders)))
        expect(count, `${id}: unchanged settled publications execute zero widget consumers`).toBe(0);
      const retained = new Map([...models].map(([id, model]) => [id, model.slice]));
      visits = 0;
      const renderStart = renders;
      const revisitWidgetRenders = new Map(rendersByWidget);
      await screen.update(page('coach'));
      await settle(1);
      await screen.update(page('how-you-work'));
      await settle(8);
      expect(reads() - admittedReads, 'a settled view switch admits no new accounting or private evidence reads').toBe(0);
      expect.soft(visits, 'revisiting admitted cohorts does not walk their compact evidence rows').toBe(0);
      expect(openings.mock.calls.length - admittedOpenings).toBe(0);
      for (const [id, model] of models) {
        expect(model.slice).toEqual(retained.get(id));
        expect(model.slice?.accounting).toBe(retained.get(id)?.accounting);
        expect(model.slice?.howYouWork?.agentCalendar?.days).toBe(retained.get(id)?.howYouWork?.agentCalendar?.days);
        expect(model.slice?.howYouWork?.agentCalendar?.weekdayHourBuckets).toBe(retained.get(id)?.howYouWork?.agentCalendar?.weekdayHourBuckets);
        expect(model.slice?.howYouWork?.runLengths).toBe(retained.get(id)?.howYouWork?.runLengths);
      }
      console.info('USAGE-COACH-SWITCH', JSON.stringify({ firstSwitchReads: admittedReads - coldReads,
        firstSwitchVisits, revisitReads: reads() - admittedReads, revisitVisits: visits, revisitRenders: renders - renderStart,
        revisitRendersByWidget: renderCountsSince(revisitWidgetRenders) }));
      const beforeNightHours = new Map(rendersByWidget);
      const beforeNightCostChoices = costChoiceRenders;
      const beforeNightSlices = new Map([...models].map(([id, model]) => [id, model.slice]));
      const beforeNightReads = reads();
      await act(async () => { storage.getState().applySettingsLocal({ usageNightHoursV1: { startHour: 23, endHour: 7 } }); });
      await expect.poll(() => [...models.values()].some(model => model.slice?.howYouWork?.nightShift?.startHour === 23)).toBe(true);
      await flushHookEffects({ cycles: 4 });
      const nightRendersByWidget = renderCountsSince(beforeNightHours);
      console.info('USAGE-COACH-SWITCH night-hours', JSON.stringify({ rendersByWidget: nightRendersByWidget, reads: reads() - beforeNightReads,
        costChoiceRenders: costChoiceRenders - beforeNightCostChoices,
        changedSliceFieldsByWidget: Object.fromEntries([...models].map(([id, model]) => [id,
          Object.entries(model.slice ?? {}).filter(([key, value]) => value !== beforeNightSlices.get(id)?.[key as keyof NonNullable<UsageWidgetBodyModel['slice']>]).map(([key]) => key)])) }));
      for (const index of [0, 2, 3, 4, 5, 6]) {
        const id = `how-you-work:group:0:widget:${index}`;
        expect.soft(nightRendersByWidget[id], `${id}: charts do not execute for unused night-hour facts`).toBe(0);
      }
      expect.soft(nightRendersByWidget['how-you-work:group:0:widget:7'], 'Daylight renders the changed night-window caption').toBeGreaterThan(0);
      expect.soft(costChoiceRenders - beforeNightCostChoices, 'unchanged cost choices do not execute page chrome for private night-hour facts').toBe(0);
      expect(reads() - beforeNightReads, 'night-hour presentation changes reproject admitted facts without transport').toBe(0);
      eventCount = 2;
      agentTimeMs = 600;
      revision++;
      visits = 0;
      const changedWidgetRenders = new Map(rendersByWidget);
      const allowanceCallsBeforeRefresh = allowanceEvaluations.mock.calls.length;
      await act(async () => {
        storage.getState().applySessions([createSessionFixture({ id: 'switch-session', serverId: server.id,
          seq: revision, encryptionMode: 'plain', metadataVersion: 1, agentStateVersion: 1 })]);
        await [...models.values()][0]!.refresh();
      });
      await settle(8);
      expect.soft(allowanceEvaluations.mock.calls.length - allowanceCallsBeforeRefresh,
        'refreshing How you work acquires its changed accounting and Session facts without unused allowance').toBe(0);
      expect([...models.values()].every(model => model.slice?.accounting?.totals.eventCount === 2)).toBe(true);
      for (const id of models.keys())
        expect(rendersByWidget.get(id)! - (changedWidgetRenders.get(id) ?? 0), `${id}: changed accounting reaches its real consumer`).toBeGreaterThan(0);
      console.info('USAGE-COACH-SWITCH changed', JSON.stringify({ rendersByWidget: renderCountsSince(changedWidgetRenders) }));
      expect(reads()).toBeGreaterThan(admittedReads);
      expect([...models.values()].some(model => model.slice?.howYouWork?.intervals?.agentTimeMs === 600)).toBe(true);
      expect(visits, 'a changed compact input crosses the evidence fold boundary').toBeGreaterThan(0);
      denySession = true;
      revision++;
      const beforeRefusal = new Map(rendersByWidget);
      await act(async () => {
        storage.getState().applySessions([createSessionFixture({ id: 'switch-session', serverId: server.id,
          seq: revision, encryptionMode: 'plain', metadataVersion: 1, agentStateVersion: 1 })]);
        await [...models.values()][0]!.refresh();
      });
      await settle(8);
      expect([...models.values()].every(model => model.slice?.howYouWork?.intervals == null),
        'a new refusal replaces the previously complete aggregate rather than disclosing retained facts').toBe(true);
      for (const id of models.keys())
        expect(rendersByWidget.get(id)! - (beforeRefusal.get(id) ?? 0), `${id}: changed evidence availability reaches its frame`).toBeGreaterThan(0);
    } finally {
      await screen.unmount();
      storage.setState(state => ({ settings: { ...state.settings, usageNightHoursV1: originalNightHours } }));
    }
  });
  it('offers cost modes from the first available accounting query and keeps that query through a pending period', async () => {
    const firstRead = createDeferred<void>();
    const nextPeriod = createDeferred<void>();
    const estimated: UsageAnalyticsQueryResponse = { ...accounting,
      totals: { ...accounting.totals, cost: { reportedUsd: 0, estimatedUsd: 2, currency: 'USD' } } };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-cost-choice-continuity.test', accountId: 'account-a' }],
      route: async request => {
        if (request.path !== '/v2/usage/query') return undefined;
        const input = UsageAnalyticsQueryRequestSchema.parse(request.body);
        if (input.filters?.agentIds?.includes('a')) {
          await firstRead.promise;
          return Response.json({ error: 'unavailable' }, { status: 503 });
        }
        if (input.dateRange?.startMs !== 1000) await nextPeriod.promise;
        return Response.json(estimated);
      } });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl(server.serverUrl);
    storage.setState({ profileScope: { serverId: server.id, accountId: 'account-a' },
      profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    let options: UsageWidgetCostBasis['options'] = [];
    const models = new Map<string, UsageWidgetBodyModel>();
    function Choices() { options = useUsageWidgetBatchCostBasis().options; return null; }
    function Query(props: { agent: string; startMs: number }) {
      const { model } = useUsageWidgetModel({ ...scope, period: { startMs: props.startMs }, agents: [props.agent],
        metric: 'tokens', breakdown: [] }, 'usage_daily');
      models.set(props.agent, model);
      return null;
    }
    const page = (startMs: number) => <InjectedAuthProvider credentials={credentials}>
      <UsageWidgetBatchProvider clauses={clauses}><Choices />
        <Query agent="a" startMs={startMs} /><Query agent="z" startMs={startMs} />
      </UsageWidgetBatchProvider>
    </InjectedAuthProvider>;
    const screen = await renderScreen(page(1000));
    try {
      await expect.poll(() => models.get('z')?.slice?.accounting).toMatchObject(estimated);
      expect(models.get('a')?.slice?.accounting).toBeUndefined();
      expect(options).toEqual(['auto', 'estimated']);
      await screen.update(page(2000));
      await flushHookEffects({ cycles: 10 });
      expect(options, 'the offered second query remains present while the next period is unknown').toEqual(['auto', 'estimated']);
      await act(async () => { firstRead.resolve(); nextPeriod.resolve(); });
      await expect.poll(() => models.get('z')?.shownQuery?.query.period.startMs).toBe(2000);
      expect(options).toEqual(['auto', 'estimated']);
    } finally { firstRead.resolve(); nextPeriod.resolve(); await screen.unmount(); }
  });
  it('admits one cold visible batch, adds only a deferred delta and still explicitly refreshes', async () => {
    const release = createDeferred<void>();
    const requests: ReturnType<typeof UsageAnalyticsQueryBatchRequestSchema.parse>[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-mount-delta.test', accountId: 'account-a' }],
      route: async request => {
        if (request.path !== '/v2/usage/query-batch') return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
        const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
        requests.push(input);
        signals.push(request.signal);
        await release.promise;
        return Response.json(collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
          results: input.queries.map(query => ({ query, value: accounting })),
        }, input, false)));
      } });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
    storage.setState({ profileScope: { serverId: server.id, accountId: 'account-a' },
      settingsScope: { serverId: server.id, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const seen = new Map<string, UsageWidgetBodyModel>();
    let costBasisOptions: UsageWidgetCostBasis['options'] = [];
    const inventoryQuery = normalizeUsageQuery({ ...scope, metric: 'tokens', breakdown: ['agent'] });
    function Inventory() { useUsageWidgetBatchInventorySlice(); return null; }
    function CostBasisOptions() { costBasisOptions = useUsageWidgetBatchCostBasis().options; return null; }
    const page = (phase: 'shell' | 'visible' | 'contracted' | 'scrolled') => <InjectedAuthProvider credentials={credentials}>
      <UsageWidgetBatchProvider clauses={clauses} inventoryQuery={inventoryQuery}>
        <Inventory />
        <CostBasisOptions />
        {(phase === 'visible' || phase === 'contracted') && <Body name="visible" metric="tokens" seen={seen} />}
        {phase === 'visible' && <Body name="leaving" metric="tokens" agent="leaving-agent" seen={seen} />}
        {phase === 'scrolled' && <Body name="deferred" metric="cost" agent="new-agent" seen={seen} />}
      </UsageWidgetBatchProvider>
    </InjectedAuthProvider>;
    const screen = await renderScreen(page('shell'));
    try {
      await flushHookEffects({ cycles: 10 });
      expect(requests, 'inventory waits for visible widget demand').toHaveLength(0);
      expect(costBasisOptions, 'empty page chrome renders without manufacturing an empty query batch').toEqual([]);
      await screen.update(page('visible'));
      await expect.poll(() => requests.length).toBe(1);
      await flushHookEffects({ cycles: 10 });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.queries).toHaveLength(3);
      // Unrelated Home traffic withdraws generic raw joins, while the Usage
      // Account owner still admits this same pending accounting acquisition.
      invalidateHomeAccountReadJoins(server.id);
      await screen.update(page('contracted'));
      await flushHookEffects({ cycles: 10 });
      expect(requests, 'deferring a row does not reissue the admitted visible subset').toHaveLength(1);
      await screen.update(page('scrolled'));
      await expect.poll(() => requests.length).toBe(2);
      expect(requests[1]!.queries).toHaveLength(1);
      expect(requests[1]!.queries[0]!.filters?.agentIds).toEqual(['new-agent']);
      expect(signals.filter(signal => signal?.aborted), 'mount and scroll do not cancel admitted batches').toHaveLength(0);
      release.resolve();
      await expect.poll(() => seen.get('deferred')?.slice?.accounting?.totals.tokens.total).toBe(15);
      await flushHookEffects({ cycles: 10 });
      expect(requests).toHaveLength(2);
      await seen.get('deferred')!.refresh();
      expect(requests, 'explicit Refresh still replaces accounting through its Account owner').toHaveLength(3);
      expect(requests[2]!.queries).toHaveLength(2);
      await screen.update(page('shell'));
      await flushHookEffects({ cycles: 10 });
      expect(costBasisOptions, 'removing the final body returns page chrome to normal zero demand').toEqual([]);
      expect(requests, 'an empty layout admits no follow-up read').toHaveLength(3);
    } finally { release.resolve(); await screen.unmount(); }
  });
  it('reuses settled Costs models when mounted widgets leave and rejoin the page, and renders a real cost change', async () => {
    // QA reload88 held 6,933 accounting events. Their mounted summary stays
    // bounded while leaving and revisiting a view must not rebuild its model.
    const eventCount = 6_933;
    let amount = 1;
    let historyAsOf = 90_000;
    const response = (): UsageAnalyticsQueryResponse => {
      const totals = { eventCount,
        tokens: { ...accounting.totals.tokens, input: 10 * eventCount, output: 5 * eventCount, total: 15 * eventCount },
        cost: { reportedUsd: amount, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const } };
      return { v: 1, totals, breakdowns: { agent: [{ key: 'codex', ...totals }] },
        activity: { calendarDays: [{ date: '1970-01-01', eventCount }] },
        coverage: { status: 'partial', reasons: ['incomplete_history'], missingDimensions: [], ranked: [],
          range: { startMs: 1_000, endMs: historyAsOf, complete: false },
          sources: [{ source: 'runtime', path: 'runtime', status: 'partial', eventCount, asOfMs: historyAsOf, historyComplete: false }] },
        contributions: [{
          id: 'recorded-events', eventCount, sessionId: null, turnId: null, observedAtMs: 1_500,
          agentId: 'codex', modelId: null, machineId: null, projectKey: null, workspaceId: null,
          source: 'runtime', tokens: totals.tokens, cost: totals.cost,
        }] };
    };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-warm-model.test', accountId: 'account-a' }],
      route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
        ? Response.json(createRootLayoutFeaturesResponse())
        : request.path === '/v2/usage/query-batch' ? (() => {
        const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
        return Response.json(collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
          results: input.queries.map(query => ({ query, value: repriceUsageAnalyticsResponse(response(), bundledUsageModelPriceCatalog, {}, query.costMode) })),
        }, input, false)));
      })() : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    storage.setState({ profileScope: { serverId: server.id, accountId: 'account-a' },
      settingsScope: { serverId: server.id, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!;
    const views = new Set<NonNullable<ReturnType<typeof useUsageAnalyticsView>>>();
    let selectedModel: UsageWidgetBodyModel | null = null;
    let selectedView: ReturnType<typeof useUsageAnalyticsView> = null;
    const warmScope = { ...scope, period: { startMs: 1_000, endMs: 100_000 } };
    const costsInput = { ...warmScope, metric: 'cost', breakdown: ['agent'] };
    function Projection(props: Readonly<{ model: UsageWidgetBodyModel; query: NonNullable<ReturnType<typeof useUsageWidgetModel>['query']> }>) {
      const view = useUsageAnalyticsView(props.model.slice!, props.query);
      if (view) views.add(view);
      selectedView = view;
      return null;
    }
    function CostObserver() {
      const selected = useUsageWidgetModel(costsInput, 'usage_breakdowns');
      selectedModel = selected.model;
      return selected.query && selected.model.slice ? <Projection model={selected.model} query={selected.query} /> : null;
    }
    const inventoryQuery = normalizeUsageQuery({ ...warmScope, metric: 'tokens', breakdown: ['agent'] });
    const page = (costs: boolean, mount = 0) => <InjectedAuthProvider credentials={credentials}><CoreCollectionScope>
      <UsageWidgetBatchProvider key={mount} clauses={clauses} inventoryQuery={inventoryQuery}>
        {costs ? <><UsageWidgetBody id="usage_breakdowns" input={costsInput} serverId={server.id} testID="warm-costs" /><CostObserver /></>
          : <UsageWidgetBody id="usage_breakdowns" input={{ ...warmScope, metric: 'tokens', breakdown: ['agent'] }} serverId={server.id} testID="warm-usage" />}
      </UsageWidgetBatchProvider>
    </CoreCollectionScope></InjectedAuthProvider>;
    const screen = await renderScreen(page(true));
    const visibleCost = () => screen.findAllByType(RankedRows).find(row => row.props.rows.some((entry: { id: string }) => entry.id === 'codex'))?.props.rows[0]?.value;
    try {
      await expect.poll(() => selectedModel?.requestedQuery).not.toBeNull();
      await expect.poll(() => selectedModel?.slice?.accounting?.totals.eventCount).toBe(eventCount);
      await expect.poll(visibleCost).toBeCloseTo(1);
      await expect.poll(() => selectedModel?.pending).toBe(false);
      await flushHookEffects({ cycles: 20 });
      const retainedAccounting = selectedModel!.slice!.accounting;
      const retainedView = selectedView;
      const builtViews = views.size;
      const reads = home.httpRequests.filter(request => request.path === '/v2/usage/query-batch').length;
      await screen.update(page(false));
      await flushHookEffects({ cycles: 20 });
      await screen.update(page(true, 1));
      await expect.poll(visibleCost).toBeCloseTo(1);
      await expect.poll(() => selectedModel?.pending).toBe(false);
      await flushHookEffects({ cycles: 20 });
      expect(home.httpRequests.filter(request => request.path === '/v2/usage/query-batch')).toHaveLength(reads);
      expect(views.size - builtViews, 'unchanged reopen builds no new Costs analytics model').toBe(0);
      expect(selectedModel!.slice!.accounting).toBe(retainedAccounting);
      expect(selectedView).toBe(retainedView);
      historyAsOf++;
      await act(async () => { await selectedModel!.refresh(); });
      await expect.poll(() => selectedModel?.slice?.accounting?.coverage?.sources[0]?.asOfMs).toBe(historyAsOf);
      await expect.poll(() => selectedModel?.pending).toBe(false);
      expect(visibleCost()).toBeCloseTo(1);
      expect(views.size - builtViews, 'history-only provenance leaves displayed Costs equal and rebuilds zero models').toBe(0);
      expect(selectedView).toBe(retainedView);
      expect(selectedView!.insights.activeDays).toBe(1);
      await screen.update(page(false));
      await flushHookEffects({ cycles: 20 });
      await screen.update(page(true, 2));
      await expect.poll(visibleCost).toBeCloseTo(1);
      await expect.poll(() => selectedModel?.pending).toBe(false);
      expect(views.size - builtViews, 'reopening after history-only refresh also reuses the Costs model').toBe(0);
      amount = 2;
      await act(async () => { await selectedModel!.refresh(); });
      await expect.poll(visibleCost).toBeCloseTo(2);
      await expect.poll(() => selectedModel?.pending).toBe(false);
      await flushHookEffects({ cycles: 20 });
      expect(views.size - builtViews, 'a real accounting change builds exactly one new Costs analytics model').toBe(1);
      expect(selectedView).not.toBe(retainedView);
    } finally { await screen.unmount(); }
  });
  it.each([false, true])('preserves best-available money across HTTP summary delivery and every Costs body (unpriced=%s)', async unpriced => {
    const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
    const rawCost = { reportedUsd: 0.0548, estimatedUsd: 2.4, currency: 'USD', costSource: 'none' as const };
    const zeroTokens = { ...tokens, input: 0, total: 0 };
    const pricedCost = { reportedUsd: 0, estimatedUsd: 2.4, currency: 'USD', costSource: 'pricing_estimate' as const };
    const reportedCost = { reportedUsd: 0.0548, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const };
    const unknownCost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const };
    const known = { eventCount: 2, tokens, cost: rawCost };
    const unknown = { eventCount: 1, tokens, cost: unknownCost };
    const entries = [
      { eventCount: 1, tokens, cost: pricedCost, key: 'codex' },
      { eventCount: 1, tokens: zeroTokens, cost: reportedCost, key: 'claude' },
    ];
    const totals = { ...known, eventCount: unpriced ? 3 : 2,
      tokens: { ...tokens, input: unpriced ? 2_000_000 : 1_000_000, total: unpriced ? 2_000_000 : 1_000_000 } };
    const value: UsageAnalyticsQueryResponse = { v: 1, totals,
      contributions: [
        { id: 'priced', sessionId: null, turnId: null, observedAtMs: 100, eventCount: 1,
          agentId: 'codex', modelId: 'gpt-5', machineId: null, projectKey: null, workspaceId: null,
          source: 'native', tokens, tokenCategories: tokens,
          cost: pricedCost },
        { id: 'reported', sessionId: null, turnId: null, observedAtMs: 200, eventCount: 1,
          agentId: 'claude', modelId: null, machineId: null, projectKey: null, workspaceId: null,
          source: 'runtime', tokens: zeroTokens, cost: reportedCost },
        ...(unpriced ? [{ id: 'unknown', sessionId: null, turnId: null, observedAtMs: 86_400_100, eventCount: 1,
          agentId: 'unknown-agent', modelId: 'unpriced-model', machineId: null, projectKey: null, workspaceId: null,
          source: 'native', tokens, tokenCategories: tokens, cost: unknownCost }] : []),
      ],
      series: [{ ...known, bucketStartMs: 0, bucketEndMs: 86_400_000 },
        ...(unpriced ? [{ ...unknown, bucketStartMs: 86_400_000, bucketEndMs: 172_800_000 }] : [])],
      breakdowns: { agent: [...entries, ...(unpriced ? [{ ...unknown, key: 'unknown-agent' }] : [])] },
      engineTimeline: [{ bucketStartMs: 0, bucketEndMs: 86_400_000, leaders: entries },
        ...(unpriced ? [{ bucketStartMs: 86_400_000, bucketEndMs: 172_800_000, leaders: [{ ...unknown, key: 'unknown-agent' }] }] : [])],
    };
    const deliveries: UsageAnalyticsQueryBatchResponse[] = [];
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-cost-consistency.test', accountId: 'account-a' }],
      route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
        ? Response.json(createRootLayoutFeaturesResponse())
        : request.path === '/v2/usage/query-batch' ? (() => {
          const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
          const delivery = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
            results: input.queries.map(query => ({ query, value: repriceUsageAnalyticsResponse(value, (value).priceCatalog ?? bundledUsageModelPriceCatalog, {}, query.costMode) })),
          }, input, false));
          deliveries.push(delivery);
          return Response.json(delivery);
        })() : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
    const serverId = home.homes.a!.id;
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><CoreCollectionScope>
      <UsageWidgetBatchProvider clauses={clauses}>{(['usage_period_summary', 'usage_cost_facts', 'usage_daily', 'usage_breakdowns', 'usage_efficiency'] as const).map(id =>
        <UsageWidgetBody key={id} id={id} input={{ ...scope, metric: 'cost', breakdown: ['agent'], period: { startMs: 0, endMs: 172_800_000 } }} serverId={serverId} testID={id} />)}
      </UsageWidgetBatchProvider></CoreCollectionScope></InjectedAuthProvider>);
    try {
      await expect.poll(() => screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'usage_cost_facts.fact.estimated')?.props.value).toBe(2.4);
      expect(deliveries.length).toBeGreaterThan(0);
      for (const result of deliveries.flatMap(delivery => delivery.results)) {
        if ('error' in result) throw new Error(`Expected a successful accounting delivery: ${result.error}`);
        expect(result.value.contributions).toBeUndefined();
        expect(result.value.summary).toBeDefined();
      }
      const metrics = screen.findAllByType(HappierDataMetric);
      expect(metrics.find(metric => metric.props.testID === 'usage_period_summary.hero')?.props.value).toBe(1.3048);
      expect(metrics.find(metric => metric.props.testID === 'usage_efficiency.perMtok')?.props.value).toBe(unpriced ? 0.6524 : 1.3048);
      const rows = screen.findByType(RankedRows).props.rows as { id: string; value: number | null }[];
      expect(rows.find(row => row.id === 'codex')?.value).toBe(1.25);
      expect(rows.find(row => row.id === 'claude')?.value).toBe(0.0548);
      expect(rows.reduce((sum, row) => sum + (row.value ?? 0), 0)).toBe(1.3048);
      const chart = screen.findByType(StackedSeriesChart);
      const points = chart.props.series.flatMap((series: { points: { y: number | null }[] }) => series.points) as { y: number | null }[];
      expect(points.reduce((sum, point) => sum + (point.y ?? 0), 0)).toBe(1.3048);
    } finally { await screen.unmount(); }
  });
  it('strips chart own inputs from queries and selects only the metric evidence it needs', async () => {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-chart-inputs.test', accountId: 'account-a' }],
      route: request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId: home.homes.a!.id, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    let query: ReturnType<typeof useUsageWidgetModel>['query'] = null;
    let accountingViewAvailable: boolean | undefined;
    function AccountingProjection(props: { slice: NonNullable<UsageWidgetBodyModel['slice']>; query: NonNullable<ReturnType<typeof useUsageWidgetModel>['query']> }) {
      accountingViewAvailable = useUsageAnalyticsView(props.slice, props.query) !== null;
      return null;
    }
    type ChartWidget = 'usage_rhythm' | 'usage_orbit' | 'usage_atmosphere' | 'usage_machines' | 'usage_projects' | 'usage_breakdowns';
    function Probe(props: { metric: 'tokens' | 'busy'; style: string; widgetId: ChartWidget }) {
      const selected = useUsageWidgetModel({ ...scope, metric: props.metric, style: props.style, colourBy: 'intensity', day: '2026-10-21' }, props.widgetId);
      query = selected.query;
      return selected.query && selected.model.slice ? <AccountingProjection slice={selected.model.slice} query={selected.query} /> : null;
    }
    const view = (metric: 'tokens' | 'busy', style = 'sky', widgetId: ChartWidget = 'usage_rhythm') => <InjectedAuthProvider credentials={credentials}><UsageWidgetBatchProvider clauses={clauses}>
      <Probe metric={metric} style={style} widgetId={widgetId} /></UsageWidgetBatchProvider></InjectedAuthProvider>;
    const screen = await renderScreen(view('tokens'));
    try {
      await expect.poll(() => query?.metric).toBe('tokens');
      expect(query).toMatchObject({ includeSessionEvidence: false, includeTranscriptEvidence: false });
      await expect.poll(() => accountingViewAvailable).toBe(true);
      for (const key of ['style', 'colourBy', 'day']) expect(query).not.toHaveProperty(key);
      await screen.update(view('busy'));
      await expect.poll(() => query?.metric).toBe('busy');
      expect(query).toMatchObject({ includeSessionEvidence: true, includeTranscriptEvidence: false });
      await expect.poll(() => accountingViewAvailable).toBe(false);
      await screen.update(view('busy', 'heatmap'));
      await expect.poll(() => query?.includeSessionEvidence).toBe(false);
      await screen.update(view('busy', 'ninetyPlanets'));
      expect(query).toMatchObject({ includeSessionEvidence: false, includeTranscriptEvidence: false });
      await screen.update(view('tokens', 'moons', 'usage_orbit'));
      expect(query).toMatchObject({ includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
      await screen.update(view('tokens', '', 'usage_atmosphere'));
      expect(query).toMatchObject({ includeSessionEvidence: true, includeTranscriptEvidence: false, includeWorkEvidence: false });
      for (const widgetId of ['usage_machines', 'usage_projects'] as const) {
        await screen.update(view('tokens', '', widgetId));
        expect(query).toMatchObject({ includeAccounting: false, includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false });
      }
      await screen.update(view('tokens', 'crew', 'usage_breakdowns'));
      expect(query).toMatchObject({ includeActivity: true, activityResolution: 'both', includeSeries: false,
        includeInsights: false, includeLeaders: false, includeModelTimeline: false, includeMessageStats: false, includeQuotaHistory: false });
      await screen.update(view('tokens', 'breakdowns', 'usage_breakdowns'));
      expect(query).toMatchObject({ includeActivity: false, includeQuotaHistory: false });
    } finally { await screen.unmount(); }
  });
  it.each([
    { metric: 'tokens', days: 7 }, { metric: 'cost', days: 7 },
    { metric: 'tokens', days: 14 }, { metric: 'cost', days: 14 },
  ] as const)('settles an accounting-only Agent river ($metric, $days days) without reading Session evidence', async ({ metric, days }) => {
    const startMs = Date.UTC(2026, 9, 26);
    const riverAccounting: UsageAnalyticsQueryResponse = {
      ...accounting,
      totals: { ...accounting.totals, eventCount: days,
        tokens: { ...accounting.totals.tokens, input: 10 * days, output: 5 * days, total: 15 * days },
        cost: { ...accounting.totals.cost, reportedUsd: days } },
      contributions: Array.from({ length: days }, (_, day) => ({
        id: `river-${day}`, sessionId: 'river-session', turnId: `turn-${day}`,
        observedAtMs: startMs + day * 86_400_000, eventCount: 1,
        agentId: 'claude', modelId: 'claude-model', machineId: null, projectKey: null, workspaceId: null,
        source: 'runtime', sourceContext: { path: 'runtime', execution: 'happier' },
        tokens: accounting.totals.tokens, cost: accounting.totals.cost,
      } satisfies NonNullable<UsageAnalyticsQueryResponse['contributions']>[number])),
    };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-river-settlement.test', accountId: 'account-a' }],
      route: request => request.path === '/v2/usage/query' ? Response.json(riverAccounting)
        : request.path === '/v1/features' || request.path === '/v1/features/authenticated'
          ? Response.json(createRootLayoutFeaturesResponse())
          : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method, headers: request.headers }) ?? undefined });
    const serverId = home.homes.a!.id;
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await sync.resumeSync('server-reachable');
    // Account restoration has its own Session-list acquisition. The contract
    // below measures the subsequent accounting-only widget mount.
    await sync.refreshSessions({ awaitSessionListHydration: true });
    const beforeMount = home.requests.length;
    const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><UsageWidgetBatchProvider clauses={clauses}>
      <UsageWidgetBody id="usage_flow" serverId={serverId} testID="river" input={{ ...scope, metric, style: 'agentRiver',
        period: { startMs: Date.UTC(2026, 9, 26), endMs: Date.UTC(2026, 9, 26) + days * 86_400_000 }, breakdown: [] }} />
    </UsageWidgetBatchProvider></InjectedAuthProvider>);
    try {
      await flushHookEffects({ cycles: 30 });
      const mountRequests = home.requests.slice(beforeMount);
      expect(mountRequests.filter(request => request.path === '/v2/usage/query')).toHaveLength(1);
      expect(mountRequests.filter(request => request.path.includes('/sessions')),
        JSON.stringify(mountRequests.map(request => ({ method: request.method, path: request.path })))).toHaveLength(0);
      expect(screen.findByTestId('river.loading')).toBeNull();
      expect(screen.findByTestId(days === 7 ? 'river.needsData' : 'river.river')).not.toBeNull();
    } finally { await screen.unmount(); }
  });
  it('requests only the output sections consumed by mounted Usage bodies and their chart styles', async () => {
    type WidgetId = Exclude<UsageBuiltinWidgetIdV1, 'usage_sources'>;
    const outputs = ['includeContributions', 'includeSeries', 'includeInsights', 'includeActivity', 'includeLeaders', 'includeModelTimeline', 'includeMessageStats', 'includeQuotaHistory', 'includeComparison'] as const;
    type Output = typeof outputs[number];
    const defaults = {
      usage_daily: ['includeSeries', 'includeModelTimeline'],
      usage_period_summary: ['includeInsights', 'includeMessageStats', 'includeComparison'],
      usage_cost_facts: [],
      usage_flow: ['includeSeries', 'includeModelTimeline'],
      usage_efficiency: ['includeInsights', 'includeComparison'],
      usage_breakdowns: [],
      usage_capacity: [],
      usage_projections: ['includeQuotaHistory'],
      usage_resets: ['includeQuotaHistory'],
      usage_plan_fit: ['includeActivity', 'includeQuotaHistory'],
      usage_project_ledger: [],
      usage_session_value: [],
      usage_outcomes: [],
      usage_coach: [],
      usage_rhythm: ['includeActivity', 'includeInsights'],
      usage_parallel: ['includeActivity'],
      usage_human_loop: [],
      usage_night_shift: ['includeActivity'],
      usage_recap: ['includeActivity', 'includeInsights', 'includeLeaders'],
      usage_footprint: [],
      usage_source_coverage: [],
      usage_unpriced: [],
      usage_score: ['includeActivity'],
      usage_orbit: ['includeActivity'],
      usage_constellation: ['includeActivity'],
      usage_planet: ['includeActivity'],
      usage_run_length: [],
      usage_atmosphere: ['includeActivity'],
      usage_machines: [],
      usage_projects: [],
    } satisfies Record<WidgetId, readonly Output[]>;
    const cases: readonly Readonly<{ id: WidgetId; style?: string; session?: string | string[]; reads: readonly Output[]; size?: WidgetPresentation['size']; exactHistory?: boolean }>[] = [
      ...Object.entries(defaults).map(([id, reads]) => ({ id: id as WidgetId, reads })),
      // Wide limits and small tiles draw no exact earlier-window curves; Large keeps the chart.
      { id: 'usage_projections', size: 'wide', reads: defaults.usage_projections, exactHistory: false },
      { id: 'usage_projections', size: 'small', reads: defaults.usage_projections, exactHistory: false },
      { id: 'usage_projections', size: 'large', reads: defaults.usage_projections, exactHistory: false },
      { id: 'usage_flow', style: 'agentRiver', reads: ['includeActivity'] },
      { id: 'usage_breakdowns', style: 'crew', reads: ['includeActivity'] },
      { id: 'usage_rhythm', style: 'sky', reads: ['includeActivity'] },
      { id: 'usage_rhythm', style: 'weekdayHour', reads: ['includeActivity', 'includeInsights'] },
      { id: 'usage_rhythm', style: 'ninetyPlanets', reads: ['includeActivity'] },
      { id: 'usage_parallel', style: 'timeline', reads: [] },
      { id: 'usage_recap', style: 'personalRecords', reads: ['includeActivity'] },
      { id: 'usage_recap', session: 'selected-session', reads: defaults.usage_recap },
      { id: 'usage_recap', session: ['selected-session'], reads: defaults.usage_recap },
      { id: 'usage_recap', session: ['first-session', 'second-session'], reads: defaults.usage_recap },
      { id: 'usage_recap', style: 'personalRecords', session: 'selected-session', reads: ['includeActivity'] },
      { id: 'usage_run_length', style: 'galaxy', reads: ['includeActivity'] },
    ];
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-rendered-output.test', accountId: 'account-a' }],
      route: request => request.path === '/v2/usage/query' ? Response.json(accounting)
        : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
    const serverId = home.homes.a!.id;
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const runtime = { pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current' as const, interactionEnabled: true,
      machineId: null, serverId, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime(),
      reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables: () => {} };
    let slices: ReturnType<typeof useUsageWidgetBatchSlices> = [];
    let inventory: ReturnType<typeof useUsageWidgetBatchInventorySlice>;
    function DemandProbe() { slices = useUsageWidgetBatchSlices(); inventory = useUsageWidgetBatchInventorySlice(); return null; }
    const pageQuery = normalizeUsageQuery({ ...resolveUsageWidgetPageInitialQuery({ nowMs: 1000, timeZoneOffsetMinutes: 0 }),
      includeContributions: true, workProjection: 'summary' });
    const inventoryQuery = normalizeUsageQuery({ ...pageQuery, period: { startMs: 0, endMs: 1000 }, breakdown: ['agent', 'machine', 'project', 'source'] });
    const view = (entry?: typeof cases[number]) => <InjectedAuthProvider credentials={credentials}><AppShellPluginUiProjectionValueProvider value={runtime}><CoreCollectionScope>
      <UsageWidgetBatchProvider clauses={readUsageWidgetQueryOverrides(pageQuery)} inventoryQuery={entry ? undefined : inventoryQuery} inventoryOnly={!entry}>
        <DemandProbe /><WidgetPresentationProvider value={entry?.size ? { size: entry.size,
          footprint: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular', width: 'half' }, geometry: { width: 500, height: 400 } } : undefined}>{entry ? <UsageWidgetBody id={entry.id} input={{ ...scope, period: { startMs: 0, endMs: 1000 }, metric: 'tokens',
          ...(entry.style ? { style: entry.style } : {}), ...(entry.session ? { session: entry.session } : {}) }} serverId={serverId} testID="output-demand" /> : null}</WidgetPresentationProvider>
      </UsageWidgetBatchProvider></CoreCollectionScope></AppShellPluginUiProjectionValueProvider></InjectedAuthProvider>;
    const screen = await renderScreen(view(cases[0]!));
    const allowanceOnly = new Set<WidgetId>(['usage_capacity', 'usage_projections', 'usage_resets', 'usage_atmosphere', 'usage_machines', 'usage_projects']);
    try {
      for (const entry of cases) {
        await screen.update(view(entry));
        await expect.poll(() => slices.map(slice => ({ ...Object.fromEntries(outputs.map(output => [output, slice.requestedQuery[output]])),
          includeAccounting: slice.requestedQuery.includeAccounting })),
          { message: `${entry.id} ${entry.style ?? 'default'} consumes only its declared output sections` })
          .toEqual([{ ...Object.fromEntries(outputs.map(output => [output, entry.reads.includes(output)])), includeAccounting: !allowanceOnly.has(entry.id) }]);
        expect.soft(slices[0]?.requestedQuery, `${entry.id}/${entry.size ?? 'default'} must demand exact earlier curves only when drawn`)
          .toMatchObject({ includeQuotaExactHistory: entry.exactHistory ?? false });
        if (entry.id === 'usage_period_summary') expect(slices[0]?.requestedQuery).toMatchObject({
          workProjection: 'summary', includeWorkEvidence: true, includeSessionEvidence: true, includeTranscriptEvidence: false,
        });
        if (entry.id === 'usage_recap') {
          const records = entry.style === 'personalRecords';
          const autopsy = !records && (typeof entry.session === 'string' || entry.session?.length === 1);
          expect(slices[0]?.requestedQuery).toMatchObject({ includeWorkEvidence: !records,
            includeSessionEvidence: true, includeCoach: !records, includeTranscriptEvidence: autopsy,
            ...(records ? {} : { breakdown: expect.arrayContaining(['agent']) }) });
        }
      }
      await screen.update(view());
      await expect.poll(() => inventory?.requestedQuery).toMatchObject({
        ...Object.fromEntries(outputs.map(output => [output, false])), includeAccounting: true,
        includeSessionEvidence: false, includeTranscriptEvidence: false, includeWorkEvidence: false,
        breakdown: ['agent', 'machine', 'project', 'source'], period: { startMs: 0, endMs: 1000 },
      });
    } finally { await screen.unmount(); }
  });
  it('keeps raw contribution bytes out of non-Work bodies despite inherited page detail clauses', async () => {
    const rich: UsageAnalyticsQueryResponse = { ...accounting, contributions: Array.from({ length: 1000 }, (_, index) => ({
      id: `detail-event-${index}`, observedAtMs: 500, sessionId: null, turnId: null, agentId: 'codex', modelId: null,
      machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
      tokens: accounting.totals.tokens, cost: accounting.totals.cost,
    })) };
    const deliveries: UsageAnalyticsQueryBatchResponse[] = [];
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-page-detail-demand.test', accountId: 'account-a' }],
      route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated'
        ? Response.json(createRootLayoutFeaturesResponse()) : request.path === '/v2/usage/query-batch' ? (() => {
        const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
        const chunks = [...projectUsageAnalyticsBatchDelivery({ v: 1,
          results: input.queries.map(query => ({ query, value: repriceUsageAnalyticsResponse(rich, (rich).priceCatalog ?? bundledUsageModelPriceCatalog) })),
        }, input, true)];
        deliveries.push(collectUsageAnalyticsBatchDelivery(chunks));
        return new Response(chunks.map(chunk => JSON.stringify(chunk)).join('\n'), { headers: { 'Content-Type': 'application/x-ndjson' } });
      })() : request.path === '/v2/usage/query' ? Response.json(rich)
        : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
    const serverId = home.homes.a!.id;
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const inherited = readUsageWidgetQueryOverrides(normalizeUsageQuery({ includeContributions: true, workProjection: 'summary' }));
    const observed: { model?: UsageWidgetBodyModel; query: ReturnType<typeof normalizeUsageQuery> | null } = { query: null };
    type WidgetId = 'usage_cost_facts' | 'usage_period_summary' | 'usage_daily' | 'usage_outcomes';
    function Probe(props: Readonly<{ id: WidgetId }>) {
      const result = useUsageWidgetModel({ ...scope, period: { startMs: 0, endMs: 1000 }, metric: 'cost' }, props.id);
      observed.model = result.model; observed.query = result.query;
      return null;
    }
    const view = (id: WidgetId) => <InjectedAuthProvider credentials={credentials}>
      <UsageWidgetBatchProvider clauses={inherited}><Probe id={id} /></UsageWidgetBatchProvider>
    </InjectedAuthProvider>;
    const screen = await renderScreen(view('usage_cost_facts'));
    try {
      for (const id of ['usage_cost_facts', 'usage_period_summary', 'usage_daily'] as const) {
        await screen.update(view(id));
        await expect.poll(() => observed.model?.slice?.accounting !== undefined && !observed.model?.slice?.pending).toBe(true);
        expect.soft(observed.query?.includeContributions, `${id} does not consume raw rows`).toBe(false);
        const rowBytes = deliveries.reduce((bytes, delivery) => bytes + (delivery.contributionPages ?? [])
          .reduce((sum, page) => sum + (page.rows.length ? new TextEncoder().encode(JSON.stringify(page.rows)).byteLength : 0), 0), 0);
        expect.soft(rowBytes, `${id} acquires zero contribution bytes`).toBe(0);
      }
      await screen.update(view('usage_outcomes'));
      await expect.poll(() => observed.query?.includeWorkEvidence).toBe(true);
      expect.soft(observed.query?.includeContributions).toBe(false);
      expect.soft(observed.query?.workProjection, 'Outcomes retains the detailed allocation demand that conserves Work').toBe('detail');
      await expect.poll(() => deliveries.some(delivery => delivery.contributionPages?.some(page => page.totalCount === 1000 && page.nextOffset === null))).toBe(true);
    } finally { await screen.unmount(); }
  });

  it('populates a Project Breakdowns preview with bounded facts outside the mounted Account page batch', async () => {
    // The reported Account has 32,975 usage events. The HTTP boundary owns the
    // raw rows; opening a ranked preview must deliver only its aggregate facts.
    const eventCount = 32_975;
    const totals = { ...accounting.totals, eventCount,
      tokens: { ...accounting.totals.tokens, input: eventCount * 10, output: eventCount * 5, total: eventCount * 15 },
      cost: { ...accounting.totals.cost, reportedUsd: eventCount } };
    const ranked: UsageAnalyticsQueryResponse = { ...accounting, totals,
      breakdowns: { agent: [{ key: 'codex', label: 'Codex', ...totals }] },
      contributions: Array.from({ length: eventCount }, (_, index) => ({ id: `preview-event-${index}`,
        observedAtMs: 1000, sessionId: null, turnId: null, agentId: 'codex', modelId: null,
        machineId: null, projectKey: 'destination-project', workspaceId: null, source: 'codex-native-accounting',
        tokens: accounting.totals.tokens, cost: accounting.totals.cost })) };
    const deliveries: UsageAnalyticsQueryBatchResponse[] = [];
    const features = createRootLayoutFeaturesResponse();
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-preview-isolation.test', accountId: 'account-a' }],
      route: request => request.path === '/v1/features' || request.path === '/v1/features/authenticated' ? Response.json(features)
        : request.path === '/v2/usage/query-batch' ? (() => {
        // Capability discovery and request selection stay real. This HTTP peer
        // serves exactly the projection the mounted preview actually requested.
        const input = UsageAnalyticsQueryBatchRequestSchema.parse(request.body);
        const delivered = collectUsageAnalyticsBatchDelivery(projectUsageAnalyticsBatchDelivery({ v: 1,
          results: input.queries.map(query => ({ query, value: repriceUsageAnalyticsResponse(
            query.filters?.projectKeys?.includes('destination-project') ? ranked : accounting, bundledUsageModelPriceCatalog) })),
        }, input, false));
        deliveries.push(delivered);
        return Response.json(delivered);
      })() : request.path === '/v2/usage/query' ? Response.json(
        UsageAnalyticsQueryRequestSchema.parse(request.body).filters?.projectKeys?.includes('destination-project') ? ranked : accounting)
        : createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined });
    const serverId = home.homes.a!.id;
    publishAppliedActiveServerSnapshot({ serverId, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const { WidgetSetupPreview } = await import('@/components/widgets/surface/WidgetSetupPreview');
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { readWidgetDescriptor } = await import('@/components/widgets/widgetCatalog');
    const candidate = readWidgetDescriptor(null, { kind: 'builtin', id: 'usage_breakdowns' })!;
    const seen = new Map<string, UsageWidgetBodyModel>();
    let slices: ReturnType<typeof useUsageWidgetBatchSlices> = [];
    function Probe() { slices = useUsageWidgetBatchSlices(); return <Body name="account" metric="tokens" seen={seen} />; }
    const input = { ...scope, projects: ['destination-project'], metric: 'tokens', breakdown: ['agent'], style: 'breakdowns' };
    const runtime = { pluginUiProjection: null, pluginBrowserProjection: null, phase: 'current' as const, interactionEnabled: true,
      machineId: null, serverId, platform: 'web' as const, accountLifetime: captureActiveServerAccountScopeLifetime(),
      reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables: () => {} };
    const view = (preview: boolean) => <InjectedAuthProvider credentials={credentials}><AppShellPluginUiProjectionValueProvider value={runtime}><CoreCollectionScope>
      <UsageWidgetBatchProvider clauses={clauses}><Probe />{preview ? <WidgetSetupPreview candidate={candidate}
        scope={{ serverId, accountId: 'account-a', owner: { kind: 'project', projectId: 'destination-project' } }}
        providedContext={{ projects: [['destination-project']] }} draft={{ bindings: {
          ...Object.fromEntries(Object.entries(input).map(([path, value]) => [path, { kind: 'value' as const, value }])),
          projects: { kind: 'context', slot: 'projects' },
        } }} testID="project-preview" /> : null}</UsageWidgetBatchProvider>
    </CoreCollectionScope></AppShellPluginUiProjectionValueProvider></InjectedAuthProvider>;
    const screen = await renderScreen(view(false));
    try {
      await expect.poll(() => seen.get('account')?.slice?.accounting?.totals.eventCount).toBe(1);
      const entry = seen.get('account')!.slice!.key;
      await screen.update(view(true));
      await expect.poll(() => deliveries.some(delivery => delivery.results.some(result =>
        result.query.filters?.projectKeys?.includes('destination-project')))).toBe(true);
      const previewRequests = home!.httpRequests.filter(request => request.path === '/v2/usage/query-batch')
        .map(request => UsageAnalyticsQueryBatchRequestSchema.parse(request.body))
        .filter(request => request.queries.some(query => query.filters?.projectKeys?.includes('destination-project')));
      expect(previewRequests.length).toBeGreaterThan(0);
      for (const request of previewRequests) {
        expect(request).toMatchObject({ includeContributions: false, contributionQueries: [] });
        for (const query of request.queries) expect(query).toMatchObject({ includeSeries: false, includeInsights: false,
          includeLeaders: false, includeModelTimeline: false, includeMessageStats: false, includeActivity: false });
      }
      for (const delivery of deliveries) {
        for (const result of delivery.results) if ('value' in result) expect(result.value).not.toHaveProperty('contributions');
        expect(delivery.contributionPages?.flatMap(page => page.rows) ?? []).toEqual([]);
      }
      await expect.poll(() => screen.findAllByType(UsageBreakdownsBody)[0]?.props.model.blocks)
        .toMatchObject([{ id: 'agent', rows: [{ id: 'codex', value: totals.tokens.total }] }]);
      expect(screen.findByType(UsageBreakdownsWidget).props.query.includeQuotaHistory).toBe(false);
      expect(slices.map(slice => slice.key)).toEqual([entry]);
      expect(slices[0]?.requestedQuery.projects).toEqual([]);
      await screen.update(view(false));
      expect(slices.map(slice => slice.key)).toEqual([entry]);
    } finally { await screen.unmount(); }
  });
  it('feeds Sources panels from one admitted accounting Resource through their real builtin dispatch', async () => {
    const value: UsageAnalyticsQueryResponse = { ...accounting,
      totals: { ...accounting.totals, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' } },
      contributions: [{ id: 'unpriced', sessionId: null, turnId: null, observedAtMs: 1, eventCount: 1,
        agentId: 'codex', modelId: null, machineId: null, projectKey: null, workspaceId: null,
        source: 'codex-native-accounting', sourceContext: { path: 'native', execution: 'outside' },
        tokens: accounting.totals.tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' } }],
      coverage: { status: 'partial', reasons: ['unpriced_tokens'], missingDimensions: [], range: { complete: false }, ranked: [],
        sources: [{ source: 'codex-native-accounting', path: 'native', status: 'partial', eventCount: 1, captureKind: 'from_logs' }] } };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-source-panels.test', accountId: 'account-a' }],
      route: request => request.path === '/v2/usage/query' ? Response.json(repriceUsageAnalyticsResponse(value, (value).priceCatalog ?? bundledUsageModelPriceCatalog)) : undefined });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId: home.homes.a!.id, accountId: 'account-a' }, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><CoreCollectionScope>
      <UsageWidgetBatchProvider clauses={clauses}>{(['usage_source_coverage', 'usage_unpriced'] as const).map(id =>
        <UsageWidgetBody key={id} id={id} input={{ ...scope, period: { startMs: 0, endMs: 1000 } }} serverId={home!.homes.a!.id} testID={id} />)}
      </UsageWidgetBatchProvider></CoreCollectionScope></InjectedAuthProvider>);
    await expect.poll(() => screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'usage_unpriced.tokens')?.props.value).toBe(15);
    expect(screen.findByType(HappierDataRows).props.rows).toHaveLength(1);
    expect(home.requests.filter(request => request.path === '/v2/sessions/read-batch'
      || request.path.endsWith('/messages') || request.path.endsWith('/turns'))).toEqual([]);
    await screen.unmount();
  });
  it('owns coverage from the first frame, before the inventory has answered', async () => {
    const seen: boolean[] = [];
    function CoverageProbe() { seen.push(useUsageWidgetPageHasCoverageDetail()); return null; }
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
      <UsageWidgetBatchProvider clauses={clauses}><CoverageProbe /></UsageWidgetBatchProvider>
    </InjectedAuthProvider>);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(Boolean)).toBe(true);
    await screen.update(<CoverageProbe />);
    expect(seen.at(-1)).toBe(false);
  });
  it.each(['usage_daily', 'usage_outcomes', 'usage_footprint', 'usage_source_coverage', 'usage_unpriced'] as const)('admits private evidence through the real %s body only when its projection consumes it', async narrowId => {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-widget-demand.test', accountId: 'account-a' }],
      route: request => {
        if (request.path === '/v2/usage/query') return Response.json(accounting);
        if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        if (request.method === 'PUT' && request.path === '/v2/sessions/work/system-records'
          && request.body !== null && typeof request.body === 'object' && 'address' in request.body && 'content' in request.body) {
          return Response.json({ record: { id: 'usage-facts', address: request.body.address, content: request.body.content,
            revision: 'ssr1.AAAACHN5c3JlY18xAAAAAQ', createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } });
        }
        if (request.path === USAGE_SESSION_EVIDENCE_PATH && request.method === 'POST') {
          const input = UsageSessionEvidenceRequestSchema.parse(request.body);
          const turns = { status: 200, body: { v: 1, sessionId: 'work', updatedAt: 900,
            turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 }] } };
          return Response.json(UsageSessionEvidenceResponseSchema.parse({
            requests: input.requests.map(demand => ({ query: demand.query, sessionIds: demand.sessionIds ?? ['work'] })),
            results: [{ sessionId: 'work', turns, ...(input.readWorkFacts ? {
              workFacts: { session: { id: 'work', seq: 1, createdAt: 1, updatedAt: 900, active: true,
                metadataVersion: 1, agentStateVersion: 1, metadataLayoutVersion: 1,
                encryptionMode: 'plain', dataEncryptionKey: null, viewerRole: 'owner',
              access: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionAccessFixture().capabilities } },
              records: (input.workFactKinds ?? ['work']).map(kind => ({ kind, content: null })) },
            } : {
              detail: { status: 200, body: { session: createPlainSessionCurrentProjectionRecordFixture({ id: 'work',
                createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
                metadataVersion: 1, metadata: { path: '', host: '', name: 'work' }, agentStateVersion: 1 }) } },
              messageEvidence: {}, messagesComplete: true,
            }) }],
          }));
        }
        return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
      } });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId: home.homes.a!.id, accountId: 'account-a' },
      profile: AccountProfileSchema.parse({ id: 'account-a' }),
      sessions: { work: createSessionFixture({ id: 'work', serverId: home.homes.a!.id, encryptionMode: 'plain' }) } });
    let slices: ReturnType<typeof useUsageWidgetBatchSlices> = [];
    function EvidenceProbe() { slices = useUsageWidgetBatchSlices(); return null; }
    const body = (id: typeof narrowId | 'usage_period_summary' | 'usage_coach') => <InjectedAuthProvider credentials={credentials}>
      <CoreCollectionScope><UsageWidgetBatchProvider clauses={clauses}><EvidenceProbe /><UsageWidgetBody id={id}
        input={{ ...scope, period: { startMs: 0, endMs: 1000 }, metric: 'tokens', breakdown: [] }}
        serverId={home!.homes.a!.id} testID="widget-demand" /></UsageWidgetBatchProvider></CoreCollectionScope>
    </InjectedAuthProvider>;
    const screen = await renderScreen(body(narrowId));
    const evidenceReads = () => home!.requests.filter(request => request.method === 'POST' && request.path === USAGE_SESSION_EVIDENCE_PATH)
      .map(request => UsageSessionEvidenceRequestSchema.parse(request.body));
    await expect.poll(() => home!.requests.filter(request => request.path === '/v2/usage/query').length).toBeGreaterThan(0);
    await flushHookEffects({ cycles: 30 });
    expect(evidenceReads()).toEqual([]);
    expect(home.requests.filter(request => request.method === 'POST' && request.path === '/v2/sessions/read-batch'
      || request.method === 'GET' && (request.path === '/v2/sessions/work' || request.path.startsWith('/v1/sessions/work/')))).toEqual([]);
    await screen.update(body('usage_period_summary'));
    // Custom windows open unconverted evidence under the shared window policy,
    // even when this body's summary projection does not consume transcript facts.
    await expect.poll(evidenceReads).toEqual([
      expect.objectContaining({ readWorkFacts: true,
        requests: [expect.objectContaining({ query: expect.objectContaining({ includeSessionEvidence: true, includeTranscriptEvidence: false }) })] }),
      expect.objectContaining({ requests: [expect.objectContaining({ sessionIds: ['work'],
        query: expect.objectContaining({ includeTranscriptEvidence: true }) })] }),
    ]);
    expect(evidenceReads()[1]).not.toHaveProperty('readWorkFacts');
    await expect.poll(() => slices.find(slice => slice.howYouWork)?.howYouWork?.intervals?.agentTimeMs).toBe(300);
    await expect.poll(() => slices.find(slice => slice.howYouWork)?.sources)
      .toContainEqual({ source: 'how_you_work:transcripts', status: 'not_loaded' });
    const admittedReads = evidenceReads();
    await screen.update(body('usage_coach'));
    await flushHookEffects({ cycles: 30 });
    expect(evidenceReads()).toEqual(admittedReads);
    expect(home.requests.filter(request => request.method === 'POST' && request.path === '/v2/sessions/read-batch'
      || request.method === 'GET' && (request.path === '/v2/sessions/work' || request.path.startsWith('/v1/sessions/work/')))).toEqual([]);
    await expect.poll(() => slices.find(slice => slice.coach)?.sources)
      .toContainEqual({ source: 'how_you_work:transcripts', status: 'available' });
  });

  it.each([false, true])('requests both consumed activity sections despite route includeActivity=%s and partial resolution, preserving independently pinned scope', async includeActivity => {
    const days = [{ date: '2026-10-08', eventCount: 1 }, { date: '2026-10-09', eventCount: 2 }, { date: '2026-10-10', eventCount: 1 }];
    const page = resolveUsageWidgetPageInitialQuery({ nowMs: Date.UTC(2026, 9, 11), timeZoneOffsetMinutes: 120,
      initialFilters: resolveUsagePageInitialFilters({ queryOverrides: JSON.stringify(readUsageWidgetQueryOverrides(normalizeUsageQuery({ includeActivity, activityResolution: 'weekdayHour' }))) }) });
    const input = { ...scope, period: { startMs: Date.UTC(2026, 9, 8), endMs: Date.UTC(2026, 9, 11) }, machines: ['pinned'], metric: 'tokens' as const, breakdown: [] };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-activity.test', accountId: 'account-a' }], route: request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
      return Response.json({ ...accounting, insights: { activeDays: 3, longestStreakDays: 3, sessionsUsed: 1,
        messagesUsed: 4, modelsTried: 0, favoriteModelChangeCount: 0 }, series: days.map((day, index) => ({ bucketStartMs: input.period.startMs + index * 86_400_000,
        bucketEndMs: input.period.startMs + (index + 1) * 86_400_000, eventCount: day.eventCount,
        tokens: accounting.totals.tokens, cost: accounting.totals.cost })), activity: query.includeActivity ? {
        calendarDays: query.activityResolution === 'weekdayHour' ? undefined : days,
        weekdayHourBuckets: query.activityResolution === 'calendar' ? undefined : [{ weekday: 4, hour: 12, eventCount: 4 }],
      } : undefined });
    } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    let observed: ReturnType<typeof useUsageWidgetModel> | undefined;
    function Probe() { observed = useUsageWidgetModel(input, 'usage_rhythm'); return null; }
    await renderScreen(<InjectedAuthProvider credentials={credentials}><UsageWidgetBatchProvider clauses={readUsageWidgetQueryOverrides(page)}>
      <Probe />
    </UsageWidgetBatchProvider></InjectedAuthProvider>);
    await flushHookEffects({ cycles: 30 });
    expect(observed?.query).toMatchObject({ includeActivity: true, activityResolution: 'both', includeSessionEvidence: false,
      machines: ['pinned'], period: input.period });
    expect(observed?.model.slice?.accounting?.activity).toEqual({ calendarDays: days,
      weekdayHourBuckets: [{ weekday: 4, hour: 12, eventCount: 4 }] });
    const view = buildUsageAnalyticsViewModel(observed!.model.slice!.accounting!, { period: 'all', metric: 'tokens', costMode: 'auto', focus: null });
    expect(view.overview.activeDays).toBe(view.activity.calendarDays.length);
    expect(view.overview.activeDays).toBe(3);
    expect(view.insights.activeDays).toBe(view.activity.calendarDays.length);
    expect(view.insights.activeDays).toBe(3);
  });
  it('keeps the period-qualified unfiltered scope inventory in the same batch as narrowed widgets', () => {
    const query = normalizeUsageQuery({ ...scope, agents: ['claude'], sources: ['runtime'], breakdown: ['model'] });
    const inventory = normalizeUsageQuery({ ...query, agents: [], sources: [], machines: [], projects: [], breakdown: ['agent', 'machine', 'project', 'source'] });
    const plan = buildUsageWidgetQueryPlan({ serverId: 'home', accountId: 'account' }, new Map(), inventory);
    expect(plan.input?.queries).toEqual([inventory]);
    expect(plan.widgets.size).toBe(0);
  });
  it('serves every mounted body from one batched read: equal queries share a slice, distinct ones stay keyed apart', async () => {
    const batches: string[][] = [];
    home = await serveAccountHomes({
      homes: [
        {
          key: 'a',
          serverUrl: 'https://usage-batch.test',
          accountId: 'account-a',
        },
      ],
      route: (request) => {
        if (request.path !== '/v2/usage/query') return createEmptyAccountBootstrapHttpResponse(request.path, { method: request.method }) ?? undefined;
        return Response.json(accounting);
      },
    });
    // This count is the mounted page's demand, not unrelated Home bootstrap.
    // Cold hydration/re-POST policy is covered by the Account stability owner.
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await sync.refreshSessions();
    await sync.refreshMachines();
    publishAppliedActiveServerSnapshot({
      serverId: home.homes.a!.id,
      serverUrl: home.homes.a!.serverUrl,
      generation: 0,
    });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(
      home.homes.a!.serverUrl,
    ))!;
    storage.setState({ profileScope: { serverId: home.homes.a!.id, accountId: 'account-a' },
      settingsScope: { serverId: home.homes.a!.id, accountId: 'account-a' },
      profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const seen = new Map<string, UsageWidgetBodyModel>();
    await renderScreen(
      <InjectedAuthProvider credentials={credentials}>
        <UsageWidgetBatchProvider clauses={clauses as never}>
          <Body name="daily" metric="tokens" seen={seen} />
          <Body name="summary" metric="tokens" seen={seen} />
          <Body name="costs" metric="cost" seen={seen} />
          <BatchProbe batches={batches} />
        </UsageWidgetBatchProvider>
      </InjectedAuthProvider>,
    );
    await flushHookEffects({ cycles: 30 });
    const daily = seen.get('daily')!;
    const summary = seen.get('summary')!;
    const costs = seen.get('costs')!;
    expect(daily.slice?.accounting?.totals.tokens.total).toBe(15);
    // Equal resolved requests are one keyed slice; a different own metric is its own slice.
    expect(summary.slice).toBe(daily.slice);
    expect(costs.slice).not.toBeNull();
    expect(costs.slice?.key).not.toBe(daily.slice?.key);
    // Both keyed slices are members of the one page batch value (one `usage.query`), not two reads.
    expect(new Set(batches.at(-1))).toEqual(new Set([daily.slice!.key, costs.slice!.key]));
    expect(home.httpRequests.filter(request => request.path === '/v2/usage/query-batch'),
      `one physical accounting batch serves this page view: ${JSON.stringify(home.httpRequests
        .filter(request => request.path === '/v2/usage/query-batch').map(request => request.body))}`).toHaveLength(1);
    expect(home.httpRequests.filter(request => request.path === '/v2/usage/query'
      || request.path === '/v2/sessions/read-batch' || request.path.endsWith('/messages'))).toHaveLength(0);
  });
});
