import { readAiLaunchProfileCollection, type AiLaunchProfile } from '../profiles/read.js';
import type { ArtifactSharingResourceV1 } from '../artifacts/artifactSharingV1.js';
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
 * Current callers supply the admitted Profile projection. The raw collection
 * reader is retained only for callers opening genuine predecessor Settings.
 */
export function resolveEffectiveCodingPromptBehaviorV1(params: Readonly<{
  settings: unknown;
  profileId?: string | null | undefined;
  /** Null is authoritative absence and must never recover from retained Settings. */
  selectedProfile?: AiLaunchProfile | null;
  /** Already-authorized, opened profile documents from the Account Artifact owner. */
  artifactsById?: ReadonlyMap<string, ArtifactSharingResourceV1>;
}>): CodingPromptBehaviorV1 {
  const base = resolveCodingPromptBehaviorV1(params.settings);
  const profileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';
  if (!profileId) return base;
  if (params.selectedProfile !== undefined) {
    return params.selectedProfile?.id === profileId
      ? applyCodingPromptBehaviorOverridesV1(base, params.selectedProfile.codingPromptBehaviorOverrides)
      : base;
  }
  const record = params.settings && typeof params.settings === 'object' && !Array.isArray(params.settings)
    ? (params.settings as Record<string, unknown>)
    : null;
  if (!record) return base;
  for (const entry of readAiLaunchProfileCollection(record.profiles, params.artifactsById
    ? { artifactsById: params.artifactsById, includeShared: true } : undefined).entries) {
    if (entry.kind === 'opaque' || entry.profile.id !== profileId) continue;
    return applyCodingPromptBehaviorOverridesV1(base, entry.profile.codingPromptBehaviorOverrides);
  }
  return base;
}
