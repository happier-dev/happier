import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { MemoryCitationV1Schema, MemoryExternalTranscriptSourceV1Schema } from './memorySearch.js';

export const MemoryExternalWindowRequestV1Schema = lazyZodSchema(() => z.object({
  source: MemoryExternalTranscriptSourceV1Schema,
  sourceItemId: z.string().min(1),
  cursor: z.string().min(1).optional(),
}).strict());
export type MemoryExternalWindowRequestV1 = z.infer<typeof MemoryExternalWindowRequestV1Schema>;

export const MemoryWindowRequestV1Schema = lazyZodSchema(() => z.union([
  MemoryExternalWindowRequestV1Schema.extend({ v: z.literal(1).optional() }).strict(),
  z.object({
    source: z.never().optional(),
    v: z.literal(1).optional(), sessionId: z.string().min(1),
    seqFrom: z.number().int().nonnegative(), seqTo: z.number().int().nonnegative(),
  }).passthrough().refine(value => value.seqFrom <= value.seqTo, {
    path: ['seqFrom'], message: 'seqFrom must be <= seqTo',
  }),
]));
export type MemoryWindowRequestV1 = z.infer<typeof MemoryWindowRequestV1Schema>;

export const MemoryExternalSnippetV1Schema = lazyZodSchema(() => z.object({
  source: MemoryExternalTranscriptSourceV1Schema,
  sourceItemId: z.string().min(1), cursor: z.string().min(1).optional(),
  createdAtMs: z.number().int().nonnegative(), text: z.string().min(1),
}).strict());
export type MemoryExternalSnippetV1 = z.infer<typeof MemoryExternalSnippetV1Schema>;

export const MemorySnippetV1Schema = lazyZodSchema(() => z.object({
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
}));
export type MemorySnippetV1 = z.infer<typeof MemorySnippetV1Schema>;

export const MemoryWindowV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  snippets: z.array(MemorySnippetV1Schema),
  citations: z.array(MemoryCitationV1Schema),
  externalSnippets: z.array(MemoryExternalSnippetV1Schema).optional(),
}).passthrough());

export type MemoryWindowV1 = z.infer<typeof MemoryWindowV1Schema>;
