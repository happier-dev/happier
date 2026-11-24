import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderScreen, standardCleanup } from '@/dev/testkit';
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
  which: 'endpoints' | 'logs' = 'endpoints',
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
});
