import * as mini from 'zod/mini';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolNumber, defineProtocolObject, defineProtocolString, defineProtocolUnion, type ProtocolSchemaOutput } from '@happier-dev/plugin-sdk/protocol';

const text = () => mini.string().check(mini.trim(), mini.minLength(1));
const closed = { policy: 'closed' } as const;
const portableText = defineProtocolString({ minLength: 1, pattern: '\\S' });
const portableId = defineProtocolNumber({ integer: true, minimum: 1 });
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
export const HetznerLaunchV1Schema = defineProtocolObject({
  serverTypeId: portableText, imageId: portableText, locationId: portableText,
  publicNetworking: defineProtocolObject({ ipv4: boolean, ipv6: boolean }, closed),
}, closed);
export const HetznerResourceV1Schema = defineProtocolObject({
  serverId: portableId, owned: defineProtocolObject({ volumeIds: defineProtocolArray(portableId), primaryIpIds: defineProtocolArray(portableId) }, closed),
}, closed);
// Native label values have a 63-character boundary (REST v1 label contract).
export const HetznerCorrelationSchema = defineProtocolString({ minLength: 1, maxLength: 63, pattern: '^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$' });
export const HetznerNativeOperationV1Schema = defineProtocolObject({ correlation: HetznerCorrelationSchema }, closed);
export const HetznerAcquireV1Schema = mini.strictObject({
  launch: mini.pipe(mini.unknown(), mini.transform(value => HetznerLaunchV1Schema.parse(value))),
  // The native create endpoint owns RFC1123 hostname validation, including dots.
  name: text(),
  correlation: mini.pipe(mini.unknown(), mini.transform(value => HetznerCorrelationSchema.parse(value))),
  bootstrapSshPublicKey: mini.string().check(mini.regex(/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]+)?$/)),
});
export const HetznerPowerIntentSchema = mini.enum(['start', 'stop']);
export type HetznerLaunchV1 = ProtocolSchemaOutput<typeof HetznerLaunchV1Schema>;
export type HetznerResourceV1 = ProtocolSchemaOutput<typeof HetznerResourceV1Schema>;
export type HetznerAcquireV1 = mini.infer<typeof HetznerAcquireV1Schema>;
export class HetznerNativeError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'HetznerNativeError'; }
}
/** Schema issues and vendor error bodies can contain credentials. */
export function parseHetznerValue<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }, value: unknown, code = 'native_input_invalid'): T {
  try {
    const result = schema.safeParse(value);
    if (!result.success) throw new HetznerNativeError(code);
    return result.data;
  } catch { throw new HetznerNativeError(code); }
}
