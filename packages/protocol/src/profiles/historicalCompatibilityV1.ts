import type { AIBackendProfile } from './backendProfileSchema.js';

const HISTORICAL_GEMINI_PROFILE_IDS = new Set(['gemini-api-key', 'gemini-vertex']);

/**
 * Compatibility projection for retained historical Gemini launch profiles.
 * Their generated default was never a user-authored preference, so every
 * parsed copy must lose the obsolete model pin while the raw settings row is
 * preserved for lossless migration and conflict handling.
 */
export function projectHistoricalBuiltInAiLaunchProfileV1(profile: AIBackendProfile): AIBackendProfile {
  if (!HISTORICAL_GEMINI_PROFILE_IDS.has(profile.id)) return profile;
  return {
    ...profile,
    environmentVariables: profile.environmentVariables.filter((entry) => entry.name !== 'GEMINI_MODEL'),
  };
}
