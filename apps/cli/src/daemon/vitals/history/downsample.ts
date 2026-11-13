import type { MachineVitalsHistoryPointV1, MachineVitalsHistoryV1, MachineVitalsMinuteRecordV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';

function withoutServices(record: MachineVitalsMinuteRecordV1): MachineVitalsMinuteRecordV1 {
  const { services: _services, ...machine } = record;
  return machine;
}

export function downsampleMachineVitalsHistory(input: Readonly<{
  records: readonly MachineVitalsMinuteRecordV1[];
  range: MachineVitalsHistoryV1['range'];
  now: number;
  serviceId?: string;
  livePoints?: readonly MachineVitalsHistoryPointV1[];
}>): MachineVitalsHistoryV1 {
  const minuteMs = 60_000;
  const bucketMs = input.range === '7d' ? 30 * minuteMs : input.range === '24h' ? 5 * minuteMs : minuteMs;
  const rangeMs = input.range === '7d' ? 7 * 86_400_000 : input.range === '24h' ? 86_400_000 : 60 * minuteMs;
  const end = input.range === '1h' ? Math.floor(input.now / bucketMs) * bucketMs : Math.ceil(input.now / bucketMs) * bucketMs;
  const start = end - rangeMs;
  const buckets: MachineVitalsMinuteRecordV1[][] = Array.from({ length: rangeMs / bucketMs }, () => []);
  for (const record of input.records) {
    if (record.t <= start || record.t > input.now) continue;
    const index = Math.floor((record.t - start - 1) / bucketMs);
    buckets[index].push(record);
  }
  const pressure = { not_reported: -1, calm: 0, elevated: 1, critical: 2 };
  const mean = (values: readonly (number | null)[]) => {
    const known = values.filter((value): value is number => value !== null);
    return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0) / known.length;
  };
  const max = (values: readonly (number | null)[]) => {
    const known = values.filter((value): value is number => value !== null);
    return known.length === 0 ? null : Math.max(...known);
  };
  const sum = (values: readonly (number | null)[]) => {
    const known = values.filter((value): value is number => value !== null);
    return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
  };
  let points: Array<MachineVitalsHistoryPointV1 | null> = buckets.map((records, index) => {
    if (records.length === 0) return null;
    const level = records.reduce((highest, record) => pressure[record.lvl] > pressure[highest] ? record.lvl : highest,
      'not_reported' as MachineVitalsMinuteRecordV1['lvl']);
    return { t: start + index * bucketMs, cpu: mean(records.map((record) => record.cpu)),
      cpuMax: max(records.map((record) => record.cpuMax)), mem: mean(records.map((record) => record.mem)),
      memMax: max(records.map((record) => record.memMax)), lvl: level, swp: max(records.map((record) => record.swp)),
      rx: sum(records.map((record) => record.rx)), tx: sum(records.map((record) => record.tx)),
      ...(records.some(record => record.rx !== null) ? { rxObservedMs: records.filter(record => record.rx !== null).length * minuteMs } : {}),
      ...(records.some(record => record.tx !== null) ? { txObservedMs: records.filter(record => record.tx !== null).length * minuteMs } : {}) };
  });
  if (input.range === '1h') {
    // Minute history seeds the part that predates the live ring; retain native live timestamps.
    const live = (input.livePoints ?? []).filter((point) => point.t > input.now - rangeMs && point.t <= input.now);
    const firstLiveMinute = live.length ? Math.floor(live[0].t / minuteMs) * minuteMs : end;
    points = [];
    const byTime = new Map(input.records.map((record) => [record.t, record]));
    for (let at = start + minuteMs; at <= firstLiveMinute && (!live.length || at < live[0].t); at += minuteMs) {
      const record = byTime.get(at);
      points.push(record ? withoutServices(record) : null);
    }
    let previous = firstLiveMinute;
    for (const point of live) {
      // Samples at adjacent minute boundaries can arrive a few milliseconds late.
      // A gap means an unobserved minute bucket, not elapsed-time jitter.
      if (Math.floor(point.t / minuteMs) - Math.floor(previous / minuteMs) > 1) points.push(null);
      points.push(point);
      previous = point.t;
    }
    if (Math.floor(input.now / minuteMs) - Math.floor(previous / minuteMs) > 1) points.push(null);
  }
  // The measured interval ending at UTC midnight belongs to the previous day.
  const todayStart = Math.floor(input.now / 86_400_000) * 86_400_000;
  const today = input.records.filter((record) => record.t > todayStart && record.t <= input.now)
    .reduce((totals, record) => ({ rxBytes: totals.rxBytes + (record.rx ?? 0), txBytes: totals.txBytes + (record.tx ?? 0) }),
      { rxBytes: 0, txBytes: 0 });
  const service = input.serviceId === undefined ? undefined : {
    serviceId: input.serviceId,
    points: buckets.map((records, index) => {
        const samples = records.flatMap(record => record.services?.filter(sample => sample.serviceId === input.serviceId) ?? []);
        if (!samples.length) return null;
        return { t: start + index * bucketMs,
          cpuPercent: mean(samples.map(sample => sample.cpuPercent)), cpuMaxPercent: max(samples.map(sample => sample.cpuPercent)),
          memoryBytes: mean(samples.map(sample => sample.memoryBytes)), memoryMaxBytes: max(samples.map(sample => sample.memoryBytes)) };
      }),
  };
  return { range: input.range, bucketMs, points, today, ...(service ? { service } : {}) };
}
