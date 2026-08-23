import { z } from 'zod';

export const CodingPromptBehaviorModeV1Schema = z.enum(['agent', 'disabled']);
export type CodingPromptBehaviorModeV1 = z.infer<typeof CodingPromptBehaviorModeV1Schema>;

export const CodingPromptSessionTitleUpdatesModeV1Schema = z.enum(['disabled', 'initial', 'ongoing']);
export type CodingPromptSessionTitleUpdatesModeV1 = z.infer<typeof CodingPromptSessionTitleUpdatesModeV1Schema>;

const CodingPromptSessionTitleUpdatesInputV1Schema = z
  .enum(['agent', 'disabled', 'initial', 'ongoing'])
  .transform((mode): CodingPromptSessionTitleUpdatesModeV1 => (mode === 'agent' ? 'ongoing' : mode));

export const CodingPromptBehaviorV1Schema = z
  .object({
    v: z.literal(1).default(1),
    sessionTitleUpdates: CodingPromptSessionTitleUpdatesInputV1Schema.default('ongoing'),
    responseOptions: CodingPromptBehaviorModeV1Schema.default('agent'),
  })
  .catch({
    v: 1,
    sessionTitleUpdates: 'ongoing',
    responseOptions: 'agent',
  });

export type CodingPromptBehaviorV1 = z.infer<typeof CodingPromptBehaviorV1Schema>;

/**
 * Sparse override of the Account coding-prompt behavior. Every key is
 * optional and an absent key inherits the Account value rather than
 * restating it, so an Account-level change still reaches an owner that
 * never expressed an opinion. This carries no prompt text: profile-specific
 * system stacks are owned by `PromptStacksV1.surfaces.profilesById`.
 */
export const CodingPromptBehaviorOverridesV1Schema = z
  .object({
    sessionTitleUpdates: CodingPromptSessionTitleUpdatesInputV1Schema.optional(),
    responseOptions: CodingPromptBehaviorModeV1Schema.optional(),
  })
  .strict();

export type CodingPromptBehaviorOverridesV1 = z.infer<typeof CodingPromptBehaviorOverridesV1Schema>;

/** Applies a sparse override onto a fully resolved Account behavior. */
export function applyCodingPromptBehaviorOverridesV1(
  base: CodingPromptBehaviorV1,
  overrides: CodingPromptBehaviorOverridesV1 | null | undefined,
): CodingPromptBehaviorV1 {
  if (!overrides) return base;
  return {
    ...base,
    ...(overrides.sessionTitleUpdates === undefined
      ? {}
      : { sessionTitleUpdates: overrides.sessionTitleUpdates }),
    ...(overrides.responseOptions === undefined
      ? {}
      : { responseOptions: overrides.responseOptions }),
  };
}

export const DEFAULT_CODING_PROMPT_BEHAVIOR_V1: CodingPromptBehaviorV1 = Object.freeze(
  CodingPromptBehaviorV1Schema.parse({}),
);

export function resolveCodingPromptBehaviorV1(settingsLike: unknown): CodingPromptBehaviorV1 {
  const rec = settingsLike && typeof settingsLike === 'object' && !Array.isArray(settingsLike)
    ? (settingsLike as Record<string, unknown>)
    : null;
  return CodingPromptBehaviorV1Schema.parse(rec?.codingPromptBehaviorV1);
}

export function resolveCodingPromptSessionTitleUpdatesModeV1(settingsLike: unknown): CodingPromptSessionTitleUpdatesModeV1 {
  return resolveCodingPromptBehaviorV1(settingsLike).sessionTitleUpdates;
}

export function isCodingPromptSessionTitleUpdatesEnabled(settingsLike: unknown): boolean {
  return resolveCodingPromptSessionTitleUpdatesModeV1(settingsLike) !== 'disabled';
}

export function isCodingPromptResponseOptionsEnabled(settingsLike: unknown): boolean {
  return resolveCodingPromptBehaviorV1(settingsLike).responseOptions === 'agent';
}
