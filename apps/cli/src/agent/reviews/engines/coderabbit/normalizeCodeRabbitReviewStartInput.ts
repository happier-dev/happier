import { ReviewStartInputSchema, type ReviewStartInput } from '@happier-dev/protocol';

export function normalizeCodeRabbitReviewStartInput(params: Readonly<{
  intentInput: unknown;
  fallbackInstructions: string;
}>): ReviewStartInput {
  const parsed = ReviewStartInputSchema.safeParse(params.intentInput ?? {});
  if (parsed.success) return parsed.data;

  const rawIntentInput = params.intentInput && typeof params.intentInput === 'object' && !Array.isArray(params.intentInput)
    ? params.intentInput as Record<string, unknown>
    : null;

  return ReviewStartInputSchema.parse({
    engineIds: ['coderabbit'],
    instructions: params.fallbackInstructions,
    ...(rawIntentInput ?? {}),
  });
}

