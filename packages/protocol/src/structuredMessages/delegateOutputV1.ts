import { z } from 'zod';

/**
 * Structured payload emitted by execution runs with `intent='delegate'`.
 *
 * This is intentionally lightweight in V1: it's a bounded list of deliverables
 * and a summary suitable for quickly feeding back into the parent session.
 */

export const DelegateDeliverableV1Schema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(400),
  details: z.string().max(20_000).optional(),
}).passthrough();
export type DelegateDeliverableV1 = z.infer<typeof DelegateDeliverableV1Schema>;

export const DelegateOutputV1Schema = z.object({
  runRef: z.object({
    runId: z.string().min(1),
    callId: z.string().min(1),
    backendId: z.string().min(1),
  }).passthrough(),
  summary: z.string().min(1).max(20_000),
  deliverables: z.array(DelegateDeliverableV1Schema).max(200),
  generatedAtMs: z.number().int().nonnegative(),
}).passthrough();
export type DelegateOutputV1 = z.infer<typeof DelegateOutputV1Schema>;

export function parseDelegateOutputV1(input: unknown): DelegateOutputV1 | null {
  const parsed = DelegateOutputV1Schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

