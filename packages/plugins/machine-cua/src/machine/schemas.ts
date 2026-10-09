import * as z from 'zod/mini';
import { defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString,
    defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const id = z.string().check(z.minLength(1));
const runtimeIds = ['gvisor', 'runc', 'qemu', 'lume'] as const;
export const CuaLocalRuntimeSchema = defineProtocolUnion([
    defineProtocolLiteral(runtimeIds[0]), defineProtocolLiteral(runtimeIds[1]),
    defineProtocolLiteral(runtimeIds[2]), defineProtocolLiteral(runtimeIds[3]),
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
export const CuaLocalOptionsQueryV1Schema = defineProtocolObject({
    runtimeId: CuaLocalRuntimeSchema.optional(), imageId: nativeId.optional(), size: CuaLocalSizeV1Schema.optional(),
}, closed);
export type CuaLocalOptionsQueryV1 = ProtocolSchemaOutput<typeof CuaLocalOptionsQueryV1Schema>;
export const CuaLocalLaunchV1Schema = defineProtocolObject({
    on: defineProtocolLiteral('local'), runtimeId: CuaLocalRuntimeSchema, imageId: nativeId,
    size: CuaLocalSizeV1Schema,
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
const nativeLocalId = id.check(z.regex(localIdPattern));
export const CuaNativeSandboxSchema = z.object({
    id: nativeLocalId, name: id.check(z.regex(namePattern)), location: z.literal('local'), runtime: z.enum(runtimeIds),
    kind: z.enum(['vm', 'container']), image: z.nullable(id), status: id, state: id, ephemeral: z.boolean(),
});
export const CuaNativeDeleteSchema = z.object({ deleted: nativeLocalId, missing: z.boolean() });
