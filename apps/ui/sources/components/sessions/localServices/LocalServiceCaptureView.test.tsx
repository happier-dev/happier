import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
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
vi.mock('@/utils/web/radixCjs', async () =>
  (await import('@/dev/testkit/mocks/radixCjs')).createRadixCjsModuleMock(),
);
vi.mock('@/components/ui/popover', async (importOriginal) =>
  (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(importOriginal, {
    maxHeight: 640, maxWidth: 280, placement: 'bottom',
  }),
);
const modal = await vi.hoisted(async () =>
  (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    renderCustomModals: true,
  }),
);
vi.mock('@/modal', () => modal.module);
afterEach(standardCleanup);

const { LocalServiceCaptureView } = await import('./LocalServiceCaptureView');
const { TelemetryCaptureFixtureProvider, createTelemetryCaptureFixtureTransport } =
  await import('@/dev/testkit/fixtures/telemetryCaptureFixtures');
const { ModalProvider } = await import('@/modal');
const { AppPresentationPlatformProvider } =
  await import('@/components/ui/presentation/AppPresentationPlatformProvider');

const lifetime = {
  scope: { serverId: 'home', accountId: 'owner' },
  isCurrent: () => true,
  onRetire: () => ({ dispose() {} }),
};
const worktree = {
  machineId: 'laptop',
  projectId: 'billing-api',
  workspaceId: 'checkout-main',
};
const source = {
  kind: 'worktree',
  serverId: 'home',
  machineId: 'laptop',
  projectId: 'billing-api',
  workspaceId: 'checkout-main',
};
const coverage = { lostObservations: 0, reason: null };

type Call = Readonly<{
  collectorMachineId: string;
  actionId: string;
  input: unknown;
}>;
function machine(answer: (call: Call) => unknown) {
  const calls: Call[] = [];
  const invoke = vi.fn(
    async (call: Call & { signal?: AbortSignal; scope?: unknown }) => {
      const { signal: _signal, scope: _scope, ...recorded } = call;
      calls.push(recorded);
      return answer(recorded);
    },
  );
  return { invoke, calls };
}

async function settle() {
  for (let tick = 0; tick < 5; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function view(
  invoke: ReturnType<typeof machine>['invoke'],
  which: 'endpoints' | 'traces' | 'logs' = 'endpoints',
  transport?: ReturnType<typeof createTelemetryCaptureFixtureTransport>,
  active = true,
) {
  return (
    <AppPresentationPlatformProvider>
      <ModalProvider>
        <TelemetryCaptureFixtureProvider invoke={invoke} transport={transport}>
          <LocalServiceCaptureView
            lifetime={lifetime}
            worktree={worktree}
            view={which}
            active={active}
            machineName="MacBook Pro"
            onShowServers={() => {}}
            testID="capture"
          />
        </TelemetryCaptureFixtureProvider>
      </ModalProvider>
    </AppPresentationPlatformProvider>
  );
}

describe('LocalServiceCaptureView', () => {
  it('does not use finite first-page reads while following collector capture', async () => {
    const finite = machine(call => call.actionId.endsWith('/capture/status')
      ? { ok: true, source, coverage, enabled: true }
      : { ok: true, source, items: [] });
    let route = '/invoices/:id';
    const capture = machine(() => ({ ok: true, source, items: [{
      serviceName: 'web', method: 'GET', route, requestCount: 1, errorCount: 0,
      errorRate: 0, totalDurationMs: 50, databaseTimeMs: 20,
    }] }));
    const transport = createTelemetryCaptureFixtureTransport(capture.invoke);
    const screen = await renderScreen(view(finite.invoke, 'endpoints', transport));
    try {
      await settle();
      expect(screen.findByTestId('telemetry.capture.endpoint.GET /invoices/:id')).not.toBeNull();
      expect(capture.calls).toEqual([expect.objectContaining({ collectorMachineId: 'laptop', input: expect.objectContaining({ source }) })]);
      expect(transport.watchers).toBe(1);
      route = '/payments';
      await act(async () => transport.invalidate());
      await settle();
      expect(screen.findByTestId('telemetry.capture.endpoint.GET /payments')).not.toBeNull();
      expect(capture.calls).toHaveLength(2);

      await settle();
      expect(capture.calls).toHaveLength(2);
      await screen.update(view(finite.invoke, 'endpoints', transport, false));
      expect(transport.watchers).toBe(0);
      await act(async () => transport.invalidate());
      await settle();
      expect(capture.calls).toHaveLength(2);
      expect(finite.calls.filter(call => call.actionId.endsWith('/capture/endpoints/list'))).toHaveLength(0);
    } finally { await screen.unmount(); }
  });

  it('keeps the settled empty Logs view while pushed reads overlap, then shows the new log', async () => {
    const finite = machine(() => ({ ok: true, source, coverage, enabled: true }));
    const refresh = createDeferred<unknown>();
    const log = {
      id: 'log-arrived', worktree: 'checkout-main', kind: 'log', source: 'otlp',
      at: Date.now(), serviceName: 'dev', bodyPrefix: 'checkout completed', bodyPrefixTruncated: false,
    };
    let reads = 0;
    const capture = machine(() => {
      reads += 1;
      if (reads === 1) return { ok: true, source, items: [] };
      if (reads === 2) return refresh.promise;
      return { ok: true, source, items: [log] };
    });
    const transport = createTelemetryCaptureFixtureTransport(capture.invoke);
    const screen = await renderScreen(view(finite.invoke, 'logs', transport));
    try {
      await settle();
      expect(screen.findByTestId('capture-waiting')).not.toBeNull();
      expect(capture.calls).toHaveLength(1);

      await act(async () => transport.invalidate());
      await act(async () => transport.invalidate());
      expect(capture.calls).toHaveLength(2);
      expect(screen.findByTestId('capture-waiting')).not.toBeNull();
      expect(screen.findByTestId('telemetry.capture.logs.empty')).toBeNull();

      await act(async () => refresh.resolve({ ok: true, source, items: [log] }));
      await settle();
      expect(screen.findByTestId('telemetry.capture.logs.card')).not.toBeNull();
      expect(screen.findByTestId('capture-waiting')).toBeNull();
      expect(finite.calls).toHaveLength(1);
      expect(capture.calls).toHaveLength(3);
    } finally { await screen.unmount(); }
  });

  it('reads this checkout on its own Machine and shows its endpoints', async () => {
    const { invoke, calls } = machine((call) =>
      call.actionId.endsWith('/capture/status')
        ? { ok: true, source, coverage, enabled: true }
        : {
            ok: true,
            source,
            items: [
              {
                serviceName: 'web',
                method: 'GET',
                route: '/invoices/:id',
                requestCount: 52,
                errorCount: 0,
                errorRate: 0,
                totalDurationMs: 52 * 231,
                databaseTimeMs: 52 * 74,
              },
            ],
          },
    );
    const screen = await renderScreen(view(invoke));
    await settle();
    try {
      expect(
        calls.map((call) => [call.collectorMachineId, call.actionId]),
      ).toEqual([
        ['laptop', 'happier.telemetry/actions/capture/status'],
        ['laptop', 'happier.telemetry/actions/capture/endpoints/list'],
      ]);
      expect(calls[1]!.input).toEqual(expect.objectContaining({ source }));
      await reportCollectionLayout(screen, 'telemetry.capture.endpoints');
      expect(
        screen.findByTestId('telemetry.capture.endpoint.GET /invoices/:id'),
      ).not.toBeNull();
    } finally {
      screen.unmount();
    }
  });

  it('says what capture would show while it is off, and its one action turns the Project switch on', async () => {
    let enabled = false;
    const { invoke, calls } = machine((call) => {
      if (call.actionId.endsWith('/capture/configure')) {
        enabled = true;
        return { ok: true, enabled: true };
      }
      if (call.actionId.endsWith('/capture/status'))
        return { ok: true, source, coverage, enabled };
      return { ok: true, source, items: [] };
    });
    const screen = await renderScreen(view(invoke, 'logs'));
    await settle();
    try {
      expect(screen.findByTestId('capture-off')).not.toBeNull();
      expect(
        calls.some((call) => call.actionId.endsWith('/capture/logs/list')),
      ).toBe(false);
      await screen.pressByTestIdAsync('capture-turn-on');
      await settle();
      expect(
        calls.find((call) => call.actionId.endsWith('/capture/configure'))
          ?.input,
      ).toEqual({
        project: {
          serverId: 'home',
          machineId: 'laptop',
          projectId: 'billing-api',
        },
        enabled: true,
      });
      expect(screen.findByTestId('capture-off')).toBeNull();
      expect(screen.findByTestId('capture-waiting')).not.toBeNull();
    } finally {
      screen.unmount();
    }
  });

  it('is the one place that turns capture off and clears it: its menu retries after a gap, turns the Project switch off and clears this checkout', async () => {
    let enabled = true;
    const { invoke, calls } = machine((call) => {
      if (call.actionId.endsWith('/capture/configure')) {
        enabled = (call.input as { enabled: boolean }).enabled;
        return { ok: true, enabled };
      }
      if (call.actionId.endsWith('/capture/clear')) return { ok: true, source };
      if (call.actionId.endsWith('/capture/status'))
        return { ok: true, source, coverage: { lostObservations: 3, reason: 'store_busy' }, enabled };
      return { ok: true, source, items: [] };
    });
    const screen = await renderScreen(view(invoke, 'logs'));
    await settle();
    try {
      await screen.pressByTestIdAsync('capture-menu');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
      await screen.pressByTestIdAsync('capture-menu.retry');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
      await settle();

      await screen.pressByTestIdAsync('capture-menu');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
      await screen.pressByTestIdAsync('capture-menu.clear');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
      await settle();
      expect(calls.find((call) => call.actionId.endsWith('/capture/clear'))?.input).toEqual({ source });

      await screen.pressByTestIdAsync('capture-menu');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
      await screen.pressByTestIdAsync('capture-menu.turn-off');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
      await settle();
      const project = { serverId: 'home', machineId: 'laptop', projectId: 'billing-api' };
      expect(calls.filter((call) => call.actionId.endsWith('/capture/configure')).map((call) => call.input)).toEqual([
        { project, enabled: true, retry: true },
        { project, enabled: false },
      ]);
      // Off again: the view says what capture would show and offers its one switch; no menu while off.
      expect(screen.findByTestId('capture-off')).not.toBeNull();
      expect(screen.findByTestId('capture-menu')).toBeNull();
    } finally {
      screen.unmount();
    }
  });

  it('shows Turn on capture waiting for approval, not a failure, when the policy holds it', async () => {
    const { invoke } = machine((call) => {
      if (call.actionId.endsWith('/capture/configure'))
        return {
          kind: 'approval_request_created',
          artifactId: 'approval-capture-1',
          actionId: 'happier.telemetry/actions/capture/configure',
        };
      if (call.actionId.endsWith('/capture/status'))
        return { ok: true, source, coverage, enabled: false };
      return { ok: true, source, items: [] };
    });
    modal.spies.alert.mockClear();
    const screen = await renderScreen(view(invoke, 'logs'));
    await settle();
    try {
      await screen.pressByTestIdAsync('capture-turn-on');
      await settle();
      expect(modal.spies.alert).not.toHaveBeenCalled();
      expect(screen.findByTestId('capture-approval')).not.toBeNull();
      // Nothing changed yet: the Project switch is still off until the approval runs.
      expect(screen.findByTestId('capture-off')).not.toBeNull();
    } finally {
      screen.unmount();
    }
  });

  // DBW review R4 #2: a wide Traces list always has a selection, the first request shown beside it until one is picked.
  it('shows the newest request beside the Traces list without a press, and the list keeps following capture', async () => {
    const at = Date.now();
    const request = (id: string, route: string, offset: number) => ({
      id, worktree: 'checkout-main', kind: 'span', source: 'otlp', at: at - offset, traceId: `trace-${id}`, spanId: id,
      durationMs: 40, serviceName: 'web', endpointMethod: 'GET', endpointRoute: route, httpStatusCode: 200,
    });
    const { invoke, calls } = machine((call) => {
      if (call.actionId.endsWith('/capture/status')) return { ok: true, source, coverage, enabled: true };
      if (call.actionId.endsWith('/capture/trace/get'))
        return { ok: true, source, traceId: 'trace-t1', summaries: [], repeatedQueries: [], slowChildSpans: [], logCorrelations: [] };
      return { ok: true, source, items: [request('t1', '/invoices/:id', 0), request('t2', '/login', 1000)] };
    });
    const screen = await renderScreen(view(invoke, 'traces'));
    try {
      await settle();
      await reportCollectionLayout(screen, 'telemetry.capture.traces', { width: 1000, height: 800 });
      await settle();
      expect(screen.findByTestId('telemetry.capture.trace.t1')).not.toBeNull();
      expect(screen.findByTestId('project-deployments.telemetry.request')).not.toBeNull();
      expect(calls.find((call) => call.actionId.endsWith('/capture/trace/get'))?.input)
        .toEqual(expect.objectContaining({ traceId: 'trace-t1' }));
      // The detail is the Collection's: no second way back of its own.
      expect(screen.findByTestId('project-deployments.telemetry.request.back')).toBeNull();
    } finally { await screen.unmount(); }
  });

  // DBW review R4 #7: gaps are said once, in the person's terms, with Retry beside them.
  it('says capture has gaps once, without the store code, and retries from that line', async () => {
    const { invoke, calls } = machine((call) => {
      if (call.actionId.endsWith('/capture/configure')) return { ok: true, enabled: true };
      if (call.actionId.endsWith('/capture/status'))
        return { ok: true, source, coverage: { lostObservations: 5791, reason: 'store_busy' }, enabled: true };
      return { ok: true, source, items: [] };
    });
    const screen = await renderScreen(view(invoke, 'logs'));
    try {
      await settle();
      const line = screen.findByTestId('capture-gaps');
      expect(line).not.toBeNull();
      expect(screen.getTextContent()).not.toMatch(/store.busy/);
      expect(screen.findByTestId('capture-status')?.props.children ?? null).toBeNull();
      await screen.pressByTestIdAsync('capture-gaps-action');
      await settle();
      expect(calls.filter((call) => call.actionId.endsWith('/capture/configure')).map((call) => call.input))
        .toEqual([expect.objectContaining({ enabled: true, retry: true })]);
    } finally { await screen.unmount(); }
  });

  // DBW review R4 #7: an unanswered read is said in the body alone, in capture's own words.
  it('does not say "Capture on" above a capture that did not answer', async () => {
    const { invoke } = machine((call) => {
      if (call.actionId.endsWith('/capture/status')) return { ok: true, source, coverage, enabled: true };
      throw Object.assign(new Error('unavailable'), { code: 'telemetry_unavailable' });
    });
    const screen = await renderScreen(view(invoke, 'endpoints'));
    try {
      await settle();
      expect(screen.findByTestId('capture-unavailable')).not.toBeNull();
      expect(screen.findByTestId('capture-status')?.props.children ?? null).toBeNull();
      expect(screen.getTextContent()).not.toMatch(/Telemetry/);
    } finally { await screen.unmount(); }
  });

  // DBW review R4 #6: a phone row says the figures the table's columns hold, the failure in its tone.
  it('recomposes an Endpoints row on a phone to its route and its figures', async () => {
    const { invoke } = machine((call) => call.actionId.endsWith('/capture/status')
      ? { ok: true, source, coverage, enabled: true }
      : { ok: true, source, items: [{
          serviceName: 'web', method: 'GET', route: '/api/invoices', requestCount: 38, errorCount: 9,
          errorRate: 9 / 38, totalDurationMs: 38 * 22, databaseTimeMs: 38 * 5,
        }] });
    const screen = await renderScreen(view(invoke, 'endpoints'));
    try {
      await settle();
      await reportCollectionLayout(screen, 'telemetry.capture.endpoints', { width: 358, height: 800 });
      await settle();
      const text = screen.getTextContent();
      expect(text).toMatch(/38 requests · 9 failed · 22\s?ms · 23% in database/);
    } finally { await screen.unmount(); }
  });
});
