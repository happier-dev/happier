import { z } from 'zod';

import { MemoryCitationV1Schema } from './memorySearch.js';

export const MemorySnippetV1Schema = z.object({
  sessionId: z.string().min(1),
  seqFrom: z.number().int().min(0),
  seqTo: z.number().int().min(0),
  createdAtFromMs: z.number().int().min(0),
  createdAtToMs: z.number().int().min(0),
  text: z.string().min(1),
}).passthrough().superRefine((value, ctx) => {
  if (value.seqFrom > value.seqTo) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'seqFrom must be <= seqTo', path: ['seqFrom'] });
  }
  if (value.createdAtFromMs > value.createdAtToMs) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'createdAtFromMs must be <= createdAtToMs', path: ['createdAtFromMs'] });
  }
});
export type MemorySnippetV1 = z.infer<typeof MemorySnippetV1Schema>;

export const MemoryWindowV1Schema = z.object({
  v: z.literal(1),
  snippets: z.array(MemorySnippetV1Schema),
  citations: z.array(MemoryCitationV1Schema),
}).passthrough();

export type MemoryWindowV1 = z.infer<typeof MemoryWindowV1Schema>;

