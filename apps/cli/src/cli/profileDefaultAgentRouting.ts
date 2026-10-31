import {
  getProfileDefaultBackendTarget,
  isProfileCompatibleWithBackendTarget,
  resolveBackendProfile,
  type AIBackendProfile,
} from '@happier-dev/protocol';

import type { Credentials } from '@/persistence';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { readProfilesFromAccountSettings } from '@/settings/profiles/readProfilesFromAccountSettings';
import { logger } from '@/ui/logger';

/**
 * Custom backend profiles for profile routing, read from the cached account-settings
 * snapshot. Routing is best-effort: failures degrade to built-in profiles only.
 */
export async function fetchCustomProfilesForProfileRouting(credentials: Credentials): Promise<ReadonlyArray<AIBackendProfile>> {
  try {
    const snapshot = await bootstrapAccountSettingsContext({ credentials, mode: 'fast' });
    return readProfilesFromAccountSettings(snapshot.settings as Readonly<Record<string, unknown>>).customProfiles;
  } catch (error) {
    logger.debug('[profile-routing] account settings bootstrap failed; routing on built-in profiles only', error);
    return [];
  }
}

/**
 * Reads the profile flag value from bare `happier ...` args, mirroring the session-start
 * flag spellings (`--profile`/`--launch-profile`, space or `=` separated).
 */
export function readProfileQueryFromArgs(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--profile' || arg === '--launch-profile') {
      const value = args[index + 1];
      if (typeof value !== 'string' || value.length === 0 || value.startsWith('-')) return null;
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (arg.startsWith('--profile=') || arg.startsWith('--launch-profile=')) {
      const value = arg.slice(arg.indexOf('=') + 1).trim();
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/**
 * The built-in agent a bare `happier --profile <query>` start should run, or null when the
 * root command must keep its default backend. Only routes to a default target the profile
 * itself allows; unresolved or ambiguous profiles and non-built-in-agent defaults return
 * null so the ordinary session-start path keeps reporting the underlying profile error.
 */
export async function resolveProfileRoutedAgentId(params: Readonly<{
  profileQuery: string;
  fetchCustomProfiles: () => Promise<ReadonlyArray<AIBackendProfile>>;
}>): Promise<string | null> {
  const customProfiles = await params.fetchCustomProfiles();
  const resolved = resolveBackendProfile({ query: params.profileQuery, customProfiles });
  if (!resolved.ok) return null;

  const defaultTarget = getProfileDefaultBackendTarget(resolved.profile);
  if (!defaultTarget || defaultTarget.kind !== 'builtInAgent') return null;
  if (!isProfileCompatibleWithBackendTarget(resolved.profile, defaultTarget)) return null;
  return defaultTarget.agentId;
}

/**
 * The agent id a session-create (or bare root) invocation should run when a profile is
 * requested and no explicit backend was chosen, or null to keep the default backend.
 */
export async function resolveProfileRoutedAgentIdFromSettings(params: Readonly<{
  profileQuery: string;
  credentials: Credentials | null;
  fetchCustomProfiles?: (credentials: Credentials) => Promise<ReadonlyArray<AIBackendProfile>>;
}>): Promise<string | null> {
  if (!params.credentials) return null;
  const fetchCustomProfiles = params.fetchCustomProfiles ?? fetchCustomProfilesForProfileRouting;
  try {
    return await resolveProfileRoutedAgentId({
      profileQuery: params.profileQuery,
      fetchCustomProfiles: () => fetchCustomProfiles(params.credentials!),
    });
  } catch (error) {
    // Routing is best-effort; the session-start path owns profile error reporting.
    logger.debug('[profile-routing] failed; using the default backend', error);
    return null;
  }
}
