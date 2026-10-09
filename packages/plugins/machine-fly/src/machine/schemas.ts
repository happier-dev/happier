import * as z from 'zod/mini';
import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const id = z.string().check(z.trim(), z.minLength(1));
const positiveInt = z.int().check(z.gt(0));
const absolutePath = z.string().check(z.startsWith('/'), z.refine(value => !value.includes('\0')));
const closed = { policy: 'closed' } as const;
const portableId = defineProtocolString({ minLength: 1, pattern: '\\S' });
const integer = defineProtocolNumber({ integer: true, minimum: 1 });
const launchFields = {
  app: defineProtocolUnion([
    defineProtocolObject({ name: portableId, ownership: defineProtocolLiteral('created'), organizationSlug: portableId }, closed),
    defineProtocolObject({ name: portableId, ownership: defineProtocolLiteral('existing'), organizationSlug: portableId.optional() }, closed),
  ]),
  region: portableId, imageReference: portableId.optional(),
  guest: defineProtocolObject({ cpuKind: defineProtocolUnion([defineProtocolLiteral('shared'), defineProtocolLiteral('performance')]), cpus: integer, memoryMb: integer }, closed),
  volume: defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('create'), sizeGb: integer }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('attach'), volumeId: portableId }, closed),
  ]),
} as const;
export const FlyLaunchV1Schema = defineProtocolObject(launchFields, closed);
// The shared form retains known inactive fields when a branch changes. Draft
// admission stays closed, while active completeness belongs to the executable
// launch schema rather than clearing the user's hidden draft values.
export const FlyLaunchQueryV1Schema = defineProtocolObject({
  appName: portableId.optional(),
  app: defineProtocolObject({ name: portableId, ownership: defineProtocolUnion([
    defineProtocolLiteral('created'), defineProtocolLiteral('existing'),
  ]), organizationSlug: portableId.optional() }, closed).optional(),
  region: launchFields.region.optional(), imageReference: launchFields.imageReference,
  guest: launchFields.guest.optional(),
  volume: defineProtocolObject({ kind: defineProtocolUnion([
    defineProtocolLiteral('create'), defineProtocolLiteral('attach'),
  ]), sizeGb: integer.optional(), volumeId: portableId.optional() }, closed).optional(),
}, closed);
export function resolveFlyLaunchQueryCandidate(query: ProtocolSchemaOutput<typeof FlyLaunchQueryV1Schema>) {
  const app = query.app === undefined ? undefined : query.app.ownership === 'created'
    ? { name: query.app.name, ownership: query.app.ownership, organizationSlug: query.app.organizationSlug }
    : { name: query.app.name, ownership: query.app.ownership };
  const volume = query.volume === undefined ? undefined : query.volume.kind === 'create'
    ? { kind: query.volume.kind, sizeGb: query.volume.sizeGb }
    : { kind: query.volume.kind, volumeId: query.volume.volumeId };
  // This is the only executable admission: selecting the active known fields
  // neither defaults a missing value nor weakens the strict launch contract.
  return FlyLaunchV1Schema.safeParse({ app, volume, region: query.region, guest: query.guest,
    ...(query.imageReference === undefined ? {} : { imageReference: query.imageReference }) });
}
export const FlyResourceV1Schema = defineProtocolObject({
  app: defineProtocolObject({ name: portableId, ownership: defineProtocolUnion([defineProtocolLiteral('created'), defineProtocolLiteral('existing')]), id: portableId.optional() }, closed),
  machineId: portableId,
  volume: defineProtocolObject({ id: portableId, ownership: defineProtocolUnion([defineProtocolLiteral('created'), defineProtocolLiteral('attached')]) }, closed),
}, closed);
export const FlyExecRequestSchema = z.strictObject({
  command: z.array(z.string()).check(z.minLength(1)), stdin: z.optional(z.string()), timeout: z.optional(positiveInt),
});
export const FlyPutFileRequestSchema = z.strictObject({
  guestPath: absolutePath,
  bytesBase64: z.string().check(z.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)),
  // chmod accepts Unix permission/special bits, not file-type bits.
  mode: z._default(z.int().check(z.gte(0), z.lte(0o7777)), 0o600),
  timeout: z.optional(positiveInt),
});
export type FlyLaunchV1 = ProtocolSchemaOutput<typeof FlyLaunchV1Schema>;
export type FlyResourceV1 = ProtocolSchemaOutput<typeof FlyResourceV1Schema>;
export type FlyExecRequest = z.infer<typeof FlyExecRequestSchema>;
export type FlyPutFileRequest = z.input<typeof FlyPutFileRequestSchema>;

export const FlyAcquireOperationV1Schema = defineProtocolObject({
  app: defineProtocolObject({ name: portableId, ownership: defineProtocolUnion([
    defineProtocolLiteral('created'), defineProtocolLiteral('existing'), defineProtocolLiteral('unknown'),
  ]), id: portableId.optional() }, closed), requestId: portableId, phase: defineProtocolUnion([
    defineProtocolLiteral('app'), defineProtocolLiteral('volume'), defineProtocolLiteral('machine'),
  ]),
  volume: defineProtocolObject({ id: portableId, ownership: defineProtocolUnion([
    defineProtocolLiteral('created'), defineProtocolLiteral('attached'),
  ]) }, closed).optional(),
}, closed);
export const FlyPendingAcquireV1Schema = defineProtocolObject({ operation: FlyAcquireOperationV1Schema, launch: FlyLaunchV1Schema }, closed);
export const FlyGuestBootSchema = z.strictObject({
  // Native guest placement is descriptive; installation remains host-owned.
  homeDir: absolutePath,
  happyHomeDir: absolutePath,
  command: z.array(z.string()).check(z.minLength(1)),
});
export const FLY_DEFAULT_IMAGE = 'ubuntu:24.04';
export const FLY_GUEST_BOOT = {
  homeDir: '/home/happier', happyHomeDir: '/home/happier/.happier', command: ['/bin/sleep', 'inf'],
} satisfies FlyGuestBoot;
export const FlyProcessConfigurationSchema = z.strictObject({
  command: z.array(z.string()).check(z.minLength(1)),
  environment: z.strictObject({ HOME: absolutePath, HAPPIER_HOME_DIR: absolutePath }),
});
export const FlyAcquireRequestSchema = z.strictObject({
  launch: z.pipe(z.unknown(), z.transform(value => FlyLaunchV1Schema.parse(value))), requestId: id, boot: FlyGuestBootSchema,
});
export type FlyAcquireRequest = z.infer<typeof FlyAcquireRequestSchema>;
export type FlyAcquireOperationV1 = ProtocolSchemaOutput<typeof FlyAcquireOperationV1Schema>;
export type FlyGuestBoot = z.infer<typeof FlyGuestBootSchema>;

// Vendor responses are extensible. Identity and fields used for decisions are
// validated here; additions from the native API do not invalidate observation.
export const FlyMachineSchema = z.object({
  id, instance_id: z.optional(id), name: z.optional(id), state: id, region: id,
  // Updates require the entire native config. Preserve native additions during
  // this exact config round trip; they never become host authority or metadata.
  config: z.looseObject({
    image: z.optional(id),
    env: z.optional(z.record(z.string(), z.string())),
    init: z.optional(z.looseObject({ exec: z.optional(z.array(z.string())) })),
    guest: z.optional(z.looseObject({ cpu_kind: z.enum(['shared', 'performance']), cpus: positiveInt, memory_mb: positiveInt })),
    rootfs: z.optional(z.looseObject({ persist: z.optional(z.enum(['', 'none', 'never', 'restart', 'always'])) })),
    mounts: z._default(z.array(z.looseObject({ volume: id, path: id })), []),
    services: z._default(z.array(z.looseObject({ autostart: z.optional(z.boolean()), autostop: z.optional(z.union([z.boolean(), z.enum(['off', 'stop', 'suspend'])])) })), []),
    metadata: z.optional(z.record(z.string(), z.string())),
  }),
});
export const FlyVolumeSchema = z.object({
  id, state: id, name: z.optional(id), region: z.optional(id), size_gb: z.optional(z.number().check(z.gt(0))),
  attached_machine_id: z.optional(z.nullable(id)),
});
// The indexed official Machines_exec response example includes numeric
// exit_signal: 0; fly-go v0.9.4's response omits it. Null is not established as a
// successful no-signal observation and therefore fails closed.
export const FlyExecResponseSchema = z.object({ exit_code: z.int(), exit_signal: z.optional(z.int().check(z.gte(0))), stdout: z.string(), stderr: z.string() });
