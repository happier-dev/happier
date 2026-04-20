import { ReviewStartInputSchema, type ReviewStartInput } from '@happier-dev/protocol';

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

  const rawIntentInput = params.intentInput && typeof params.intentInput === 'object' && !Array.isArray(params.intentInput)
    ? params.intentInput as Record<string, unknown>
    : null;

  const fallbackInstructions = String(params.fallbackInstructions ?? '').trim();
  const fallbackEngineIds = ['coderabbit'];
  const normalizedIntentInput = {
    engineIds: fallbackEngineIds,
    instructions: fallbackInstructions,
    ...(rawIntentInput ?? {}),
  } as Record<string, unknown>;

  const rawEngineIds = Array.isArray(normalizedIntentInput.engineIds)
    ? normalizedIntentInput.engineIds
      .flatMap((value) => (typeof value === 'string' && value.trim().length > 0 ? [value.trim()] : []))
    : [];
  normalizedIntentInput.engineIds = rawEngineIds.length > 0 ? rawEngineIds : fallbackEngineIds;

  const instructions = typeof normalizedIntentInput.instructions === 'string'
    ? normalizedIntentInput.instructions.trim()
    : '';
  normalizedIntentInput.instructions = instructions.length > 0 ? instructions : fallbackInstructions;

  return {
    ...ReviewStartInputSchema.parse(normalizedIntentInput),
    engineIds: ['coderabbit'],
  };
}
