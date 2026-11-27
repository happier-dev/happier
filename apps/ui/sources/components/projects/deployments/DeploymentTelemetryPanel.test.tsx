import { Profiler } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1, DATABASE_CAPTURE_STATUS_ACTION_ID_V1, DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1, DatabaseCaptureEndpointsListInputV1Schema, type DatabaseCaptureSourceV1 } from '@happier-dev/database-protocol';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployments/testing/v1';
import {
  createDeploymentEnvironmentHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import {
  act,
  createDeferred,
  createMachineFixture,
  renderScreen,
  standardCleanup,
} from '@/dev/testkit';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { reportCollectionLayout } from '@/dev/testkit/harness/collectionLayoutHarness';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { storage } from '@/sync/domains/state/storage';
import { publishAppliedActiveServerRuntimeAvailability, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { discardSessionDraftPersistenceWrites, prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { clearBrowserRecords } from '@/sync/domains/state/browserRecordStorage';
import { readWorkflowDefinitionDraftSeed } from '@/sync/domains/workflows/workflowDefinitionDraftSeed';
import { TRIAGE_APP_PAGE_DESTINATION_V1 } from '@happier-dev/triage-protocol/v1';
import { buildPluginAppPageRoutePath } from '@/components/plugins/pages/pluginPageRoute';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const router = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/router')).createExpoRouterMock(),
);
vi.mock('expo-router', () => router.module);
// Portal measurement and native menu SDKs are browser boundaries; the menus stay real.
vi.mock('@/utils/web/radixCjs', async () => (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock());
vi.mock('@/components/ui/popover', async (importOriginal) => (await import('@/dev/testkit/mocks/popover'))
  .createInlinePopoverModuleMock(importOriginal, { maxHeight: 640, maxWidth: 280, placement: 'bottom' }));
const modal = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    renderCustomModals: true,
  }),
);
vi.mock('@/modal', () => modal.module);
vi.mock('@/sync/domains/state/browserRecordStorage', async () =>
  (await import('@/dev/testkit/mocks/browserRecordStorage')).createBrowserRecordStorageModuleMock(),
);
afterEach(standardCleanup);

const { DeploymentTelemetryPanel, TelemetryRequestDetail } = await import('./DeploymentTelemetryPanel');
const { PluginEventAutomationEditor } = await import('@/components/automations/editor/PluginEventAutomationEditor');
const { createTelemetryCaptureReads } = await import('./telemetryCaptureReads');
const { LocalServiceCaptureView } = await import('@/components/sessions/localServices/LocalServiceCaptureView');
const { TelemetryCaptureFixtureProvider, createTelemetryCaptureFixtureTransport } =
  await import('@/dev/testkit/fixtures/telemetryCaptureFixtures');
const { ModalProvider } = await import('@/modal');
const { CoreCollectionScope } = await import('@/components/ui/lists/collection/CoreCollectionScope');
// The app root's shared presentation theme, which the capture views draw with.
const { AppPresentationPlatformProvider } = await import('@/components/ui/presentation/AppPresentationPlatformProvider');

const lifetime = {
  scope: { serverId: 'home', accountId: 'owner' },
  isCurrent: () => true,
  onRetire: () => ({ dispose() {} }),
};

function setUpDetail(role: 'manager' | 'reader' = 'manager', collectorId = 'collector') {
  const base = createDeploymentEnvironmentDetailV1({
    environment: createDeploymentEnvironmentHeaderV1({ id: 'production' }),
  });
  return {
    ...base,
    environment: {
      ...base.environment,
      telemetryMachineId: collectorId,
      capabilities: { ...base.environment.capabilities, role, manage: role === 'manager', manageBindings: role === 'manager' },
    },
    content: {
      ...base.content,
      telemetry: { metrics: false, appLlmCost: true, exceptions: true },
    },
  };
}

const checkout = {
  serviceName: 'billing-api',
  method: 'POST',
  route: '/checkout',
  requestCount: 4812,
  errorCount: 116,
  errorRate: 116 / 4812,
  totalDurationMs: 4812 * 412,
  databaseTimeMs: 4812 * 156,
};
const request = {
  id: 'req-1',
  worktree: 'environment:production',
  kind: 'span',
  source: 'otlp',
  at: Date.UTC(2026, 10, 17, 19, 48),
  traceId: 'trace-1',
  spanId: 'root',
  spanKind: 2,
  durationMs: 412,
  endpointMethod: 'POST',
  endpointRoute: '/checkout',
  httpStatusCode: 500,
  serviceName: 'billing-api',
} as const;
const source = {
  kind: 'environment',
  serverId: 'home',
  environmentId: 'production',
} as const;

type Call = Readonly<{
  collectorMachineId: string;
  actionId: string;
  input: unknown;
}>;

/** The collector's answers at the Action front door: the one network edge of the tab's reads. */
function collector(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const invoke = vi.fn(async (call: Call & { signal?: AbortSignal }) => {
    const { signal: _signal, ...recorded } = call as Call & {
      signal?: AbortSignal;
      scope?: unknown;
    };
    calls.push(recorded);
    return answer(recorded);
  });
  return { invoke, calls };
}

/** Reads resolve and the Collection lays its rows out over a few turns. */
async function settle() {
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

function panel(
  invoke: ReturnType<typeof collector>['invoke'],
  detail: ReturnType<typeof setUpDetail>,
  demand?: { telemetryApplied?: boolean; hostedServingDeploymentId?: string | null; active?: boolean; lifetime?: typeof lifetime },
  transport?: ReturnType<typeof createTelemetryCaptureFixtureTransport>,
) {
  return (
    <AppPresentationPlatformProvider><ModalProvider>
      <TelemetryCaptureFixtureProvider invoke={invoke} transport={transport}>
        <DeploymentTelemetryPanel
          detail={detail}
          lifetime={lifetime}
          environmentName="Production"
          onChanged={() => {}}
          {...demand}
        />
      </TelemetryCaptureFixtureProvider>
    </ModalProvider></AppPresentationPlatformProvider>
  );
}

async function mount(
  invoke: ReturnType<typeof collector>['invoke'],
  role: 'manager' | 'reader' = 'manager',
) {
  const screen = await renderScreen(panel(invoke, setUpDetail(role)));
  await settle();
  return screen;
}

const answers = (call: Call, admittedSource: DatabaseCaptureSourceV1 = source) => {
  const source = admittedSource;
  if (call.actionId === DATABASE_CAPTURE_STATUS_ACTION_ID_V1)
    return { ok: true, source, enabled: true, coverage: { lostObservations: 0, reason: null } };
  if (call.actionId.endsWith('/capture/endpoints/list'))
    return { ok: true, source, items: [checkout] };
  if (call.actionId.endsWith('/capture/traces/list'))
    return { ok: true, source, items: [request] };
  if (call.actionId.endsWith('/capture/trace/get'))
    return {
      ok: true,
      source,
      traceId: 'trace-1',
      findings: [{
        v: 1,
        sourceRef: { pluginId: 'happier.telemetry', localId: 'capture-findings' },
        sourceScope: { serverId: source.serverId, machineId: source.kind === 'worktree' ? source.machineId : 'collector' },
        evidenceIdentity: 'retained-request-failure',
        kind: 'failing_endpoint',
        ...(source.kind === 'environment' ? { environmentObservation: { shapeKey: 'checkout-shape',
          reportedService: { kind: 'workload_reported', name: request.serviceName } } } : {}),
        title: 'Endpoint request failed',
        observedWindow: { fromMs: request.at, toMs: request.at + request.durationMs },
        coverage: { status: 'complete' },
        summary: { records: 1, totalTimeMs: request.durationMs },
        verification: {
          observationKey: request.id,
          httpStatusCode: request.httpStatusCode,
          readBefore: { action: 'happier.telemetry/actions/capture/trace/get', input: { source, traceId: 'trace-1', page: { limit: 10 } } },
          findAfter: { action: 'happier.telemetry/actions/capture/traces/list', input: { source, since: request.at + request.durationMs, page: { limit: 10 } } },
        },
      }],
      repeatedQueries: [],
      slowChildSpans: [],
      logCorrelations: [],
      summaries: [
        request,
        {
          ...request,
          id: 'stripe',
          spanId: 'stripe',
          parentSpanId: 'root',
          spanKind: 3,
          at: request.at + 20,
          durationMs: 318,
          endpointMethod: null,
          endpointRoute: null,
          httpStatusCode: null,
          shape: 'stripe.paymentIntents.create',
        },
        {
          id: 'log-1',
          worktree: request.worktree,
          kind: 'log',
          source: 'otlp',
          at: request.at + 30,
          traceId: 'trace-1',
          severityNumber: 17,
          bodyPrefix: 'TypeError: Cannot read properties of undefined',
          bodyPrefixTruncated: false,
        },
      ],
    };
  if (call.actionId.endsWith('/capture/logs/list'))
    return { ok: true, source, items: [] };
  if (call.actionId.endsWith('/capture/queries/list'))
    return { ok: true, source, items: [] };
  throw new Error(`unexpected ${call.actionId}`);
};

describe('Environment Telemetry tabs', () => {
  it('does not use finite first-page reads while following collector capture', async () => {
    let route = '/checkout';
    const before = { serviceName: checkout.serviceName, method: checkout.method, route };
    const finite = collector(() => ({ ok: true, source, items: [{ ...checkout, route: '/older' }] }));
    const capture = collector(() => ({ ok: true, source, items: [{ ...checkout, route }],
      ...(route === '/checkout' ? { nextCursor: before } : {}) }));
    const transport = createTelemetryCaptureFixtureTransport(capture.invoke);
    const detail = setUpDetail();
    const commits = vi.fn();
    const screen = await renderScreen(
      <Profiler id="Environment Telemetry" onRender={commits}>
        {panel(finite.invoke, detail, { active: true }, transport)}
      </Profiler>,
    );
    try {
      await settle();
      expect(screen.findByTestId('telemetry.capture.endpoint.POST /checkout')).not.toBeNull();
      expect(capture.calls).toEqual([expect.objectContaining({ collectorMachineId: 'collector', input: expect.objectContaining({ source }) })]);
      expect(transport.watchers).toBe(1);
      expect(finite.calls).toHaveLength(0);
      commits.mockClear();
      vi.useFakeTimers();
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      vi.useRealTimers();
      expect(finite.calls).toHaveLength(0);
      expect(capture.calls).toHaveLength(1);
      expect(commits).toHaveBeenCalledTimes(0);

      const initial = DatabaseCaptureEndpointsListInputV1Schema.parse(capture.calls[0]?.input);
      await screen.pressByTestIdAsync('telemetry.capture.endpoints.older');
      await settle();
      expect(finite.calls).toEqual([expect.objectContaining({ actionId: DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1,
        input: expect.objectContaining({ source, since: initial.since, until: initial.until,
          page: expect.objectContaining({ before }) }) })]);
      expect(screen.findByTestId('telemetry.capture.endpoint.POST /older')).not.toBeNull();

      commits.mockClear();
      route = '/payment';
      await act(async () => transport.invalidate());
      await settle();
      expect(screen.findByTestId('telemetry.capture.endpoint.POST /payment')).not.toBeNull();
      expect(screen.findByTestId('telemetry.capture.endpoint.POST /older')).toBeNull();
      expect(capture.calls).toHaveLength(2);

      await settle();
      expect(capture.calls).toHaveLength(2);
      expect(commits).toHaveBeenCalledTimes(1);
      await screen.update(panel(finite.invoke, detail, { active: false }, transport));
      expect(transport.watchers).toBe(0);
      await act(async () => transport.invalidate());
      await settle();
      expect(capture.calls).toHaveLength(2);
      expect(finite.calls).toHaveLength(1);
    } finally { vi.useRealTimers(); await screen.unmount(); }
  });

  it('distinguishes deployment settlement from accepted data and reads only while presented', async () => {
    let lastReceivedAt: number | null = null;
    const { invoke, calls } = collector(call => call.actionId.endsWith('/capture/status')
      ? { ok: true, source, coverage: { lostObservations: 0, reason: null }, lastReceivedAt }
      : answers(call));
    const detail = setUpDetail();
    const screen = await renderScreen(panel(invoke, detail, { active: false, telemetryApplied: false }));
    const status = () => screen.findByTestId('project-deployments.telemetry.collector')?.props.children;
    try {
      await settle();
      expect(calls).toHaveLength(0);
      await screen.update(panel(invoke, detail, { active: true, telemetryApplied: false }));
      await settle();
      expect(status()).toContain('Changes apply at the next deploy.');
      expect(calls.map(call => call.actionId)).toEqual(['happier.telemetry/actions/capture/endpoints/list']);

      await screen.update(panel(invoke, detail, { active: true, telemetryApplied: true }));
      await settle();
      expect(status()).toContain('Waiting for first data');
      expect(calls.filter(call => call.actionId.endsWith('/capture/status'))).toEqual([
        expect.objectContaining({ collectorMachineId: 'collector', input: { source } }),
      ]);

      await screen.update(panel(invoke, detail, { active: false, telemetryApplied: true }));
      const whileHidden = calls.length;
      lastReceivedAt = request.at;
      await settle();
      expect(calls).toHaveLength(whileHidden);
      await screen.update(panel(invoke, detail, { active: true, telemetryApplied: true }));
      await settle();
      expect(status()).toContain('Receiving');
      expect(calls.slice(whileHidden).map(call => call.actionId).sort()).toEqual([
        'happier.telemetry/actions/capture/status',
      ]);
    } finally {
      await screen.unmount();
    }
  });

  it('renders hosted capture readiness from the collector and refreshes when the serving deploy changes', async () => {
    let environmentReadiness = 'redeploy_required';
    const { invoke, calls } = collector(call => call.actionId === DATABASE_CAPTURE_STATUS_ACTION_ID_V1
      ? { ok: true, source, coverage: { lostObservations: 0, reason: null }, environmentReadiness,
          lastReceivedAt: environmentReadiness === 'receiving' ? request.at : null }
      : answers(call));
    const detail = setUpDetail();
    const screen = await renderScreen(panel(invoke, detail, { active: false, hostedServingDeploymentId: null }));
    const status = () => screen.findByTestId('project-deployments.telemetry.collector')?.props.children;
    try {
      await settle();
      expect(calls).toHaveLength(0);
      await screen.update(panel(invoke, detail, { hostedServingDeploymentId: null }));
      await settle();
      expect(status()).toContain('Changes apply at the next deploy.');
      environmentReadiness = 'waiting_for_first_data';
      await screen.update(panel(invoke, detail, { hostedServingDeploymentId: 'serving' }));
      await settle();
      expect(status()).toContain('Waiting for first data');
      expect(status()).toContain('Changes apply at the next deploy.');
      await screen.update(panel(invoke, detail, { active: false, hostedServingDeploymentId: 'serving' }));
      environmentReadiness = 'receiving';
      await screen.update(panel(invoke, detail, { hostedServingDeploymentId: 'serving' }));
      await settle();
      expect(status()).toContain('Receiving');
      expect(calls.filter(call => call.actionId === DATABASE_CAPTURE_STATUS_ACTION_ID_V1)).toHaveLength(3);
    } finally {
      await screen.unmount();
    }
  });

  it('shows collector storage is full while keeping previously captured data readable', async () => {
    const { invoke, calls } = collector(call => call.actionId === DATABASE_CAPTURE_STATUS_ACTION_ID_V1
      ? {
          ok: true,
          source,
          coverage: { lostObservations: 1, reason: 'daemon_database_quota_exceeded' },
          lastReceivedAt: request.at,
        }
      : answers(call));
    const screen = await renderScreen(panel(invoke, setUpDetail(), { telemetryApplied: true }));
    try {
      await settle();
      expect(screen.findByTestId('project-deployments.telemetry.collector')?.props.children).toBe('Collector storage full');
      await reportCollectionLayout(screen, 'telemetry.capture.endpoints');
      expect(screen.findByTestId('telemetry.capture.endpoint.POST /checkout')).not.toBeNull();
      expect(calls.filter(call => call.actionId === DATABASE_CAPTURE_STATUS_ACTION_ID_V1)).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  });

  it('reads the open list once on the collector with the Environment as its source, and each tab reads its own list', async () => {
    const { invoke, calls } = collector(answers);
    const screen = await mount(invoke);
    try {
      expect(calls).toEqual([
        expect.objectContaining({
          collectorMachineId: 'collector',
          actionId: 'happier.telemetry/actions/capture/endpoints/list',
          input: expect.objectContaining({
            source,
            since: expect.any(Number),
            until: expect.any(Number),
          }),
        }),
      ]);
      await reportCollectionLayout(screen, 'telemetry.capture.endpoints');
      expect(
        screen.findByTestId('telemetry.capture.endpoint.POST /checkout'),
      ).not.toBeNull();
      await screen.pressByTestIdAsync(
        'project-deployments.telemetry.tab:traces',
      );
      await settle();
      expect(calls.map((call) => call.actionId)).toEqual([
        'happier.telemetry/actions/capture/endpoints/list',
        'happier.telemetry/actions/capture/traces/list',
      ]);
      await reportCollectionLayout(screen, 'telemetry.capture.traces');
      expect(
        screen.findByTestId('telemetry.capture.trace.req-1'),
      ).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it.each([{ openRequest: false }, { openRequest: true }])('drops retained capture when the collector changes (openRequest=$openRequest)', async ({ openRequest }) => {
    const refused = createDeferred<{ ok: false; code: string }>();
    const { invoke, calls } = collector(call => call.collectorMachineId === 'other-collector' ? refused.promise : answers(call));
    const screen = await mount(invoke);
    const traceRow = 'telemetry.capture.trace.req-1';
    try {
      await reportCollectionLayout(screen, 'telemetry.capture.endpoints');
      expect(screen.findByTestId('telemetry.capture.endpoint.POST /checkout')).not.toBeNull();
      await screen.pressByTestIdAsync('project-deployments.telemetry.tab:traces');
      await settle();
      await reportCollectionLayout(screen, 'telemetry.capture.traces');
      expect(screen.findByTestId(traceRow)).not.toBeNull();
      if (openRequest) {
        await screen.pressByTestIdAsync(traceRow);
        await settle();
        expect(screen.findByTestId('project-deployments.telemetry.request')).not.toBeNull();
      }

      const beforeSwitch = calls.length;
      await screen.update(panel(invoke, setUpDetail('manager', 'other-collector')));
      expect(calls.slice(beforeSwitch)).toEqual([expect.objectContaining({
        collectorMachineId: 'other-collector',
        actionId: 'happier.telemetry/actions/capture/traces/list',
      })]);
      expect(screen.findByTestId(traceRow)).toBeNull();
      expect(screen.findByTestId('project-deployments.telemetry.request')).toBeNull();
      expect(screen.findByTestId('project-deployments.telemetry.reading')).not.toBeNull();

      refused.resolve({ ok: false, code: 'capture_source_unavailable' });
      await settle();
      expect(screen.findByTestId('project-deployments.telemetry.unavailable')).not.toBeNull();
      expect(screen.findByTestId(traceRow)).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.telemetry.tab:endpoints');
      await settle();
      expect(screen.findByTestId('telemetry.capture.endpoint.POST /checkout')).toBeNull();
      expect(calls.slice(beforeSwitch).map(call => [call.collectorMachineId, call.actionId])).toEqual([
        ['other-collector', 'happier.telemetry/actions/capture/traces/list'],
        ['other-collector', 'happier.telemetry/actions/capture/endpoints/list'],
      ]);
    } finally {
      refused.resolve({ ok: false, code: 'capture_source_unavailable' });
      await screen.unmount();
    }
  });

  it('opens the selected individual App LLM call in the existing Trace detail', async () => {
    const genAi = { provider: 'example', modelId: 'fixture-model', requestedModel: null, operation: 'chat',
      tokens: { input: 12, output: 3, total: null, reasoning: null, cacheRead: null, cacheWrite: null },
      tokenCategories: null, reportedCost: { amount: 0.002, currency: 'USD' } };
    const selection = { serviceName: 'api', serviceVersion: 'v2' };
    const call = { id: 'call-b', worktree: 'environment:production', kind: 'span', source: 'otlp',
      at: 1001, serviceName: 'api', serviceVersion: 'v2', traceId: 'trace-1', genAi } as const;
    const { invoke, calls } = collector((request) => {
      if (request.actionId.endsWith('/capture/traces/list')) {
        return { ok: true, source, items: [{ ...call, id: 'call-a', traceId: 'other-trace' }, call] };
      }
      return answers(request);
    });
    const reads = createTelemetryCaptureReads(invoke, { scope: lifetime.scope, collectorMachineId: 'collector',
      environmentId: source.environmentId });
    const retained = await reads.appLlmCalls(selection, 1_000, 2_000, null);
    const selected = retained.items.find(item => item.id === 'call-b');
    expect(selected?.genAi).toEqual(genAi);
    if (!selected) throw new Error('Expected a retained App LLM call');
    const screen = await renderScreen(
      <AppPresentationPlatformProvider>
        <CoreCollectionScope>
          <TelemetryRequestDetail reads={reads} lifetime={lifetime} active request={selected} locale="en" onBack={() => {}} />
        </CoreCollectionScope>
      </AppPresentationPlatformProvider>,
    );
    try {
      await settle();
      expect(calls.map(request => request.input)).toEqual([
        expect.objectContaining({ source, since: 1_000, until: 2_000, appLlmCalls: selection }),
        expect.objectContaining({ source, traceId: 'trace-1' }),
      ]);
      expect(screen.findByTestId('project-deployments.telemetry.request')).not.toBeNull();
    } finally { await screen.unmount(); }
  });

  it('opens a trace row as its request: one trace read by its id, then where its time went and its logs', async () => {
    const { invoke, calls } = collector(answers);
    const screen = await mount(invoke);
    try {
      await screen.pressByTestIdAsync(
        'project-deployments.telemetry.tab:traces',
      );
      await settle();
      await reportCollectionLayout(screen, 'telemetry.capture.traces');
      await screen.pressByTestIdAsync('telemetry.capture.trace.req-1');
      await settle();
      expect(calls.at(-1)).toEqual(
        expect.objectContaining({
          actionId: 'happier.telemetry/actions/capture/trace/get',
          input: expect.objectContaining({ source, traceId: 'trace-1' }),
        }),
      );
      expect(
        screen.findByTestId('project-deployments.telemetry.request'),
      ).not.toBeNull();
      expect(screen.findByTestId('telemetry.request.slowest')).not.toBeNull();
      expect(screen.findByTestId('telemetry.request.log.log-1')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.telemetry.request.investigate')).not.toBeNull();
      // The request opens beside the list (CaptureTraces detail): the list stays, and the detail has no way back of its own.
      expect(screen.findByTestId('project-deployments.telemetry.request.back')).toBeNull();
      expect(
        screen.findByTestId('telemetry.capture.trace.req-1'),
      ).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it('opens a Workflow draft scoped to the selected production finding without saving it', async () => {
    const { invoke, calls } = collector(call => answers(call));
    router.spies.push.mockClear();
    const screen = await renderScreen(panel(invoke, setUpDetail('reader')));
    try {
      await settle();
      await screen.pressByTestIdAsync('project-deployments.telemetry.tab:traces');
      await settle();
      await reportCollectionLayout(screen, 'telemetry.capture.traces');
      await screen.pressByTestIdAsync('telemetry.capture.trace.req-1');
      await settle();
      const readsBefore = calls.length;
      await screen.pressByTestIdAsync('project-deployments.telemetry.request.automate');
      expect(router.spies.push).toHaveBeenCalledWith({
        pathname: '/workflows/[id]', params: { id: 'new', definitionDraftSeedId: expect.any(String), serverId: source.serverId },
      });
      const route = router.spies.push.mock.lastCall?.[0];
      if (!route || typeof route === 'string' || typeof route.params?.definitionDraftSeedId !== 'string') throw new Error('Workflow draft route missing');
      expect(readWorkflowDefinitionDraftSeed(route.params.definitionDraftSeedId, lifetime.scope)).toMatchObject({
        initialView: 'sentence',
        eventSeed: {
          eventRef: { pluginId: 'happier.telemetry', localId: 'production-finding-observed' },
          monitoringMachineId: 'collector',
          setupInput: { v: 1, source: source },
          initialFilter: { v: 1, all: [
            { op: 'eq', field: '/groupKey', value: expect.stringMatching(/^[a-zA-Z0-9_-]{43}$/) },
          ] },
        },
      });
      expect(calls).toHaveLength(readsBefore);
    } finally {
      await screen.unmount();
    }
  });

  it.each(['trace', 'log'] as const)('shows the collector refusal in the App request %s', async kind => {
    const refusal = { ok: false, status: 'failed', code: 'telemetry_collector_read_failed',
      reason: 'The collector refused the read.', cause: { source: 'platform', code: '503', message: 'The collector is restarting.' } };
    const { invoke } = collector(call => {
      if (call.actionId.endsWith('/capture/query/get')) return refusal;
      const result = answers(call);
      if (!call.actionId.endsWith('/capture/trace/get') || !('summaries' in result) || !result.summaries) return result;
      if (kind === 'trace') return refusal;
      return { ...result, summaries: result.summaries.map(item => item.kind === 'log' ? { ...item, bodyPrefixTruncated: true } : item) };
    });
    const reads = createTelemetryCaptureReads(invoke, { scope: lifetime.scope, collectorMachineId: 'collector',
      environmentId: source.environmentId });
    const screen = await renderScreen(
      <AppPresentationPlatformProvider>
        <CoreCollectionScope>
          <TelemetryRequestDetail reads={reads} lifetime={lifetime} active request={request} locale="en" />
        </CoreCollectionScope>
      </AppPresentationPlatformProvider>,
    );
    try {
      await settle();
      if (kind === 'log') {
        await screen.pressByTestIdAsync('telemetry.request.log.log-1.open');
        await settle();
        expect(screen.getTextContent()).toContain('TypeError: Cannot read properties of undefined');
      }
      expect(screen.getTextContent()).toContain('The collector is restarting.');
    } finally { await screen.unmount(); }
  });

  it.each(['request', 'endpoint', 'setup', 'Worktree request'] as const)('opens an editable Session draft with the selected %s and verification reads', async (feature) => {
    await prepareSessionDraftPersistenceStorage();
    const homes = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries(homes);
    const serverUrl = 'https://telemetry.test';
    const accountId = lifetime.scope.accountId;
    const serverId = await homes.addHome({ name: 'Telemetry', serverUrl, accountId, currentAccount: true });
    const scope = { serverId, accountId };
    publishAppliedActiveServerSnapshot({ serverId, serverUrl, generation: 1 });
    storage.getState().activateProfileScope(scope);
    router.spies.push.mockClear();
    modal.spies.alert.mockClear();
    modal.spies.confirm.mockResolvedValue(true);
    const actualModal = await vi.importActual<typeof import('@/modal')>('@/modal');
    const confirm = vi.spyOn(actualModal.Modal, 'confirm').mockImplementation(modal.spies.confirm);
    const worktree = { machineId: 'running-machine', projectId: 'billing-api', workspaceId: 'checkout' };
    const admittedSource: DatabaseCaptureSourceV1 = feature === 'Worktree request'
      ? { kind: 'worktree', serverId, ...worktree } : { ...source, serverId };
    const { invoke, calls } = collector(call => {
      if (call.actionId !== DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1) return answers(call, admittedSource);
      const input = DatabaseCaptureEndpointsListInputV1Schema.parse(call.input);
      if (!input.endpoint) return answers(call, admittedSource);
      return { ok: true, source: admittedSource, items: [checkout], finding: {
        v: 1, sourceRef: { pluginId: 'happier.telemetry', localId: 'capture-findings' }, sourceScope: { serverId, machineId: 'collector' },
        evidenceIdentity: 'retained-endpoint-latency', kind: 'endpoint_latency', title: 'Endpoint latency',
        observedWindow: { fromMs: input.since, toMs: input.until }, coverage: { status: 'complete' },
        summary: { records: checkout.requestCount, totalTimeMs: checkout.totalDurationMs }, verification: {
          observationKey: 'checkout', readBefore: { action: DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1, input },
          findAfter: { action: DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1,
            input: { source: admittedSource, endpoint: input.endpoint, page: input.page, since: input.until } },
        },
      } };
    });
    const detail = setUpDetail(feature === 'setup' ? 'manager' : 'reader');
    const selectedLifetime = { ...lifetime, scope };
    const screen = await renderScreen(feature === 'Worktree request'
      ? <AppPresentationPlatformProvider><ModalProvider>
          <TelemetryCaptureFixtureProvider invoke={invoke} transport={createTelemetryCaptureFixtureTransport(invoke)}>
            <LocalServiceCaptureView lifetime={selectedLifetime} worktree={worktree} view="traces" active
              machineName="Running machine" onShowServers={() => {}} testID="worktree-capture" />
          </TelemetryCaptureFixtureProvider>
        </ModalProvider></AppPresentationPlatformProvider>
      : panel(invoke, detail, { lifetime: selectedLifetime }));
    try {
      await settle();
      if (feature === 'request' || feature === 'Worktree request') {
        if (feature === 'request') {
          await screen.pressByTestIdAsync('project-deployments.telemetry.tab:traces');
          await settle();
        }
        await reportCollectionLayout(screen, 'telemetry.capture.traces');
        await screen.pressByTestIdAsync('telemetry.capture.trace.req-1');
        await settle();
        await screen.pressByTestIdAsync('project-deployments.telemetry.request.investigate');
      } else if (feature === 'setup') {
        await screen.pressByTestIdAsync('project-deployments.telemetry.menu');
        await waitForHomeGovernance(() => {
          expect(screen.findByTestId('project-deployments.telemetry.menu.add-telemetry')).not.toBeNull();
        });
        await screen.pressByTestIdAsync('project-deployments.telemetry.menu.add-telemetry');
      } else {
        await reportCollectionLayout(screen, 'telemetry.capture.endpoints');
        const menu = screen.findAll(node => node.props.triggerAccessibilityLabel === 'Actions for POST /checkout'
          && Array.isArray(node.props.items) && typeof node.props.onSelect === 'function')[0];
        if (!menu) throw new Error('Expected actions for the selected route');
        expect(menu.props.items).toContainEqual(expect.objectContaining({ id: 'send-to-agent' }));
        await act(async () => { menu.props.onSelect('send-to-agent'); });
        expect(calls.map(call => call.input)).toEqual([
          { source: admittedSource, page: expect.any(Object), since: expect.any(Number), until: expect.any(Number) },
          { source: admittedSource, page: { limit: 1 }, since: expect.any(Number), until: expect.any(Number),
            endpoint: { serviceName: checkout.serviceName, method: checkout.method, route: checkout.route } },
        ]);
      }
      const draftId = await waitForHomeGovernance(() => {
        const failure = modal.spies.alert.mock.calls[0];
        if (failure) {
          failure[2]?.[0]?.onPress?.();
          throw new Error(`Opening finding failed: ${String(modal.spies.alert.mock.calls.at(-1)?.[1])}`);
        }
        const route = router.spies.push.mock.calls.at(-1)?.[0];
        if (typeof route !== 'object' || route === null || !('params' in route)) throw new Error('The Session draft did not open');
        const params = route.params;
        if (typeof params !== 'object' || params === null || !('draftId' in params) || typeof params.draftId !== 'string') {
          throw new Error('The Session route did not include a draft ID');
        }
        expect(route).toMatchObject({ pathname: '/new' });
        return params.draftId;
      });
      const draft = readNewSessionDraftFromRepository({ scope, draftId });
      const evidence = JSON.stringify(draft?.composerAttachmentSeeds);
      if (feature === 'setup') {
        expect(draft?.input).toContain('same-origin');
        expect(draft?.input).toContain('Environment');
        expect(evidence).toContain(JSON.stringify({
          serverId, projectSourceId: detail.environment.projectSourceId, environmentId: 'production',
        }).replaceAll('"', '\\"'));
        expect(evidence).toContain('browserSetup');
      } else {
        const requestBrief = feature === 'request' || feature === 'Worktree request';
        expect(draft?.input).toContain(requestBrief ? 'Endpoint request failed' : 'Endpoint latency');
        expect(evidence).toContain(requestBrief ? 'retained-request-failure' : 'retained-endpoint-latency');
        expect(evidence).toContain(requestBrief ? DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1 : DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1);
        if (feature === 'Worktree request') {
          expect(calls.filter(call => call.actionId === DATABASE_CAPTURE_TRACE_GET_ACTION_ID_V1)).toEqual([
            expect.objectContaining({ collectorMachineId: worktree.machineId,
              input: expect.objectContaining({ source: admittedSource, traceId: request.traceId }) }),
          ]);
          expect(evidence).toContain(JSON.stringify(JSON.stringify(admittedSource)).slice(1, -1));
        }
      }
    } finally {
      await screen.unmount();
      confirm.mockRestore();
      await discardSessionDraftPersistenceWrites();
      resetSessionDraftRepositoryForTests();
      await clearBrowserRecords();
      publishAppliedActiveServerRuntimeAvailability(false);
      await homes.reset();
    }
  });

  it('opens an editable owner recovery draft for a role-off collector the person can use', async () => {
    const { showDeploymentTelemetrySheet } = await import('./DeploymentTelemetrySheet');
    const { DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1 } = await import('@happier-dev/protocol/machines/roles/machineRolesV1');
    const { createHydratedPlainMachineFixture, createPlainSharedMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    await prepareSessionDraftPersistenceStorage();
    const homes = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries(homes);
    const serverUrl = 'https://collector-role.test';
    const accountId = lifetime.scope.accountId;
    const serverId = await homes.addHome({ name: 'Telemetry', serverUrl, accountId, currentAccount: true });
    const scope = { serverId, accountId };
    publishAppliedActiveServerSnapshot({ serverId, serverUrl, generation: 1 });
    storage.getState().activateProfileScope(scope);
    const [pluginId, roleId] = DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1.split('/');
    const machine = createHydratedPlainMachineFixture({ id: 'collector', accountId, machine: {
      activeAt: Date.now(), daemonState: { machineRoles: { plugins: [{ pluginId: pluginId!, declaration: {
        id: roleId!, title: 'Telemetry', description: 'Collect telemetry',
      } }] } },
    } });
    const share = createPlainSharedMachineRowFixture({ id: machine.id, custodianAccountId: 'machine-owner', machine });
    await publishMachineInventoryForTest(scope, [{ ...machine, access: share.access }]);
    router.spies.push.mockClear();
    const screen = await renderScreen(<ModalProvider />);
    const setTelemetry = vi.fn();
    try {
      await act(async () => {
        showDeploymentTelemetrySheet({ detail: setUpDetail(), lifetime: { ...lifetime, scope }, environmentName: 'Production',
          setTelemetry, setBindings: vi.fn(), onSaved: vi.fn() });
      });
      await settle();
      expect(screen.findByTestId('project-deployments.telemetry.enable-role')).toBeNull();
      await screen.pressByTestIdAsync('project-deployments.telemetry.ask-role-owner');
      const draftId = await waitForHomeGovernance(() => {
        const route = router.spies.push.mock.calls.at(-1)?.[0];
        if (typeof route !== 'object' || route === null || !('params' in route)) throw new Error('No recovery draft');
        const params = route.params;
        if (typeof params !== 'object' || params === null || !('draftId' in params) || typeof params.draftId !== 'string') throw new Error('No recovery draft ID');
        return params.draftId;
      });
      const draft = readNewSessionDraftFromRepository({ scope, draftId });
      expect(draft?.input).toContain('collector');
      const evidence = JSON.stringify(draft?.composerAttachmentSeeds);
      for (const value of ['collector_role_recovery', 'production', machine.id, DATABASE_TELEMETRY_MACHINE_ROLE_ID_V1]) {
        expect(evidence).toContain(value);
      }
      expect(setTelemetry).not.toHaveBeenCalled();
    } finally {
      await act(async () => { modal.module.Modal.hideAll(); });
      await screen.unmount();
      await discardSessionDraftPersistenceWrites();
      resetSessionDraftRepositoryForTests();
      await clearBrowserRecords();
      publishAppliedActiveServerRuntimeAvailability(false);
      await homes.reset();
    }
  });

  it('offers investigation only when the collector returned a finding for the selected request', async () => {
    const { invoke } = collector(call => {
      const reply = answers(call);
      return call.actionId.endsWith('/capture/trace/get') ? { ...reply, findings: [] } : reply;
    });
    const screen = await mount(invoke);
    try {
      await screen.pressByTestIdAsync('project-deployments.telemetry.tab:traces');
      await settle();
      await reportCollectionLayout(screen, 'telemetry.capture.traces');
      await screen.pressByTestIdAsync('telemetry.capture.trace.req-1');
      await settle();
      expect(screen.findByTestId('telemetry.request.slowest')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.telemetry.request.investigate')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it.each(['manager', 'reader'] as const)('only offers an Environment manager Add a check on the selected request route (%s)', async role => {
    const screen = await mount(collector(answers).invoke, role);
    try {
      await screen.pressByTestIdAsync('project-deployments.telemetry.tab:traces');
      await settle();
      await reportCollectionLayout(screen, 'telemetry.capture.traces');
      await screen.pressByTestIdAsync('telemetry.capture.trace.req-1');
      await settle();
      const action = 'project-deployments.telemetry.request.add-check';
      if (role === 'manager') {
        await screen.pressByTestIdAsync(action);
        expect(screen.findByTestId('project-deployments.telemetry.add-check')).not.toBeNull();
      } else {
        expect(screen.findByTestId(action)).toBeNull();
      }
    } finally {
      await screen.unmount();
    }
  });

  it('shows the Action front door refusal in Details for the list and the selected trace', async () => {
    const code = 'deployment_target_role_unavailable';
    let first = true;
    const { invoke } = collector((call) => {
      if (first || call.actionId.endsWith('/capture/trace/get')) {
        first = false;
        requireActionSuccess({ ok: false, errorCode: code, error: 'Collector access is unavailable' });
      }
      return answers(call);
    });
    const screen = await mount(invoke);
    try {
      await screen.pressByTestIdAsync('project-deployments.telemetry.unavailable-details-toggle');
      expect(screen.findByTestId('project-deployments.telemetry.unavailable-details-code')?.props.children).toBe(code);
      await screen.pressByTestIdAsync('project-deployments.telemetry.retry');
      await settle();
      await screen.pressByTestIdAsync('project-deployments.telemetry.tab:traces');
      await settle();
      await reportCollectionLayout(screen, 'telemetry.capture.traces');
      await screen.pressByTestIdAsync('telemetry.capture.trace.req-1');
      await settle();
      await screen.pressByTestIdAsync('project-deployments.telemetry.request.unavailable-details-toggle');
      expect(screen.findByTestId('project-deployments.telemetry.request.unavailable-details-code')?.props.children).toBe(code);
      expect(screen.findByTestId('project-deployments.telemetry.request.investigate')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it('says the collector Machine is not answering, with Retry, when its read fails while it is offline', async () => {
    await publishMachineInventoryForTest(lifetime.scope, [
      createMachineFixture({ id: 'collector', active: false, activeAt: 1 }),
    ]);
    let reachable = false;
    const { invoke, calls } = collector((call) => {
      if (!reachable)
        throw Object.assign(new Error('machine_offline'), {
          code: 'machine_offline',
        });
      return answers(call);
    });
    const screen = await mount(invoke);
    try {
      expect(
        screen.findByTestId('project-deployments.telemetry.offline'),
      ).not.toBeNull();
      reachable = true;
      await screen.pressByTestIdAsync('project-deployments.telemetry.retry');
      await settle();
      expect(calls).toHaveLength(2);
      expect(
        screen.findByTestId('project-deployments.telemetry.offline'),
      ).toBeNull();
      await reportCollectionLayout(screen, 'telemetry.capture.endpoints');
      expect(
        screen.findByTestId('telemetry.capture.endpoint.POST /checkout'),
      ).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it('clears the selected Environment for a manager and refreshes its list and collector status', async () => {
    let cleared = false;
    const refreshed = createDeferred<void>();
    const clearId = 'happier.telemetry/actions/capture/clear';
    const { invoke, calls } = collector(call => {
      if (call.actionId === clearId) {
        cleared = true;
        transport.invalidate();
        return { ok: true };
      }
      if (cleared && call.actionId.endsWith('/capture/endpoints/list')) {
        refreshed.resolve();
        return { ok: true, source, items: [] };
      }
      if (call.actionId === DATABASE_CAPTURE_STATUS_ACTION_ID_V1) {
        return cleared
          ? { ok: true, source, lastReceivedAt: null, coverage: { lostObservations: 0, reason: null } }
          : { ok: true, source, lastReceivedAt: request.at, coverage: { lostObservations: 1, reason: 'daemon_database_quota_exceeded' } };
      }
      return answers(call);
    });
    const transport = createTelemetryCaptureFixtureTransport(invoke);
    const screen = await renderScreen(panel(invoke, setUpDetail(), { telemetryApplied: true }, transport));
    await settle();
    try {
      const collectorStatus = () => screen.findByTestId('project-deployments.telemetry.collector')?.props.children;
      expect(collectorStatus()).toBe('Collector storage full');
      await screen.pressByTestIdAsync('project-deployments.telemetry.menu');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
      expect(screen.findByTestId('project-deployments.telemetry.menu.settings')).not.toBeNull();
      await screen.pressByTestIdAsync('project-deployments.telemetry.menu.clear');
      await refreshed.promise;
      await settle();
      expect(collectorStatus()).toBe('Waiting for first data');
      expect(calls.filter(call => call.actionId === DATABASE_CAPTURE_STATUS_ACTION_ID_V1)).toHaveLength(2);
      expect(calls.filter(call => call.actionId === clearId)).toEqual([expect.objectContaining({
        collectorMachineId: 'collector',
        input: { source },
      })]);
      expect(calls.filter(call => call.actionId.endsWith('/capture/endpoints/list'))).toHaveLength(2);
    } finally {
      await screen.unmount();
    }
    const viewer = await mount(collector(answers).invoke, 'reader');
    try {
      expect(viewer.findByTestId('project-deployments.telemetry.menu')).toBeNull();
    } finally {
      await viewer.unmount();
    }
  });

  it('opens setup on a shared collector and leaves watcher admission to the save owner', async () => {
    await publishMachineInventoryForTest(lifetime.scope, [
      createMachineFixture({ id: 'collector', isShared: true }),
    ]);
    const { invoke } = collector(answers);
    const screen = await mount(invoke);
    try {
      await reportCollectionLayout(screen, 'telemetry.capture.endpoints');
      const row = screen.find(node => Array.isArray(node.props?.secondaryActions)
        && typeof node.props?.onSecondaryAction === 'function');
      await act(async () => row.props.onSecondaryAction('add-check'));
      expect(screen.findAllByType(PluginEventAutomationEditor).map(editor => editor.props.authoringMachineId))
        .toEqual(['collector']);
      expect(screen.findByTestId('project-deployments.telemetry.add-check.collector-refused')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it('opens a shared collector check on the Account’s own online Machine', async () => {
    await publishMachineInventoryForTest(lifetime.scope, [
      createMachineFixture({ id: 'collector', isShared: true, active: true, activeAt: Date.now() }),
      createMachineFixture({ id: 'observer-offline', isShared: false, active: false, activeAt: 1 }),
      createMachineFixture({ id: 'observer', isShared: false, active: true, activeAt: Date.now() }),
    ]);
    const screen = await mount(collector(answers).invoke);
    try {
      await reportCollectionLayout(screen, 'telemetry.capture.endpoints');
      const row = screen.find(node => Array.isArray(node.props?.secondaryActions)
        && typeof node.props?.onSecondaryAction === 'function');
      await act(async () => row.props.onSecondaryAction('add-check'));
      expect(screen.findAllByType(PluginEventAutomationEditor).map(editor => editor.props.authoringMachineId))
        .toEqual(['observer']);
    } finally {
      await screen.unmount();
    }
  });

  it('offers Add a check… on a route row to managers and opens the check editor on their collector', async () => {
    await publishMachineInventoryForTest(lifetime.scope, [
      createMachineFixture({ id: 'collector', isShared: false }),
    ]);
    const { invoke } = collector(answers);
    const screen = await mount(invoke);
    try {
      await reportCollectionLayout(screen, 'telemetry.capture.endpoints');
      const row = screen.find(
        (node) =>
          Array.isArray(node.props?.secondaryActions) &&
          typeof node.props?.onSecondaryAction === 'function',
      );
      expect(row.props.secondaryActions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'add-check', label: 'Add a check…' }),
      ]));
      await act(async () => {
        row.props.onSecondaryAction('add-check');
      });
      expect(screen.findByTestId('project-deployments.telemetry.add-check')).not.toBeNull();
      expect(screen.findAllByType(PluginEventAutomationEditor)).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
    const viewer = await mount(collector(answers).invoke, 'reader');
    try {
      expect(
        viewer.findAll((node) => Array.isArray(node.props?.secondaryActions)
          && node.props.secondaryActions.some((action: { id: string }) => action.id === 'add-check')),
      ).toHaveLength(0);
    } finally {
      await viewer.unmount();
    }
  });
});

describe('Environment Telemetry capability views', () => {
  const now = Date.now();
  const evidence = { v: 1, items: [{ source: { kind: 'alert', label: 'Collector' }, author: { kind: 'process' }, text: 'Retained metrics' }] };
  const httpRead = (p95: number) => ({ result: { status: 'up', observedAt: now, evidence,
    measurements: { measure: 'p95', value: p95, unit: 'ms', basis: 'metric_points', p95Ms: p95, p50Ms: 88, requestCount: 3600,
      errorRate: 0.024, producers: [{ serviceName: 'billing-api' }], window: { since: now - 3_600_000, until: now },
      completeness: 'complete', reasons: [] } },
    routes: [], trend: [
      { since: now - 7_200_000, until: now - 3_600_000, value: 380, p95: 380, count: 3600, errorRate: 0.01, unit: 'ms' },
      { since: now - 3_600_000, until: now, value: p95, p95, count: 3600, errorRate: 0.024, unit: 'ms' },
    ] });
  const call = { ...request, id: 'call-1', traceId: 'trace-1', endpointMethod: null, endpointRoute: null, httpStatusCode: null,
    serviceVersion: 'v1.43', genAi: { provider: 'openai', modelId: 'gpt-5-mini', requestedModel: 'gpt-5-mini', operation: 'chat',
      tokens: { input: 900, output: 340, total: 1240, reasoning: null, cacheRead: null, cacheWrite: null },
      tokenCategories: null, reportedCost: { amount: 0.0021, currency: 'USD' } } };
  const capabilityAnswers = (sampled: Readonly<{ metrics: number | null; appLlmCost: number | null; exceptions: number | null }>) =>
    (call_: Call) => {
      if (call_.actionId.endsWith('/capture/status'))
        return { ok: true, source, coverage: { lostObservations: 0, reason: null }, lastReceivedAt: now, capabilityLastSampleAt: sampled };
      if (call_.actionId.endsWith('/capture/costs/read'))
        return { ok: true, source, since: now - 86_400_000, until: now, items: [{ bucketStartMs: now - 3_600_000,
          route: { method: 'POST', path: '/checkout' }, provider: 'openai',
          modelId: 'gpt-5-mini', requestedModel: 'gpt-5-mini', operation: 'chat', callCount: 2,
          tokens: { input: 1800, output: 680, total: 2480, reasoning: null, cacheRead: null, cacheWrite: null },
          tokenCategories: { input: 1800, output: 680, total: 2480, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
          reportedCost: { amount: 0.0042, currency: 'USD' }, firstSeenMs: now - 3_000_000, lastSeenMs: now - 180_000 },
          // More tokens, less money: embeddings at a fraction of a cent.
          { bucketStartMs: now - 3_600_000, route: { method: 'POST', path: '/search' }, provider: 'openai',
            modelId: 'text-embedding-3-small', requestedModel: 'text-embedding-3-small', operation: 'embeddings', callCount: 1,
            tokens: { input: 50_000, output: 0, total: 50_000, reasoning: null, cacheRead: null, cacheWrite: null },
            tokenCategories: { input: 50_000, output: 0, total: 50_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
            reportedCost: null, firstSeenMs: now - 3_000_000, lastSeenMs: now - 180_000 }],
          coverage: { lostObservations: 0, reason: null, callCount: 3, tokenCategoryCallCount: 3, reportedCostCallCount: 2 } };
      if (call_.actionId.endsWith('/capture/traces/list') && (call_.input as { appLlmCalls?: unknown }).appLlmCalls)
        return { ok: true, source, items: [call] };
      if (call_.actionId.endsWith('/capture/metrics/read')) {
        const input = call_.input as { view?: string; serviceName?: string; serviceVersion?: string };
        const http = httpRead(412);
        const unknownMetric = { result: { status: 'unknown', observedAt: now, evidence }, trend: [] };
        return { view: 'overview', services: [{ serviceName: 'billing-api', versions: ['v1.43'] }],
          selected: { serviceName: input.serviceName ?? 'billing-api', serviceVersion: input.serviceVersion ?? null },
          metrics: { http: { result: http.result, trend: http.trend }, heap: unknownMetric, gc: unknownMetric,
            activeRequests: unknownMetric } };
      }
      return answers(call_);
    };
  const detailWith = (telemetry: Readonly<{ metrics: boolean; appLlmCost: boolean; exceptions: boolean }>) => {
    const detail = setUpDetail();
    return { ...detail, content: { ...detail.content, telemetry } };
  };

  it('refreshes the open LLM tab on collector change and stops the reads when it closes', async () => {
    const { invoke, calls } = collector(capabilityAnswers({ metrics: null, appLlmCost: now, exceptions: null }));
    const transport = createTelemetryCaptureFixtureTransport(invoke);
    const screen = await renderScreen(panel(invoke, detailWith({ metrics: false, appLlmCost: true, exceptions: false }),
      { active: true, telemetryApplied: true }, transport));
    const llmCostReads = () => calls.filter(read => read.actionId.endsWith('/capture/costs/read')).length;
    try {
      await settle();
      expect(llmCostReads()).toBe(0);
      await screen.pressByTestIdAsync('project-deployments.telemetry.tab:llmCalls');
      await settle();
      expect(llmCostReads()).toBe(1);
      // Readiness follows status alongside the LLM costs and call list.
      expect(transport.watchers).toBe(3);
      await act(async () => transport.invalidate());
      await settle();
      expect(llmCostReads()).toBe(2);
      await reportCollectionLayout(screen, 'telemetry.capture.llmCalls');
      await screen.pressByTestIdAsync('telemetry.capture.llmCall.call-1');
      await settle();
      // Opening the trace releases both rolling LLM reads and keeps readiness.
      expect(transport.watchers).toBe(1);
      await act(async () => transport.invalidate());
      await settle();
      expect(llmCostReads()).toBe(2);
    } finally { await screen.unmount(); }
  });

  it('opens the native PRs and Issues page from the Environment exception summary', async () => {
    const { invoke } = collector(capabilityAnswers({ metrics: null, appLlmCost: null, exceptions: now }));
    const screen = await renderScreen(panel(invoke, detailWith({ metrics: false, appLlmCost: false, exceptions: true }),
      { active: true, telemetryApplied: true }));
    try {
      await settle();
      await screen.pressByTestIdAsync('project-deployments.telemetry.exceptions.open-triage');
      expect(router.spies.push).toHaveBeenCalledWith(buildPluginAppPageRoutePath(TRIAGE_APP_PAGE_DESTINATION_V1));
    } finally { await screen.unmount(); }
  });

  it('follows newly retained exception times while the Environment summary is open', async () => {
    let exceptions: number | null = null;
    const { invoke, calls } = collector(call_ => capabilityAnswers({ metrics: null, appLlmCost: null, exceptions })(call_));
    const transport = createTelemetryCaptureFixtureTransport(invoke);
    const detail = detailWith({ metrics: false, appLlmCost: false, exceptions: true });
    const screen = await renderScreen(panel(invoke, detail, { active: true, telemetryApplied: true }, transport));
    const statusReads = () => calls.filter(read => read.actionId === DATABASE_CAPTURE_STATUS_ACTION_ID_V1).length;
    const summary = () => (screen.findByTestId('project-deployments.telemetry.exceptions.summary')?.findAll(node => typeof node.type === 'string') ?? [])
      .flatMap(node => [node.props.children].flat().filter((child): child is string => typeof child === 'string')).join(' ');
    try {
      await settle();
      expect(statusReads()).toBe(1);
      expect(summary()).not.toContain('Last seen');
      exceptions = now;
      await act(async () => transport.invalidate());
      await settle();
      expect(statusReads()).toBe(2);
      expect(summary()).toContain('Last seen');
      await screen.update(panel(invoke, detail, { active: false, telemetryApplied: true }, transport));
      const whileHidden = statusReads();
      await act(async () => transport.invalidate());
      await settle();
      expect(statusReads()).toBe(whileHidden);
    } finally { await screen.unmount(); }
  });

  it('refreshes the open Metrics tab from one selected collector watch', async () => {
    const { invoke, calls } = collector(capabilityAnswers({ metrics: now, appLlmCost: null, exceptions: null }));
    const transport = createTelemetryCaptureFixtureTransport(invoke);
    const screen = await renderScreen(panel(invoke, detailWith({ metrics: true, appLlmCost: false, exceptions: false }),
      { active: true, telemetryApplied: true }, transport));
    const metricReads = () => calls.filter(read => read.actionId.endsWith('/capture/metrics/read')).map(read => read.input);
    try {
      await settle();
      expect(metricReads()).toEqual([]);
      await screen.pressByTestIdAsync('project-deployments.telemetry.tab:metrics');
      await settle();
      expect(metricReads()).toEqual([expect.objectContaining({ view: 'overview', serverId: 'home', environmentId: 'production' })]);
      // The selected Metrics overview and collector readiness each have one watch.
      expect(transport.watchers).toBe(2);
      await act(async () => transport.invalidate());
      await settle();
      expect(metricReads()).toHaveLength(2);
      await screen.pressByTestIdAsync('project-deployments.telemetry.tab:endpoints');
      await settle();
      await act(async () => transport.invalidate());
      await settle();
      expect(metricReads()).toHaveLength(2);
    } finally { await screen.unmount(); }
  });

  it('says each enabled capability’s delivery, and opens a selected LLM call in the existing trace detail', async () => {
    const { invoke, calls } = collector(capabilityAnswers({ metrics: null, appLlmCost: now - 180_000, exceptions: null }));
    const screen = await renderScreen(panel(invoke, detailWith({ metrics: true, appLlmCost: true, exceptions: true }),
      { active: true, telemetryApplied: true }));
    const barStatus = () => String(screen.findByTestId('project-deployments.telemetry.collector')?.props.children);
    // The rendered words under one node, as a reader meets them.
    const textIn = (testID: string) => (screen.findByTestId(testID)?.findAll(node => typeof node.type === 'string') ?? [])
      .flatMap(node => [node.props.children].flat().filter((child): child is string => typeof child === 'string')).join(' ');
    try {
      await settle();
      // Getting ready: each recorded choice says its own delivery; Exceptions offers the browser addition.
      expect(textIn('project-deployments.telemetry.readiness.exceptions')).toContain('Not receiving yet');
      expect(screen.findByTestId('project-deployments.telemetry.readiness.llm')).toBeNull();
      // Exceptions are said once: Getting ready speaks until one arrives, then the summary does.
      expect(screen.findByTestId('project-deployments.telemetry.exceptions.summary')).toBeNull();
      expect(screen.findByTestId('project-deployments.telemetry.exceptions.add-telemetry')).not.toBeNull();

      await screen.pressByTestIdAsync('project-deployments.telemetry.tab:llmCalls');
      await settle();
      expect(barStatus()).toContain('Receiving · last sample');
      const llmReads = calls.filter(read => read.actionId.endsWith('/capture/costs/read') || read.actionId.endsWith('/capture/traces/list'));
      expect(llmReads).toEqual([
        expect.objectContaining({ collectorMachineId: 'collector', input: expect.objectContaining({ source, since: expect.any(Number), until: expect.any(Number) }) }),
        expect.objectContaining({ collectorMachineId: 'collector', input: expect.objectContaining({ source, appLlmCalls: {} }) }),
      ]);
      // Priced with the viewer's Usage prices and drawn by Usage's own bodies: the provider's figure stays its own fact.
      expect(textIn('project-deployments.telemetry.llm.costFacts')).toContain('$0.0042');
      // Worth at API prices: $0.0018 of gpt-5-mini and $0.001 of embeddings, said once as the card's lead (D2).
      expect(textIn('project-deployments.telemetry.llm.costFacts').match(/\$0\.0028/g)).toHaveLength(1);
      expect(textIn('project-deployments.telemetry.llm.costFacts')).not.toContain('Value at current API prices');
      // An app's calls have no agents: the provider reported that cost.
      expect(textIn('project-deployments.telemetry.llm.costFacts')).toContain('Provider-reported cost');
      expect(screen.findByTestId('project-deployments.telemetry.llm.daily.drawn')).not.toBeNull();
      // A day's window draws hours, so the chart is named by its bucket (N1).
      expect(textIn('project-deployments.telemetry.llm.daily.frame')).toContain('Hourly usage');
      // Routes rank by the cost they draw, not by tokens.
      const routes = textIn('project-deployments.telemetry.llm.routes');
      expect(routes.indexOf('POST /checkout')).toBeGreaterThanOrEqual(0);
      expect(routes.indexOf('POST /checkout')).toBeLessThan(routes.indexOf('POST /search'));
      // Service and version are the window's own facts, chosen from chips; a choice applies at once.
      await screen.pressByTestIdAsync('project-deployments.telemetry.llm.service');
      await waitForHomeGovernance(() => {
        expect(screen.findByTestId('project-deployments.telemetry.llm.service:billing-api')).not.toBeNull();
      });
      await screen.pressByTestIdAsync('project-deployments.telemetry.llm.service:billing-api');
      await settle();
      await screen.pressByTestIdAsync('project-deployments.telemetry.llm.version');
      await waitForHomeGovernance(() => {
        expect(screen.findByTestId('project-deployments.telemetry.llm.version:v1.43')).not.toBeNull();
      });
      await screen.pressByTestIdAsync('project-deployments.telemetry.llm.version:v1.43');
      await settle();
      const selectedReads = calls.filter(read => read.actionId.endsWith('/capture/costs/read') || read.actionId.endsWith('/capture/traces/list')).slice(-2);
      expect(selectedReads).toEqual([
        expect.objectContaining({ input: expect.objectContaining({ source, serviceName: 'billing-api', serviceVersion: 'v1.43',
          granularity: 'hour', groupByRoute: true }) }),
        expect.objectContaining({ input: expect.objectContaining({ source, appLlmCalls: { serviceName: 'billing-api', serviceVersion: 'v1.43' } }) }),
      ]);
      await reportCollectionLayout(screen, 'telemetry.capture.llmCalls');
      // The retained calls are a titled card of their own.
      expect(textIn('project-deployments.telemetry.llm.calls.frame')).toContain('Model calls');
      await screen.pressByTestIdAsync('telemetry.capture.llmCall.call-1');
      await settle();
      expect(calls.at(-1)).toEqual(expect.objectContaining({ input: expect.objectContaining({ source, traceId: 'trace-1' }) }));
      expect(screen.findByTestId('project-deployments.telemetry.request')).not.toBeNull();

      await screen.pressByTestIdAsync('project-deployments.telemetry.request.back');
      await settle();
      expect(textIn('project-deployments.telemetry.llm.service')).toContain('billing-api');
      expect(textIn('project-deployments.telemetry.llm.version')).toContain('v1.43');

      await screen.pressByTestIdAsync('project-deployments.telemetry.tab:metrics');
      await settle();
      expect(barStatus()).toContain('Not receiving yet');
      const metricReads = calls.filter(read => read.actionId.endsWith('/capture/metrics/read')).map(read => read.input);
      expect(metricReads).toEqual([
        expect.objectContaining({ view: 'overview', serverId: 'home', environmentId: 'production' }),
      ]);
      expect(textIn('project-deployments.telemetry.metrics.p95')).toContain('412');
      expect(textIn('project-deployments.telemetry.metrics.heap')).toContain('doesn’t report heap use');
      await screen.pressByTestIdAsync('project-deployments.telemetry.metrics.version');
      await waitForHomeGovernance(() => {
        expect(screen.findByTestId('project-deployments.telemetry.metrics.version:v1.43')).not.toBeNull();
      });
      await screen.pressByTestIdAsync('project-deployments.telemetry.metrics.version:v1.43');
      await waitForHomeGovernance(() => {
        expect(calls.at(-1)?.input).toMatchObject({ view: 'overview', serverId: 'home', environmentId: 'production',
          serviceName: 'billing-api', serviceVersion: 'v1.43' });
      });
    } finally {
      await screen.unmount();
    }
  });

  it('offers only the capability views the Environment records', async () => {
    const { invoke, calls } = collector(capabilityAnswers({ metrics: null, appLlmCost: null, exceptions: null }));
    const screen = await renderScreen(panel(invoke, detailWith({ metrics: false, appLlmCost: false, exceptions: false }),
      { active: true, telemetryApplied: true }));
    try {
      await settle();
      expect(screen.findByTestId('project-deployments.telemetry.tab:llmCalls')).toBeNull();
      expect(screen.findByTestId('project-deployments.telemetry.tab:metrics')).toBeNull();
      expect(screen.findByTestId('project-deployments.telemetry.readiness.exceptions')).toBeNull();
      expect(calls.some(read => read.actionId.endsWith('/capture/costs/read') || read.actionId.endsWith('/capture/metrics/read'))).toBe(false);
    } finally {
      await screen.unmount();
    }
  });
});
