import * as z from 'zod/mini';
import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString,
    defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const id = z.string().check(z.minLength(1));
// macOS VMs belong to the Lume plugin alone; Cua here owns container and QEMU sandboxes.
const runtimeIds = ['gvisor', 'runc', 'qemu'] as const;
export const CuaLocalRuntimeSchema = defineProtocolUnion([
    defineProtocolLiteral(runtimeIds[0]), defineProtocolLiteral(runtimeIds[1]), defineProtocolLiteral(runtimeIds[2]),
]);
const closed = { policy: 'closed' } as const;
const nativeId = defineProtocolString({ minLength: 1 });
// These are native u32 CPU and integral byte/MB boundaries, not host quotas.
const bytes = defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
// Native StateStore::path rejects separator-bearing and dot-prefixed names;
// SandboxRef::valid_name additionally rejects ':' and whitespace. No local cap.
// JavaScript $ alone also matches before a final newline; require actual EOF.
const namePattern = /^(?!\.)[^:\s/\\\0]+$(?![\s\S])/u;
const localIdPattern = /^local:(?!\.)[^:\s/\\\0]+$(?![\s\S])/u;
export const CuaLocalNameSchema = defineProtocolString({ minLength: 1, pattern: namePattern.source });
const localId = defineProtocolString({ minLength: 1, pattern: localIdPattern.source });
export const CuaLocalSizeV1Schema = defineProtocolObject({ cpu: defineProtocolNumber({ integer: true, minimum: 1, maximum: 4_294_967_295 }),
    memoryBytes: bytes, diskBytes: bytes }, closed);
// A query omits the disk to take the chosen image's own: the native disk follows the image, so asking for it is not a person's input.
export const CuaLocalOptionsSizeV1Schema = defineProtocolObject({ cpu: defineProtocolNumber({ integer: true, minimum: 1, maximum: 4_294_967_295 }),
    memoryBytes: bytes, diskBytes: bytes.optional() }, closed);
export const CuaLocalOptionsQueryV1Schema = defineProtocolObject({
    runtimeId: CuaLocalRuntimeSchema.optional(), imageId: nativeId.optional(), size: CuaLocalOptionsSizeV1Schema.optional(),
}, closed);
export type CuaLocalOptionsQueryV1 = ProtocolSchemaOutput<typeof CuaLocalOptionsQueryV1Schema>;
const localLaunch = {
    on: defineProtocolLiteral('local'), runtimeId: CuaLocalRuntimeSchema, imageId: nativeId,
    size: CuaLocalSizeV1Schema,
};
export const CuaLocalBaseLaunchV1Schema = defineProtocolObject(localLaunch, closed);
export const CuaLocalLaunchV1Schema = defineProtocolObject({ ...localLaunch,
    preparedOperationId: CuaLocalNameSchema.optional(),
}, closed);
export type CuaLocalLaunchV1 = ProtocolSchemaOutput<typeof CuaLocalLaunchV1Schema>;
export const CuaLocalResourceV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('sandbox'), namespace: defineProtocolLiteral('local'),
        runtimeId: CuaLocalRuntimeSchema, sandboxId: localId }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('space'), spaceId: localId, sandboxId: localId,
        runtimeId: CuaLocalRuntimeSchema }, closed),
]);
export type CuaLocalResourceV1 = ProtocolSchemaOutput<typeof CuaLocalResourceV1Schema>;

// Portable grammar cannot express cross-field equality. All native operation
// owners consume this single resource admission before any read or effect.
export function parseCuaLocalResource(input: unknown): CuaLocalResourceV1 {
    const resource = CuaLocalResourceV1Schema.parse(input);
    if (resource.kind === 'space' && resource.spaceId !== resource.sandboxId) {
        throw new Error('A created local Space requires its exact sandbox identity');
    }
    return resource;
}

// Native read projections discard additions and all private endpoint/auth data.
// They use the same native name/runtime vocabulary as portable declarations.
// One decoder per `cua --json` shape serves both local and BYOC routes.
const nativeLocalId = id.check(z.regex(localIdPattern));
const sandboxInfo = { image: z.nullable(id), status: id, state: id, ephemeral: z.boolean() };
/** `sandbox info` on a local route: runtime-qualified, no provider fields. */
export const CuaNativeSandboxSchema = z.object({ ...sandboxInfo, id: nativeLocalId, name: id.check(z.regex(namePattern)),
    location: z.literal('local'), runtime: z.enum(runtimeIds), kind: z.enum(['vm', 'container']) });
/** `sandbox info` on a BYOC route: the native provider record and expiry instead of a local runtime. */
export const CuaNativeCloudSandboxSchema = z.object({ ...sandboxInfo, id: z.string(), name: z.string(), location: z.string(),
    expires_at: z.nullable(z.iso.datetime({ offset: true })),
    provider_details: z.object({ provider: z.enum(['aws', 'gcp', 'modal']), id: id }) });
export const CuaNativeDeleteSchema = z.object({ deleted: z.string(), missing: z.boolean() });
/** `spaces ls` / `spaces add` rows. */
export const CuaNativeSpaceSchema = z.object({ id: z.string(), provider: z.string(), image: z.optional(z.string()) });
export const CuaNativeSpaceRegistrySchema = z.object({ spaces: z.array(CuaNativeSpaceSchema) });
/** The catalog row fields every image read shares (`images ls` / `images info`). */
export const CuaNativeImageRefSchema = z.object({ ref: id, published: z.boolean() });
