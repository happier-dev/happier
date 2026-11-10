import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { MemoryCitationV1Schema, MemoryExternalTranscriptSourceV1Schema } from './memorySearch.js';

export const MemoryExternalWindowRequestV1Schema = lazyZodSchema(() => z.strictObject({
  source: MemoryExternalTranscriptSourceV1Schema,
  sourceItemId: z.string().check(z.minLength(1)),
  cursor: z.optional(z.string().check(z.minLength(1))),
}));
export type MemoryExternalWindowRequestV1 = z.infer<typeof MemoryExternalWindowRequestV1Schema>;

export const MemoryWindowRequestV1Schema = lazyZodSchema(() => z.union([
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(MemoryExternalWindowRequestV1Schema, { v: z.optional(z.literal(1)) })),
  z.looseObject({
    source: z.optional(z.never()),
    v: z.optional(z.literal(1)), sessionId: z.string().check(z.minLength(1)),
    seqFrom: z.number().check(z.int(), z.nonnegative()), seqTo: z.number().check(z.int(), z.nonnegative()),
  }).check(z.refine(value => value.seqFrom <= value.seqTo, {
    path: ['seqFrom'], message: 'seqFrom must be <= seqTo',
  })),
]));
export type MemoryWindowRequestV1 = z.infer<typeof MemoryWindowRequestV1Schema>;

export const MemoryExternalSnippetV1Schema = lazyZodSchema(() => z.strictObject({
  source: MemoryExternalTranscriptSourceV1Schema,
  sourceItemId: z.string().check(z.minLength(1)), cursor: z.optional(z.string().check(z.minLength(1))),
  createdAtMs: z.number().check(z.int(), z.nonnegative()), text: z.string().check(z.minLength(1)),
}));
export type MemoryExternalSnippetV1 = z.infer<typeof MemoryExternalSnippetV1Schema>;

export const MemorySnippetV1Schema = lazyZodSchema(() => z.looseObject({
  sessionId: z.string().check(z.minLength(1)),
  seqFrom: z.number().check(z.int(), z.minimum(0)),
  seqTo: z.number().check(z.int(), z.minimum(0)),
  createdAtFromMs: z.number().check(z.int(), z.minimum(0)),
  createdAtToMs: z.number().check(z.int(), z.minimum(0)),
  text: z.string().check(z.minLength(1)),
}).check(z.superRefine((value, ctx) => {
  if (value.seqFrom > value.seqTo) {
    ctx.addIssue({ code: "custom", message: 'seqFrom must be <= seqTo', path: ['seqFrom'] });
  }
  if (value.createdAtFromMs > value.createdAtToMs) {
    ctx.addIssue({ code: "custom", message: 'createdAtFromMs must be <= createdAtToMs', path: ['createdAtFromMs'] });
  }
})));
export type MemorySnippetV1 = z.infer<typeof MemorySnippetV1Schema>;

export const MemoryWindowV1Schema = lazyZodSchema(() => z.looseObject({
  v: z.literal(1),
  snippets: z.array(MemorySnippetV1Schema),
  citations: z.array(MemoryCitationV1Schema),
  externalSnippets: z.optional(z.array(MemoryExternalSnippetV1Schema)),
}));

export type MemoryWindowV1 = z.infer<typeof MemoryWindowV1Schema>;
