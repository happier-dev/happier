import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const FrameBridgeIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  instanceId: z.string().check(z.trim(), z.minLength(1)),
  mountNonce: z.string().check(z.trim(), z.minLength(1)),
}));
export type FrameBridgeIdentityV1 = z.infer<typeof FrameBridgeIdentityV1Schema>;

export function wireIdentitiesEqual(expected: FrameBridgeIdentityV1, actual: FrameBridgeIdentityV1): boolean {
  return expected.instanceId === actual.instanceId && expected.mountNonce === actual.mountNonce;
}

/** Exact WHATWG origin; renderer-specific custom schemes belong in their adapter. */
export function isExactBridgeOriginV1(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.origin === value && parsed.origin !== 'null';
  } catch {
    return false;
  }
}

export const FrameBridgeEnvelopeBaseV1Schema = lazyZodSchema(() => z.strictObject({
  version: z.literal(1),
  identity: FrameBridgeIdentityV1Schema,
  sequence: z.number().check(z.int(), z.nonnegative()),
}));
export type FrameBridgeEnvelopeBaseV1 = z.infer<typeof FrameBridgeEnvelopeBaseV1Schema>;

export const FrameBridgeResponseKindV1Schema = lazyZodSchema(() => z.enum(['ack', 'result', 'error']));
export type FrameBridgeResponseKindV1 = z.infer<typeof FrameBridgeResponseKindV1Schema>;
export const FrameBridgeResponseEnvelopeBaseV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(FrameBridgeEnvelopeBaseV1Schema, {
  requestSequence: z.number().check(z.int(), z.nonnegative()),
  kind: FrameBridgeResponseKindV1Schema,
})));
export type FrameBridgeResponseEnvelopeBaseV1 = z.infer<typeof FrameBridgeResponseEnvelopeBaseV1Schema>;

export const FrameBridgeHostToFrameEnvelopeBaseV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(FrameBridgeEnvelopeBaseV1Schema, {
  direction: z.literal('hostToFrame'),
})));
export type FrameBridgeHostToFrameEnvelopeBaseV1 = z.infer<typeof FrameBridgeHostToFrameEnvelopeBaseV1Schema>;
