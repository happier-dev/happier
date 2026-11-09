import { describe, expect, it } from 'vitest';
import type { MachineVitalsHistoryV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import type { MachineVitalsSnapshotV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import type {
  MachinePublishedResourceSummaryV1,
  MachineResourceAttentionV1,
} from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import { downsampleMachineVitalsHistory } from '../../../../../cli/src/daemon/vitals/history/downsample';

import {
  buildMachineVitalsTimeline,
  formatMachinePartOfWhole,
  resolveMachineCoreCount,
  resolveMachineCpuCapacityCores,
  resolveMemoryZoom,
  resolveNetworkDomain,
  selectHeadlineVolume,
  selectMachineVitalsExtras,
  selectMachineVitalsOverviewView,
  selectMachineVitalsReading,
} from './machineVitalsPresentation';

const GIB = 1024 ** 3;
const host = { logicalCores: 18, memoryTotalBytes: 128 * GIB, bootedAt: 0 };
const calm: MachineResourceAttentionV1 = { level: 'calm', reasons: [] };
const reporting: MachinePublishedResourceSummaryV1 = {
  v: 1,
  attention: calm,
  vitals: { state: 'reporting' },
  host,
};

it('keeps CPU capacity exact for accounting while rounding the displayed core count', () => {
  const quotaHost = { ...host, effectiveCores: 1.26 };
  expect(resolveMachineCpuCapacityCores(quotaHost)).toBe(1.26);
  expect(resolveMachineCoreCount(quotaHost)).toBe(1.3);
  expect(resolveMachineCpuCapacityCores(host)).toBe(18);
  expect(resolveMachineCpuCapacityCores({ ...host, effectiveCores: 0 })).toBe(18);
  expect(resolveMachineCpuCapacityCores({ ...host, effectiveCores: 0.5 })).toBe(0.5);
});

function sample(
  at: number,
  extra: Partial<MachineVitalsSampleV1> = {},
): MachineVitalsSampleV1 {
  return {
    v: 1,
    sampledAt: at,
    intervalMs: 2_000,
    cpu: { reported: true, busyPct: 12 },
    memory: {
      reported: true,
      totalBytes: 128 * GIB,
      availableBytes: 71 * GIB,
      usedBytes: 57 * GIB,
      pressure: { level: 'calm', source: 'kernel_level' },
    },
    disk: { reported: true, volumes: [] },
    network: { reported: true, rxBps: 2_100_000, txBps: 340_000 },
    ...extra,
  };
}
const snapshot = (
  s: MachineVitalsSampleV1 | null,
  state: MachineVitalsSnapshotV1['state'] = 'reporting',
): MachineVitalsSnapshotV1 => ({
  state,
  sample: s,
  series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] },
});

describe('history maxima', () => {
  it.each(['1h', '24h', '7d'] as const)('uses measured traffic duration through the real daemon %s projection', (range) => {
    const start = Date.UTC(2026, 9, 10, 12);
    const bucketMs = range === '7d' ? 1_800_000 : range === '24h' ? 300_000 : 60_000;
    for (const offsets of [[1], [1, 3], Array.from({ length: bucketMs / 60_000 }, (_, i) => i + 1)]) {
      const records = offsets.map(offset => ({ t: start + offset * 60_000, cpu: null, cpuMax: null,
        mem: null, memMax: null, lvl: 'not_reported' as const, swp: null, rx: 60_000, tx: 120_000 }));
      const history = downsampleMachineVitalsHistory({ range, now: start + Math.max(...offsets) * 60_000, records });
      const timeline = buildMachineVitalsTimeline({ range, history, samples: [] });
      const measured = timeline?.points.filter(point => point.rxBps !== null);
      expect(measured?.length).toBeGreaterThan(0);
      expect(measured?.every(point => point.rxBps === 1000 && point.txBps === 2000)).toBe(true);
    }
  });

  it.each(['24h', '7d'] as const)('keeps bucket means, maxima and gaps for %s', (range) => {
    const timeline = buildMachineVitalsTimeline({ range, samples: [], history: { range, bucketMs: 300_000,
      points: [{ t: 300_000, cpu: 10, cpuMax: 95, mem: 20 * GIB, memMax: 100 * GIB, lvl: 'calm', swp: null, rx: null, tx: null },
        null, { t: 900_000, cpu: 0, cpuMax: 0, mem: 20 * GIB, memMax: 20 * GIB, lvl: 'calm', swp: null, rx: null, tx: null }],
      today: { rxBytes: 0, txBytes: 0 } } });
    expect(timeline?.points).toMatchObject([
      { cpu: 10, cpuMax: 95, usedBytes: 20 * GIB, usedBytesMax: 100 * GIB },
      { cpu: null, cpuMax: null, usedBytes: null, usedBytesMax: null },
      { cpu: 0, cpuMax: 0, usedBytes: 20 * GIB, usedBytesMax: 20 * GIB },
    ]);
  });
});

describe('the Overview state (lab rv OS 1–6)', () => {
  it('uses the same recovered reader availability as summaries while an older failure publication is held', () => {
    const failing: MachinePublishedResourceSummaryV1 = {
      v: 1, attention: calm, host,
      vitals: { state: 'unavailable', since: 42, reason: 'reader_failed' },
    };
    const recovered = sample(90);
    expect(selectMachineVitalsOverviewView({ online: true, published: failing,
      state: { status: 'ready', snapshot: snapshot(recovered), stale: false },
    })).toEqual({ kind: 'ready', sample: recovered, freshness: 'live' });
    // A failure after the held observation remains a genuine unavailable state.
    expect(selectMachineVitalsOverviewView({ online: true, published: failing,
      state: { status: 'ready', snapshot: snapshot(sample(1)), stale: false },
    })).toEqual({ kind: 'unavailable', since: 42, reason: 'reader_failed' });
  });
  it('says monitoring is Off instead of loading, zero or unavailable, and keeps what was read before as of its time', () => {
    const held = sample(1);
    // Nothing read yet: Off, never a skeleton waiting for a sample that will not come.
    expect(selectMachineVitalsOverviewView({ online: true, published: reporting, monitoring: 'off',
      state: { status: 'loading', snapshot: null, stale: false },
    })).toEqual({ kind: 'monitoring_off', sample: null });
    // Read before it was turned off: kept, and labelled as from before rather than live.
    expect(selectMachineVitalsOverviewView({ online: true, published: reporting, monitoring: 'off',
      state: { status: 'ready', snapshot: snapshot(held), stale: false },
    })).toEqual({ kind: 'monitoring_off', sample: held });
    // A daemon that reports a failing sampler while Off is still Off: nothing is being read.
    expect(selectMachineVitalsOverviewView({ online: true, monitoring: 'off',
      published: { v: 1, attention: calm, host, vitals: { state: 'unavailable', since: 42, reason: 'reader_failed' } },
      state: { status: 'error', snapshot: null, stale: false },
    })).toEqual({ kind: 'monitoring_off', sample: null });
    // Offline still says offline first; While viewing reads as usual.
    expect(selectMachineVitalsOverviewView({ online: false, published: reporting, monitoring: 'off',
      state: { status: 'ready', snapshot: snapshot(held), stale: false },
    })).toMatchObject({ kind: 'ready', freshness: 'offline' });
    expect(selectMachineVitalsOverviewView({ online: true, published: reporting, monitoring: 'while_viewing',
      state: { status: 'ready', snapshot: snapshot(held), stale: false },
    })).toMatchObject({ kind: 'ready', freshness: 'live' });
  });
  it('keeps the held sample stale while the first watch failure is slow', () => {
    const held = sample(1);
    expect(selectMachineVitalsOverviewView({ online: true, published: reporting,
      state: { status: 'slow', snapshot: snapshot(held), stale: false },
    })).toEqual({ kind: 'ready', sample: held, freshness: 'stale' });
  });
  it('retains a failed read and its code without inferring support from absent publication metadata', () => {
    expect(selectMachineVitalsOverviewView({ online: true, published: null,
      state: { status: 'error', snapshot: null, stale: false, errorCode: 'action_failed' },
    })).toEqual({ kind: 'unavailable', since: null, reason: 'request_failed', errorCode: 'action_failed' });
  });
  it('chooses each of the six states from presence, the published summary and the read', () => {
    const ready = (
      s: MachineVitalsSnapshotV1 | null,
      status: 'loading' | 'ready' | 'error' | 'not_reported' = 'ready',
      stale = false,
    ) => ({ status, snapshot: s, stale });
    // 1 Loading: a reporting machine whose first read has not answered.
    expect(
      selectMachineVitalsOverviewView({
        online: true,
        published: reporting,
        state: ready(null, 'loading'),
      }),
    ).toEqual({ kind: 'loading' });
    // Live, then 2 stale: the retained sample stays at full strength.
    expect(
      selectMachineVitalsOverviewView({
        online: true,
        published: reporting,
        state: ready(snapshot(sample(1))),
      }),
    ).toMatchObject({ kind: 'ready', freshness: 'live' });
    expect(
      selectMachineVitalsOverviewView({
        online: true,
        published: reporting,
        state: ready(snapshot(sample(1)), 'error'),
      }),
    ).toMatchObject({ kind: 'ready', freshness: 'stale' });
    expect(
      selectMachineVitalsOverviewView({
        online: true,
        published: reporting,
        state: ready(snapshot(sample(1)), 'ready', true),
      }),
    ).toMatchObject({ kind: 'ready', freshness: 'stale' });
    // 3 Offline: the last report, never zeros; nothing retained is its own quiet state.
    expect(
      selectMachineVitalsOverviewView({
        online: false,
        published: reporting,
        state: ready(snapshot(sample(1))),
      }),
    ).toMatchObject({ kind: 'ready', freshness: 'offline' });
    expect(
      selectMachineVitalsOverviewView({
        online: false,
        published: reporting,
        state: ready(null, 'loading'),
      }),
    ).toEqual({ kind: 'offline_empty' });
    // 5 Error: the daemon says its sampler stopped, even with an older sample retained.
    const failing: MachinePublishedResourceSummaryV1 = {
      v: 1,
      attention: calm,
      vitals: { state: 'unavailable', since: 42, reason: 'reader_failed' },
      host,
    };
    expect(
      selectMachineVitalsOverviewView({
        online: true,
        published: failing,
        state: ready(snapshot(sample(1))),
      }),
    ).toEqual({ kind: 'unavailable', since: 42, reason: 'reader_failed' });
    expect(
      selectMachineVitalsOverviewView({
        online: true,
        published: reporting,
        state: ready(null, 'error'),
      }),
    ).toEqual({ kind: 'unavailable', since: null, reason: 'request_failed' });
    // 6 Doesn't report yet: no published field (no version sniffing), or the read is unknown to the daemon.
    expect(
      selectMachineVitalsOverviewView({
        online: true,
        published: null,
        state: ready(null, 'loading'),
      }),
    ).toEqual({ kind: 'older_happier' });
    expect(
      selectMachineVitalsOverviewView({
        online: true,
        published: reporting,
        state: ready(null, 'not_reported'),
      }),
    ).toEqual({ kind: 'older_happier' });
  });
});

describe('figures', () => {
  it('keeps the free figure’s unit and drops the whole’s when it repeats it, or the other way round for swap', () => {
    expect(formatMachinePartOfWhole(412e9, 994e9, 'storage', 'part')).toEqual({
      part: '412 GB',
      whole: '994',
    });
    expect(formatMachinePartOfWhole(164e9, 1.8e12, 'storage', 'part')).toEqual({
      part: '164 GB',
      whole: '1.8 TB',
    });
    expect(
      formatMachinePartOfWhole(1.8 * GIB, 2 * GIB, 'memory', 'whole'),
    ).toEqual({ part: '1.8', whole: '2 GB' });
    expect(formatMachinePartOfWhole(0, 2 * GIB, 'memory', 'whole')).toEqual({
      part: '0 B',
      whole: '2 GB',
    });
  });
});

describe('history the charts draw', () => {
  it('reads range buckets as rates, keeps gaps as gaps, and extends the hour with live samples', () => {
    const day: MachineVitalsHistoryV1 = {
      range: '24h',
      bucketMs: 300_000,
      today: { rxBytes: 0, txBytes: 0 },
      points: [
        null,
        {
          t: 600_000,
          cpu: 10,
          cpuMax: 20,
          mem: GIB,
          memMax: GIB,
          lvl: 'calm',
          swp: null,
          rx: 300_000,
          rxObservedMs: 300_000,
          tx: null,
        },
        null,
      ],
    };
    const timeline = buildMachineVitalsTimeline({
      range: '24h',
      history: day,
      samples: [],
    })!;
    expect(
      timeline.points.map((point) => [point.t, point.cpu, point.rxBps]),
    ).toEqual([
      [300_000, null, null],
      [600_000, 10, 1_000],
      [900_000, null, null],
    ]);

    const minute = (t: number) => ({
      t,
      cpu: 5,
      cpuMax: 5,
      mem: GIB,
      memMax: GIB,
      lvl: 'calm' as const,
      swp: null,
      rx: 60_000,
      tx: 0,
    });
    const hour: MachineVitalsHistoryV1 = {
      range: '1h',
      bucketMs: 60_000,
      today: { rxBytes: 0, txBytes: 0 },
      points: [minute(60_000), null, minute(180_000)],
    };
    const live = buildMachineVitalsTimeline({
      range: '1h',
      history: hour,
      samples: [sample(181_000), sample(183_000)],
    })!;
    expect(live.points.map((point) => point.t)).toEqual([
      60_000, 120_000, 180_000, 181_000, 183_000,
    ]);
    expect(live.points[0]!.rxBps).toBe(1_000);
    expect(live.points.at(-1)!.cpu).toBe(12);
    expect(live.end).toBe(183_000);
  });

  it('retains counter-reset gaps inside folded minutes instead of averaging them away', () => {
    const timeline = buildMachineVitalsTimeline({ range: '1h', history: null, samples: [
      sample(61_000),
      sample(90_000, { cpu: { reported: true, busyPct: null }, network: { reported: true, rxBps: null, txBps: null } }),
      sample(100_000), sample(124_000),
    ] })!;
    const cpu = timeline.points.map(point => point.cpu);
    expect(cpu).toContain(null);
    expect(cpu[0]).toBe(12);
    expect(cpu.at(-1)).toBe(12);
  });

  it('folds live samples older than the current minute into that minute, keeping the last minute live', () => {
    const samples = [61_000, 90_000, 120_000, 122_000, 124_000].map(
      (at, index) =>
        sample(at, { cpu: { reported: true, busyPct: index * 10 } }),
    );
    const timeline = buildMachineVitalsTimeline({
      range: '1h',
      history: null,
      samples,
    })!;
    // 61 s, 90 s and 120 s belong to the minute ending at 120 s; the minute still running stays at its 2 s step.
    expect(timeline.points.map((point) => [point.t, point.cpu])).toEqual([
      [120_000, 10],
      [122_000, 30],
      [124_000, 40],
    ]);
    expect(timeline.points.map((point) => point.cpuMax)).toEqual([20, 30, 40]);
  });
});

it('prefers a current measured zero and dates a held reading without inventing an absent value', () => {
  const timeline = buildMachineVitalsTimeline({ range: '1h', history: null, samples: [sample(62_000)] });
  const input = { sampledAt: 64_000, timeline, metric: 'cpu' as const };
  expect(selectMachineVitalsReading({ ...input, value: 0 })).toEqual({ value: 0, sampledAt: 64_000, held: false });
  expect(selectMachineVitalsReading({ ...input, value: null })).toEqual({ value: 12, sampledAt: 62_000, held: true });
  expect(selectMachineVitalsReading({ ...input, value: null, timeline: null })).toBeNull();
});

describe('scales', () => {
  it('zooms memory to three even ticks that hold every value, never tighter than a twentieth of the machine', () => {
    expect(resolveMemoryZoom([55.2 * GIB, 58.9 * GIB], 128 * GIB)).toEqual({
      min: 52 * GIB,
      max: 60 * GIB,
      ticks: [52 * GIB, 56 * GIB, 60 * GIB],
    });
    // A flat line on a small machine stays flat rather than filling the chart.
    const flat = resolveMemoryZoom([3.8 * GIB, 3.81 * GIB], 4 * GIB)!;
    expect(flat.max - flat.min).toBeGreaterThan(0.19 * GIB);
  });

  it('mirrors network around a round ceiling, giving uploads room when they need it', () => {
    const at = (rxBps: number, txBps: number) => ({
      t: 0,
      cpu: null,
      cpuMax: null,
      usedBytes: null,
      usedBytesMax: null,
      level: 'calm' as const,
      rxBps,
      txBps,
    });
    expect(resolveNetworkDomain([at(7_400_000, 300_000)])).toEqual({
      min: -6_000_000,
      max: 10_000_000,
      ceiling: 10_000_000,
    });
    expect(resolveNetworkDomain([at(1_000_000, 9_000_000)]).min).toBe(
      -9_000_000,
    );
  });
});

describe('the Disk headline and More from', () => {
  const volume = (id: string, free: number, total: number) => ({
    id,
    label: id,
    mount: `/${id}`,
    totalBytes: total,
    availableBytes: free,
  });
  it('leads with the volume that needs you, then the one worth a look, then the tightest', () => {
    const volumes = [
      volume('root', 148, 240),
      volume('data', 164, 1_800),
      volume('docker', 212, 500),
    ];
    expect(selectHeadlineVolume(volumes, calm)?.id).toBe('data');
    const look: MachineResourceAttentionV1 = {
      level: 'look',
      reasons: [
        {
          key: 'disk:docker',
          level: 'look',
          since: 1,
          metric: 'disk',
          kind: 'disk_nearly_full',
          volumeId: 'docker',
          volumeLabel: 'docker',
        },
      ],
    };
    expect(selectHeadlineVolume(volumes, look)?.id).toBe('docker');
  });

  it('keeps each extra from the newest sample that carried it, and drops one older than a missed read', () => {
    const latest = sample(100_000);
    const older = [
      sample(60_000, { gpu: [{ name: 'Apple M5 Max', busyPct: 14 }] }),
      sample(80_000, { battery: { pct: 82, state: 'charging', onAC: true } }),
    ];
    const extras = selectMachineVitalsExtras(latest, older);
    expect(extras.battery?.pct).toBe(82);
    expect(extras.gpu).toBeUndefined();
  });
});
