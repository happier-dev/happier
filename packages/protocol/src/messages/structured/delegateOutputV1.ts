import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { ExecutionRunStructuredRunRefSchema } from './executionRunStructuredRunRef.js';
import { SessionUpdatePostInputV1Schema } from '../../sessions/relations/workerUpdateV1.js';

/**
 * Structured payload emitted by execution runs with `intent='delegate'`.
 *
 * This is intentionally lightweight in V1: it's a bounded list of deliverables
 * and a summary suitable for quickly feeding back into the parent session.
 */

export const DelegateDeliverableV1Schema = lazyZodSchema(() => z.looseObject({
  id: z.string().check(z.minLength(1), z.maxLength(200)),
  title: z.string().check(z.minLength(1), z.maxLength(400)),
  details: z.optional(z.string().check(z.maxLength(20_000))),
}));
export type DelegateDeliverableV1 = z.infer<typeof DelegateDeliverableV1Schema>;

export const DelegateOutputV1Schema = lazyZodSchema(() => z.looseObject({
  runRef: ExecutionRunStructuredRunRefSchema,
  summary: z.string().check(z.minLength(1), z.maxLength(20_000)),
  deliverables: z.array(DelegateDeliverableV1Schema).check(z.maxLength(200)),
  workerReport: z.optional(SessionUpdatePostInputV1Schema),
  generatedAtMs: z.number().check(z.int(), z.nonnegative()),
}));
export type DelegateOutputV1 = z.infer<typeof DelegateOutputV1Schema>;

export function parseDelegateOutputV1(input: unknown): DelegateOutputV1 | null {
  const parsed = DelegateOutputV1Schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
