import { useMemo } from 'react';

import type {
  MachinePublishedResourceSummaryV1,
  MachineResourceAttentionV1,
  MachineResourceReasonV1,
} from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type { MachineVitalsHistoryV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';
import type { MachineVitalsSnapshotV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import type {
  MachineVitalsHostFactsV1,
  MachineVitalsSampleV1,
} from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import { formatHappierDataBytesParts } from '@happier-dev/plugin-ui/presentation';

import type { MachineResourceTone } from '@/components/machines/summary/machineSummaryStripModel';
import type { MachineVitalsRange } from '@/sync/domains/machines/resources/machineRpc';
import type { MachineResourceState } from '@/sync/domains/machines/resources/machineResourceStore';
import { readMachineResourceObservation } from '@/sync/domains/machines/resources/machineResourceAvailability';

/**
 * The Overview's pure rules (plan 20 VU-6): which of the six states a machine is in, the history each
 * chart draws, the scales they use, which volume leads the Disk tile and which extras "More from" shows.
 * Values and tone are the machine's (the sample and the published attention); nothing here invents a
 * threshold or re-derives attention.
 */

export const MACHINE_VITALS_RANGES = [
  '1h',
  '24h',
  '7d',
] as const satisfies readonly MachineVitalsRange[];
export const MACHINE_VITALS_RANGE_MS: Readonly<
  Record<MachineVitalsRange, number>
> = { '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000 };

const MINUTE_MS = 60_000;

/** A widget's explicit percent warning is presentation-only; never weakens canonical attention. */
export function resolveMetricWarningTone(tone: MachineResourceTone, usedPct: number | null, warnAbove: number | null | undefined): MachineResourceTone {
  return tone === 'calm' && usedPct !== null && warnAbove != null && usedPct > warnAbove ? 'warn' : tone;
}

// ── State ────────────────────────────────────────────────────────────────────────────────────────────

/** What the Overview body is, before any tile is drawn (lab `rv` OS 1–6). */
export type MachineVitalsOverviewView =
  | Readonly<{ kind: 'loading' }>
  /** Runs an older Happier that has no sampler (no published `resources`, or the read is unknown to it). */
  | Readonly<{ kind: 'older_happier' }>
  /** Online, but the sampler or the read failed and nothing is retained: one state card. */
  | Readonly<{
      kind: 'unavailable';
      since: number | null;
      reason: 'reader_failed' | 'helper_missing' | 'request_failed';
      errorCode?: string;
    }>
  /** Offline with nothing this app session read: the banner and one quiet line. */
  | Readonly<{ kind: 'offline_empty' }>
  /** Monitoring is Off by choice: nothing reads; what was read before stays, as of its time. */
  | Readonly<{ kind: 'monitoring_off'; sample: MachineVitalsSampleV1 | null }>
  | Readonly<{
      kind: 'ready';
      sample: MachineVitalsSampleV1;
      freshness: 'live' | 'stale' | 'offline';
    }>;

export function selectMachineVitalsOverviewView(
  input: Readonly<{
    online: boolean | null;
    published: MachinePublishedResourceSummaryV1 | null;
    /** The machine's saved monitoring mode; null while its policy can't be read. */
    monitoring?: 'off' | 'while_viewing' | 'always' | null;
    state: Readonly<{
      status: MachineResourceState['status'];
      snapshot: MachineVitalsSnapshotV1 | null;
      stale: boolean;
      errorCode?: string | null;
    }>;
  }>,
): MachineVitalsOverviewView {
  const { state, published } = input;
  const observation = readMachineResourceObservation(state, published?.vitals ?? null);
  const sample = state.snapshot?.sample ?? null;
  // The last report stays while a machine is away; nothing is shown as zero (OS 3).
  if (input.online === false)
    return sample
      ? { kind: 'ready', sample, freshness: 'offline' }
      : { kind: 'offline_empty' };
  if (input.online === null) return sample
    ? { kind: 'ready', sample, freshness: 'stale' }
    : { kind: 'unavailable', since: null, reason: 'request_failed' };
  // Off is the person's choice, not a failure or an empty machine: say so before any read state.
  if (input.monitoring === 'off') return { kind: 'monitoring_off', sample };
  if (state.status === 'not_reported') return { kind: 'older_happier' };
  // The daemon itself says its sampler is failing: the body is one state card that names it (OS 5).
  if (published?.vitals.state === 'unavailable' && (published.vitals.reason === 'helper_missing' || observation.readerFailed)) {
    return {
      kind: 'unavailable',
      since: published.vitals.since,
      reason: published.vitals.reason,
    };
  }
  if (state.snapshot?.state === 'unavailable' && state.status === 'ready') {
    return {
      kind: 'unavailable',
      since: null,
      reason:
        state.snapshot.reason === 'helper_missing'
          ? 'helper_missing'
          : 'reader_failed',
    };
  }
  if (sample)
    return {
      kind: 'ready',
      sample,
      freshness: observation.freshness === 'live' ? 'live' : 'stale',
    };
  if (state.status === 'error')
    return { kind: 'unavailable', since: null, reason: 'request_failed', ...(state.errorCode ? { errorCode: state.errorCode } : {}) };
  // No published summary and no answer yet: a daemon without the field has no sampler (no version sniffing).
  if (!published)
    return state.status === 'ready'
      ? { kind: 'loading' }
      : { kind: 'older_happier' };
  return { kind: 'loading' };
}

// ── Bytes ────────────────────────────────────────────────────────────────────────────────────────────

/** A byte figure split for the tile's big value and its quieter unit ("71" "GB"). */
export function machineBytesParts(bytes: number, kind: 'memory' | 'storage') {
  return formatHappierDataBytesParts(bytes, { kind });
}

export function formatMachineBytes(
  bytes: number,
  kind: 'memory' | 'storage',
): string {
  const parts = machineBytesParts(bytes, kind);
  return `${parts.value} ${parts.unit}`;
}

/**
 * "412 GB" + "of 994" / "1.2 TB" + "of 2 TB"… the free figure keeps its unit; the whole drops it when it
 * says the same unit (lab: "412 GB free of 994", "164 GB free of 1.8 TB").
 */
export function formatMachinePartOfWhole(
  part: number,
  whole: number,
  kind: 'memory' | 'storage',
  unitOn: 'part' | 'whole',
): Readonly<{ part: string; whole: string }> {
  const a = machineBytesParts(part, kind);
  const b = machineBytesParts(whole, kind);
  const same = a.unit === b.unit;
  if (unitOn === 'part')
    return {
      part: `${a.value} ${a.unit}`,
      whole: same ? b.value : `${b.value} ${b.unit}`,
    };
  // Swap and page file read "1.8 of 2 GB": the used figure drops a unit the whole repeats.
  return {
    part: same ? a.value : `${a.value} ${a.unit}`,
    whole: `${b.value} ${b.unit}`,
  };
}

// ── Host facts ───────────────────────────────────────────────────────────────────────────────────────

/** The machine's age since boot, as the header says it ("6 d 4 h", "41 d", "3 h 20 min", "12 min"). */
export function resolveMachineUptimeParts(
  bootedAt: number,
  nowMs: number,
): Readonly<{ days: number; hours: number; minutes: number }> {
  const totalMinutes = Math.max(0, Math.floor((nowMs - bootedAt) / MINUTE_MS));
  return {
    days: Math.floor(totalMinutes / 1440),
    hours: Math.floor((totalMinutes % 1440) / 60),
    minutes: totalMinutes % 60,
  };
}

/** Exact CPU capacity used by accounting, including a container's fractional quota. */
export function resolveMachineCpuCapacityCores(host: Pick<MachineVitalsHostFactsV1, 'logicalCores' | 'effectiveCores'>): number {
  return host.effectiveCores !== undefined && host.effectiveCores > 0 ? host.effectiveCores : host.logicalCores;
}

/** Cores as the machine has them, rounded only for the displayed machine fact. */
export function resolveMachineCoreCount(
  host: Pick<MachineVitalsHostFactsV1, 'logicalCores' | 'effectiveCores'>,
): number {
  return Math.round(resolveMachineCpuCapacityCores(host) * 10) / 10;
}

// ── Tone ─────────────────────────────────────────────────────────────────────────────────────────────

function toneOf(
  reason: MachineResourceReasonV1 | undefined,
): MachineResourceTone {
  return !reason ? 'calm' : reason.level === 'needs_you' ? 'crit' : 'warn';
}

/** The machine's memory reason, if any (published attention owns it; the sample never tones a tile). */
export function selectMemoryReason(
  attention: MachineResourceAttentionV1 | null,
) {
  const reason = attention?.reasons.find(
    (entry) => entry.kind === 'memory_pressure',
  );
  return reason && reason.kind === 'memory_pressure' ? reason : null;
}

export function resolveMemoryTone(
  attention: MachineResourceAttentionV1 | null,
): MachineResourceTone {
  return toneOf(selectMemoryReason(attention) ?? undefined);
}

export function resolveVolumeTone(
  attention: MachineResourceAttentionV1 | null,
  volumeId: string,
): MachineResourceTone {
  const reasons = (attention?.reasons ?? []).filter(
    (entry) =>
      (entry.kind === 'disk_full' || entry.kind === 'disk_nearly_full') &&
      entry.volumeId === volumeId,
  );
  return toneOf(
    reasons.find((entry) => entry.level === 'needs_you') ?? reasons[0],
  );
}

export function resolveLimitTone(
  attention: MachineResourceAttentionV1 | null,
  limit: 'files' | 'ptys' | 'processes' | 'inotify',
): MachineResourceTone {
  return toneOf(
    attention?.reasons.find(
      (entry) => entry.kind === 'limit_reached' && entry.limit === limit,
    ),
  );
}

type Volume = Extract<
  MachineVitalsSampleV1['disk'],
  { reported: true }
>['volumes'][number];

/** The volume the Disk tile leads with: the one that needs you, else the one worth a look, else the tightest. */
export function selectHeadlineVolume(
  volumes: readonly Volume[],
  attention: MachineResourceAttentionV1 | null,
): Volume | null {
  if (volumes.length === 0) return null;
  const ranked = (level: 'needs_you' | 'look') =>
    volumes.find(
      (volume) =>
        resolveVolumeTone(attention, volume.id) ===
        (level === 'needs_you' ? 'crit' : 'warn'),
    );
  const fraction = (volume: Volume) =>
    volume.totalBytes > 0 ? volume.availableBytes / volume.totalBytes : 1;
  return (
    ranked('needs_you') ??
    ranked('look') ??
    [...volumes].sort((a, b) => fraction(a) - fraction(b))[0]!
  );
}

// ── History ──────────────────────────────────────────────────────────────────────────────────────────

export type MachineVitalsLevel =
  | 'calm'
  | 'elevated'
  | 'critical'
  | 'not_reported';

/** One point a chart draws. `null` values break the line (a gap: asleep, daemon down, not measured). */
export type MachineVitalsTimelinePoint = Readonly<{
  t: number;
  cpu: number | null;
  cpuMax: number | null;
  usedBytes: number | null;
  usedBytesMax: number | null;
  level: MachineVitalsLevel;
  rxBps: number | null;
  txBps: number | null;
}>;

export type MachineVitalsTimeline = Readonly<{
  start: number;
  end: number;
  points: readonly MachineVitalsTimelinePoint[];
}>;

/** A headline may hold the latest chart reading across a counter reset, but never relabel it as current. */
export function selectMachineVitalsReading(input: Readonly<{
  value: number | null;
  sampledAt: number;
  timeline: MachineVitalsTimeline | null;
  metric: 'cpu' | 'rxBps' | 'txBps';
}>): Readonly<{ value: number; sampledAt: number; held: boolean }> | null {
  if (input.value !== null) return { value: input.value, sampledAt: input.sampledAt, held: false };
  const points = input.timeline?.points ?? [];
  for (let index = points.length - 1; index >= 0; index--) {
    const point = points[index]!;
    const value = point[input.metric];
    if (value !== null && point.t <= input.sampledAt) return { value, sampledAt: point.t, held: true };
  }
  return null;
}

const GAP = (t: number): MachineVitalsTimelinePoint => ({
  t,
  cpu: null,
  cpuMax: null,
  usedBytes: null,
  usedBytesMax: null,
  level: 'not_reported',
  rxBps: null,
  txBps: null,
});
const LEVEL_RANK: Readonly<Record<MachineVitalsLevel, number>> = {
  not_reported: -1,
  calm: 0,
  elevated: 1,
  critical: 2,
};

function fromSample(sample: MachineVitalsSampleV1): MachineVitalsTimelinePoint {
  return {
    t: sample.sampledAt,
    cpu: sample.cpu.reported ? sample.cpu.busyPct : null,
    cpuMax: sample.cpu.reported ? sample.cpu.busyPct : null,
    usedBytes: sample.memory.reported ? sample.memory.usedBytes : null,
    usedBytesMax: sample.memory.reported ? sample.memory.usedBytes : null,
    level: sample.memory.reported
      ? sample.memory.pressure.level
      : 'not_reported',
    rxBps: sample.network.reported ? sample.network.rxBps : null,
    txBps: sample.network.reported ? sample.network.txBps : null,
  };
}

function mean(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0
    ? null
    : known.reduce((sum, value) => sum + value, 0) / known.length;
}

function maximum(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : Math.max(...known);
}

const NO_LIVE_TIMELINE_SAMPLES: readonly MachineVitalsSampleV1[] = [];

/** Long ranges consume daemon buckets; only the hour consumes the changing live tail. */
export function useMachineVitalsTimeline(input: Parameters<typeof buildMachineVitalsTimeline>[0]): MachineVitalsTimeline | null {
  const { range, history } = input;
  const samples = range === '1h' ? input.samples : NO_LIVE_TIMELINE_SAMPLES;
  return useMemo(() => buildMachineVitalsTimeline({ range, history, samples }), [range, history, samples]);
}

/**
 * The points a range draws. History records are the daemon's (minute means and range buckets; network as
 * bytes per bucket, read here as bytes per second); for the hour, the live samples newer than the history
 * extend it at their own 2 s step. Live points older than the current minute fold into their minute, so
 * an hour stays about one point per minute of width while its last minute stays live — display
 * resolution only, the daemon still owns every stored figure.
 */
export function buildMachineVitalsTimeline(
  input: Readonly<{
    range: MachineVitalsRange;
    history: MachineVitalsHistoryV1 | null;
    samples: readonly MachineVitalsSampleV1[];
  }>,
): MachineVitalsTimeline | null {
  const rangeMs = MACHINE_VITALS_RANGE_MS[input.range];
  const history =
    input.history && input.history.range === input.range ? input.history : null;
  const points: MachineVitalsTimelinePoint[] = [];
  if (history) {
    const anchorIndex = history.points.findIndex((point) => point !== null);
    const anchor = anchorIndex >= 0 ? history.points[anchorIndex]! : null;
    let previousT: number | null = null;
    let previousIndex = -1;
    history.points.forEach((record, index) => {
      if (record === null) {
        // An hour lists gaps in order without a time; ranges are evenly bucketed.
        if (input.range === '1h') {
          const nextIndex = history.points.findIndex((point, following) => following > index && point !== null);
          const next = nextIndex >= 0 ? history.points[nextIndex]! : null;
          if (previousT !== null) {
            points.push(GAP(next
              ? previousT + (next.t - previousT) * (index - previousIndex) / (nextIndex - previousIndex)
              : previousT + (index - previousIndex) * history.bucketMs));
          } else if (next) points.push(GAP(next.t - (nextIndex - index) * history.bucketMs));
        } else if (anchor)
          points.push(GAP(anchor.t + (index - anchorIndex) * history.bucketMs));
        return;
      }
      // Stored minute records describe one measured minute. Projected live/range
      // points carry their own coverage; an unobserved bucket span is never idle.
      const rxMs = record.rxObservedMs ?? (input.range === '1h' ? MINUTE_MS : null);
      const txMs = record.txObservedMs ?? (input.range === '1h' ? MINUTE_MS : null);
      points.push({
        t: record.t,
        cpu: record.cpu,
        cpuMax: record.cpuMax,
        usedBytes: record.mem,
        usedBytesMax: record.memMax,
        level: record.lvl,
        rxBps: record.rx === null || rxMs === null ? null : record.rx * 1000 / rxMs,
        txBps: record.tx === null || txMs === null ? null : record.tx * 1000 / txMs,
      });
      previousT = record.t;
      previousIndex = index;
    });
  }
  if (input.range === '1h') {
    let last = -1;
    for (const point of points) if (point.cpu !== null || point.usedBytes !== null) last = point.t;
    for (const sample of input.samples)
      if (sample.sampledAt > last) points.push(fromSample(sample));
  }
  const drawn = points.filter(
    (point) =>
      point.cpu !== null || point.usedBytes !== null || point.rxBps !== null || point.txBps !== null,
  );
  if (drawn.length === 0) return null;
  const end = drawn.at(-1)!.t;
  const start = end - rangeMs;
  const inRange = points.filter((point) => point.t > start);
  return {
    start,
    end,
    points: input.range === '1h' ? foldToMinutes(inRange, end) : inRange,
  };
}

function foldToMinutes(
  points: readonly MachineVitalsTimelinePoint[],
  end: number,
): MachineVitalsTimelinePoint[] {
  const liveFrom = Math.ceil(end / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
  const groups = new Map<number, MachineVitalsTimelinePoint[]>();
  const result: MachineVitalsTimelinePoint[] = [];
  for (const point of points) {
    if (point.t > liveFrom) {
      result.push(point);
      continue;
    }
    const key = Math.ceil(point.t / MINUTE_MS) * MINUTE_MS;
    const group = groups.get(key);
    if (group) group.push(point);
    else {
      groups.set(key, [point]);
      result.push(point);
    }
  }
  return result.flatMap((point) => {
    if (point.t > liveFrom) return [point];
    const group = groups.get(Math.ceil(point.t / MINUTE_MS) * MINUTE_MS)!;
    if (group.length === 1) return [point];
    // Folding may reduce measured points, but must never erase a break in any metric's line.
    const hasBreak = (key: 'cpu' | 'usedBytes' | 'rxBps' | 'txBps') =>
      group.some(entry => entry[key] === null) && group.some(entry => entry[key] !== null);
    if (hasBreak('cpu') || hasBreak('usedBytes') || hasBreak('rxBps') || hasBreak('txBps')) return group;
    return [{
      t: Math.ceil(point.t / MINUTE_MS) * MINUTE_MS,
      cpu: mean(group.map((entry) => entry.cpu)),
      cpuMax: maximum(group.map((entry) => entry.cpuMax)),
      usedBytes: mean(group.map((entry) => entry.usedBytes)),
      usedBytesMax: maximum(group.map((entry) => entry.usedBytesMax)),
      level: group.reduce<MachineVitalsLevel>(
        (worst, entry) =>
          LEVEL_RANK[entry.level] > LEVEL_RANK[worst] ? entry.level : worst,
        'not_reported',
      ),
      rxBps: mean(group.map((entry) => entry.rxBps)),
      txBps: mean(group.map((entry) => entry.txBps)),
    }];
  });
}

// ── Scales ───────────────────────────────────────────────────────────────────────────────────────────

const GIB = 1024 ** 3;
const ZOOM_STEPS_GIB = [
  0.1, 0.2, 0.25, 0.5, 1, 2, 3, 4, 5, 10, 15, 20, 25, 50, 100, 200, 250, 500,
  1000,
];

/**
 * The memory line's zoom (lab: "54 · 57 · 60 GB"): three even ticks that hold every value, never tighter
 * than a twentieth of the machine's memory, so a fraction of a gigabyte of wobble stays flat. The floor is
 * labelled, so the zoom never reads as an empty machine.
 */
export function resolveMemoryZoom(
  values: readonly number[],
  totalBytes: number,
): Readonly<{ min: number; max: number; ticks: readonly number[] }> | null {
  const known = values.filter((value) => Number.isFinite(value));
  if (known.length === 0) return null;
  const low = Math.min(...known);
  const high = Math.max(...known);
  const minimumSpan = totalBytes / 20;
  for (const stepGib of ZOOM_STEPS_GIB) {
    const step = stepGib * GIB;
    if (step * 2 < minimumSpan) continue;
    const min = Math.max(0, Math.floor(low / step) * step);
    if (min + step * 2 >= high)
      return {
        min,
        max: min + step * 2,
        ticks: [min, min + step, min + step * 2],
      };
  }
  return {
    min: 0,
    max: Math.max(high, totalBytes),
    ticks: [0, totalBytes / 2, totalBytes],
  };
}

/** A rate chart's ceiling: the next 1 · 2 · 5 step above what it drew, so the visible max is a round number. */
export function resolveRateCeiling(peak: number): number {
  if (!(peak > 0)) return 1_000;
  const magnitude = 10 ** Math.floor(Math.log10(peak));
  for (const step of [1, 2, 5, 10])
    if (step * magnitude >= peak) return step * magnitude;
  return 10 * magnitude;
}

/**
 * The mirrored network scale: downloads above the baseline, uploads below it in the same units, the lower
 * half a little shorter (lab: the baseline at about three fifths) unless uploads need more room.
 */
export function resolveNetworkDomain(
  points: readonly MachineVitalsTimelinePoint[],
): Readonly<{ min: number; max: number; ceiling: number }> {
  const down = Math.max(0, ...points.map((point) => point.rxBps ?? 0));
  const up = Math.max(0, ...points.map((point) => point.txBps ?? 0));
  const ceiling = resolveRateCeiling(Math.max(down, up));
  return { min: -Math.max(ceiling * 0.6, up), max: ceiling, ceiling };
}

// ── Extras ───────────────────────────────────────────────────────────────────────────────────────────

/** Extras arrive on the Overview's 15 s cadence: the newest sample carrying each, within one missed read. */
const EXTRAS_HELD_MS = 30_000;

export type MachineVitalsExtras = Readonly<
  Pick<
    MachineVitalsSampleV1,
    'gpu' | 'battery' | 'thermal' | 'sharedMemory' | 'limits'
  >
>;

export function selectMachineVitalsExtras(
  latest: MachineVitalsSampleV1,
  samples: readonly MachineVitalsSampleV1[],
): MachineVitalsExtras {
  const recent = [latest, ...[...samples].reverse()].filter(
    (sample) => latest.sampledAt - sample.sampledAt <= EXTRAS_HELD_MS,
  );
  const pick = <K extends keyof MachineVitalsExtras>(
    key: K,
  ): MachineVitalsExtras[K] =>
    recent.find((sample) => sample[key] !== undefined)?.[key];
  return {
    gpu: pick('gpu'),
    battery: pick('battery'),
    thermal: pick('thermal'),
    sharedMemory: pick('sharedMemory'),
    limits: pick('limits'),
  };
}
