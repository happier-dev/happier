import type { AIBackendProfile } from './backendProfileSchema.js';
import {
  projectHistoricalCodingPromptBehaviorProfileOverrideV1,
  type CodingPromptBehaviorOverridesV1,
} from '../prompts/codingPromptBehaviorV1.js';

const HISTORICAL_GEMINI_PROFILE_IDS = new Set(['gemini-api-key', 'gemini-vertex']);

/**
 * Executable projection of a persisted legacy AI profile. The raw
 * predecessor-only coding-prompt field is admitted by the legacy schema and
 * projected onto the canonical V2 sparse override semantics. It remains on
 * the legacy shape solely so a legacy form can retain its source field during
 * an in-place save; effective behavior consumes only the projected field.
 */
export type HistoricalAiBackendProfileV1 = AIBackendProfile & Readonly<{
  codingPromptBehaviorOverrides?: CodingPromptBehaviorOverridesV1;
}>;

/**
 * Compatibility projection for retained historical Gemini launch profiles.
 * Their generated default was never a user-authored preference, so every
 * parsed copy must lose the obsolete model pin while the raw settings row is
 * preserved for lossless migration and conflict handling.
 */
export function projectHistoricalBuiltInAiLaunchProfileV1(profile: AIBackendProfile): HistoricalAiBackendProfileV1 {
  const codingPromptBehaviorOverrides = projectHistoricalCodingPromptBehaviorProfileOverrideV1(
    profile.codingPromptBehaviorV1,
  );
  const projected: HistoricalAiBackendProfileV1 = {
    ...profile,
    ...(codingPromptBehaviorOverrides !== undefined ? { codingPromptBehaviorOverrides } : {}),
  };

  if (!HISTORICAL_GEMINI_PROFILE_IDS.has(profile.id)) return projected;
  return {
    ...projected,
    environmentVariables: projected.environmentVariables.filter((entry) => entry.name !== 'GEMINI_MODEL'),
  };
}
