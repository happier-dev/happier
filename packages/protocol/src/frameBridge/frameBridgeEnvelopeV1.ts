import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const FrameBridgeIdentityV1Schema = lazyZodSchema(() => z.object({
  instanceId: z.string().trim().min(1),
  mountNonce: z.string().trim().min(1),
}).strict());
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

export const FrameBridgeEnvelopeBaseV1Schema = lazyZodSchema(() => z.object({
  version: z.literal(1),
  identity: FrameBridgeIdentityV1Schema,
  sequence: z.number().int().nonnegative(),
}).strict());
export type FrameBridgeEnvelopeBaseV1 = z.infer<typeof FrameBridgeEnvelopeBaseV1Schema>;

export const FrameBridgeResponseKindV1Schema = lazyZodSchema(() => z.enum(['ack', 'result', 'error']));
export type FrameBridgeResponseKindV1 = z.infer<typeof FrameBridgeResponseKindV1Schema>;
export const FrameBridgeResponseEnvelopeBaseV1Schema = lazyZodSchema(() => FrameBridgeEnvelopeBaseV1Schema.extend({
  requestSequence: z.number().int().nonnegative(),
  kind: FrameBridgeResponseKindV1Schema,
}).strict());
export type FrameBridgeResponseEnvelopeBaseV1 = z.infer<typeof FrameBridgeResponseEnvelopeBaseV1Schema>;

export const FrameBridgeHostToFrameEnvelopeBaseV1Schema = lazyZodSchema(() => FrameBridgeEnvelopeBaseV1Schema.extend({
  direction: z.literal('hostToFrame'),
}).strict());
export type FrameBridgeHostToFrameEnvelopeBaseV1 = z.infer<typeof FrameBridgeHostToFrameEnvelopeBaseV1Schema>;
