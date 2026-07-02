import {
  ReviewStartInputSchema,
  type ReviewStartInput,
} from '@happier-dev/protocol';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeCodeRabbitReviewStartInput(params: Readonly<{
  intentInput: unknown;
  fallbackInstructions: string;
}>): ReviewStartInput {
  const parsed = ReviewStartInputSchema.safeParse(params.intentInput ?? {});
  if (parsed.success) {
    return {
      ...parsed.data,
      engineIds: ['coderabbit'],
    };
  }

  const rawIntentInput = readRecord(params.intentInput);
  const fallbackInstructions = String(params.fallbackInstructions ?? '').trim();
  const normalizedIntentInput = {
    engineIds: ['coderabbit'],
    instructions: fallbackInstructions,
    ...(rawIntentInput ?? {}),
  };

  const instructions = typeof normalizedIntentInput.instructions === 'string'
    ? normalizedIntentInput.instructions.trim()
    : '';
  const parsedFallback = ReviewStartInputSchema.parse({
    ...normalizedIntentInput,
    engineIds: ['coderabbit'],
    instructions: instructions.length > 0 ? instructions : fallbackInstructions,
  });

  return {
    ...parsedFallback,
    engineIds: ['coderabbit'],
  };
}
