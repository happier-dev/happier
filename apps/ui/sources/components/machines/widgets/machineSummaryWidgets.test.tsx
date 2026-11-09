import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import {
  getWidgetSizeFootprintV1,
  type WidgetSizeV1,
} from '@happier-dev/protocol/widgets';
import {
  createRpcCallError,
  RPC_ERROR_CODES,
  RPC_ERROR_MESSAGES,
} from '@happier-dev/protocol/rpcErrors';

import { createDeferred, flushHookEffects, invokeTestInstanceHandler, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import {
  createHomeGovernanceHarness,
  installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';

const boundary = vi.hoisted(() => ({
  rpc: vi.fn<
    (input: {
      method: string;
      payload: unknown;
      signal?: AbortSignal;
    }) => Promise<unknown>
  >(),
}));
vi.mock('react-native', async () => {
  const { createReactNativeAppStateEmitter, createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  // The app is in the foreground: mounted widgets may demand live values.
  return createReactNativeWebMock({
    AppState: createReactNativeAppStateEmitter('active').appState,
  });
});
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () =>
  (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string) => key,
  }),
);
// The scoped machine RPC transport is the external boundary; the resource store, its demand and the strip stay real.
vi.mock(
  '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc',
  async () => {
    const { createServerScopedMachineRpcBoundaryMock } =
      await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock((input) => {
      // Invocation is dispatch at this network boundary; parked replies settle later.
      input.onDispatched?.();
      return boundary.rpc(input);
    });
  },
);
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);

installDisconnectedServerSocketBoundary();
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
await import('@/sync/domains/machines/resources/machineRpc');
const { useMachineWidgetMachine } =
  await import('@/components/machines/widgets/machineWidgetKit');
const { storage } = await import('@/sync/domains/state/storageStore');
const { clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { machineResourceStore } =
  await import('@/sync/domains/machines/resources/machineResourceStore');
const { WidgetFrameBodyCaptionContext, WidgetFrameBodyIdentityContext, WidgetFrameBodyMetaContext } =
  await import('@/components/widgets/frame/widgetFrameBodyCaption');
const { MachineVitalsWidget } = await import('./MachineVitalsWidget');
const { useMachineWidgetVitalsView } = await import('./machineWidgetVitalsView');
const { MachineAttentionStatedAbove } =
  await import('./machineAttentionStatedAbove');
const { MachineFleetWidget, orderFleetMachines, resolveFleetPresentation } =
  await import('./MachineFleetWidget');
const { getActiveServerSnapshot } =
  await import('@/sync/domains/server/serverRuntime');
const { MachineMetricWidget, narrowToVolume, readMachineMetricWidgetConfig } =
  await import('./MachineMetricWidget');
const { MachineSummaryStrip } =
  await import('@/components/machines/summary/MachineSummaryStrip');
const { AllMachinesIndex } = await import('@/components/machines/index/AllMachinesIndex');
const { DiskTile } = await import('@/components/machines/vitals/DiskTile');
const { MachineSummaryFreshnessLine, useMachineSummaryFreshnessFacts } =
  await import('@/components/machines/summary/MachineSummaryFreshnessLine');
const { MachineAlertsPage, DiskThresholdSelect } =
  await import('@/components/machines/vitals/MachineAlertsPage');
const { parseCustomDiskThreshold } =
  await import('@/components/machines/vitals/machineAlertsPresentation');

const HOME = 'srv_widget_summary';
let accountConnection: Awaited<
  ReturnType<typeof restoreServerAccountForTest>
> | null = null;
let machineCensus = createDeferred<void>();
beforeEach(async () => {
  const serverId = await home.addHome({
    name: 'Widget Home',
    serverUrl: 'https://machine-summary-widgets.test',
    serverIdentityId: HOME,
    accountId: 'owner',
  });
  home.answer(serverId, '/v2/account/settings', {
    body: { content: { t: 'plain', v: {} }, version: 1 },
  });
  machineCensus = createDeferred<void>();
  // Each case installs its inventory; an unrelated bootstrap reply must not overwrite it.
  home.answer(serverId, '/v1/machines', { body: [], respondAfter: machineCensus.promise });
  accountConnection = await restoreServerAccountForTest({
    serverUrl: 'https://machine-summary-widgets.test',
    serverIdentityId: HOME,
    accountId: 'owner',
    request: home.request,
  });
});
const resources = {
  v: 1,
  vitals: { state: 'reporting' },
  host: { logicalCores: 18, memoryTotalBytes: 128e9, bootedAt: 1 },
  attention: { level: 'calm', reasons: [] },
};
const sample = (sampledAt: number) => ({
  v: 1,
  sampledAt,
  intervalMs: 15_000,
  cpu: { reported: true, busyPct: 12 },
  memory: {
    reported: true,
    totalBytes: 128e9,
    availableBytes: 71e9,
    usedBytes: 57e9,
    pressure: { level: 'calm', source: 'psi' },
  },
  disk: { reported: true, volumes: [] },
  network: { reported: true, rxBps: 12, txBps: 3 },
});

afterEach(async () => {
  clearMachineRequestReachabilityForTest();
  machineResourceStore.reset();
  boundary.rpc.mockReset();
  storage.setState({
    machines: {},
    machineListByServerId: {},
    machineListStatusByServerId: {},
  });
  standardCleanup();
  await accountConnection?.dispose();
  accountConnection = null;
  machineCensus.resolve();
  await home.reset();
});

function seed(machine: ReturnType<typeof createMachineFixture>) {
  storage.setState({
    machineListByServerId: { [HOME]: [machine] },
    machineListStatusByServerId: { [HOME]: 'idle' },
  });
}

/** The frame lends the body its header meta slot; here it is drawn beside the body so the test can read it. */
function MetaHost(props: Readonly<{ children: React.ReactNode }>) {
  const [meta, setMeta] = React.useState<React.ReactNode>(null);
  return (
    <WidgetFrameBodyMetaContext.Provider value={setMeta}>
      {meta}
      {props.children}
    </WidgetFrameBodyMetaContext.Provider>
  );
}

async function renderVitals(size: WidgetSizeV1) {
  return renderScreen(
    <MetaHost>
      <WidgetPresentationProvider
        value={{
          size,
          footprint: getWidgetSizeFootprintV1('home', size)!,
        }}
      >
        <MachineVitalsWidget
          input={{ machine: { serverId: HOME, machineId: 'm1' } }}
          serverId={HOME}
          testID="vitals"
        />
      </WidgetPresentationProvider>
    </MetaHost>,
  );
}

function expectInlineChip(screen: { findByTestId: (id: string) => { props: { style?: unknown } } | null }) {
  const flatten = (value: unknown): Record<string, unknown> => Array.isArray(value) ? Object.assign({}, ...value.map(flatten)) : (value ?? {}) as Record<string, unknown>;
  const style = flatten(screen.findByTestId('machines.summary.stale')!.props.style);
  expect(style.flexShrink).toBe(1);
  expect(style.backgroundColor).toBe('transparent');
}

describe('Vitals widget (lab rw V, VS)', () => {
  it.each(['vitals', 'metric', 'list'] as const)('projects monitoring Off for passive summaries in a Small %s without showing held numbers', async kind => {
    const { MachineResourcesPolicyV1Schema } = await import('@happier-dev/protocol/machines/resources/machineResourcesPolicyV1');
    const { MachineListRowSummary } = await import('@/components/machines/summary/MachineListRowSummary');
    const sampledAt = Date.now();
    const machine = createMachineFixture({ id: 'm1', active: true, activeAt: sampledAt, daemonState: { resources } });
    seed(machine);
    boundary.rpc.mockResolvedValue({ state: 'reporting', sample: sample(sampledAt),
      series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } });
    const key = { serverId: HOME, expectedAccountId: 'owner', machineId: 'm1', view: 'summary' as const };
    await machineResourceStore.read(key);
    seed({ ...machine, metadata: { ...machine.metadata!,
      resourcesPolicyV1: MachineResourcesPolicyV1Schema.parse({ v: 1, monitoring: { mode: 'off' } }) } });
    const originalLocalSettings = storage.getState().localSettings;
    storage.setState({ localSettings: { ...originalLocalSettings, uiMachineSummaryMetrics: ['cpu'] } });
    boundary.rpc.mockClear();
    const screen = kind === 'vitals' ? await renderVitals('small') : await renderScreen(
      <WidgetPresentationProvider value={{ size: 'small', footprint: getWidgetSizeFootprintV1('home', 'small')! }}>
        {kind === 'metric'
          ? <MachineMetricWidget input={{ machine: { serverId: HOME, machineId: 'm1' } }} serverId={HOME} testID="metric" />
          : <MachineListRowSummary serverId={HOME} machineId="m1" online quietWord="Online" testID="list" />}
      </WidgetPresentationProvider>,
    );
    try {
      await flushHookEffects();
      expect(screen.getTextContent()).toContain(kind === 'vitals' ? 'machineVitals.monitoring.offTitle' : 'machineVitals.monitoring.modes.off');
      expect(screen.getTextContent()).not.toContain('12%');
      expect(boundary.rpc).not.toHaveBeenCalled();
      expect(machineResourceStore.getState(key).summary).toMatchObject({ cpu: { busyPct: 12 } });
    } finally { await screen.unmount(); storage.setState({ localSettings: originalLocalSettings }); }
  });

  it.each(['24h', '7d'] as const)('publishes zero unchanged %s chart projections for live arrivals and refreshes changed history', async range => {
    const { MachineVitalsHistoryV1Schema } = await import('@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1');
    const { commitPreferredLanguage, getPreferredLanguage } = await import('@/text/preferredLanguage');
    const originalLanguage = getPreferredLanguage();
    const translate = vi.spyOn(await import('@/text'), 't').mockImplementation(key => String(key).startsWith('machineVitals.range.')
      ? `${getPreferredLanguage()}:${String(key)}` : String(key));
    const at = Date.now();
    seed(createMachineFixture({ id: 'm1', active: true, activeAt: at, daemonStateVersion: 1, daemonState: { resources } }));
    const bucketMs = range === '7d' ? 1_800_000 : 300_000;
    let history = MachineVitalsHistoryV1Schema.parse({ range, bucketMs,
      points: Array.from({ length: range === '7d' ? 336 : 288 }, (_, index) => ({
        t: at - (336 - index) * bucketMs, cpu: 12, cpuMax: 20, mem: 57e9, memMax: 60e9,
        lvl: 'calm', swp: null, rx: 120, tx: 30, rxObservedMs: bucketMs, txObservedMs: bucketMs,
      })), today: { rxBytes: 120, txBytes: 30 } });
    let observedAt = at;
    boundary.rpc.mockImplementation(async input => {
      if (input.method.includes('watch')) return new Promise(() => {});
      if (input.method.includes('history')) return history;
      return { state: 'reporting', sample: sample(observedAt),
        series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] }, attention: { level: 'calm', reasons: [] } };
    });
    const target = { serverId: HOME, machineId: 'm1' };
    const hook = await renderHook(() => useMachineWidgetVitalsView({ target, facts: useMachineWidgetMachine(target), range }));
    try {
      await flushHookEffects();
      const original = hook.getCurrent();
      expect(original.timeline?.points).toHaveLength(history.points.length);
      let publications = 0;
      for (let arrival = 1; arrival <= 10; arrival++) {
        observedAt = at + arrival * 2_000;
        const previous = hook.getCurrent();
        await act(async () => { await machineResourceStore.read({ ...target, expectedAccountId: 'owner', view: 'overview' }); });
        if (hook.getCurrent().timeline !== previous.timeline || hook.getCurrent().axis !== previous.axis) publications++;
      }
      expect(publications).toBe(0);
      // Live figures still advance; only the daemon-owned long-range chart stays unchanged.
      const currentView = hook.getCurrent().view;
      expect(currentView.kind === 'ready' && currentView.sample.sampledAt).toBe(observedAt);
      const previous = hook.getCurrent().timeline;
      history = { ...history, points: [...history.points.slice(0, -1), { ...history.points.at(-1)!, cpu: 80, cpuMax: 90 }] };
      await act(async () => { await machineResourceStore.readHistory({ ...target, expectedAccountId: 'owner', range }); });
      expect(hook.getCurrent().timeline).not.toBe(previous);
      expect(hook.getCurrent().timeline?.points.at(-1)?.cpu).toBe(80);
      const nextLanguage = originalLanguage === 'fr' ? 'en' : 'fr';
      await act(async () => { commitPreferredLanguage(nextLanguage); });
      expect(hook.getCurrent().axis[1]).toBe(`${nextLanguage}:machineVitals.range.now`);
    } finally { await hook.unmount(); commitPreferredLanguage(originalLanguage); translate.mockRestore(); }
  });

  it('bounds custom disk alerts by this Account’s retained volume rather than treating it as unread', async () => {
    const { MachineResourcesPolicyV1Schema } =
      await import('@happier-dev/protocol/machines/resources/machineResourcesPolicyV1');
    const fixture = createMachineFixture({
      id: 'm1',
      active: true,
      activeAt: Date.now(),
      isShared: false,
      metadata: {
        ...createMachineFixture().metadata!,
        resourcesPolicyV1: MachineResourcesPolicyV1Schema.parse({
          v: 1,
          alerts: { disk: { enabled: true } },
        }),
      },
      daemonState: { resources },
    });
    seed(fixture);
    const key = {
      serverId: HOME,
      expectedAccountId: 'owner',
      machineId: 'm1',
      view: 'summary' as const,
    };
    boundary.rpc.mockResolvedValue({
      state: 'reporting',
      sample: {
        ...sample(Date.now()),
        disk: {
          reported: true,
          volumes: [
            {
              id: 'root',
              label: 'Root',
              mount: '/',
              totalBytes: 100e9,
              availableBytes: 80e9,
            },
          ],
        },
      },
      series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
      attention: { level: 'calm', reasons: [] },
    });
    await machineResourceStore.read(key);
    expect(machineResourceStore.getState(key).status).toBe('ready');
    const screen = await renderScreen(
      <MachineAlertsPage
        serverId={HOME}
        machine={fixture}
        machineName="Machine"
      />,
    );
    const selector = screen.root.findByType(DiskThresholdSelect);
    await vi.waitFor(() =>
      expect(selector.props.largestVolumeBytes()).toBe(100e9),
    );
    expect(
      parseCustomDiskThreshold('101 GB', selector.props.largestVolumeBytes()),
    ).toBeNull();
    expect(
      parseCustomDiskThreshold('99 GB', selector.props.largestVolumeBytes()),
    ).not.toBeNull();
  });
  it('is demand on the summary transport while mounted and draws the strip’s three rings', async () => {
    const sampledAt = Date.now();
    seed(
      createMachineFixture({
        id: 'm1',
        active: true,
        activeAt: sampledAt,
        daemonStateVersion: 1,
        daemonState: { resources },
      }),
    );
    boundary.rpc.mockResolvedValue({
      state: 'reporting',
      sample: sample(sampledAt),
      series5m: {
        cpu: [{ t: sampledAt, y: 12 }],
        memory: [{ t: sampledAt, y: 45 }],
        networkRx: [],
        networkTx: [],
      },
      attention: { level: 'calm', reasons: [] },
    });
    const screen = await renderVitals('small');
    await act(async () => {
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    });
    expect(
      boundary.rpc.mock.calls.some(
        ([call]) =>
          call.method.startsWith('machines.vitals') ||
          call.method.startsWith('daemon.vitals'),
      ),
    ).toBe(true);
    expect(screen.findByTestId('vitals.strip')).toBeTruthy();
    expect(screen.findByTestId('vitals.strip')?.props.accessibilityLabel).toContain('machineVitals.memory.source.estimated');
    expect(screen.findByTestId('vitals.offline')).toBeNull();
  });

  it('says an offline machine with nothing read is offline, and asks it nothing', async () => {
    seed(
      createMachineFixture({
        id: 'm1',
        active: false,
        activeAt: Date.now() - 86_400_000,
        daemonState: { resources },
      }),
    );
    const screen = await renderVitals('medium');
    await act(async () => {
      for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    });
    expect(screen.findByTestId('vitals.offline')).toBeTruthy();
    expect(boundary.rpc).not.toHaveBeenCalled();
  });

  it('keeps an unanswered Vitals read loading, then shows unsupported only after the owner answers', async () => {
    const answer = createDeferred<unknown>();
    boundary.rpc.mockReturnValue(answer.promise);
    seed(
      createMachineFixture({
        id: 'm1',
        active: true,
        activeAt: Date.now(),
        daemonStateVersion: 1,
        metadata: null,
        daemonState: {},
      }),
    );
    const screen = await renderVitals('small');
    expect(screen.findByTestId('vitals.loading')).toBeTruthy();
    expect(screen.findByTestId('vitals.notReported')).toBeNull();
    await act(async () => {
      seed(
        createMachineFixture({
          id: 'm1',
          active: true,
          activeAt: Date.now(),
          daemonStateVersion: 1,
          daemonState: {},
        }),
      );
      answer.reject(
        createRpcCallError({
          error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND,
          errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
        }),
      );
    });
    await vi.waitFor(() =>
      expect(screen.findByTestId('vitals.notReported')).toBeTruthy(),
    );
    expect(screen.findByTestId('vitals.loading')).toBeNull();
  });

  it('shows a failed Vitals read as retryable, not unsupported or still loading', async () => {
    boundary.rpc.mockRejectedValue(new Error('network failed'));
    seed(
      createMachineFixture({
        id: 'm1',
        active: true,
        activeAt: Date.now(),
        daemonStateVersion: 1,
        daemonState: {},
      }),
    );
    const screen = await renderVitals('small');
    await vi.waitFor(() =>
      expect(
        machineResourceStore.getState({
          serverId: HOME,
          expectedAccountId: 'owner',
          machineId: 'm1',
          view: 'summary',
        }).status,
      ).toBe('error'),
    );
    expect(screen.findByTestId('vitals.error')).toBeTruthy();
    expect(
      screen.findHostByTestId('vitals.error-details-toggle'),
    ).not.toBeNull();
    await screen.pressByTestIdAsync('vitals.error-details-toggle');
    expect(screen.getTextContent()).toContain('action_failed');
    expect(screen.findByTestId('vitals.notReported')).toBeNull();
    expect(screen.findByTestId('vitals.loading')).toBeNull();
    const metric = await renderScreen(
      <MachineMetricWidget
        input={{ machine: { serverId: HOME, machineId: 'm1' } }}
        serverId={HOME}
        testID="failedMetric"
      />,
    );
    await vi.waitFor(() =>
      expect(metric.findByTestId('failedMetric.error')).toBeTruthy(),
    );
    expect(
      metric.findHostByTestId('failedMetric.error-details-toggle'),
    ).not.toBeNull();
    await metric.pressByTestIdAsync('failedMetric.error-details-toggle');
    expect(metric.getTextContent()).toContain('action_failed');
    expect(metric.findByTestId('failedMetric.strip')).toBeNull();
    boundary.rpc.mockResolvedValue({
      state: 'reporting',
      sample: sample(Date.now()),
      series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
      attention: { level: 'calm', reasons: [] },
    });
    await screen.pressByTestIdAsync('vitals.error-action');
    await vi.waitFor(() =>
      expect(screen.findByTestId('vitals.strip')).not.toBeNull(),
    );
  });

  it('shows the rail freshness recovery for the same Account-qualified retained summary', async () => {
    const sampledAt = Date.now();
    seed(
      createMachineFixture({
        id: 'm1',
        active: true,
        activeAt: sampledAt,
        daemonState: { resources },
      }),
    );
    const key = {
      serverId: HOME,
      expectedAccountId: 'owner',
      machineId: 'm1',
      view: 'summary' as const,
    };
    boundary.rpc.mockResolvedValue({
      state: 'reporting',
      sample: sample(sampledAt),
      series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
      attention: { level: 'calm', reasons: [] },
    });
    await machineResourceStore.read(key);
    const screen = await renderScreen(
      <MachineSummaryFreshnessLine
        machineKeys={[{ serverId: HOME, machineId: 'm1' }]}
        fallback={null}
      />,
    );
    expect(screen.findByTestId('machines.summary.stale')).toBeNull();
    boundary.rpc.mockRejectedValue(new Error('transport unavailable'));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(sampledAt + 30_000);
    try {
      await act(async () => {
        await machineResourceStore.retry(key);
      });
      expect(
        machineResourceStore.getState(key).snapshot?.sample?.sampledAt,
      ).toBe(sampledAt);
      expect(screen.findByTestId('machines.summary.stale')).not.toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it('gives a page header "Live" while the summaries answer and "As of … · Retry" once they stop', async () => {
    const sampledAt = Date.now();
    seed(
      createMachineFixture({
        id: 'm1',
        active: true,
        activeAt: sampledAt,
        daemonState: { resources },
      }),
    );
    const key = {
      serverId: HOME,
      expectedAccountId: 'owner',
      machineId: 'm1',
      view: 'summary' as const,
    };
    boundary.rpc.mockResolvedValue({
      state: 'reporting',
      sample: sample(sampledAt),
      series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
      attention: { level: 'calm', reasons: [] },
    });
    const keys = [{ serverId: HOME, machineId: 'm1' }];
    const noKeys: readonly { serverId: string; machineId: string }[] = [];
    const none = await renderHook(() => useMachineSummaryFreshnessFacts(noKeys, 'page'));
    expect(none.getCurrent()).toEqual([]);
    const hook = await renderHook(() => useMachineSummaryFreshnessFacts(keys, 'page'));
    // Nothing has answered yet: no claim about freshness.
    expect(hook.getCurrent()).toEqual([]);
    await act(async () => {
      await machineResourceStore.read(key);
    });
    expect(hook.getCurrent().map(fact => fact.testID)).toEqual(['page.live']);
    boundary.rpc.mockRejectedValue(new Error('transport unavailable'));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(sampledAt + 30_000);
    try {
      await act(async () => {
        await machineResourceStore.retry(key);
      });
      expect(hook.getCurrent().map(fact => fact.testID)).toEqual(['page.stale', 'page.retry']);
      const before = boundary.rpc.mock.calls.length;
      await act(async () => {
        hook.getCurrent()[1]!.onPress!();
      });
      await vi.waitFor(() => expect(boundary.rpc.mock.calls.length).toBeGreaterThan(before));
    } finally {
      clock.mockRestore();
    }
  });

  it('says a machine is slow to answer after one failed watch and stopped answering once it errors, keeping its values', async () => {
    const sampledAt = Date.now();
    seed(
      createMachineFixture({
        id: 'm1',
        active: true,
        activeAt: sampledAt,
        daemonState: { resources },
      }),
    );
    const key = {
      serverId: HOME,
      expectedAccountId: 'owner',
      machineId: 'm1',
      view: 'summary' as const,
    };
    let watchFailed = false;
    const parkedWatch = createDeferred<unknown>();
    boundary.rpc.mockImplementation(async ({ method }) => {
      if (method.includes('watch')) {
        if (!watchFailed) {
          watchFailed = true;
          throw new Error('watch unavailable');
        }
        return parkedWatch.promise;
      }
      return {
        state: 'reporting',
        sample: sample(sampledAt),
        series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
        attention: { level: 'calm', reasons: [] },
      };
    });
    await machineResourceStore.read(key);
    const screen = await renderScreen(
      <MachineSummaryFreshnessLine
        machineKeys={[{ serverId: HOME, machineId: 'm1' }]}
        fallback={null}
      />,
    );
    expect(screen.findByTestId('machines.summary.stale')).toBeNull();
    const release = machineResourceStore.demand(key);
    try {
      await act(async () => {
        await vi.waitFor(() =>
          expect(machineResourceStore.getState(key).status).toBe('slow'),
        );
      });
      // The first failed watch keeps every value and says only that the machine is slow.
      expect(machineResourceStore.getState(key).summary).not.toBeNull();
      expect(screen.getTextContent()).toContain('machineSummary.slowReason');
      expectInlineChip(screen);
    } finally {
      release();
      parkedWatch.resolve({ changed: false });
    }
    // A failed read of a still-fresh sample is the same "stopped answering" the age boundary says.
    boundary.rpc.mockRejectedValue(new Error('transport unavailable'));
    await act(async () => {
      await machineResourceStore.retry(key);
    });
    expect(machineResourceStore.getState(key).status).toBe('error');
    expect(machineResourceStore.getState(key).summary).not.toBeNull();
    // Stopped answering reads as the machine page's chip, "As of 10:42 · Retry": it gives way before Retry does.
    expect(screen.getTextContent()).not.toContain('machineSummary.slowReason');
    expect(screen.findByTestId('machines.summary.stale-action')).not.toBeNull();
    expectInlineChip(screen);
  });

  it('says a machine on an older Happier does not report, never zero', async () => {
    boundary.rpc.mockRejectedValue(
      createRpcCallError({
        error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
      }),
    );
    seed(
      createMachineFixture({
        id: 'm1',
        active: true,
        activeAt: Date.now(),
        daemonStateVersion: 1,
        daemonState: {},
      }),
    );
    const screen = await renderVitals('small');
    await vi.waitFor(() =>
      expect(screen.findByTestId('vitals.notReported')).toBeTruthy(),
    );
    expect(screen.findByTestId('vitals.notReported')).toBeTruthy();
    expect(screen.findByTestId('vitals.strip')).toBeNull();
  });
});

describe('Machine widget names', () => {
  it('uses the existing generic machine subject while identity is hydrating, never a Loading sentence subject', async () => {
    seed(
      createMachineFixture({
        id: 'm1',
        metadata: null,
        availability: undefined,
        daemonState: {},
        active: true,
        activeAt: Date.now(),
      }),
    );
    let subject = '';
    function Probe() {
      subject = useMachineWidgetMachine({
        serverId: HOME,
        machineId: 'm1',
      }).name;
      return null;
    }
    const screen = await renderScreen(<Probe />);
    expect(subject).toBe('machines.widgets.body.common.unknownMachine');
    const readable = createMachineFixture({ id: 'm1' });
    const readableMetadata = readable.metadata;
    if (!readableMetadata)
      throw new Error('Fixture must have readable metadata');
    await act(async () =>
      seed({
        ...readable,
        metadata: { ...readableMetadata, host: 'Readable box' },
      }),
    );
    expect(subject).toBe('Readable box');
    await screen.unmount();
  });
  it('says the same disambiguated name as the Home list when two machines share a host name', async () => {
    const twin = (id: string) =>
      createMachineFixture({
        id,
        active: true,
        activeAt: Date.now(),
        daemonStateVersion: 1,
        daemonState: {},
      });
    storage.setState({
      machineListByServerId: {
        [HOME]: [twin('a1b2c3d4-0000'), twin('e5f6a7b8-0000')],
      },
      machineListStatusByServerId: { [HOME]: 'idle' },
    });
    const names: string[] = [];
    function Probe(props: Readonly<{ machineId: string }>) {
      names.push(
        useMachineWidgetMachine({ serverId: HOME, machineId: props.machineId })
          .name,
      );
      return null;
    }
    const screen = await renderScreen(
      <>
        <Probe machineId="a1b2c3d4-0000" />
        <Probe machineId="e5f6a7b8-0000" />
      </>,
    );
    const [first, second] = names.slice(-2);
    expect(first).not.toEqual(second);
    await screen.unmount();
  });
});

describe('Vitals on an offline machine', () => {
  it('dates the values it still holds and makes no live claim about what the machine is doing', async () => {
    const sampledAt = Date.now();
    const machine = (online: boolean) =>
      createMachineFixture({
        id: 'm1',
        active: online,
        activeAt: online ? sampledAt : sampledAt - 3_600_000,
        daemonStateVersion: 1,
        daemonState: {
          resources: {
            ...resources,
            host: { logicalCores: 18, memoryTotalBytes: 128e9, bootedAt: 1 },
          },
        },
      });
    seed(machine(true));
    boundary.rpc.mockResolvedValue({
      state: 'reporting',
      sample: sample(sampledAt),
      series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
      attention: { level: 'calm', reasons: [] },
    });
    const screen = await renderVitals('medium');
    await act(async () => {
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    });
    // Live: the sentence about what the machine is doing is there, and the header says nothing.
    expect(screen.getTextContent()).toContain('machineAttention.machine.idle');
    expect(screen.findByTestId('vitals.asOf')).toBeNull();
    // The machine drops offline while this app still holds its last reading.
    await act(async () => {
      seed(machine(false));
    });
    await act(async () => {
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    });
    expect(screen.findByTestId('vitals.memory')).toBeTruthy();
    expect(screen.findByTestId('vitals.offline')).toBeTruthy();
    expect(screen.findByTestId('vitals.asOf')).toBeTruthy();
    expect(screen.getTextContent()).not.toContain(
      'machineAttention.machine.idle',
    );
  });
});

describe('Vitals attention block', () => {
  const attentionResources = {
    ...resources,
    attention: {
      level: 'needs_you',
      reasons: [
        {
          key: 'memory',
          level: 'needs_you',
          since: Date.now() - 60_000,
          metric: 'memory',
          nextStep: 'review_processes',
          kind: 'memory_pressure',
          pressure: 'critical',
          swapping: true,
        },
      ],
    },
  };
  async function mountWithAttention(statedAbove: boolean) {
    const sampledAt = Date.now();
    seed(
      createMachineFixture({
        id: 'm1',
        active: true,
        activeAt: sampledAt,
        daemonStateVersion: 1,
        daemonState: { resources: attentionResources },
      }),
    );
    boundary.rpc.mockResolvedValue({
      state: 'reporting',
      sample: sample(sampledAt),
      series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
      attention: attentionResources.attention,
    });
    const entries = statedAbove
      ? [
          {
            key: `${HOME}:m1`,
            serverId: HOME,
            machineId: 'm1',
            name: 'm1',
            online: true,
            attention: attentionResources.attention,
            lastAutomaticAction: null,
          },
        ]
      : [];
    const screen = await renderScreen(
      <MachineAttentionStatedAbove entries={entries as never}>
        <WidgetPresentationProvider
          value={{
            size: 'medium',
            footprint: getWidgetSizeFootprintV1('home', 'medium')!,
          }}
        >
          <MachineVitalsWidget
            input={{ machine: { serverId: HOME, machineId: 'm1' } }}
            serverId={HOME}
            testID="vitals"
          />
        </WidgetPresentationProvider>
      </MachineAttentionStatedAbove>,
    );
    await act(async () => {
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    });
    return screen;
  }

  it('carries the full attention block and its one action on its own', async () => {
    const screen = await mountWithAttention(false);
    expect(screen.findByTestId('vitals.nextStep')).toBeTruthy();
  });

  it('steps back where the page above already names this machine: no repeated sentence, no second button', async () => {
    const screen = await mountWithAttention(true);
    expect(screen.findByTestId('vitals.nextStep')).toBeNull();
    expect(screen.findByTestId('vitals.phrase')).toBeTruthy();
    // The state itself stays on the ring row.
    expect(screen.findByTestId('vitals.memory')).toBeTruthy();
  });
});

describe('Machines widget presentation', () => {
  it.each(['medium', 'large'] as const)('keeps local and remote Linux machine glyphs in the %s fleet', async size => {
    const serverId = getActiveServerSnapshot().serverId;
    const { getSystemTasksRunner } = await import('@/components/systemTasks/systemTasksRuntime');
    const { publishLocalDaemonStatus } = await import('@/components/settings/machines/localControl/localDaemonSharedState');
    const { Icon } = await import('@/components/ui/icons/Icon');
    const { publishMachineInventoryForTest } = await import('@/dev/testkit/harness/machinePresence');
    const machine = createMachineFixture({ id: 'linux-box', active: true, activeAt: Date.now(),
      metadata: { ...createMachineFixture().metadata!, platform: 'linux' } });
    await publishMachineInventoryForTest({ serverId, accountId: 'owner' }, [machine,
      createMachineFixture({ id: 'peer', active: true, activeAt: Date.now() })]);
    storage.getState().markMachineListSettled(serverId);
    const draw = () => <WidgetPresentationProvider value={{ size, footprint: getWidgetSizeFootprintV1('home', size)! }}>
      <MachineFleetWidget input={{ metrics: [] }} serverId={serverId} testID="fleet" />
    </WidgetPresentationProvider>;
    const runner = getSystemTasksRunner();
    publishLocalDaemonStatus(runner, { machineId: null });
    const screen = await renderScreen(draw());
    await vi.waitFor(() => expect(screen.findByTestId(size === 'large' ? 'fleet.card.linux-box' : 'fleet.machine.linux-box')).not.toBeNull());
    expect(screen.findAll(node => node.type === Icon && node.props.name === 'hard-drives')).not.toHaveLength(0);
    await act(async () => publishLocalDaemonStatus(runner, { machineId: machine.id }));
    expect(screen.findAll(node => node.type === Icon && node.props.name === 'laptop')).not.toHaveLength(0);
    await act(async () => publishLocalDaemonStatus(runner, { machineId: null }));
    await screen.unmount();
  });

  it('with no machine yet, its empty state is the ways to add one, each opening the one Add chooser at that way (58d AF1)', async () => {
    const { router } = await import('expo-router');
    const serverId = getActiveServerSnapshot().serverId;
    storage.getState().applyMachines([], true, { sourceServerId: serverId });
    storage.getState().markMachineListSettled(serverId);
    boundary.rpc.mockClear();
    const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'small', footprint: getWidgetSizeFootprintV1('home', 'small')! }}>
      <MachineFleetWidget input={{ metrics: ['cpu'] }} serverId={serverId} testID="fleet" />
    </WidgetPresentationProvider>);
    expect(screen.getTextContent()).toContain('machines.widgets.body.fleet.firstRun.title');
    expect(screen.findByTestId('fleet.way.create')).not.toBeNull();
    expect(screen.findByTestId('fleet.way.ssh')).not.toBeNull();
    expect(screen.findByTestId('fleet.way.computer')).not.toBeNull();
    vi.mocked(router.push).mockClear();
    await screen.pressByTestIdAsync('fleet.way.create');
    expect(router.push).toHaveBeenLastCalledWith('/settings/machines/add?path=create');
    await screen.pressByTestIdAsync('fleet.way.ssh');
    expect(router.push).toHaveBeenLastCalledWith('/settings/machines/add?path=ssh');
    // Nothing on an empty fleet asks a machine.
    expect(boundary.rpc).not.toHaveBeenCalled();
    await screen.unmount();
  });

  it('opens the large fleet shared card while keeping live metric content and its offline peer', async () => {
    const { router } = await import('expo-router');
    const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
    const serverId = getActiveServerSnapshot().serverId;
    const at = Date.now();
    storage.getState().applyMachines([
      createMachineFixture({ id: 'edge', active: true, activeAt: at, daemonStateVersion: 1, daemonState: { resources } }),
      createMachineFixture({ id: 'studio', active: false, activeAt: at - 86_400_000 }),
    ], true, { sourceServerId: serverId });
    observeMachinePresenceForTest({ serverId, accountId: 'owner' }, ['edge', 'studio']);
    boundary.rpc.mockResolvedValue({ state: 'reporting', sample: sample(at), series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] }, attention: resources.attention });
    const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'large', footprint: getWidgetSizeFootprintV1('home', 'large')! }}>
      <MachineFleetWidget input={{ metrics: ['cpu'] }} serverId={serverId} testID="fleet" />
    </WidgetPresentationProvider>);
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('12%'));
    expect(screen.findByTestId('fleet.card.studio')).not.toBeNull();
    expect(screen.getTextContent()).toContain('machines.widgets.body.common.offline');
    vi.mocked(router.push).mockClear();
    await screen.pressByTestIdAsync('fleet.card.edge:open');
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenLastCalledWith(`/settings/machines/edge?serverId=${encodeURIComponent(serverId)}`);
    expect(screen.getTextContent()).toContain('12%');
    await screen.unmount();
  });

  it('keeps the Machines index Update target independent while its shared card retains the unsupported metric explanation', async () => {
    const { MachinesDoorProvider } = await import('@/components/machines/page/machinesDoor');
    const { router } = await import('expo-router');
    const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
    const serverId = getActiveServerSnapshot().serverId;
    storage.setState(state => ({ localSettings: { ...state.localSettings, machinesIndexViewV1: 'grid', uiMachineSummaryMetrics: ['cpu'] } }));
    storage.getState().applyMachines([createMachineFixture({ id: 'older', active: true, activeAt: Date.now(), daemonState: {} })], true, { sourceServerId: serverId });
    observeMachinePresenceForTest({ serverId, accountId: 'owner' }, ['older']);
    boundary.rpc.mockRejectedValue(createRpcCallError({ error: RPC_ERROR_MESSAGES.METHOD_NOT_FOUND, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }));
    const screen = await renderScreen(<MachinesDoorProvider door="rail"><AllMachinesIndex /></MachinesDoorProvider>);
    await act(async () => invokeTestInstanceHandler(screen.findHostByTestId('machines.index.collection:stage'), 'onLayout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 800 } },
    }));
    const update = `machines.index.card.machine:${serverId}:older.update`;
    await vi.waitFor(() => expect(screen.getTextContent()).toContain('machineSummary.updateToSee'));
    expect(screen.findByTestId(update)).not.toBeNull();
    vi.mocked(router.push).mockClear();
    await screen.pressByTestIdAsync(update);
    expect(router.push).toHaveBeenCalledOnce();
    expect(router.push).toHaveBeenLastCalledWith('/settings/updates');
    expect(screen.getTextContent()).toContain('machineSummary.updateToSee');
    await screen.unmount();
  });

  it('says offline machines in one quiet line at Medium and Full, so a long offline list never overflows the card', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    const offline = ['old-a', 'old-b', 'old-c'].map((id) => createMachineFixture({ id, active: false, activeAt: Date.now() - 86_400_000 }));
    const machines = [createMachineFixture({ id: 'edge', active: true, activeAt: Date.now() }), ...offline];
    storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
    for (const size of ['medium', 'full'] as const) {
      const screen = await renderScreen(<WidgetPresentationProvider value={{ size, footprint: getWidgetSizeFootprintV1('home', size)! }}>
        <MachineFleetWidget input={{ metrics: [] }} serverId={serverId} testID="fleet" />
      </WidgetPresentationProvider>);
      expect(screen.findByTestId('fleet.machine.edge')).not.toBeNull();
      for (const machine of offline) expect(screen.findByTestId(`fleet.machine.${machine.id}`)).toBeNull();
      expect(screen.findByTestId('fleet.rest')).not.toBeNull();
      expect(screen.getTextContent()).not.toContain('machines.widgets.body.fleet.offlineGroup');
      await screen.unmount();
    }
  });

  it('lends its frame "All machines" as the source, since it reads every machine (lab rw H)', async () => {
    const serverId = getActiveServerSnapshot().serverId;
    storage.getState().applyMachines([createMachineFixture({ id: 'edge', active: true, activeAt: Date.now() })], true, { sourceServerId: serverId });
    const lent: (string | null)[] = [];
    const screen = await renderScreen(
      <WidgetFrameBodyCaptionContext.Provider value={(caption) => { lent.push(caption); }}>
        <WidgetPresentationProvider value={{ size: 'wide', footprint: getWidgetSizeFootprintV1('home', 'wide')! }}>
          <MachineFleetWidget input={{ metrics: [] }} serverId={serverId} testID="fleet" />
        </WidgetPresentationProvider>
      </WidgetFrameBodyCaptionContext.Provider>,
    );
    // The same words the Activity widget lends when it reads every machine.
    expect(lent.at(-1)).toBe('machines.widgets.body.activity.allMachines');
    await screen.unmount();
  });

  it('keeps withdrawn Machine rows visible without adding them to the offline group', async () => {
    const { withdrawMachinePresenceForScope, captureMachinePresenceObservation } =
      await import('@/sync/domains/machines/reachability/machineReachability');
    const serverId = getActiveServerSnapshot().serverId;
    const machines = [createMachineFixture({ id: 'edge', activeAt: Date.now() }), createMachineFixture({ id: 'studio', activeAt: Date.now() })];
    storage.getState().applyMachines(machines, true, { sourceServerId: serverId });
    const screen = await renderScreen(<WidgetPresentationProvider value={{ size: 'medium', footprint: getWidgetSizeFootprintV1('home', 'medium')! }}>
      <MachineFleetWidget input={{ metrics: [] }} serverId={serverId} testID="fleet" />
    </WidgetPresentationProvider>);
    const scope = { serverId, accountId: 'owner' };
    await act(async () => withdrawMachinePresenceForScope(scope));
    expect(screen.findByTestId('fleet.machine.edge')).not.toBeNull();
    expect(screen.findByTestId('fleet.machine.studio')).not.toBeNull();
    expect(screen.getTextContent()).toContain('common.unknown');
    expect(screen.getTextContent()).not.toContain('machines.widgets.body.fleet.offlineGroup');
    await act(async () => captureMachinePresenceObservation(scope)(machines.map(machine => machine.id)));
    expect(screen.getTextContent()).not.toContain('common.unknown');
    await screen.unmount();
  });

  it('ends a failed cold read with recovery and retains machines when a refresh fails', async () => {
    const home = getActiveServerSnapshot().serverId;
    storage.setState({
      machines: {},
      machineListByServerId: {},
      machineListStatusByServerId: { [home]: 'loading' },
    });
    const screen = await renderScreen(
      <WidgetPresentationProvider
        value={{
          size: 'wide',
          footprint: getWidgetSizeFootprintV1('home', 'wide')!,
        }}
      >
        <MachineFleetWidget input={{}} serverId={home} testID="fleet" />
      </WidgetPresentationProvider>,
    );
    expect(screen.findByTestId('fleet.loading')).not.toBeNull();
    await act(async () => {
      storage.getState().markMachineListUnavailable(home);
    });
    expect(screen.findByTestId('fleet.loading')).toBeNull();
    expect(screen.findByTestId('fleet.error')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain(
      'machines.widgets.body.fleet.noMachines',
    );
    await act(async () => {
      storage
        .getState()
        .applyMachines(
          [
            createMachineFixture({ id: 'edge' }),
            createMachineFixture({ id: 'studio' }),
          ],
          true,
          { sourceServerId: home },
        );
      storage.getState().markMachineListUnavailable(home);
    });
    expect(screen.findByTestId('fleet.error')).toBeNull();
    expect(screen.findByTestId('fleet.freshness')).not.toBeNull();
    expect(screen.getTextContent()).not.toContain(
      'machines.widgets.body.fleet.noMachines',
    );
  });

  it('says it is still reading the Home\'s machines, never "no machines", until the machine list has arrived', async () => {
    const home = getActiveServerSnapshot().serverId;
    storage.setState({
      machines: {},
      machineListByServerId: {},
      machineListStatusByServerId: { [home]: 'loading' },
    });
    const screen = await renderScreen(
      <WidgetPresentationProvider
        value={{
          size: 'wide',
          footprint: getWidgetSizeFootprintV1('home', 'wide')!,
        }}
      >
        <MachineFleetWidget input={{}} serverId={home} testID="fleet" />
      </WidgetPresentationProvider>,
    );
    expect(screen.getTextContent()).not.toContain(
      'machines.widgets.body.fleet.firstRun.title',
    );
    await act(async () => {
      storage.setState({
        machineListByServerId: { [home]: [] },
        machineListStatusByServerId: { [home]: 'idle' },
      });
    });
    // Once the list has really arrived empty, the empty state (the ways to add one) is the truth.
    expect(screen.getTextContent()).toContain(
      'machines.widgets.body.fleet.firstRun.title',
    );
  });

  it('opens a needs-you block in its row and folds it back in place when the machine recovers (lab FL, MO)', async () => {
    const home = getActiveServerSnapshot().serverId;
    const memory = {
      key: 'memory',
      level: 'needs_you',
      since: Date.now() - 60_000,
      metric: 'memory',
      nextStep: 'review_processes',
      kind: 'memory_pressure',
      pressure: 'critical',
      swapping: true,
    };
    // Fixture metadata carries only the name the rows show (`as never`: the boundary record's other fields are irrelevant here).
    const fleet = (edgeCalm: boolean) => [
      createMachineFixture({
        id: 'zz-edge',
        active: true,
        activeAt: Date.now(),
        metadata: { host: 'zz-edge' } as never,
        daemonState: {
          resources: {
            ...resources,
            attention: edgeCalm
              ? { level: 'calm', reasons: [] }
              : { level: 'needs_you', reasons: [memory] },
          },
        },
      }),
      createMachineFixture({
        id: 'nl2',
        active: true,
        activeAt: Date.now(),
        metadata: { host: 'nl2' } as never,
        daemonState: { resources },
      }),
    ];
    storage.setState({
      machines: Object.fromEntries(
        fleet(false).map((machine) => [machine.id, machine]),
      ),
      machineListByServerId: { [home]: fleet(false) },
      machineListStatusByServerId: { [home]: 'idle' },
    });
    boundary.rpc.mockResolvedValue({
      state: 'reporting',
      sample: null,
      series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
    });
    const screen = await renderScreen(
      <WidgetPresentationProvider
        value={{
          size: 'medium',
          footprint: getWidgetSizeFootprintV1('home', 'medium')!,
        }}
      >
        <MachineFleetWidget input={{}} serverId={home} testID="fleet" />
      </WidgetPresentationProvider>,
    );
    expect(screen.findByTestId('fleet.machine.zz-edge.need')).toBeTruthy();
    expect(screen.findByTestId('fleet.machine.nl2.need')).toBeNull();
    // Needing the person puts zz-edge first; by name alone it would sort after nl2.
    const rowsBefore =
      screen.getTextContent().indexOf('zz-edge') <
      screen.getTextContent().indexOf('nl2');
    expect(rowsBefore).toBe(true);
    await act(async () => {
      storage.setState({
        machines: Object.fromEntries(
          fleet(true).map((machine) => [machine.id, machine]),
        ),
        machineListByServerId: { [home]: fleet(true) },
      });
    });
    await act(async () => {
      for (let turn = 0; turn < 8; turn++) await Promise.resolve();
    });
    // The block folds; the row stays where it was (worst-first order is held while the person looks).
    expect(screen.findByTestId('fleet.machine.zz-edge.need')).toBeNull();
    expect(screen.findByTestId('fleet.machine.zz-edge')).toBeTruthy();
    expect(
      screen.getTextContent().indexOf('zz-edge') <
        screen.getTextContent().indexOf('nl2'),
    ).toBe(rowsBefore);
  });

  it('keeps online machines first with this computer leading, offline last, so calm rows never reorder by state', () => {
    const entry = (id: string, online: boolean, thisComputer = false) => ({
      key: id,
      serverId: HOME,
      machine: createMachineFixture({ id }),
      name: id,
      online,
      thisComputer,
    });
    expect(
      orderFleetMachines([
        entry('studio', false),
        entry('nl2', true),
        entry('leeroy-mbp', true, true),
        entry('edge-1', true),
      ]).map((row) => row.name),
    ).toEqual(['leeroy-mbp', 'edge-1', 'nl2', 'studio']);
  });

  it('defaults to the device Machine summary setting and keeps the widget’s own choice when set (R8)', () => {
    const device = {
      style: 'sparklines' as const,
      metrics: ['cpu', 'memory', 'disk'] as const,
    };
    expect(resolveFleetPresentation({}, device)).toEqual(device);
    expect(
      resolveFleetPresentation(
        { style: 'rings', metrics: ['disk', 'cpu', 'bogus'] },
        device,
      ),
    ).toEqual({ style: 'rings', metrics: ['cpu', 'disk'] });
  });
});

describe('Metric widget configuration', () => {
  it('gives the chart the room at Wide and Medium and keeps per-core and the minute maximum for the sizes that have space', async () => {
    const sampledAt = Date.now();
    seed(createMachineFixture({ id: 'm1', activeAt: sampledAt, daemonState: { resources } }));
    const points = Array.from({ length: 6 }, (_, index) => ({ t: sampledAt - (6 - index) * 60_000, cpuPct: 10 + index, cpuPctMax: 30 + index }));
    boundary.rpc.mockImplementation(async ({ method }) => {
      if (method === 'daemon.vitals.watch') return new Promise(() => {});
      if (method === 'machines.vitals.history.get')
        return { range: '1h', bucketMs: 60000, points, today: { rxBytes: 0, txBytes: 0 } };
      return { state: 'reporting', sample: sample(sampledAt), series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
        attention: { level: 'calm', reasons: [] } };
    });
    const draw = (size: WidgetSizeV1) => (
      <MetaHost>
        <WidgetPresentationProvider value={{ size, footprint: getWidgetSizeFootprintV1('home', size)! }}>
          <MachineMetricWidget input={{ machine: { serverId: HOME, machineId: 'm1' }, metric: 'cpu' }} serverId={HOME} testID="metric" />
        </WidgetPresentationProvider>
      </MetaHost>
    );
    const charts = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
      screen.root.findAll((node) => node.props.testID === 'machine-vitals-cpu-chart' && Array.isArray(node.props.series));
    const screen = await renderScreen(draw('tall'));
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-vitals-per-core-toggle')).not.toBeNull()); });
    for (const size of ['wide', 'medium'] as const) {
      await screen.update(draw(size));
      await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-vitals-cpu')).not.toBeNull()); });
      expect(screen.findByTestId('machine-vitals-per-core-toggle')).toBeNull();
    }
    await screen.update(draw('large'));
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-vitals-per-core-toggle')).not.toBeNull()); });
    expect(charts(screen).length).toBeGreaterThan(0);
  });

  it('names its frame by the metric it shows, with that metric\'s mark, and draws no second label (lab rw M)', async () => {
    const sampledAt = Date.now();
    seed(createMachineFixture({ id: 'm1', activeAt: sampledAt, daemonState: { resources } }));
    boundary.rpc.mockImplementation(async ({ method }) => {
      if (method === 'daemon.vitals.watch') return new Promise(() => {});
      return { state: 'reporting', sample: sample(sampledAt), series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
        attention: { level: 'calm', reasons: [] } };
    });
    const lent: ({ title: string; mark: string } | null)[] = [];
    const draw = (metric: string) => (
      <WidgetFrameBodyIdentityContext.Provider value={(identity) => { lent.push(identity); }}>
        <MetaHost>
          <WidgetPresentationProvider value={{ size: 'medium', footprint: getWidgetSizeFootprintV1('home', 'medium')! }}>
            <MachineMetricWidget input={{ machine: { serverId: HOME, machineId: 'm1' }, metric }} serverId={HOME} testID="metric" />
          </WidgetPresentationProvider>
        </MetaHost>
      </WidgetFrameBodyIdentityContext.Provider>
    );
    const screen = await renderScreen(draw('cpu'));
    await act(async () => { await vi.waitFor(() => expect(screen.findByTestId('machine-vitals-cpu')).not.toBeNull()); });
    expect(lent.at(-1)).toEqual({ title: 'machines.widgets.inputs.cpu', mark: 'cpu' });
    // The frame says "CPU"; the tile under it does not say it again.
    expect(screen.root.findAll((node) => Array.isArray(node.children) && node.children.includes('machineVitals.cpu.title'))).toHaveLength(0);
    await screen.update(draw('disk_free'));
    expect(lent.at(-1)).toEqual({ title: 'machines.widgets.inputs.diskFree', mark: 'hard-drives' });
    await screen.unmount();
  });

  it('keeps a selected disk and custom warning across Small and Medium, and never substitutes another disk when it disappears', async () => {
    const sampledAt = Date.now();
    seed(
      createMachineFixture({
        id: 'm1',
        activeAt: sampledAt,
        daemonState: { resources },
      }),
    );
    const root = {
      id: 'root',
      label: 'Root',
      mount: '/',
      totalBytes: 100e9,
      availableBytes: 80e9,
    };
    const data = {
      id: 'data',
      label: 'Data',
      mount: '/data',
      totalBytes: 100e9,
      availableBytes: 20e9,
    };
    let volumes = [root, data];
    boundary.rpc.mockImplementation(async ({ method }) => {
      if (method === 'daemon.vitals.watch') return new Promise(() => {});
      if (method === 'machines.vitals.history.get')
        return {
          range: '1h',
          bucketMs: 60000,
          points: [],
          today: { rxBytes: 0, txBytes: 0 },
        };
      return {
        state: 'reporting',
        sample: {
          ...sample(sampledAt),
          disk: { reported: true, homeVolumeId: 'root', volumes },
        },
        series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
        attention: { level: 'calm', reasons: [] },
      };
    });
    const draw = (size: WidgetSizeV1, warnAbove: number) => (
      <MetaHost>
        <WidgetPresentationProvider
          value={{ size, footprint: getWidgetSizeFootprintV1('home', size)! }}
        >
          <MachineMetricWidget
            input={{
              machine: { serverId: HOME, machineId: 'm1' },
              metric: 'disk_free',
              volume: 'data',
              warnAbove,
            }}
            serverId={HOME}
            testID="metric"
          />
        </WidgetPresentationProvider>
      </MetaHost>
    );
    const screen = await renderScreen(draw('small', 75));
    const diskSummary = () =>
      screen.root.findAll(
        (node) => node.type === Reflect.get(MachineSummaryStrip, 'type'),
      )[0]?.props.availability?.summary?.disk;
    await act(async () => {
      await vi.waitFor(() =>
        expect(diskSummary()).toMatchObject({
          volumeId: 'data',
          availableBytes: 20e9,
          tone: 'warn',
        }),
      );
    });
    expect(screen.getTextContent()).toContain('20 GB');
    await screen.update(draw('medium', 75));
    await act(async () => {
      await vi.waitFor(() =>
        expect(
          screen.root.findAll(
            (node) => node.type === Reflect.get(DiskTile, 'type'),
          )[0]?.props.sample.disk.volumes,
        ).toEqual([data]),
      );
    });
    expect(screen.getTextContent()).toContain('20');
    await screen.update(draw('small', 85));
    await act(async () => {
      await vi.waitFor(() =>
        expect(diskSummary()).toMatchObject({
          volumeId: 'data',
          availableBytes: 20e9,
          tone: 'calm',
        }),
      );
    });
    volumes = [root];
    await act(async () =>
      machineResourceStore.retry({
        serverId: HOME,
        expectedAccountId: 'owner',
        machineId: 'm1',
        view: 'summary',
      }),
    );
    await act(async () => {
      await vi.waitFor(() =>
        expect(diskSummary()).toMatchObject({
          volumeId: null,
          availableBytes: null,
        }),
      );
    });
    expect(screen.getTextContent()).not.toContain('80 GB');
    await screen.unmount();
  });
  it('reads the descriptor defaults (CPU, last hour) and the widget’s own choices', () => {
    expect(
      readMachineMetricWidgetConfig({
        machine: { serverId: HOME, machineId: 'm1' },
      }),
    ).toEqual({ metric: 'cpu', range: '1h', volume: null, warnAbove: null });
    expect(
      readMachineMetricWidgetConfig({
        metric: 'disk_free',
        range: '7d',
        volume: 'data',
        warnAbove: 85,
      }),
    ).toEqual({
      metric: 'disk_free',
      range: '7d',
      volume: 'data',
      warnAbove: 85,
    });
  });

  it('narrows the Overview’s disk tile to the chosen volume, and keeps an absent selection unmeasured', () => {
    const volume = (id: string) => ({
      id,
      label: id,
      mount: `/${id}`,
      totalBytes: 10,
      availableBytes: 5,
    });
    const base = {
      ...sample(1),
      disk: { reported: true, volumes: [volume('root'), volume('data')] },
    } as unknown as Parameters<typeof narrowToVolume>[0]; // A boundary-shaped sample; only the disk volumes matter here.
    expect(narrowToVolume(base, 'data').disk).toMatchObject({
      volumes: [{ id: 'data' }],
    });
    expect(narrowToVolume(base, 'missing').disk).toMatchObject({ volumes: [] });
  });
});
