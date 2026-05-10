import { z } from 'zod';

export const CodingPromptBehaviorModeV1Schema = z.enum(['agent', 'disabled']);
export type CodingPromptBehaviorModeV1 = z.infer<typeof CodingPromptBehaviorModeV1Schema>;

export const CodingPromptBehaviorV1Schema = z
  .object({
    v: z.literal(1).default(1),
    sessionTitleUpdates: CodingPromptBehaviorModeV1Schema.default('agent'),
    responseOptions: CodingPromptBehaviorModeV1Schema.default('agent'),
  })
  .catch({
    v: 1,
    sessionTitleUpdates: 'agent',
    responseOptions: 'agent',
  });

export type CodingPromptBehaviorV1 = z.infer<typeof CodingPromptBehaviorV1Schema>;

export const DEFAULT_CODING_PROMPT_BEHAVIOR_V1: CodingPromptBehaviorV1 = Object.freeze(
  CodingPromptBehaviorV1Schema.parse({}),
);

export function resolveCodingPromptBehaviorV1(settingsLike: unknown): CodingPromptBehaviorV1 {
  const rec = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
    ? (settingsLike as Record<string, unknown>)
    : null;
  return CodingPromptBehaviorV1Schema.parse(rec?.codingPromptBehaviorV1);
}

export function isCodingPromptSessionTitleUpdatesEnabled(settingsLike: unknown): boolean {
  return resolveCodingPromptBehaviorV1(settingsLike).sessionTitleUpdates === 'agent';
}

export function isCodingPromptResponseOptionsEnabled(settingsLike: unknown): boolean {
  return resolveCodingPromptBehaviorV1(settingsLike).responseOptions === 'agent';
}
