import { z } from '../../zodRuntimePolicy.js';

import { lazyZodSchema } from '../../lazyZodSchema.js';

function boundedString(maximumLength: number) {
  return z.string().check(z.minLength(1), z.maxLength(maximumLength), z.refine((value) => value.trim() === value));
}

/** Recovery payloads belong to the named recovery owner and remain opaque here. */
export const ModelPackPromotionIntentV1Schema = lazyZodSchema(() => z.strictObject({
  schemaVersion: z.literal(1),
  packId: z.string(),
  phase: z.enum(['swap_prepared', 'metadata_pending', 'metadata_committed', 'rollback_pending']),
  startedAtMs: z.number().check(z.int(), z.nonnegative()),
  token: boundedString(256),
  priorInstall: z.nullable(z.strictObject({
    scopeKey: boundedString(1024),
    identityKey: boundedString(1024),
  })),
  recovery: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value, context) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'value')) {
      context.issues.push({ code: 'custom', message: 'Recovery records require their own value field', input: context.value });
    }
    return value;
  }), z.nullable(z.strictObject({
    kind: boundedString(256),
    value: z.unknown(),
  }))),
}));
