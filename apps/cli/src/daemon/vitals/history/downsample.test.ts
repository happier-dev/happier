import { describe, expect, it } from 'vitest';
import { MachineVitalsHistoryV1Schema, type MachineVitalsMinuteRecordV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';

import { downsampleMachineVitalsHistory } from './downsample';

const minute = (t: number, cpu = 10): MachineVitalsMinuteRecordV1 => ({ t, cpu, cpuMax: cpu + 20,
  mem: cpu * 10, memMax: cpu * 20, lvl: 'calm', swp: null, rx: cpu, tx: cpu * 2 });

describe('machine vitals downsampling', () => {
  it.each(['1h', '24h', '7d'] as const)('selects only the requested service and preserves unknowns and spikes (%s)', range => {
    const now = Date.UTC(2026, 9, 10, 12);
    const records = [1, 2].map(i => ({ ...minute(now - (2 - i) * 60_000), services: [
      { serviceId: 'web', cpuPercent: i === 1 ? 150 : null, memoryBytes: i * 1024 },
      { serviceId: 'private', cpuPercent: 99, memoryBytes: 9999 },
    ] }));
    const history = downsampleMachineVitalsHistory({ range, now, records, serviceId: 'web' });
    expect(MachineVitalsHistoryV1Schema.parse(history).service).toEqual(history.service);
    const points = history.service!.points.filter(point => point !== null);
    expect(points.at(-1)).toMatchObject(range === '1h'
      ? { cpuPercent: null, cpuMaxPercent: null, memoryBytes: 2048, memoryMaxBytes: 2048 }
      : { cpuPercent: 150, cpuMaxPercent: 150, memoryBytes: 1536, memoryMaxBytes: 2048 });
    expect(JSON.stringify(history)).not.toContain('private');
    expect(downsampleMachineVitalsHistory({ range, now, records }).service).toBeUndefined();
    expect(JSON.stringify(downsampleMachineVitalsHistory({ range, now, records }))).not.toContain('services');
    expect(downsampleMachineVitalsHistory({ range, now, records, serviceId: 'missing' }).service!.points.every(point => point === null)).toBe(true);
  });
  it.each(['24h', '7d'] as const)('preserves measured network coverage in partial, interrupted and complete %s buckets', (range) => {
    const bucketMs = range === '24h' ? 300_000 : 1_800_000;
    const start = Date.UTC(2026, 9, 10, 12);
    for (const offsets of [[1], [1, 3], Array.from({ length: bucketMs / 60_000 }, (_, i) => i + 1)]) {
      const records = offsets.map(offset => ({ ...minute(start + offset * 60_000), rx: 60_000, tx: 120_000 }));
      const result = downsampleMachineVitalsHistory({ range, now: start + Math.max(...offsets) * 60_000, records });
      const point = result.points.at(-1);
      expect(point).toMatchObject({ rx: records.length * 60_000, tx: records.length * 120_000,
        rxObservedMs: records.length * 60_000, txObservedMs: records.length * 60_000 });
      expect(MachineVitalsHistoryV1Schema.safeParse(result).success).toBe(true);
      expect(result.today).toEqual({ rxBytes: records.length * 60_000, txBytes: records.length * 120_000 });
    }
    const unknown = downsampleMachineVitalsHistory({ range, now: start + 60_000,
      records: [{ ...minute(start + 60_000), rx: null, tx: 0 }] }).points.at(-1);
    expect(unknown).toMatchObject({ rx: null, tx: 0, txObservedMs: 60_000 });
    expect(unknown).not.toHaveProperty('rxObservedMs');
  });

  it.each([['24h', 300_000, 288], ['7d', 1_800_000, 336]] as const)
   ('preserves means, spikes and explicit missing buckets in %s', (range, bucketMs, count) => {
      const now = Date.UTC(2026, 9, 10, 12);
      const result = downsampleMachineVitalsHistory({ range, now,
        records: [minute(now - bucketMs + 60_000, 10), { ...minute(now - bucketMs + 120_000, 30), lvl: 'critical' }] });
      expect(result.bucketMs).toBe(bucketMs);
      expect(result.points).toHaveLength(count);
      expect(result.points.slice(0, -1).every((point) => point === null)).toBe(true);
      expect(result.points.at(-1)).toEqual({ t: now - bucketMs, cpu: 20, cpuMax: 50, mem: 200,
        memMax: 600, lvl: 'critical', swp: null, rx: 40, tx: 80, rxObservedMs: 120_000, txObservedMs: 120_000 });
    });

  it('seeds the hour before live samples and computes today totals from UTC minutes only', () => {
    const now = Date.UTC(2026, 9, 10, 0, 2);
    const result = downsampleMachineVitalsHistory({ range: '1h', now,
      records: [minute(now - 240_000), minute(now - 120_000), minute(now - 60_000)],
      livePoints: [minute(now - 90_000, 30), minute(now - 30_000, 50)] });
    expect(result.points.filter((point) => point !== null).map((point) => point.t))
      .toEqual([now - 240_000, now - 120_000, now - 90_000, now - 30_000]);
    expect(result.today).toEqual({ rxBytes: 10, txBytes: 20 });
  });

  it('includes the newest measured minute in the current partial bucket and ignores future rows', () => {
    const now = Date.UTC(2026, 9, 10, 12, 3);
    const result = downsampleMachineVitalsHistory({ range: '24h', now,
      records: [minute(now), minute(now + 60_000, 90)] });
    expect(result.points.at(-1)).toEqual({ ...minute(Date.UTC(2026, 9, 10, 12)), cpu: 10, rxObservedMs: 60_000, txObservedMs: 60_000 });
  });

  it('uses the live sample once when the restored-minute and ring frontiers have the same timestamp', () => {
    const now = Date.UTC(2026, 9, 10, 12);
    const result = downsampleMachineVitalsHistory({ range: '1h', now,
      records: [minute(now - 120_000), minute(now - 60_000)], livePoints: [minute(now - 60_000, 70)] });
    expect(result.points.filter((point) => point !== null)).toEqual([minute(now - 120_000), minute(now - 60_000, 70)]);
  });

  it('keeps adjacent sampled minutes continuous despite timer jitter, but retains a genuinely missing minute', () => {
    const start = Date.UTC(2026, 9, 10, 12);
    const livePoints = [minute(start), minute(start + 60_001), minute(start + 120_000), minute(start + 180_005)];
    const continuous = downsampleMachineVitalsHistory({ range: '1h', now: start + 180_010, records: [], livePoints });
    expect(continuous.points.slice(continuous.points.indexOf(livePoints[0]))).toEqual(livePoints);

    const missing = downsampleMachineVitalsHistory({ range: '1h', now: start + 180_010, records: [],
      livePoints: [livePoints[0], livePoints[2], livePoints[3]] });
    expect(missing.points.slice(missing.points.indexOf(livePoints[0])))
      .toEqual([livePoints[0], null, livePoints[2], livePoints[3]]);
  });
});
