import type { BackgroundServiceRepairPlan } from '@/diagnostics/backgroundServiceRepair';
import type { DaemonServiceMode } from '@/daemon/service/plan';

import { classifyAuth, type AuthSignalsForProfile } from './classifyAuth';
import { classifyAutomaticStartup } from './classifyAutomaticStartup';
import { classifyCurrentCli } from './classifyCurrentCli';
import { classifyCurrentlyRunning } from './classifyCurrentlyRunning';
import { classifyLocalRelays } from './classifyLocalRelays';
import { classifyStacks } from './classifyStacks';
import {
  compareFindingByOrder,
  type AutomaticStartupEntry,
  type CurrentCliInfo,
  type DoctorRepairReport,
  type LocalRelayEntry,
  type RepairFinding,
  type RunningDaemonEntry,
  type ServerProfileMissing,
} from './types';
import {
  automaticStartupEntryIsRelevantToTargetServer,
  filterFindingsForTargetServer,
  serverUrlsReferToSameServer,
} from './filterFindingsForTargetServer';

/**
 * Pure, deterministic report builder.
 *
 * Given pre-resolved inventory (current CLI info, automatic-startup entries,
 * currently-running daemons, local relays) plus the existing
 * `BackgroundServiceRepairPlan`, project everything into a `DoctorRepairReport`
 * with ordered findings.
 *
 * The live-system adapter lives in `resolveDoctorRepairReport.ts`; keeping this
 * function pure makes it trivial to unit-test against fixtures.
 */
export async function buildDoctorRepairReport(params: Readonly<{
  currentCli: CurrentCliInfo;
  automaticStartup: readonly AutomaticStartupEntry[];
  currentlyRunning: readonly RunningDaemonEntry[];
  localRelays: readonly LocalRelayEntry[];
  plan: BackgroundServiceRepairPlan;
  currentServerId: string;
  preferredMode: DaemonServiceMode;
  latestRelayVersionForCurrentChannel: string | null;
  activeServerUrl: string | null;
  authSignals: readonly AuthSignalsForProfile[];
  hasAnyServerProfile: boolean;
  platform: NodeJS.Platform;
  uid: number | null;
  onMigration?: boolean;
  /**
   * When true (the `doctor repair` path), the CLI classifier performs a live
   * npm dist-tag lookup with a short timeout so the user always sees the
   * current state rather than a possibly-stale cached hint.
   */
  forceRefreshLatestCli?: boolean;
  /**
   * When set, the report is built as if `targetServerId` were the active
   * server. Findings are filtered to those touching that server so the user
   * sees only what matters for that profile. Set by `--server <id>`.
   */
  targetServerId?: string | null;
  /**
   * Required when `targetServerId` is set. `true` if a profile with that id
   * exists in settings, `false` if missing — the report emits
   * `server_profile_missing` in the latter case.
   */
  targetProfileExists?: boolean | null;
}>): Promise<DoctorRepairReport> {
  const cliSelfUpdateFindings = await classifyCurrentCli({
    currentCliReleaseChannel: params.currentCli.releaseChannel,
    currentCliVersion: params.currentCli.version,
    onMigration: params.onMigration,
    forceRefresh: params.forceRefreshLatestCli,
  });
  const cliIsLatest = cliSelfUpdateFindings.length === 0;

  const automaticStartupFindings = classifyAutomaticStartup({
    plan: params.plan,
    entries: params.automaticStartup,
    currentCliReleaseChannel: params.currentCli.releaseChannel,
    currentCliRingId: params.currentCli.ringId,
    currentCliVersion: params.currentCli.version,
    currentServerId: params.currentServerId,
    preferredMode: params.preferredMode,
    onMigration: params.onMigration,
  });

  const currentlyRunningFindings = classifyCurrentlyRunning({
    running: params.currentlyRunning,
    automaticStartup: params.automaticStartup,
    currentCliReleaseChannel: params.currentCli.releaseChannel,
    currentCliVersion: params.currentCli.version,
    currentServerId: params.currentServerId,
    platform: params.platform,
    uid: params.uid,
  });

  const localRelayFindings = classifyLocalRelays({
    relays: params.localRelays,
    currentCliReleaseChannel: params.currentCli.releaseChannel,
    cliIsLatest,
    latestRelayVersionForCurrentChannel: params.latestRelayVersionForCurrentChannel,
  });

  const { findings: stackFindings } = classifyStacks({
    automaticStartup: params.automaticStartup,
    currentlyRunning: params.currentlyRunning,
    localRelays: params.localRelays,
    currentCliReleaseChannel: params.currentCli.releaseChannel,
    activeServerUrl: params.activeServerUrl,
    onMigration: params.onMigration,
  });

  const authFindings = classifyAuth({
    hasAnyServerProfile: params.hasAnyServerProfile,
    signals: params.authSignals,
  });

  // If the top-level question is "switch to a different channel?", that
  // decision precedes any within-stack drift fixes — filter those so the
  // user isn't asked about repairing a stack they're about to switch away
  // from.
  const hasChannelSwitchFinding = stackFindings.some(
    (f) => f.kind === 'channel_switch_recommended',
  );
  const suppressWithinStackDrift = hasChannelSwitchFinding;

  // Cross-classifier dedup: `automatic_startup_version_stale` and
  // `running_daemon_cli_mismatch` describe the same physical situation
  // when both fire on the same managed slot — service entry says "running
  // version != current" AND daemon reports "started with version != current".
  //
  // The mismatch finding is the one that actually dispatches an action
  // (`service restart --takeover`); the version_stale finding sets a flag
  // that runs through `applyBackgroundServiceRepairPlan`, which has no
  // restart action in its vocabulary. Keeping both creates two prompts with
  // identical copy where the second one does the work.
  //
  // Suppress version_stale when a service-restart-strategy mismatch finding
  // covers the same slot, so the user is asked once and the action runs.
  const cliMismatchProfileSet = new Set(
    currentlyRunningFindings
      .filter((f) => f.kind === 'running_daemon_cli_mismatch')
      .map((f) => (f as Extract<RepairFinding, { kind: 'running_daemon_cli_mismatch' }>).daemon.serverId),
  );
  const dedupedAutomaticStartup = automaticStartupFindings.filter((f) => {
    if (f.kind !== 'automatic_startup_version_stale') return true;
    const managed = f.entry.managedServerIds ?? [f.entry.serverId];
    return !managed.some((id) => cliMismatchProfileSet.has(id));
  });

  // When `--server <id>` is set and the profile doesn't exist, surface the
  // configuration gap as the first thing the user sees — the rest of the
  // report would be empty (no service, no daemon, no auth) for that profile,
  // so the right action is "configure this server first."
  const targetServerId = params.targetServerId ?? null;
  const serverProfileMissingFindings: ServerProfileMissing[] = (
    targetServerId !== null && params.targetProfileExists === false
  )
    ? [{
      kind: 'server_profile_missing',
      severity: 'warning',
      autoApplyWithoutPrompt: false,
      serverId: targetServerId,
    }]
    : [];

  const aggregated: RepairFinding[] = [
    ...stackFindings,
    ...serverProfileMissingFindings,
    ...authFindings,
    ...cliSelfUpdateFindings,
    ...(suppressWithinStackDrift ? [] : dedupedAutomaticStartup),
    ...(suppressWithinStackDrift ? [] : currentlyRunningFindings),
    ...(suppressWithinStackDrift ? [] : localRelayFindings),
  ];

  // When the report is scoped via `--server <id>`, filter findings to those
  // touching that server profile (auth, automatic startup, running daemon,
  // service health) and drop orthogonal stack/multi-stack findings. CLI
  // self-update remains since it's always relevant.
  const findings = (targetServerId !== null
    ? filterFindingsForTargetServer(aggregated, {
      targetServerId,
      activeServerUrl: params.activeServerUrl,
      currentCliReleaseChannel: params.currentCli.releaseChannel,
      automaticStartup: params.automaticStartup,
      currentlyRunning: params.currentlyRunning,
    })
    : aggregated
  ).sort(compareFindingByOrder);

  const visibleAutomaticStartup = targetServerId === null
    ? params.automaticStartup
    : params.automaticStartup.filter((entry) => automaticStartupEntryIsRelevantToTargetServer(entry, {
      targetServerId,
      activeServerUrl: params.activeServerUrl,
      currentCliReleaseChannel: params.currentCli.releaseChannel,
    }));
  const visibleCurrentlyRunning = targetServerId === null
    ? params.currentlyRunning
    : params.currentlyRunning.filter((daemon) => daemon.serverId === targetServerId);
  const visibleLocalRelays = targetServerId === null
    ? params.localRelays
    : params.localRelays.filter((relay) => serverUrlsReferToSameServer(relay.relayUrl, params.activeServerUrl));
  const visibleAuthSignals = targetServerId === null
    ? params.authSignals
    : params.authSignals.filter((signal) => signal.serverId === targetServerId);

  return {
    currentCli: params.currentCli,
    automaticStartup: visibleAutomaticStartup,
    currentlyRunning: visibleCurrentlyRunning,
    localRelays: visibleLocalRelays,
    authProfiles: visibleAuthSignals.map((s) => ({
      serverId: s.serverId,
      serverName: s.serverName,
      serverUrl: s.serverUrl,
      hasCredentials: s.hasCredentials,
      isExpired: s.isExpired,
      machineRegistered: s.machineRegistered,
      isActive: s.isActive,
      reachability: s.reachability,
    })),
    hasAnyServerProfile: params.hasAnyServerProfile,
    findings,
    manualWarnings: params.plan.manualWarnings,
  };
}
