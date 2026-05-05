import { createServerUrlComparableKey } from '@happier-dev/protocol';

import type {
  AutomaticStartupEntry,
  CurrentCliInfo,
  RepairFinding,
  RepairFindingKind,
  RunningDaemonEntry,
} from './types';

/**
 * Finding kinds that are intrinsically scope-orthogonal — they describe the
 * machine as a whole, not any single server profile, and shouldn't appear
 * when the user explicitly scoped the report to one server. Stack-level
 * "switch channel?" prompts in particular would derail the scoped flow.
 */
const ORTHOGONAL_KINDS: ReadonlySet<RepairFindingKind> = new Set([
  'channel_switch_recommended',
  'no_active_stack_yet',
  'dev_on_hosted_cloud_informational',
  'multi_stack_detected_informational',
  'local_relay_lane_missing',
  'local_relay_version_stale',
  'local_relay_off_channel_leftovers',
]);

/**
 * Finding kinds that are always-relevant regardless of scope — even for a
 * single-server scoped report we want CLI self-update to surface, and we
 * always want `server_profile_missing` / `no_servers_configured` to show
 * because they answer "is this server configured at all?".
 */
const ALWAYS_RELEVANT_KINDS: ReadonlySet<RepairFindingKind> = new Set([
  'cli_self_update_available',
  'no_servers_configured',
  'server_profile_missing',
  'automatic_startup_foreign_home',
]);

/**
 * Filter findings to only those touching `targetServerId`.
 *
 * Each finding kind has its own server-scoping rule:
 *   - Auth findings carry `serverId` directly.
 *   - Automatic-startup entry findings are kept when the entry's
 *     `managedServerIds` (or its own `serverId` for pinned services)
 *     includes the target.
 *   - Duplicate / lane / legacy findings are kept when ANY of the
 *     entries they reference touches the target.
 *   - Running-daemon findings are kept when the daemon is on the target
 *     profile.
 *   - Background-service health findings are kept when the entry manages
 *     the target server.
 *   - Stack/multi-stack/local-relay/no-active-stack findings are dropped.
 *   - CLI self-update + foreign-home + no-servers-configured + the new
 *     `server_profile_missing` are always preserved.
 */
export function filterFindingsForTargetServer(
  findings: readonly RepairFinding[],
  context: Readonly<{
    targetServerId: string;
    activeServerUrl?: string | null;
    currentCliReleaseChannel?: CurrentCliInfo['releaseChannel'];
    automaticStartup: readonly AutomaticStartupEntry[];
    currentlyRunning: readonly RunningDaemonEntry[];
  }>,
): RepairFinding[] {
  return findings.filter((finding) => {
    if (ORTHOGONAL_KINDS.has(finding.kind)) return false;
    if (ALWAYS_RELEVANT_KINDS.has(finding.kind)) return true;
    return findingTouchesTargetServer(finding, context);
  });
}

export function automaticStartupEntryIsRelevantToTargetServer(
  entry: AutomaticStartupEntry,
  context: Readonly<{
    targetServerId: string;
    activeServerUrl?: string | null;
    currentCliReleaseChannel?: CurrentCliInfo['releaseChannel'];
  }>,
): boolean {
  const managed = entry.managedServerIds ?? [entry.serverId];
  if (!managed.includes(context.targetServerId)) return false;
  if (serverUrlsReferToSameServer(entry.relayUrl, context.activeServerUrl ?? null)) return true;
  if (entry.targetMode === 'pinned') return true;
  if (context.currentCliReleaseChannel && entry.releaseChannel === context.currentCliReleaseChannel) return true;
  return !context.activeServerUrl && !context.currentCliReleaseChannel;
}

export function serverUrlsReferToSameServer(left: string | null | undefined, right: string | null | undefined): boolean {
  const l = String(left ?? '').trim();
  const r = String(right ?? '').trim();
  if (!l || !r) return false;
  try {
    return createServerUrlComparableKey(l) === createServerUrlComparableKey(r);
  } catch {
    return l.replace(/\/+$/, '') === r.replace(/\/+$/, '');
  }
}

function findingTouchesTargetServer(
  finding: RepairFinding,
  context: Readonly<{
    targetServerId: string;
    automaticStartup: readonly AutomaticStartupEntry[];
    currentlyRunning: readonly RunningDaemonEntry[];
  }>,
): boolean {
  const target = context.targetServerId;
  switch (finding.kind) {
    case 'auth_missing_for_profile':
    case 'auth_expired_for_active_profile':
    case 'machine_not_registered_for_profile':
      return finding.serverId === target;

    case 'automatic_startup_missing':
      // Missing fires when no compatible default-following service exists for
      // the active profile. With `--server <id>`, that question is "is there
      // a service for the target profile?" — always relevant when scoped.
      return true;

    case 'automatic_startup_lane_mismatch':
      return finding.existing.some((e) => automaticStartupEntryIsRelevantToTargetServer(e, context));

    case 'automatic_startup_version_stale':
    case 'automatic_startup_stale_definition':
    case 'automatic_startup_legacy_channel_scoped':
    case 'automatic_startup_legacy_pinned_current_server':
      return automaticStartupEntryIsRelevantToTargetServer(finding.entry, context);

    case 'automatic_startup_duplicate_default_following':
    case 'automatic_startup_duplicate_pinned_same_server':
      return [finding.keeper, ...finding.duplicates].some((e) => automaticStartupEntryIsRelevantToTargetServer(e, context));

    case 'background_service_not_running':
    case 'background_service_crash_looping':
      return automaticStartupEntryIsRelevantToTargetServer(finding.entry, context);

    case 'running_daemon_cli_mismatch':
      return finding.daemon.serverId === target;

    case 'running_daemon_duplicate_profile':
      return finding.serverId === target;

    case 'orphan_daemon_on_other_channel':
      // By definition orphans don't touch the active profile. When scoping
      // to a specific server, they're irrelevant unless the daemon happens
      // to point at that server (rare but possible).
      return finding.daemon.serverId === target;

    default:
      // Defensive: unknown kinds default to "drop in scoped mode" so a new
      // finding kind doesn't silently leak into scoped reports.
      return false;
  }
}
