import * as z from 'zod/mini';

const counter = () => z.int().check(z.gte(0));
const composition = () => z.strictObject({ kind: z.enum(['apps', 'wired', 'compressed', 'kernel', 'system', 'cached_files']), bytes: counter() });
const limit = () => z.strictObject({ used: counter(), max: counter() });

// Strict at the native boundary: an invalid helper result never replaces the last good sample.
export const NativeVitalsSampleSchema = z.strictObject({
    v: z.literal(1), t: z.literal('vitals-sample'), sample: z.strictObject({
        cpu: z.optional(z.array(z.strictObject({ user: counter(), system: counter(), idle: counter() }))),
        clusters: z.optional(z.array(z.enum(['p', 'e']))),
        memory: z.strictObject({
            totalBytes: counter(), availableBytes: z.optional(counter()),
            pressureLevel: z.enum(['calm', 'elevated', 'critical', 'not_reported']), pressureSource: z.enum(['kernel_level', 'none']),
            lowMemorySignal: z.optional(z.boolean()),
            swap: z.optional(z.strictObject({ kind: z.enum(['swap', 'page_file']), totalBytes: counter(), usedBytes: counter(), in: z.optional(counter()), out: z.optional(counter()) })),
            composition: z.optional(z.array(composition())),
        }),
        volumes: z.array(z.strictObject({ id: z.string(), label: z.string(), mount: z.string(), totalBytes: counter(), availableBytes: counter(), apfsContainerId: z.optional(z.string()), inodesExhausted: z.optional(z.boolean()) })),
        interfaces: z.array(z.strictObject({ id: z.string(), name: z.string(), rxBytes: counter(), txBytes: counter(), included: z.boolean() })),
        performanceCores: z.optional(counter()), efficiencyCores: z.optional(counter()),
        daemonFileSoftLimit: z.optional(counter()),
        limits: z.optional(z.strictObject({ files: z.optional(limit()), processes: z.optional(limit()), daemonFiles: z.optional(limit()) })),
        power: z.optional(z.strictObject({ onAC: z.boolean() })),
        battery: z.optional(z.strictObject({ pct: z.number().check(z.gte(0), z.lte(100)), state: z.enum(['charging', 'discharging', 'full']), onAC: z.boolean(), minutesToEmpty: z.optional(counter()) })),
    }),
});
export type NativeVitalsSample = z.infer<typeof NativeVitalsSampleSchema>['sample'];
