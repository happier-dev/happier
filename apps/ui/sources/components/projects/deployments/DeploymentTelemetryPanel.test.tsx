import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1, DatabaseCaptureEndpointsListInputV1Schema } from '@happier-dev/database-protocol';
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
const { createTelemetryCaptureReads } = await import('./telemetryCaptureReads');
const { TelemetryCaptureFixtureProvider, createTelemetryCaptureFixtureTransport } =
  await import('@/dev/testkit/fixtures/telemetryCaptureFixtures');
const { ModalProvider } = await import('@/modal');
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
  demand?: { telemetryApplied?: boolean; active?: boolean; lifetime?: typeof lifetime },
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

const answers = (call: Call, admittedSource: Readonly<{ kind: 'environment'; serverId: string; environmentId: string }> = source) => {
  const source = admittedSource;
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
        sourceScope: { serverId: source.serverId, machineId: 'collector' },
        evidenceIdentity: 'retained-request-failure',
        kind: 'failing_endpoint',
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
    const screen = await renderScreen(panel(finite.invoke, detail, { active: true }, transport));
    try {
      await settle();
      expect(screen.findByTestId('telemetry.capture.endpoint.POST /checkout')).not.toBeNull();
      expect(capture.calls).toEqual([expect.objectContaining({ collectorMachineId: 'collector', input: expect.objectContaining({ source }) })]);
      expect(transport.watchers).toBe(1);
      expect(finite.calls).toHaveLength(0);
      const initial = DatabaseCaptureEndpointsListInputV1Schema.parse(capture.calls[0]?.input);
      await screen.pressByTestIdAsync('telemetry.capture.endpoints.older');
      await settle();
      expect(finite.calls).toEqual([expect.objectContaining({ actionId: DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1,
        input: expect.objectContaining({ source, since: initial.since, until: initial.until,
          page: expect.objectContaining({ before }) }) })]);
      expect(screen.findByTestId('telemetry.capture.endpoint.POST /older')).not.toBeNull();

      route = '/payment';
      await act(async () => transport.invalidate());
      await settle();
      expect(screen.findByTestId('telemetry.capture.endpoint.POST /payment')).not.toBeNull();
      expect(screen.findByTestId('telemetry.capture.endpoint.POST /older')).toBeNull();
      expect(capture.calls).toHaveLength(2);

      await settle();
      expect(capture.calls).toHaveLength(2);
      await screen.update(panel(finite.invoke, detail, { active: false }, transport));
      expect(transport.watchers).toBe(0);
      await act(async () => transport.invalidate());
      await settle();
      expect(capture.calls).toHaveLength(2);
      expect(finite.calls).toHaveLength(1);
    } finally { await screen.unmount(); }
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
    const screen = await renderScreen(<AppPresentationPlatformProvider><TelemetryRequestDetail
      reads={reads} lifetime={lifetime} active request={selected} locale="en" onBack={() => {}} />
      </AppPresentationPlatformProvider>);
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
      await screen.pressByTestIdAsync(
        'project-deployments.telemetry.request.back',
      );
      await reportCollectionLayout(screen, 'telemetry.capture.traces');
      expect(
        screen.findByTestId('telemetry.capture.trace.req-1'),
      ).not.toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it.each(['request', 'endpoint', 'setup'] as const)('opens an editable Session draft with the selected %s and verification reads', async (feature) => {
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
    const admittedSource = { ...source, serverId };
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
    const screen = await renderScreen(panel(invoke, detail, { lifetime: { ...lifetime, scope } }));
    try {
      await settle();
      if (feature === 'request') {
        await screen.pressByTestIdAsync('project-deployments.telemetry.tab:traces');
        await settle();
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
        expect(draft?.input).toContain(feature === 'request' ? 'Endpoint request failed' : 'Endpoint latency');
        expect(evidence).toContain(feature === 'request' ? 'retained-request-failure' : 'retained-endpoint-latency');
        expect(evidence).toContain(feature === 'request' ? 'happier.telemetry/actions/capture/trace/get' : DATABASE_CAPTURE_ENDPOINTS_LIST_ACTION_ID_V1);
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

  it('clears the selected Environment for a manager and refreshes its list', async () => {
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
      return answers(call);
    });
    const transport = createTelemetryCaptureFixtureTransport(invoke);
    const screen = await renderScreen(panel(invoke, setUpDetail(), undefined, transport));
    await settle();
    try {
      await screen.pressByTestIdAsync('project-deployments.telemetry.menu');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
      expect(screen.findByTestId('project-deployments.telemetry.menu.settings')).not.toBeNull();
      await screen.pressByTestIdAsync('project-deployments.telemetry.menu.clear');
      await refreshed.promise;
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

  it('offers Add a check… on a route row to managers and opens the check editor from it', async () => {
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
      expect(
        screen.findByTestId('project-deployments.telemetry.add-check'),
      ).not.toBeNull();
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
