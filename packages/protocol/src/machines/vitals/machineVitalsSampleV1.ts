import * as z from '../../zodRuntimePolicy.js';

import { lazyDefinition } from '../../lazyZodSchema.js';

const nonnegative = () => z.number().check(z.gte(0));
const percent = () => z.number().check(z.gte(0), z.lte(100));
const rate = () => z.nullable(nonnegative());
const unavailable = () => z.strictObject({ reported: z.literal(false), reason: z.enum(['platform', 'container', 'unavailable']) });

export const MachineMemoryPressureSourceV1Schema = lazyDefinition(() => z.enum(['kernel_level', 'psi', 'events', 'none']));
export type MachineMemoryPressureSourceV1 = z.infer<typeof MachineMemoryPressureSourceV1Schema>;

export const MachineVitalsHostFactsV1Schema = lazyDefinition(() => z.strictObject({
    logicalCores: nonnegative(), effectiveCores: z.optional(nonnegative()),
    performanceCores: z.optional(nonnegative()), efficiencyCores: z.optional(nonnegative()), sockets: z.optional(nonnegative()),
    memoryTotalBytes: nonnegative(), bootedAt: nonnegative(),
}));
export type MachineVitalsHostFactsV1 = z.infer<typeof MachineVitalsHostFactsV1Schema>;

export const MachineVitalsSampleV1Schema = lazyDefinition(() => z.strictObject({
    v: z.literal(1), sampledAt: nonnegative(), intervalMs: z.number().check(z.gt(0)),
    cpu: z.union([unavailable(), z.strictObject({
        reported: z.literal(true), busyPct: z.nullable(percent()), perCore: z.optional(z.array(z.nullable(percent()))),
        perCoreNotReportedReason: z.optional(z.enum(['container', 'unavailable'])), clusters: z.optional(z.array(z.enum(['p', 'e']))),
        userPct: z.optional(z.nullable(percent())), systemPct: z.optional(z.nullable(percent())),
        iowaitPct: z.optional(z.nullable(percent())), stealPct: z.optional(z.nullable(percent())),
        load1: z.optional(nonnegative()), load5: z.optional(nonnegative()), load15: z.optional(nonnegative()),
        throttled: z.optional(z.boolean()),
    })]),
    memory: z.union([unavailable(), z.strictObject({
        reported: z.literal(true), totalBytes: nonnegative(), availableBytes: nonnegative(), usedBytes: nonnegative(),
        pressure: z.strictObject({ level: z.enum(['calm', 'elevated', 'critical', 'not_reported']), source: MachineMemoryPressureSourceV1Schema }),
        composition: z.optional(z.array(z.strictObject({ kind: z.enum(['apps', 'wired', 'compressed', 'kernel', 'system', 'cached_files']), bytes: nonnegative() }))),
        swap: z.optional(z.strictObject({ kind: z.enum(['swap', 'page_file']), totalBytes: nonnegative(), usedBytes: nonnegative(), swapping: z.boolean() })),
        limitSource: z.optional(z.literal('cgroup')), lowMemorySignal: z.optional(z.boolean()),
        commitUsedBytes: z.optional(nonnegative()), commitLimitBytes: z.optional(nonnegative()),
    })]),
    disk: z.union([unavailable(), z.strictObject({
        reported: z.literal(true), homeVolumeId: z.optional(z.string()), volumes: z.array(z.strictObject({
            id: z.string(), label: z.string(), mount: z.string(), totalBytes: nonnegative(), availableBytes: nonnegative(),
            reservedBytes: z.optional(nonnegative()), apfsContainerId: z.optional(z.string()),
            availableIncludingPurgeableBytes: z.optional(nonnegative()), inodesExhausted: z.optional(z.boolean()),
        })),
    })]),
    network: z.union([unavailable(), z.strictObject({
        reported: z.literal(true), rxBps: rate(), txBps: rate(), label: z.optional(z.string()),
        interfaces: z.optional(z.array(z.strictObject({ id: z.string(), label: z.string(), included: z.boolean(), rxBps: rate(), txBps: rate() }))),
    })]),
    limits: z.optional(z.strictObject({
        files: z.optional(z.strictObject({ used: nonnegative(), max: nonnegative() })),
        daemonFiles: z.optional(z.strictObject({ used: nonnegative(), max: nonnegative() })),
        ptys: z.optional(z.strictObject({ used: nonnegative(), max: nonnegative() })),
        processes: z.optional(z.strictObject({ used: nonnegative(), max: nonnegative() })),
        inotify: z.optional(z.strictObject({ used: nonnegative(), max: nonnegative() })),
    })),
    // Transient presentation facts are additive-open/drop; no authority lives here.
    gpu: z.optional(z.array(z.object({ name: z.string(), powerState: z.optional(z.literal('off')), busyPct: z.optional(percent()), memUsedBytes: z.optional(nonnegative()), memTotalBytes: z.optional(nonnegative()), cores: z.optional(nonnegative()) }))),
    power: z.optional(z.strictObject({ onAC: z.boolean() })),
    battery: z.optional(z.strictObject({ pct: percent(), state: z.enum(['charging', 'discharging', 'full']), onAC: z.boolean(), minutesToFull: z.optional(nonnegative()), minutesToEmpty: z.optional(nonnegative()) })),
    thermal: z.optional(z.strictObject({ state: z.optional(z.enum(['nominal', 'fair', 'serious', 'critical'])), throttled: z.optional(z.boolean()), tempC: z.optional(z.number()), sensor: z.optional(z.string()), fanPct: z.optional(percent()) })),
    sharedMemory: z.optional(z.strictObject({ totalBytes: nonnegative(), availableBytes: nonnegative() })),
}));
export type MachineVitalsSampleV1 = z.infer<typeof MachineVitalsSampleV1Schema>;
