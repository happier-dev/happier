import { configuration } from '@/configuration';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveServerProfileApiUrl } from '@/configuration/serverSelection';
import { readSettings, readStoredCredentialCustodyForServerId, readStoredCredentials, readStoredCredentialsForServerId } from '@/persistence';
import { validateStoredAuthTokenAgainstServer } from '@/auth/validateStoredAuthTokenAgainstActiveServer';
import { resolveMachineIdForServerFromSettings } from '@/daemon/resolveMachineIdForServerFromSettings';

import type { AuthSignalsForProfile } from './classifyAuth';

/**
 * Assemble auth signals for every configured server profile + the active
 * server URL, using the process selection unless an explicit profile is requested. Machine registration comes
 * only from the account-scoped server-confirmation fact written after the
 * server accepts the local identity; local id allocation alone is not enough.
 *
 * Live-check policy: a stored token is checked for the active profile only.
 * Inactive profile credential files are read locally but never probed over the
 * network; their state is rendered as stored-but-unverified until selected.
 */
export async function resolveDoctorRepairAuthContext(params: Readonly<{
  /**
   * When set, the auth signals are built as if this profile were active —
   * driving live-check, expiry, and `isActive` flags off it instead of
   * the process's runtime selection. Surfaces absence: when no profile matches,
   * `targetProfileExists` is `false`.
   */
  targetServerId: string | null;
} > = { targetServerId: null }): Promise<Readonly<{
  activeServerUrl: string | null;
  authSignals: readonly AuthSignalsForProfile[];
  hasAnyServerProfile: boolean;
  /**
   * `null` when no `targetServerId` was passed (unscoped report).
   * `true` when the requested server profile exists in settings.
   * `false` when the requested server profile is not configured — the
   * caller emits `server_profile_missing` in this case.
   */
  targetProfileExists: boolean | null;
}>> {
  const [settings, credentials] = await Promise.all([
    readSettings().catch(() => null),
    (params.targetServerId === null
      ? readStoredCredentials()
      : readStoredCredentialsForServerId(params.targetServerId)
    ).catch(() => null),
  ]);
  const servers = settings?.servers ?? {};
  const machineIdConfirmedByServerByServerId = settings?.machineIdConfirmedByServerByServerId ?? {};
  const lastTokenSubByServerId = settings?.lastTokenSubByServerId ?? {};
  const profiles = Object.values(servers).filter((p): p is NonNullable<typeof p> => Boolean(p));
  const hasAnyServerProfile = profiles.length > 0;

  // When `--server <id>` is set, the report treats THAT profile as active
  // for the purpose of finding generation. Settings aren't mutated; only
  // the in-memory snapshot used to build this report.
  const effectiveActiveServerId = params.targetServerId ?? configuration.activeServerId;
  const activeProfile = profiles.find((p) => p.id === effectiveActiveServerId) ?? null;
  const targetProfileExists = params.targetServerId === null
    ? null
    : activeProfile !== null;
  const activeServerUrl = params.targetServerId === null
    ? configuration.serverUrl
    : activeProfile?.serverUrl ?? configuration.serverUrl ?? null;
  const signalProfiles = params.targetServerId === null && !activeProfile
    ? [...profiles, { id: effectiveActiveServerId, name: effectiveActiveServerId, serverUrl: configuration.serverUrl }]
    : profiles;

  // Live expiry check for the active profile only. The credentials file is
  // profile-scoped, so `credentials.token` belongs to the selected profile.
  // Reachability tells the renderer whether we actually
  // confirmed the auth state — critical when the relay is down, so users
  // don't see a misleading "signed in" when we couldn't verify.
  const activeToken = String(credentials?.token ?? '').trim();
  let activeCredentialState: AuthSignalsForProfile['credentialState'] = 'missing';
  if ((params.targetServerId === null || activeProfile) && activeToken) {
    const result = await validateStoredAuthTokenAgainstServer({
      baseUrl: normalizeServerHttpBaseUrl(params.targetServerId === null
        ? configuration.apiServerUrl
        : resolveServerProfileApiUrl(activeProfile!)),
      token: activeToken,
    });
    activeCredentialState = result.state;
  }

  const inactiveCredentialStateByServerId = new Map(
    await Promise.all(profiles.filter((profile) => profile.id !== effectiveActiveServerId).map(async (profile) => [
      profile.id,
      await readStoredCredentialCustodyForServerId(profile.id) ? 'stored-unverified' : 'missing',
    ] as const)),
  );

  const signals: AuthSignalsForProfile[] = signalProfiles.map((profile) => {
    const lastSub = String(lastTokenSubByServerId[profile.id] ?? '').trim();
    // Unreadable settings yield no server profiles at all, so this callback only
    // runs with settings present; the empty fallback keeps the machine-id owner's
    // "no recorded machine" answer rather than reading through a null snapshot.
    const machineId = resolveMachineIdForServerFromSettings(settings ?? {}, profile.id, lastSub || null);
    const isActive = profile.id === effectiveActiveServerId;
    return {
      serverId: profile.id,
      serverName: profile.name || profile.id,
      serverUrl: isActive && params.targetServerId === null ? configuration.serverUrl : profile.serverUrl,
      ...(isActive && !activeProfile ? { isRuntimeOnly: true } : {}),
      credentialState: isActive
        ? activeCredentialState
        : inactiveCredentialStateByServerId.get(profile.id) ?? 'missing',
      machineRegistered: machineId !== null
        && machineIdConfirmedByServerByServerId[profile.id] === true,
      isActive,
    };
  });

  return { activeServerUrl, authSignals: signals, hasAnyServerProfile, targetProfileExists };
}
