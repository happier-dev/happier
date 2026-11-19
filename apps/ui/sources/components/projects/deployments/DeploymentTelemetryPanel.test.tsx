import { afterEach, describe, expect, it, vi } from 'vitest';
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
afterEach(standardCleanup);

const { DeploymentTelemetryPanel } = await import('./DeploymentTelemetryPanel');
const { TelemetryCaptureInvokeContext } =
  await import('./telemetryCaptureReads');
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
      capabilities: { ...base.environment.capabilities, role },
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
) {
  return (
    <AppPresentationPlatformProvider><ModalProvider>
      <TelemetryCaptureInvokeContext.Provider value={invoke}>
        <DeploymentTelemetryPanel
          detail={detail}
          lifetime={lifetime}
          environmentName="Production"
          onChanged={() => {}}
        />
      </TelemetryCaptureInvokeContext.Provider>
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

const answers = (call: Call) => {
  if (call.actionId.endsWith('/capture/endpoints/list'))
    return { ok: true, source, items: [checkout] };
  if (call.actionId.endsWith('/capture/traces/list'))
    return { ok: true, source, items: [request] };
  if (call.actionId.endsWith('/capture/trace/get'))
    return {
      ok: true,
      source,
      traceId: 'trace-1',
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

  it('offers Telemetry settings without Clear to an Environment manager', async () => {
    const { invoke } = collector(answers);
    const screen = await mount(invoke);
    try {
      await screen.pressByTestIdAsync('project-deployments.telemetry.menu');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
      expect(screen.findByTestId('project-deployments.telemetry.menu.settings')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.telemetry.menu.clear')).toBeNull();
    } finally {
      await screen.unmount();
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
      expect(row.props.secondaryActions).toEqual([
        expect.objectContaining({ id: 'add-check', label: 'Add a check…' }),
      ]);
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
        viewer.findAll((node) => Array.isArray(node.props?.secondaryActions)),
      ).toHaveLength(0);
    } finally {
      await viewer.unmount();
    }
  });
});
