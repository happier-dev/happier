import {
  ReviewStartInputSchema,
  type ReviewStartInput,
} from '@happier-dev/plugin-sdk/reviews';

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function normalizeCodeRabbitReviewStartInput(params: Readonly<{
  intentInput: unknown;
  fallbackInstructions: string;
}>): ReviewStartInput {
  const rawIntentInput = readRecord(params.intentInput);
  const fallbackInstructions = String(params.fallbackInstructions ?? '').trim();
  const instructions = typeof rawIntentInput?.instructions === 'string'
    ? rawIntentInput.instructions.trim()
    : '';
  return ReviewStartInputSchema.parse({
    ...(rawIntentInput ?? {}),
    reviewers: [{ kind: 'engine', engineId: 'coderabbit' }],
    instructions: instructions.length > 0 ? instructions : fallbackInstructions,
  });
}
