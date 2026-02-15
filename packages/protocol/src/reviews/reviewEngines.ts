import { z } from 'zod';

export const NativeReviewEngineIdSchema = z.enum(['coderabbit']);
export type NativeReviewEngineId = z.infer<typeof NativeReviewEngineIdSchema>;

export const NativeReviewEngineSpecSchema = z
  .object({
    id: NativeReviewEngineIdSchema,
    title: z.string().min(1),
  })
  .strict();
export type NativeReviewEngineSpec = z.infer<typeof NativeReviewEngineSpecSchema>;

const NATIVE_REVIEW_ENGINES: readonly NativeReviewEngineSpec[] = Object.freeze([
  { id: 'coderabbit', title: 'CodeRabbit' },
]);

export function listNativeReviewEngines(): readonly NativeReviewEngineSpec[] {
  return NATIVE_REVIEW_ENGINES;
}

export function getNativeReviewEngine(id: string): NativeReviewEngineSpec | null {
  const key = String(id ?? '').trim();
  if (!key) return null;
  return NATIVE_REVIEW_ENGINES.find((e) => e.id === key) ?? null;
}

