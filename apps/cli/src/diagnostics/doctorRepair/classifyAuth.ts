import type {
  AuthExpiredForActiveProfile,
  AuthMissingForProfile,
  MachineNotRegisteredForProfile,
  NoServersConfigured,
  RepairFinding,
} from './types';

export type AuthReachability =
  | 'verified'          // live check succeeded for this profile
  | 'unreachable'       // live check attempted but the server didn't respond (timeout / 5xx / network fail)
  | 'not-probed';       // no live check was made for this profile (non-active profiles by default)

export type AuthSignalsForProfile = Readonly<{
  serverId: string;
  serverName: string;
  serverUrl: string;
  /** True if this profile has stored credentials (token + keys). */
  hasCredentials: boolean;
  /** True if credentials are present but failed a live /whoami check. */
  isExpired: boolean;
  /** True if a machine id has been confirmed for this profile. */
  machineRegistered: boolean;
  /** True if this profile is the currently active one. */
  isActive: boolean;
  /**
   * What we were able to verify for this profile. `verified` means the live
   * check succeeded (or returned 401/403, which is still a verified auth
   * state). `unreachable` means we attempted but the server didn't respond.
   * `not-probed` means we didn't try at all.
   */
  reachability: AuthReachability;
}>;

/**
 * Emit auth-related repair findings.
 *
 * Ordering within this classifier:
 *   1. No server profiles configured at all — the user can't do anything
 *      until they have at least one server to sign into.
 *   2. Missing credentials for *active* profile — the user is going to hit
 *      this on the first session attempt.
 *   3. Expired credentials for active profile — same reason.
 *   4. Missing credentials for non-active profiles — surfaced but lower-priority.
 *   5. Machine not registered on the active profile — usually auto-fixes on
 *      first daemon start, but surfacing it is helpful when nothing's running.
 *
 * Live auth checks are the caller's responsibility (they may time out or
 * require network access). The resolver populates the `isExpired` flag when
 * a live check was performed; when it's null/false, we don't flag expiry.
 */
export function classifyAuth(params: Readonly<{
  hasAnyServerProfile: boolean;
  signals: readonly AuthSignalsForProfile[];
}>): readonly RepairFinding[] {
  const findings: RepairFinding[] = [];

  if (!params.hasAnyServerProfile) {
    const finding: NoServersConfigured = {
      kind: 'no_servers_configured',
      severity: 'info',
      autoApplyWithoutPrompt: false,
    };
    findings.push(finding);
    return findings;
  }

  const active = params.signals.find((s) => s.isActive) ?? null;

  if (active) {
    if (!active.hasCredentials) {
      const finding: AuthMissingForProfile = {
        kind: 'auth_missing_for_profile',
        severity: 'warning',
        autoApplyWithoutPrompt: false,
        serverId: active.serverId,
        serverName: active.serverName,
        serverUrl: active.serverUrl,
      };
      findings.push(finding);
    } else if (active.isExpired) {
      const finding: AuthExpiredForActiveProfile = {
        kind: 'auth_expired_for_active_profile',
        severity: 'warning',
        autoApplyWithoutPrompt: false,
        serverId: active.serverId,
        serverName: active.serverName,
        serverUrl: active.serverUrl,
      };
      findings.push(finding);
    } else if (!active.machineRegistered) {
      const finding: MachineNotRegisteredForProfile = {
        kind: 'machine_not_registered_for_profile',
        severity: 'info',
        autoApplyWithoutPrompt: false,
        serverId: active.serverId,
        serverName: active.serverName,
        serverUrl: active.serverUrl,
      };
      findings.push(finding);
    }
  }

  for (const s of params.signals) {
    if (s.isActive) continue;                 // already handled above
    if (s.hasCredentials) continue;
    const finding: AuthMissingForProfile = {
      kind: 'auth_missing_for_profile',
      severity: 'info',
      autoApplyWithoutPrompt: false,
      serverId: s.serverId,
      serverName: s.serverName,
      serverUrl: s.serverUrl,
    };
    findings.push(finding);
  }

  return findings;
}
