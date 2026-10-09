import * as z from 'zod/mini';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString,
    defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const id = z.string().check(z.minLength(1));
const closed = { policy: 'closed' } as const;
const nativeId = defineProtocolString({ minLength: 1 });
const cloud = defineProtocolUnion([defineProtocolLiteral('aws'), defineProtocolLiteral('gcp'), defineProtocolLiteral('modal')]);
const finite = defineProtocolObject({ kind: defineProtocolLiteral('finite'),
    durationSeconds: defineProtocolNumber({ integer: true, minimum: 1 }) }, closed);
const durableLifetime = defineProtocolUnion([defineProtocolObject({ kind: defineProtocolLiteral('no-native-ttl') }, closed), finite]);

export const ByocLaunchV1Schema = defineProtocolUnion([
    defineProtocolObject({ cloud: defineProtocolLiteral('aws'), region: nativeId, nativeImageId: nativeId, nativeSizeId: nativeId,
        nativeLifetime: durableLifetime }, closed),
    defineProtocolObject({ cloud: defineProtocolLiteral('gcp'), region: nativeId, nativeImageId: nativeId, nativeSizeId: nativeId,
        nativeLifetime: durableLifetime }, closed),
    defineProtocolObject({ cloud: defineProtocolLiteral('modal'), region: nativeId, nativeImageId: nativeId, nativeSizeId: nativeId,
        // cua-byoc's Modal connection/provisioner caps native lifetime at 24 hours.
        nativeLifetime: defineProtocolObject({ kind: defineProtocolLiteral('finite'),
            durationSeconds: defineProtocolNumber({ integer: true, minimum: 1, maximum: 24 * 60 * 60 }) }, closed) }, closed),
]);
export type ByocLaunchV1 = ProtocolSchemaOutput<typeof ByocLaunchV1Schema>;
export const ByocOptionsQueryV1Schema = defineProtocolObject({ cloud }, closed);
export const ByocNativeOperationV1Schema = defineProtocolObject({ launch: ByocLaunchV1Schema, sandboxId: nativeId }, closed);

export const ByocResourceV1Schema = defineProtocolObject({
    cloud, nativeResourceId: nativeId, sandboxId: nativeId,
    spaceId: nativeId.optional(), ownedAttachmentIds: defineProtocolArray(nativeId),
}, closed);
export type ByocResourceV1 = ProtocolSchemaOutput<typeof ByocResourceV1Schema>;

// Immutable Fleet SDK routes.rs validates Kubernetes DNS labels for namespace,
// claim, pool and template names (63 ASCII characters, lowercase only).
export const FleetNativeIdSchema = defineProtocolString({ minLength: 1, maxLength: 63,
    pattern: '^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$' });
// The native claim API accepts u32 seconds. Both reviewed options and acquire
// use this one finite-lease input, never a provider/controller default.
const nativeLease = defineProtocolObject({ durationSeconds: defineProtocolNumber({ integer: true, minimum: 1, maximum: 4_294_967_295 }) }, closed);
export const FleetOptionsQueryV1Schema = defineProtocolObject({ namespace: FleetNativeIdSchema, nativeLease }, closed);
export const FleetLaunchV1Schema = defineProtocolObject({
    namespace: FleetNativeIdSchema, runtimeId: defineProtocolUnion([defineProtocolLiteral('kubevirt'), defineProtocolLiteral('gvisor')]),
    imageId: defineProtocolString({ minLength: 1 }), sizeId: FleetNativeIdSchema,
    nativeLease,
}, { policy: 'closed' });
export type FleetLaunchV1 = ProtocolSchemaOutput<typeof FleetLaunchV1Schema>;
export const FleetResourceV1Schema = defineProtocolObject({ namespace: FleetNativeIdSchema,
    // Native FleetSandbox.name is opaque returned data, not a claim-route input.
    claimId: FleetNativeIdSchema, sandboxId: defineProtocolString({ minLength: 1 }).optional() }, { policy: 'closed' });
export type FleetResourceV1 = ProtocolSchemaOutput<typeof FleetResourceV1Schema>;

// External native read projections drop vendor additions. Only these known facts
// leave the decoder; native JSON, credentials, addresses and service URLs do not.
export const NativeCloudResourceSchema = z.object({
    provider: z.enum(['aws', 'gcp', 'modal']), id, type: id,
    sandbox: z.string(), machine: z.string(), region: z.string(), state: z.string(),
    expires: z.string(), expired: z.boolean(),
});
export const NativeCloudProviderSchema = z.object({
    name: z.enum(['aws', 'gcp', 'modal']), connected: z.boolean(), region: z.string(),
    ttl_hours: z.number().check(z.int(), z.minimum(0), z.maximum(4_294_967_295)),
    kinds: z.array(z.object({ image: id, supported: z.boolean(), machine_type: id,
        usd_per_hour: z.number().check(z.minimum(0)) })),
});

const nativeDate = z.iso.datetime({ offset: true });
export const NativeFleetClaimSchema = z.object({
    metadata: z.object({ name: id, namespace: id,
        creationTimestamp: z.optional(nativeDate), deletionTimestamp: z.optional(nativeDate) }),
    spec: z.object({ sandboxTemplateRef: z.object({ name: id }),
        secretRef: z.optional(z.object({ name: id })),
        warmpool: z.optional(z.string()), ttlSecondsAfterCreated: z.optional(z.number().check(z.int(), z.minimum(0), z.maximum(4_294_967_295))),
        lifecycle: z.optional(z.object({ shutdownTime: z.optional(nativeDate), autoRenew: z.optional(z.boolean()) })) }),
    status: z.optional(z.object({ phase: z.optional(z.string()),
        sandbox: z.optional(z.object({ name: z.optional(id) })) })),
});
export const NativeFleetClaimRecordSchema = z.object({ name: id, namespace: id, json: z.string() });
export const NativeFleetSandboxSchema = z.object({ name: id, namespace: id, claim: id, services: z.array(id) });

export const NativeFleetPoolSchema = z.object({
    metadata: z.object({ name: id, namespace: id }),
    spec: z.object({ sandboxTemplateRef: z.object({ name: id }) }),
});
export const NativeFleetTemplateSchema = z.object({
    metadata: z.object({ name: id, namespace: id }),
    spec: z.object({ vmTemplate: z.object({
        containerDiskImage: id, runtime: z.optional(z.enum(['kubevirt', 'gvisor', 'macos'])),
        cpuCores: z.optional(z.number().check(z.int(), z.minimum(1))), memory: z.optional(id),
        services: z.optional(z.array(z.object({ name: id,
            targetPort: z.optional(z.number().check(z.int(), z.minimum(1), z.maximum(65535))) }))),
    }) }),
});
