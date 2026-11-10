import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { MemoryIndexPolicyV1Schema } from '../../memory/memorySettings.js';

/**
 * Structured meta payload for an encrypted summary shard covering a transcript seq window.
 *
 * Emitted under `meta.happier.kind='session_summary_shard.v1'`.
 *
 * This payload is intentionally self-contained so the daemon can rebuild local indexes
 * from transcript history without re-running the summarizer.
 */
export const SessionSummaryShardV1Schema = lazyZodSchema(() => z.looseObject({
  v: z.literal(1),
  seqFrom: z.number().check(z.int(), z.minimum(0)),
  seqTo: z.number().check(z.int(), z.minimum(0)),
  createdAtFromMs: z.number().check(z.int(), z.minimum(0)),
  createdAtToMs: z.number().check(z.int(), z.minimum(0)),
  summary: z.string().check(z.minLength(1)),
  keywords: z._default(z.array(z.string().check(z.minLength(1))), []),
  entities: z._default(z.array(z.string().check(z.minLength(1))), []),
  decisions: z._default(z.array(z.string().check(z.minLength(1))), []),
  memoryPolicy: z.optional(MemoryIndexPolicyV1Schema),
}).check(z.superRefine((value, ctx) => {
  if (value.seqFrom > value.seqTo) {
    ctx.addIssue({
      code: "custom",
      message: 'seqFrom must be <= seqTo',
      path: ['seqFrom'],
    });
  }
  if (value.createdAtFromMs > value.createdAtToMs) {
    ctx.addIssue({
      code: "custom",
      message: 'createdAtFromMs must be <= createdAtToMs',
      path: ['createdAtFromMs'],
    });
  }
})));

export type SessionSummaryShardV1 = z.infer<typeof SessionSummaryShardV1Schema>;
