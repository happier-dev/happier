import * as React from 'react';
import { act } from 'react-test-renderer';
import { StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { parseNvidiaVitalsGpu } from '../../../../../cli/src/daemon/vitals/readers/extras/gpu';
import { parseDarwinThermal } from '../../../../../cli/src/daemon/vitals/readers/darwinParsers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { formatAsOfTime } from '@/utils/time/formatAsOfTime';

vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@/text', async () => {
  const { english } =
    await import('@/text/translations/machineDetailPageTranslations.shared');
  const limits: Record<string, unknown> = english.machineVitals.more.limits;
  return (await import('@/dev/testkit/mocks/text')).createTextModuleMock({
    translate: (key: string, values?: Record<string, unknown>) => {
      if (key === 'machineVitals.more.gpu.memory')
        return `${values?.used} / ${values?.total}`;
      if (!key.startsWith('machineVitals.more.limits.')) return key;
      const translation =
        limits[key.slice('machineVitals.more.limits.'.length)];
      return typeof translation === 'function'
        ? translation(values)
        : typeof translation === 'string'
          ? translation
          : key;
    },
  });
});

const { CpuTile } = await import('./CpuTile');
const { NetworkTile } = await import('./NetworkTile');
const { VitalsSheet } = await import('./VitalsSheet');
const { MachineMoreFrom, buildMachineMoreFromFacts } =
  await import('./MachineMoreFrom');
const { DiskTile } = await import('./DiskTile');
const { MemoryTile } = await import('./MemoryTile');
const { VitalsHistoryChart } = await import('./VitalsHistoryChart');
const { VitalsMeterRow } = await import('./VitalsMeterRow');
const { MachinePressureIndicator } = await import('@/components/machines/summary/MachinePressureIndicator');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { ScrubLens } =
  await import('@/components/settings/usage/UsageScrubLens');
const { buildMachineVitalsTimeline } =
  await import('./machineVitalsPresentation');

afterEach(() => {
  standardCleanup();
});

const GB = 1e9;
const sample = (sampledAt: number): MachineVitalsSampleV1 =>
  ({
    v: 1,
    sampledAt,
    intervalMs: 15_000,
    cpu: { reported: true, busyPct: 40 },
    memory: {
      reported: true,
      totalBytes: 100 * GB,
      availableBytes: 30 * GB,
      usedBytes: 70 * GB,
      pressure: { level: 'calm', source: 'psi' },
    },
    disk: {
      reported: true,
      volumes: [
        {
          id: 'data',
          label: '/data',
          mount: '/data',
          totalBytes: 100 * GB,
          availableBytes: 10 * GB,
        },
      ],
    },
    network: { reported: true, rxBps: 12, txBps: 3 },
  }) as MachineVitalsSampleV1;

describe('a Metric widget’s “Warn above” on the Overview tiles (plan 60 rw SE)', () => {
  const now = Date.now();
  const timeline = buildMachineVitalsTimeline({
    range: '1h',
    history: null,
    samples: [sample(now - 60_000), sample(now)],
  });
  const chart = {
    timeline,
    axis: ['1 h ago', 'now'] as const,
    freshness: 'live' as const,
    live: true,
  };

  it('draws the CPU line’s threshold at that percent', async () => {
    const screen = await renderScreen(
      <CpuTile sample={sample(now)} host={null} {...chart} warnAbovePct={85} />,
    );
    expect(screen.findByType(VitalsHistoryChart).props.threshold).toMatchObject(
      { value: 85, tone: 'warning' },
    );
  });

  it('draws memory’s threshold in the chart’s own unit (bytes in use on the zoomed scale)', async () => {
    const screen = await renderScreen(
      <MemoryTile
        sample={sample(now)}
        attention={null}
        {...chart}
        nowMs={now}
        warnAbovePct={80}
      />,
    );
    expect(screen.findByType(VitalsHistoryChart).props.threshold).toMatchObject(
      { value: 80 * GB, tone: 'warning' },
    );
  });

  it('tones a volume used past the value, and leaves one below it calm', async () => {
    const above = await renderScreen(
      <DiskTile sample={sample(now)} attention={null} warnAbovePct={85} />,
    );
    expect(above.findByType(VitalsMeterRow).props.tone).toBe('warn');
    standardCleanup();
    const below = await renderScreen(
      <DiskTile sample={sample(now)} attention={null} warnAbovePct={95} />,
    );
    expect(below.findByType(VitalsMeterRow).props.tone).toBe('calm');
  });

  it('draws nothing extra when the widget follows the machine’s own alert', async () => {
    const screen = await renderScreen(
      <CpuTile sample={sample(now)} host={null} {...chart} />,
    );
    expect(
      screen.findByType(VitalsHistoryChart).props.threshold,
    ).toBeUndefined();
  });
});

describe('retained vitals readings', () => {
  it.each(['cpu', 'memory'] as const)('publishes zero unchanged %s chart inputs with a custom warning for ten live readings', async metric => {
    const at = Date.now();
    const timeline = buildMachineVitalsTimeline({ range: '1h', history: null, samples: [sample(at - 2_000), sample(at)] });
    const axis = ['then', 'now'] as const;
    let update = (_value: MachineVitalsSampleV1) => { throw new Error('Metric tile not mounted'); };
    let updateWarning = (_value: number) => { throw new Error('Metric tile not mounted'); };
    function Reading() {
      const [value, setValue] = React.useState(sample(at));
      const [warning, setWarning] = React.useState(70);
      update = setValue;
      updateWarning = setWarning;
      return metric === 'cpu'
        ? <CpuTile sample={value} host={null} timeline={timeline} axis={axis} freshness="live" live={false} warnAbovePct={warning} />
        : <MemoryTile sample={value} attention={null} timeline={timeline} axis={axis} freshness="live" live={false} nowMs={at} warnAbovePct={warning} />;
    }
    const screen = await renderScreen(<Reading />);
    let publications = 0;
    for (let arrival = 1; arrival <= 10; arrival++) {
      const previous = screen.findByType(VitalsHistoryChart).props;
      act(() => update(sample(at + arrival * 2_000)));
      const current = screen.findByType(VitalsHistoryChart).props;
      if (Object.keys(current).some(key => current[key] !== previous[key])) publications++;
    }
    expect(publications).toBe(0);
    act(() => updateWarning(80));
    expect(screen.findByType(VitalsHistoryChart).props.threshold.value).toBe(metric === 'cpu' ? 80 : 80 * GB);
  });

  it('publishes zero unchanged network chart inputs for ten live readings', async () => {
    const at = Date.now();
    const timeline = buildMachineVitalsTimeline({ range: '1h', history: null, samples: [sample(at - 2_000), sample(at)] });
    const axis = ['then', 'now'] as const;
    let update = (_value: MachineVitalsSampleV1) => { throw new Error('Network tile not mounted'); };
    function Reading() {
      const [value, setValue] = React.useState(sample(at));
      update = setValue;
      return <NetworkTile sample={value} today={null} timeline={timeline} axis={axis} freshness="live" live={false} />;
    }
    const screen = await renderScreen(<Reading />);
    let publications = 0;
    for (let arrival = 1; arrival <= 10; arrival++) {
      const previous = screen.findByType(VitalsHistoryChart).props;
      const next = sample(at + arrival * 2_000);
      act(() => update({ ...next, network: { reported: true, rxBps: 12 + arrival, txBps: 3 + arrival } }));
      const current = screen.findByType(VitalsHistoryChart).props;
      if (Object.keys(current).some(key => current[key] !== previous[key])) publications++;
    }
    expect(publications).toBe(0);
    // The mirrored upload formatter still says its magnitude, never a negative transfer rate.
    const format = screen.findByType(VitalsHistoryChart).props.format;
    expect(format(-1200)).toBe(format(1200));
  });

  it('rebuilds zero historical memory series for ten live readings with unchanged chart inputs', async () => {
    const at = Date.now();
    const timeline = buildMachineVitalsTimeline({ range: '24h', samples: [], history: {
      range: '24h', bucketMs: 300_000, today: { rxBytes: 0, txBytes: 0 },
      points: Array.from({ length: 288 }, (_, index) => ({ t: at - (288 - index) * 300_000,
        cpu: 10, cpuMax: 20, mem: 60 * GB, memMax: 65 * GB, lvl: 'calm', swp: null, rx: null, tx: null })),
    } });
    const axis = ['then', 'now'] as const;
    let update = (_value: MachineVitalsSampleV1) => { throw new Error('Memory tile not mounted'); };
    function Reading() {
      const [value, setValue] = React.useState(sample(at));
      update = setValue;
      return <MemoryTile sample={value} attention={null} timeline={timeline} axis={axis} freshness="live" live={false} nowMs={at} />;
    }
    const screen = await renderScreen(<Reading />);
    let publications = 0;
    for (let arrival = 1; arrival <= 10; arrival++) {
      const previous = screen.findByType(VitalsHistoryChart).props.series;
      const next = sample(at + arrival * 2_000);
      if (!next.memory.reported) throw new Error('Fixture memory must be reported');
      act(() => update({ ...next, memory: { ...next.memory, availableBytes: next.memory.availableBytes + arrival, usedBytes: next.memory.usedBytes - arrival } }));
      if (screen.findByType(VitalsHistoryChart).props.series !== previous) publications++;
    }
    expect(publications).toBe(0);
    const previous = screen.findByType(VitalsHistoryChart).props.series;
    const next = sample(at);
    if (!next.memory.reported) throw new Error('Fixture memory must be reported');
    act(() => update({ ...next, memory: { ...next.memory, totalBytes: next.memory.totalBytes * 2 } }));
    expect(screen.findByType(VitalsHistoryChart).props.series).not.toBe(previous);
  });

  it('stops live chart motion when its retained Overview is hidden', async () => {
    const at = Date.now();
    const timeline = buildMachineVitalsTimeline({ range: '1h', history: null, samples: [sample(at - 2_000), sample(at)] });
    let setActive: React.Dispatch<React.SetStateAction<boolean>> = () => { throw new Error('Presentation not mounted'); };
    function PresentedOverview() {
      const [active, update] = React.useState(true);
      setActive = update;
      return <PluginSurfaceFocusEligibilityProvider active={active}>
        <CpuTile sample={sample(at)} host={null} timeline={timeline} axis={['then', 'now']} freshness="live" live />
      </PluginSurfaceFocusEligibilityProvider>;
    }
    const screen = await renderScreen(<PresentedOverview />);
    act(() => screen.findByTestId('machine-vitals-cpu-chart')!.props.onLayout({ nativeEvent: { layout: { width: 400 } } }));
    const chart = screen.findByType(StackedSeriesChart);
    expect(chart.props.liveMotion.active).toBe(true);
    act(() => setActive(false));
    expect(screen.findByType(StackedSeriesChart)).toBe(chart);
    expect(chart.props.liveMotion.active).toBe(false);
    act(() => setActive(true));
    expect(chart.props.liveMotion.active).toBe(true);
  });
  it('retains the measured chart through a hidden zero-width layout and measures a real resize on reveal', async () => {
    const at = Date.now();
    const timeline = buildMachineVitalsTimeline({ range: '1h', history: null, samples: [sample(at - 2_000), sample(at)] });
    const screen = await renderScreen(<CpuTile sample={sample(at)} host={null} timeline={timeline}
      axis={['then', 'now']} freshness="live" live />);
    const layout = (width: number) => act(() => screen.findByTestId('machine-vitals-cpu-chart')!.props.onLayout({
      nativeEvent: { layout: { width, height: 64, x: 0, y: 0 } },
    }));
    layout(400);
    const chart = screen.findByType(StackedSeriesChart);
    expect(chart.props.width).toBe(400);
    layout(0);
    expect(screen.findByType(StackedSeriesChart)).toBe(chart);
    expect(chart.props.width).toBe(400);
    layout(280);
    expect(screen.findByType(StackedSeriesChart)).toBe(chart);
    expect(chart.props.width).toBe(280);
  });
  it('keeps a retained narrow sheet in its measured composition while hidden', async () => {
    const at = Date.now();
    const timeline = buildMachineVitalsTimeline({ range: '1h', history: null, samples: [sample(at - 2_000), sample(at)] });
    const screen = await renderScreen(<VitalsSheet testID="retained-sheet">{[
      <CpuTile key="cpu" sample={sample(at)} host={null} timeline={timeline} axis={['then', 'now']} freshness="live" live />,
      <NetworkTile key="network" sample={sample(at)} timeline={timeline} axis={['then', 'now']} freshness="live" live />,
    ]}</VitalsSheet>);
    const layout = (width: number) => act(() => screen.findByTestId('retained-sheet')!.props.onLayout({
      nativeEvent: { layout: { width, height: 200, x: 0, y: 0 } },
    }));
    layout(400);
    const network = screen.findByType(NetworkTile);
    layout(0);
    expect(screen.findByType(NetworkTile) === network).toBe(true);
    layout(400);
    expect(screen.findByType(NetworkTile) === network).toBe(true);
  });
  it('shows the history mean and maximum as separate lens facts on CPU and both memory scales', async () => {
    const timeline = buildMachineVitalsTimeline({
      range: '24h',
      samples: [],
      history: {
        range: '24h',
        bucketMs: 300_000,
        points: [
          {
            t: 300_000,
            cpu: 10,
            cpuMax: 95,
            mem: 20 * GB,
            memMax: 90 * GB,
            lvl: 'calm',
            swp: null,
            rx: null,
            tx: null,
          },
        ],
        today: { rxBytes: 0, txBytes: 0 },
      },
    });
    const chart = {
      timeline,
      axis: ['then', 'now'] as const,
      freshness: 'live' as const,
      live: false,
    };
    const pressure = {
      level: 'needs_you' as const,
      reasons: [
        {
          key: 'memory',
          kind: 'memory_pressure' as const,
          level: 'needs_you' as const,
          since: 1,
          metric: 'memory' as const,
          pressure: 'critical' as const,
          swapping: false,
        },
      ],
    };
    for (const element of [
      <CpuTile sample={sample(300_000)} host={null} {...chart} />,
      <MemoryTile
        sample={sample(300_000)}
        attention={null}
        nowMs={300_000}
        {...chart}
      />,
      <MemoryTile
        sample={sample(300_000)}
        attention={pressure}
        nowMs={300_000}
        {...chart}
      />,
    ]) {
      const screen = await renderScreen(element);
      const history = screen.findByType(VitalsHistoryChart);
      await act(async () => {
        screen
          .findByTestId(history.props.testID)!
          .props.onLayout({ nativeEvent: { layout: { width: 300 } } });
      });
      const plot = screen.findByType(StackedSeriesChart);
      const peak = plot.props.series[1].points.at(-1)!.y;
      expect(plot.props.domain.max).toBeGreaterThanOrEqual(peak);
      // The maximum is a quiet solid line named by a key, never a stray dotted one.
      expect(plot.props.showLegend).toBe(true);
      expect(plot.props.series[1].lineStyle).toBeUndefined();
      const lens = screen.findByType(ScrubLens);
      const readout = lens.props.resolveContent(
        lens.props.layout.centers.length - 1,
      );
      expect(readout.rows).toMatchObject([
        { label: 'machineVitals.history.mean' },
        { label: 'machineVitals.history.maximum' },
      ]);
      expect(readout.rows[0].value).not.toBe(readout.rows[1].value);
      expect(readout.total).toBeUndefined();
      standardCleanup();
    }
  });
  it('reads every history point by its time of day, on the lens and in accessible names, never as an epoch number', async () => {
    const at = new Date(2026, 9, 18, 10, 42).getTime();
    const live = buildMachineVitalsTimeline({
      range: '1h',
      history: null,
      samples: [sample(at - 60_000), sample(at)],
    });
    const chart = {
      timeline: live,
      axis: ['then', 'now'] as const,
      freshness: 'live' as const,
      live: true,
    };
    for (const element of [
      <CpuTile sample={sample(at)} host={null} {...chart} />,
      <MemoryTile sample={sample(at)} attention={null} nowMs={at} {...chart} />,
      <NetworkTile sample={sample(at)} today={null} {...chart} />,
    ]) {
      const screen = await renderScreen(element);
      const history = screen.findByType(VitalsHistoryChart);
      await act(async () => {
        screen
          .findByTestId(history.props.testID)!
          .props.onLayout({ nativeEvent: { layout: { width: 300 } } });
      });
      const lens = screen.findByType(ScrubLens);
      const last = lens.props.layout.centers.length - 1;
      expect(lens.props.resolveContent(last).title).toBe(formatAsOfTime(at));
      expect(lens.props.resolveContent(last - 1).title).toBe(
        formatAsOfTime(at - 60_000),
      );
      // Every accessible name that carries a point's time says it once, as the time of day.
      const named = screen.root.findAll(
        (node) => typeof node.props.accessibilityLabel === 'string'
          && node.props.accessibilityLabel.includes(formatAsOfTime(at)),
      );
      expect(named.length).toBeGreaterThan(0);
      for (const node of named) {
        expect(node.props.accessibilityLabel).toContain(`${formatAsOfTime(at)}: `);
        expect(node.props.accessibilityLabel).not.toContain(`${formatAsOfTime(at)} · `);
      }
      standardCleanup();
    }
  });
  it('preserves unknown GPU memory, observed zero and throttle-only facts', () => {
    const unknown = buildMachineMoreFromFacts({
      gpu: parseNvidiaVitalsGpu('GPU, 42, N/A, 8192'),
    });
    const zero = buildMachineMoreFromFacts({
      gpu: parseNvidiaVitalsGpu('GPU, 42, 0, 8192'),
    });
    expect(unknown[0]?.detail).toContain('machineVitals.unmeasured / 8 GiB');
    expect(unknown[0]?.detail).not.toContain('0 B');
    expect(zero[0]?.detail).toContain('0 B / 8 GiB');
    expect(
      buildMachineMoreFromFacts({
        gpu: parseNvidiaVitalsGpu('GPU, 42, 0, N/A'),
      })[0]?.detail,
    ).toBe('GPU');
  });
  it('renders positively observed throttle-only facts while omitting an unreported state', () => {
    expect(
      buildMachineMoreFromFacts({
        thermal: parseDarwinThermal('CPU_Speed_Limit = 80'),
      }),
    ).toMatchObject([
      { key: 'thermal', value: 'machineVitals.more.thermal.throttled' },
    ]);
    expect(
      buildMachineMoreFromFacts({ thermal: { throttled: false } }),
    ).toEqual([]);
  });
  it('keeps the last measured CPU and network figures visibly dated across a counter reset', async () => {
    const at = Date.now();
    const reset = {
      ...sample(at),
      cpu: { reported: true as const, busyPct: null },
      network: { reported: true as const, rxBps: null, txBps: null },
    };
    const timeline = buildMachineVitalsTimeline({
      range: '1h',
      history: null,
      samples: [sample(at - 2_000), reset],
    });
    const chart = {
      timeline,
      axis: ['then', 'now'] as const,
      freshness: 'live' as const,
      live: true,
    };
    const cpu = await renderScreen(
      <CpuTile sample={reset} host={null} {...chart} />,
    );
    const cpuTree = cpu.getTextContent();
    expect.soft(cpuTree).toContain('40');
    expect.soft(cpuTree).toContain('machineVitals.asOf');
    standardCleanup();
    const network = await renderScreen(
      <NetworkTile sample={reset} today={null} {...chart} />,
    );
    const networkTree = network.getTextContent();
    expect(networkTree).toContain('12');
    expect(networkTree).toContain('machineVitals.asOf');
  });

  it('leaves the freshness statement to the tab-row chip when the whole answer is stale', async () => {
    const at = Date.now();
    const reset = {
      ...sample(at),
      cpu: { reported: true as const, busyPct: null },
      network: { reported: true as const, rxBps: null, txBps: null },
    };
    const timeline = buildMachineVitalsTimeline({
      range: '1h',
      history: null,
      samples: [sample(at - 2_000), reset],
    });
    const chart = {
      timeline,
      axis: ['then', 'now'] as const,
      freshness: 'stale' as const,
      live: true,
    };
    const cpu = await renderScreen(
      <CpuTile sample={reset} host={null} {...chart} />,
    );
    expect(cpu.getTextContent()).toContain('40');
    expect(cpu.getTextContent()).not.toContain('machineVitals.asOf');
    standardCleanup();
    const network = await renderScreen(
      <NetworkTile sample={reset} today={null} {...chart} />,
    );
    expect(network.getTextContent()).toContain('12');
    expect(network.getTextContent()).not.toContain('machineVitals.asOf');
  });

  it('names known CPU sensors in user copy and omits unknown raw sensor ids', () => {
    for (const sensor of ['Package id 0', 'Tctl', 'Tdie']) {
      expect(
        buildMachineMoreFromFacts({ thermal: { tempC: 70, sensor } })[0]
          ?.detail,
      ).toBe('machineVitals.cpu.title');
    }
    expect(
      buildMachineMoreFromFacts({
        thermal: { tempC: 70, sensor: 'hwmon29_temp2' },
      })[0]?.detail,
    ).toBeNull();
  });

  it.each([2 ** 63 - 1, 2 ** 64 - 1])(
    'renders an unlimited maximum without a finite ratio (%s)',
    async (max) => {
      const screen = await renderScreen(
        <MachineMoreFrom
          machineName="laptop"
          attention={null}
          extras={{
            limits: {
              files: { used: 46688, max },
              ptys: { used: 5, max: 4096 },
            },
          }}
        />,
      );
      const tree = screen.getTextContent();
      expect(tree).toContain('Open files 46,688 · no limit');
      expect(tree).toContain('Terminals 5 of 4,096');
      expect(
        screen.findByTestId('machine-vitals-limits')?.props.accessibilityLabel,
      ).toBe('Open files 46,688 · no limit, Terminals 5 of 4,096');
    },
  );
});

describe('held vitals of a machine that is not running', () => {
  const now = Date.now();
  const timeline = buildMachineVitalsTimeline({ range: '1h', history: null, samples: [sample(now - 60_000), sample(now)] });
  const chart = { timeline, axis: ['1 h ago', 'now'] as const, freshness: 'offline' as const, live: false };
  const tiles = (held: boolean) => (
    <VitalsSheet held={held}>
      <MemoryTile sample={sample(now)} attention={null} {...chart} nowMs={now} />
      <NetworkTile sample={sample(now)} today={null} {...chart} />
    </VitalsSheet>
  );

  it('says no transfer rate and no memory pressure word, which only a running machine has', async () => {
    const live = await renderScreen(tiles(false));
    expect(live.getTextContent()).toContain('machineVitals.network.perSecondUnit');
    expect(live.findAllByType(MachinePressureIndicator)).not.toHaveLength(0);
    standardCleanup();
    const held = await renderScreen(tiles(true));
    expect(held.getTextContent()).not.toContain('machineVitals.network.perSecondUnit');
    expect(held.findAllByType(MachinePressureIndicator)).toHaveLength(0);
    // History stays: the hour it reported is still its own.
    expect(held.findAllByType(VitalsHistoryChart)).toHaveLength(2);
  });
});
