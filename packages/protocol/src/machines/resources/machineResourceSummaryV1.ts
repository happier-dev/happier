import * as z from 'zod/mini';
import { lazyDefinition } from '../../lazyZodSchema.js';
import type { MachineVitalsSnapshotV1 } from '../vitals/machineVitalsRpcV1.js';
import { MachineMemoryPressureSourceV1Schema, MachineVitalsHostFactsV1Schema, type MachineVitalsHostFactsV1 } from '../vitals/machineVitalsSampleV1.js';
import { MachineGuardStateV1Schema } from '../guard/guardStateV1.js';
import { projectMachineVitalsSeriesV1 } from '../vitals/machineVitalsSeriesV1.js';
export { appendMachineVitalsSeriesV1, projectMachineVitalsSeriesV1 } from '../vitals/machineVitalsSeriesV1.js';

// V1 published summary and attention boundaries are closed; facts cannot grant authority.
export const MachineResourceReasonV1Schema = lazyDefinition(() => {
    const common = {
        key: z.string(), level: z.enum(['look', 'needs_you']), since: z.number().check(z.gte(0)),
        metric: z.enum(['cpu', 'memory', 'disk', 'network', 'limits']),
        nextStep: z.optional(z.enum(['review_processes', 'free_up_space'])),
    };
    return z.union([
        z.strictObject({ ...common, kind: z.literal('guard_out_of_steps') }),
        z.strictObject({ ...common, kind: z.literal('memory_pressure'), pressure: z.enum(['elevated', 'critical']), swapping: z.boolean() }),
        z.strictObject({ ...common, kind: z.enum(['disk_nearly_full', 'disk_full']), volumeId: z.string(), volumeLabel: z.string() }),
        z.strictObject({ ...common, kind: z.literal('limit_reached'), limit: z.enum(['files', 'ptys', 'processes', 'inotify']), used: z.number().check(z.gte(0)), max: z.number().check(z.gte(0)) }),
    ]);
});
export type MachineResourceReasonV1 = z.infer<typeof MachineResourceReasonV1Schema>;

export const MachineResourceAttentionV1Schema = lazyDefinition(() => z.strictObject({
    level: z.enum(['calm', 'look', 'needs_you']), reasons: z.array(MachineResourceReasonV1Schema),
}));
export type MachineResourceAttentionV1 = z.infer<typeof MachineResourceAttentionV1Schema>;

/** Only actions for which the guard actually acted belong on the always-on channel. */
export const MachineResourceAutomaticActionV1Schema = lazyDefinition(() => z.strictObject({
    at: z.number().check(z.gte(0)),
    kind: z.enum(['stopped_session', 'closed_browser', 'stopped_service', 'stopped_left_behind']),
    entryId: z.string().check(z.minLength(1)), undoable: z.boolean(),
    facts: z.strictObject({
        rule: z.enum(['memory_guard', 'idle_sessions', 'left_behind', 'ceiling']),
        freedBytes: z.optional(z.number().check(z.gte(0))), inTrashBytes: z.optional(z.number().check(z.gte(0))),
        count: z.optional(z.number().check(z.int(), z.gte(0))),
    }),
}));
export type MachineResourceAutomaticActionV1 = z.infer<typeof MachineResourceAutomaticActionV1Schema>;

/** Share-wide transition facts only. Samples and history stay on the Machine. */
export const MachinePublishedResourceSummaryV1Schema = lazyDefinition(() => {
    const common = { v: z.literal(1), attention: MachineResourceAttentionV1Schema,
        lastAutomaticAction: z.optional(MachineResourceAutomaticActionV1Schema), guard: z.optional(MachineGuardStateV1Schema) };
    return z.union([
        z.strictObject({ ...common, vitals: z.strictObject({ state: z.literal('reporting') }), host: MachineVitalsHostFactsV1Schema }),
        z.strictObject({ ...common, vitals: z.strictObject({ state: z.literal('unavailable'), since: z.number().check(z.gte(0)),
            reason: z.enum(['reader_failed', 'helper_missing']) }), host: z.optional(MachineVitalsHostFactsV1Schema) }),
    ]);
});
export type MachinePublishedResourceSummaryV1 = z.infer<typeof MachinePublishedResourceSummaryV1Schema>;

const resourceTone = () => z.enum(['calm', 'warn', 'crit']);
const nullableValue = () => z.nullable(z.number().check(z.gte(0)));
const resourceSeries = () => z.array(z.strictObject({ t: z.number().check(z.gte(0)), y: nullableValue() }));

/** Transient CPU/memory presentation is additive-open/drop; other boundaries are closed. No values are published in daemonState. */
export const MachineResourceSummaryV1Schema = lazyDefinition(() => z.strictObject({
    sampledAt: z.number().check(z.gte(0)), stepMs: z.literal(15_000), seriesFrom: nullableValue(),
    cpu: z.object({
        busyPct: z.nullable(z.number().check(z.gte(0), z.lte(100))), tone: resourceTone(), series: resourceSeries(),
        load1: z.optional(z.number().check(z.gte(0))), logicalCores: z.optional(z.number().check(z.gte(0))),
        effectiveCores: z.optional(z.number().check(z.gte(0))),
    }),
    memory: z.object({
        availableBytes: nullableValue(), totalBytes: nullableValue(),
        // The summary line is percent available; daemon snapshot/history values remain bytes.
        pressure: z.enum(['calm', 'elevated', 'critical', 'not_reported']),
        pressureSource: z.optional(MachineMemoryPressureSourceV1Schema), tone: resourceTone(), series: resourceSeries(),
    }),
    disk: z.strictObject({
        volumeId: z.nullable(z.string()), volumeLabel: z.nullable(z.string()),
        availableBytes: nullableValue(), totalBytes: nullableValue(), tone: resourceTone(), series: resourceSeries(),
    }),
    network: z.strictObject({ rxBps: nullableValue(), txBps: nullableValue(), tone: resourceTone(), rxSeries: resourceSeries(), txSeries: resourceSeries() }),
}));
export type MachineResourceSummaryV1 = z.infer<typeof MachineResourceSummaryV1Schema>;

const EMPTY_DISK_SERIES: MachineResourceSummaryV1['disk']['series'] = [];

/** Values and lines come from the sample; only the canonical daemon attention owns tone. */
export function projectMachineResourceSummaryV1(snapshot: MachineVitalsSnapshotV1, host?: MachineVitalsHostFactsV1): MachineResourceSummaryV1 | null {
    const sample = snapshot.sample;
    if (!sample) return null;
    const series = projectMachineVitalsSeriesV1(snapshot.series5m, sample.sampledAt);
    const reasons = snapshot.attention?.reasons ?? [];
    const tone = (metric: 'cpu' | 'memory' | 'disk' | 'network'): MachineResourceSummaryV1['cpu']['tone'] => {
        const matching = reasons.filter(reason => reason.metric === metric);
        return matching.some(reason => reason.level === 'needs_you') ? 'crit' : matching.length > 0 ? 'warn' : 'calm';
    };
    const attentionVolume = reasons.find(reason => reason.kind === 'disk_full' || reason.kind === 'disk_nearly_full');
    const disk = sample.disk.reported ? sample.disk : null;
    const homeVolumeId = disk?.homeVolumeId ?? null;
    const volumeId = attentionVolume && 'volumeId' in attentionVolume ? attentionVolume.volumeId : homeVolumeId;
    const volume = disk?.volumes.find(candidate => candidate.id === volumeId);
    const times = Object.values(series).flatMap(points => points.map(point => point.t));
    const memoryTotal = sample.memory.reported ? sample.memory.totalBytes : null;
    return {
        sampledAt: sample.sampledAt, stepMs: 15_000, seriesFrom: times.length > 0 ? Math.min(...times) : null,
        cpu: {
            busyPct: sample.cpu.reported ? sample.cpu.busyPct : null, tone: tone('cpu'), series: series.cpu,
            // The display reads two decimals; sub-display jitter is not a new summary fact.
            ...(sample.cpu.reported && sample.cpu.load1 !== undefined ? { load1: Math.round(sample.cpu.load1 * 100) / 100 } : {}),
            // Static host facts stay on their transition-published path, never in samples.
            ...(host ? { logicalCores: host.logicalCores,
                ...(host.effectiveCores !== undefined ? { effectiveCores: host.effectiveCores } : {}) } : {}),
        },
        memory: {
            availableBytes: sample.memory.reported ? sample.memory.availableBytes : null,
            totalBytes: memoryTotal,
            pressure: sample.memory.reported ? sample.memory.pressure.level : 'not_reported', tone: tone('memory'),
            ...(sample.memory.reported ? { pressureSource: sample.memory.pressure.source } : {}),
            series: series.memory.map(point => ({ t: point.t,
                y: point.y !== null && memoryTotal !== null && memoryTotal > 0 ? point.y / memoryTotal * 100 : null })),
        },
        disk: { volumeId: volume?.id ?? null, volumeLabel: volume?.label ?? null, availableBytes: volume?.availableBytes ?? null,
            totalBytes: volume?.totalBytes ?? null, tone: tone('disk'), series: EMPTY_DISK_SERIES },
        network: { rxBps: sample.network.reported ? sample.network.rxBps : null, txBps: sample.network.reported ? sample.network.txBps : null,
            tone: tone('network'), rxSeries: series.networkRx, txSeries: series.networkTx },
    };
}
