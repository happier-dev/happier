import { z } from 'zod';

/**
 * Structured meta payload for an encrypted summary shard covering a transcript seq window.
 *
 * Emitted under `meta.happier.kind='session_summary_shard.v1'`.
 *
 * This payload is intentionally self-contained so the daemon can rebuild local indexes
 * from transcript history without re-running the summarizer.
 */
export const SessionSummaryShardV1Schema = z.object({
  v: z.literal(1),
  seqFrom: z.number().int().min(0),
  seqTo: z.number().int().min(0),
  createdAtFromMs: z.number().int().min(0),
  createdAtToMs: z.number().int().min(0),
  summary: z.string().min(1),
  keywords: z.array(z.string().min(1)).default([]),
  entities: z.array(z.string().min(1)).default([]),
  decisions: z.array(z.string().min(1)).default([]),
}).passthrough().superRefine((value, ctx) => {
  if (value.seqFrom > value.seqTo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'seqFrom must be <= seqTo',
      path: ['seqFrom'],
    });
  }
  if (value.createdAtFromMs > value.createdAtToMs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'createdAtFromMs must be <= createdAtToMs',
      path: ['createdAtFromMs'],
    });
  }
});

export type SessionSummaryShardV1 = z.infer<typeof SessionSummaryShardV1Schema>;

