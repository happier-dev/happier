import * as z from 'zod/mini';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const nativeId = z.int().check(z.gt(0));
const text = z.string().check(z.trim(), z.minLength(1));
const closed = { policy: 'closed' } as const;
const portableText = defineProtocolString({ minLength: 1, pattern: '\\S' });
const portableId = defineProtocolNumber({ integer: true, minimum: 1 });
export const dropletLaunchSchema = defineProtocolObject({
  regionSlug: portableText, sizeSlug: portableText, imageId: defineProtocolUnion([portableId, portableText]),
  publicNetworking: defineProtocolObject({ ipv6: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]) }, closed),
}, closed);
export const dropletResourceSchema = defineProtocolObject({ dropletId: portableId, ownedVolumeIds: defineProtocolArray(portableText) }, closed);
export const dropletNativeOperationSchema = defineProtocolObject({ recoveryTag: portableText }, closed);
// The host derives tolerant stored projections from these declared schemas.
// Leaf role inputs arrive through strict action admission, never stored parsing.
export const bootstrapSshPublicKeySchema = z.string().check(z.regex(/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/=]+(?: [^\r\n]*)?$/));
export const dropletAcquireInputSchema = z.strictObject({
  launch: z.pipe(z.unknown(), z.transform(value => dropletLaunchSchema.parse(value))), name: text, recoveryTag: text, bootstrapSshPublicKey: bootstrapSshPublicKeySchema,
});
export const dropletPowerIntentSchema = z.enum(['start', 'stop']);
export type DropletAcquireInputV1 = z.infer<typeof dropletAcquireInputSchema>;
export type DropletLaunchV1 = ProtocolSchemaOutput<typeof dropletLaunchSchema>;
export type DropletResourceV1 = ProtocolSchemaOutput<typeof dropletResourceSchema>;
const network = z.object({ type: text, ip_address: text });
export const nativeDropletSchema = z.object({
  id: nativeId, name: text, status: text, tags: z._default(z.array(text), []), volume_ids: z._default(z.array(text), []),
  networks: z.optional(z.object({ v4: z._default(z.array(network), []), v6: z._default(z.array(network), []) })),
});
export const nativeActionSchema = z.object({
  id: nativeId, status: z.enum(['in-progress', 'completed', 'errored']), type: text,
  resource_id: nativeId, resource_type: z.literal('droplet'),
});
export const nativeSizeSchema = z.object({
  slug: text, memory: z.number().check(z.gt(0)), vcpus: nativeId, disk: z.number().check(z.gte(0)), transfer: z.number().check(z.gte(0)),
  price_hourly: z.optional(z.nullable(z.number().check(z.gte(0)))), price_monthly: z.optional(z.nullable(z.number().check(z.gte(0)))),
  regions: z.array(text), available: z.boolean(),
});
export const nativeRegionSchema = z.object({ slug: text, name: text, available: z.boolean(), sizes: z.array(text) });
export const nativeImageSchema = z.object({
  id: nativeId, slug: z.optional(z.nullable(text)), name: text, distribution: z.optional(text), regions: z.array(text), status: text, type: text,
  description: z.optional(z.nullable(z.string().check(z.trim()))),
});
export type NativeImage = z.infer<typeof nativeImageSchema>;
