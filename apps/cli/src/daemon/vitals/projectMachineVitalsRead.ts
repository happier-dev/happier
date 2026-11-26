import { appendMachineVitalsSeriesV1, type MachineResourceAttentionV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type { MachineVitalsSnapshotV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';
import type { MachineVitalsSampleV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsSampleV1';
import type { MachineVitalsSampler } from './createMachineVitalsSampler';

/** Independent Overview extras are filtered; a memory observation stays whole. */
export function projectMachineVitalsSample(sample: MachineVitalsSampleV1, view: 'summary' | 'overview'): MachineVitalsSampleV1 {
    if (view === 'overview') return sample;
    const { gpu: _gpu, battery: _battery, thermal: _thermal, sharedMemory: _sharedMemory, ...base } = sample;
    const limits = base.limits ? (() => {
        const { inotify: _inotify, ...limits } = base.limits;
        return limits;
    })() : undefined;
    return { ...base, ...(limits ? { limits } : {}) };
}

export function projectMachineVitalsSnapshot(
    sampler: MachineVitalsSampler, view: 'summary' | 'overview', attention?: MachineResourceAttentionV1,
): MachineVitalsSnapshotV1 {
    const latest = sampler.latest();
    const end = latest?.sampledAt ?? Date.now();
    const start = end - 5 * 60_000;
    const live = sampler.samplesSince(start);
    const firstLive = live[0]?.sampledAt ?? end + 1;
    const memoryTotal = latest?.memory.reported ? latest.memory.totalBytes : sampler.host()?.memoryTotalBytes;
    const series: MachineVitalsSnapshotV1['series5m'] = { cpu: [], memory: [], networkRx: [], networkTx: [] };
    if (latest || sampler.minutes(0).length) {
        const minutes = new Map(sampler.minutes(start).map(record => [record.t, record]));
        for (let at = (Math.floor(start / 60_000) + 1) * 60_000; at < firstLive && at <= end; at += 60_000) {
            const minute = minutes.get(at);
            series.cpu.push({ t: at, y: minute?.cpu ?? null });
            series.memory.push({ t: at, y: minute?.mem != null && memoryTotal !== undefined ? Math.max(0, memoryTotal - minute.mem) : null });
            series.networkRx.push({ t: at, y: minute?.rx != null ? minute.rx / 60 : null });
            series.networkTx.push({ t: at, y: minute?.tx != null ? minute.tx / 60 : null });
        }
    }
    return { ...sampler.state(), sample: latest ? projectMachineVitalsSample(latest, view) : null,
        series5m: appendMachineVitalsSeriesV1(series, null, live), ...(attention ? { attention } : {}) };
}
