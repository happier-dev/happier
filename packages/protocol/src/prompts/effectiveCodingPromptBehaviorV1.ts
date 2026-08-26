import { readAiLaunchProfileCollection } from '../profiles/read.js';
import {
  applyCodingPromptBehaviorOverridesV1,
  resolveCodingPromptBehaviorV1,
  type CodingPromptBehaviorV1,
} from './codingPromptBehaviorV1.js';

/**
 * The single owner of coding-prompt behavior resolution for a session.
 *
 * Order: Account default, then the selected Launch Profile's sparse override.
 * A hard runtime/capability constraint (for example a tool-delivery mode that
 * moves title guidance into the tool appendix) is applied by the caller that
 * owns that constraint, on top of this result — never inside a profile.
 *
 * Callers pass the same Account settings object they already hold; the profile
 * is read through the canonical launch-profile collection reader so no second
 * profile parser exists.
 */
export function resolveEffectiveCodingPromptBehaviorV1(params: Readonly<{
  settings: unknown;
  profileId?: string | null | undefined;
}>): CodingPromptBehaviorV1 {
  const base = resolveCodingPromptBehaviorV1(params.settings);
  const profileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';
  if (!profileId) return base;
  const record = params.settings && typeof params.settings === 'object' && !Array.isArray(params.settings)
    ? (params.settings as Record<string, unknown>)
    : null;
  if (!record) return base;
  for (const entry of readAiLaunchProfileCollection(record.profiles).entries) {
    if (entry.kind === 'opaque' || entry.profile.id !== profileId) continue;
    return applyCodingPromptBehaviorOverridesV1(base, entry.profile.codingPromptBehaviorOverrides);
  }
  return base;
}
