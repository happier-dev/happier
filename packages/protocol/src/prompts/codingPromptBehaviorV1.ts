import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

export const CodingPromptBehaviorModeV1Schema = lazyZodSchema(() => z.enum(['agent', 'disabled']));
export type CodingPromptBehaviorModeV1 = z.infer<typeof CodingPromptBehaviorModeV1Schema>;

export const CodingPromptSessionTitleUpdatesModeV1Schema = lazyZodSchema(() => z.enum(['disabled', 'initial', 'ongoing']));
export type CodingPromptSessionTitleUpdatesModeV1 = z.infer<typeof CodingPromptSessionTitleUpdatesModeV1Schema>;

const CodingPromptSessionTitleUpdatesInputV1Schema = lazyZodSchema(() => z.pipe(z
  .enum(['agent', 'disabled', 'initial', 'ongoing']), z.transform((mode): CodingPromptSessionTitleUpdatesModeV1 => (mode === 'agent' ? 'ongoing' : mode))));

export const CodingPromptBehaviorV1Schema = lazyZodSchema(() => z.catch(z
  .object({
    v: z._default(z.literal(1), 1),
    sessionTitleUpdates: z._default(CodingPromptSessionTitleUpdatesInputV1Schema, 'initial'),
    sessionCompactionNudge: z._default(z.boolean(), false),
    responseOptions: z._default(CodingPromptBehaviorModeV1Schema, 'agent'),
  }), {
    v: 1,
    sessionTitleUpdates: 'initial',
    sessionCompactionNudge: false,
    responseOptions: 'agent',
  }));

export type CodingPromptBehaviorV1 = z.infer<typeof CodingPromptBehaviorV1Schema>;

/**
 * Sparse override of the Account coding-prompt behavior. Every key is
 * optional and an absent key inherits the Account value rather than
 * restating it, so an Account-level change still reaches an owner that
 * never expressed an opinion. This carries no prompt text: profile-specific
 * system stacks are owned by `PromptStacksV1.surfaces.profilesById`.
 */
export const CodingPromptBehaviorOverridesV1Schema = lazyZodSchema(() => z.strictObject({
    sessionTitleUpdates: z.optional(CodingPromptSessionTitleUpdatesInputV1Schema),
    responseOptions: z.optional(CodingPromptBehaviorModeV1Schema),
  }));

export type CodingPromptBehaviorOverridesV1 = z.infer<typeof CodingPromptBehaviorOverridesV1Schema>;

/**
 * Reader-only shape persisted on legacy AI launch profiles by the moving
 * remote-dev predecessor. New V2 profiles write
 * `codingPromptBehaviorOverrides` instead. Keep this while supported stored
 * legacy profiles can carry the predecessor field.
 */
export const HistoricalCodingPromptBehaviorProfileOverrideV1Schema = lazyZodSchema(() => z.catch(z
  .object({
    v: z._default(z.literal(1), 1),
    sessionTitleUpdates: z.optional(CodingPromptSessionTitleUpdatesInputV1Schema),
    responseOptions: z.optional(CodingPromptBehaviorModeV1Schema),
  }), { v: 1 }));

export type HistoricalCodingPromptBehaviorProfileOverrideV1 = z.infer<
  typeof HistoricalCodingPromptBehaviorProfileOverrideV1Schema
>;

/** Projects the legacy persisted shape onto the canonical sparse V2 semantics. */
export function projectHistoricalCodingPromptBehaviorProfileOverrideV1(
  override: HistoricalCodingPromptBehaviorProfileOverrideV1 | null | undefined,
): CodingPromptBehaviorOverridesV1 | undefined {
  if (!override) return undefined;
  const projected: CodingPromptBehaviorOverridesV1 = {};
  if (override.sessionTitleUpdates !== undefined) {
    projected.sessionTitleUpdates = override.sessionTitleUpdates;
  }
  if (override.responseOptions !== undefined) {
    projected.responseOptions = override.responseOptions;
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

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

export function isCodingPromptResponseOptionsEnabled(settingsLike: unknown): boolean {
  return resolveCodingPromptBehaviorV1(settingsLike).responseOptions === 'agent';
}
