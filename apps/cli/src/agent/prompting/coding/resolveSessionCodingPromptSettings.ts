import { applyCodingPromptBehaviorOverrideToSettings } from '@happier-dev/protocol';

import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';

/**
 * Single merge owner for a session's resolved coding-prompt behavior settings.
 *
 * Takes the raw account settings and the session's selected profile id, resolves the
 * selected custom profile's `codingPromptBehaviorV1` override (if any), and returns the
 * settings record with the override merged over the global `codingPromptBehaviorV1`.
 *
 * Every consumer derived from this decision — base prompt blocks, the shell-bridge
 * tool-delivery appendix, and the pi tools-bridge backend options — must consume the
 * merged record this returns, never the raw global settings, so the prompt's base
 * blocks, its advertised tools, and the bridge's registered tools can never disagree.
 *
 * Resolution is by profile id and non-throwing: an unknown, incompatible, or built-in
 * profile id (or no profile) simply falls back to the global default.
 */
export function resolveSessionCodingPromptSettings(params: Readonly<{
  settings: Record<string, unknown>;
  profileId: string | null | undefined;
}>): Record<string, unknown> {
  const selectedProfileId = typeof params.profileId === 'string' ? params.profileId.trim() : '';
  const selectedProfileOverride = selectedProfileId
    ? readProfilesFromAccountSettings(params.settings).customProfiles
        .find((profile) => profile.id === selectedProfileId)?.codingPromptBehaviorV1 ?? null
    : null;
  return applyCodingPromptBehaviorOverrideToSettings({
    settings: params.settings,
    override: selectedProfileOverride,
  });
}

type SessionCodingPromptProfileSource = Readonly<{
  getMetadataSnapshot?: (() => unknown) | null;
}>;

/**
 * Resolves effective coding-prompt settings at session-owned runtime boundaries.
 * Compatibility session implementations may not expose a metadata snapshot reader,
 * so absence or malformed metadata intentionally falls back to Account behavior.
 */
export function resolveSessionCodingPromptSettingsFromSession(params: Readonly<{
  settings: Record<string, unknown>;
  session: SessionCodingPromptProfileSource;
}>): Record<string, unknown> {
  const metadata = params.session.getMetadataSnapshot?.();
  const profileId = metadata && typeof metadata === 'object' && 'profileId' in metadata
    ? metadata.profileId
    : null;

  return resolveSessionCodingPromptSettings({
    settings: params.settings,
    profileId: typeof profileId === 'string' ? profileId : null,
  });
}
