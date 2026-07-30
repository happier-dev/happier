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

// Override schema for per-profile overrides (partial, no field defaults)
export const CodingPromptBehaviorOverrideV1Schema = z.object({
  v: z.literal(1).default(1),
  sessionTitleUpdates: CodingPromptSessionTitleUpdatesInputV1Schema.optional(),
  responseOptions: CodingPromptBehaviorModeV1Schema.optional(),
}).catch({ v: 1 });

export type CodingPromptBehaviorOverrideV1 = z.infer<typeof CodingPromptBehaviorOverrideV1Schema>;

// Merge resolver: global defaults; override fields win when set; v from global
export function resolveCodingPromptBehaviorV1WithOverride(params: {
  settingsLike: unknown;
  override?: CodingPromptBehaviorOverrideV1 | null;
}): CodingPromptBehaviorV1 {
  const global = resolveCodingPromptBehaviorV1(params.settingsLike);
  
  if (!params.override) {
    return global;
  }

  // Override is an object (could be minimal from .catch({ v: 1 }))
  const overrideObj = params.override as Record<string, unknown> | null;
  
  // Build merged result: v always from global, other fields use override if set
  return {
    v: global.v,
    sessionTitleUpdates: (overrideObj?.sessionTitleUpdates ?? global.sessionTitleUpdates) as CodingPromptSessionTitleUpdatesModeV1,
    responseOptions: (overrideObj?.responseOptions ?? global.responseOptions) as CodingPromptBehaviorModeV1,
  };
}

// Settings-record helper: returns { ...settings, codingPromptBehaviorV1: <resolved full object> }
export function applyCodingPromptBehaviorOverrideToSettings(params: {
  settings: Readonly<Record<string, unknown>> | null | undefined;
  override?: CodingPromptBehaviorOverrideV1 | null;
}): Record<string, unknown> {
  if (!params.override) {
    // No override => settings unchanged reference
    return params.settings ?? {};
  }

  const resolved = resolveCodingPromptBehaviorV1WithOverride({
    settingsLike: params.settings,
    override: params.override,
  });

  return { ...params.settings, codingPromptBehaviorV1: resolved };
}
