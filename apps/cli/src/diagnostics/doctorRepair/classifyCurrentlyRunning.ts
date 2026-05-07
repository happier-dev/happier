import type { PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import { readBackgroundServiceHealth } from '@/daemon/service/readBackgroundServiceHealth';
import type {
  AutomaticStartupEntry,
  BackgroundServiceCrashLooping,
  BackgroundServiceNotRunning,
  OrphanDaemonOnOtherChannel,
  RepairFinding,
  RunningDaemonCliMismatch,
  RunningDaemonDuplicateProfile,
  RunningDaemonEntry,
} from './types';

/**
 * Pick the recovery strategy for a running-daemon-mismatch finding.
 *
 * When an auto-starting background service owns the same relay profile as the
 * running daemon AND it targets the current CLI's channel, the correct fix is
 * `happier service restart` — the service install layer refuses
 * `daemon restart --takeover` against a profile it already manages.
 *
 * Only when there's no matching managing service do we fall back to a direct
 * daemon takeover.
 */
function resolveDriftKind(daemon: RunningDaemonEntry, currentCliReleaseChannel: PublicReleaseRingLabel): 'version-only' | 'cross-channel' {
  const daemonChannel = daemon.startedWithReleaseChannel;
  if (!daemonChannel) return 'version-only';
  return daemonChannel === currentCliReleaseChannel ? 'version-only' : 'cross-channel';
}

function resolveRecoveryStrategy(params: Readonly<{
  daemon: RunningDaemonEntry;
  automaticStartup: readonly AutomaticStartupEntry[];
  currentCliReleaseChannel: PublicReleaseRingLabel;
  driftKind: 'version-only' | 'cross-channel';
  isOnActiveProfile: boolean;
}>): Pick<RunningDaemonCliMismatch, 'recoveryStrategy' | 'serviceManagerName'> {
  // Prefer a manager service when one exists for this profile on the current
  // channel — restarting it converges the daemon cleanly whether the drift is
  // version-only or cross-channel (the service template bakes in the CURRENT
  // CLI, so kickstarting it replaces the old daemon with a current-CLI one).
  //
  // We use `managedServerIds` — the REAL profile ids this service manages —
  // not `serverId` directly. For default-following services the bare
  // `serverId` field is a sentinel ('default') that never matches a real
  // daemon, so a direct compare misses the exact case we care about.
  const manager = params.automaticStartup.find((e) => {
    if (e.releaseChannel !== params.currentCliReleaseChannel) return false;
    if (e.isForeignHome) return false;
    return (e.managedServerIds ?? [e.serverId]).includes(params.daemon.serverId);
  });
  if (manager) {
    return { recoveryStrategy: 'service-restart', serviceManagerName: manager.name };
  }
  // Version-only drift with no manager → direct daemon takeover with the
  // current CLI (same channel). Same action when a cross-channel daemon is
  // sitting on the ACTIVE profile — takeover stops the old daemon and starts
  // a fresh one with the current CLI, which lands the profile on the current
  // channel. That's exactly what the user wants in both cases.
  if (params.driftKind === 'version-only' || params.isOnActiveProfile) {
    return { recoveryStrategy: 'daemon-takeover', serviceManagerName: null };
  }
  // Cross-channel daemon on a profile we don't care about right now — stop
  // is the honest action; the user decides whether to start something here.
  return { recoveryStrategy: 'daemon-stop', serviceManagerName: null };
}

export function classifyCurrentlyRunning(params: Readonly<{
  running: readonly RunningDaemonEntry[];
  automaticStartup: readonly AutomaticStartupEntry[];
  currentCliReleaseChannel: PublicReleaseRingLabel;
  currentCliVersion: string;
  /**
   * The current CLI's active profile (serverId). Used to distinguish
   * "daemon on the slot we care about" (takeover candidate) from
   * "daemon on a profile unrelated to us" (informational orphan), which
   * the cross-channel-daemon branch needs to decide correctly.
   */
  currentServerId: string;
  platform: NodeJS.Platform;
  uid: number | null;
}>): readonly RepairFinding[] {
  const findings: RepairFinding[] = [];

  // Duplicate-profile: more than one daemon on the same serverId
  const byServerId = new Map<string, RunningDaemonEntry[]>();
  for (const daemon of params.running) {
    const list = byServerId.get(daemon.serverId) ?? [];
    list.push(daemon);
    byServerId.set(daemon.serverId, list);
  }
  for (const [serverId, daemons] of byServerId) {
    if (daemons.length < 2) continue;
    const dup: RunningDaemonDuplicateProfile = {
      kind: 'running_daemon_duplicate_profile',
      severity: 'warning',
      autoApplyWithoutPrompt: false,
      serverId,
      daemons,
    };
    findings.push(dup);
  }

  // CLI mismatch / cross-channel / orphan: the branching depends on whether
  // the daemon and any current-channel service share a serverId.
  for (const daemon of params.running) {
    if (daemon.matchesCurrentCli !== false) continue;
    const driftKind = resolveDriftKind(daemon, params.currentCliReleaseChannel);

    // Cross-channel daemon: decide orphan-vs-takeover using TWO signals.
    //  1) Is there a current-channel service configured for this daemon's
    //     serverId? (Means we'd restart that service.)
    //  2) Is this daemon on the CLI's *active* profile? (Means the user
    //     cares about this slot right now, so it's a takeover candidate,
    //     not an orphan — even if no service is configured for it yet.)
    // Only when BOTH are false is this genuinely an orphan on an unrelated
    // profile that the user keeps running intentionally.
    if (driftKind === 'cross-channel') {
      const sameProfileService = params.automaticStartup.find((e) =>
        e.serverId === daemon.serverId
        && e.releaseChannel === params.currentCliReleaseChannel
        && !e.isForeignHome,
      );
      const isOnActiveProfile = daemon.serverId === params.currentServerId;
      if (!sameProfileService && !isOnActiveProfile) {
        const orphan: OrphanDaemonOnOtherChannel = {
          kind: 'orphan_daemon_on_other_channel',
          severity: 'info',
          autoApplyWithoutPrompt: false,
          daemon,
          currentCliReleaseChannel: params.currentCliReleaseChannel,
        };
        findings.push(orphan);
        continue;
      }
      // Either a current-channel service exists for this serverId, OR the
      // daemon is on the active profile — both mean the user wants a fresh
      // daemon started by the current CLI here. Fall through to the standard
      // mismatch path so recoveryStrategy picks the right fix (service-restart
      // when a manager service exists; daemon-takeover otherwise).
    }

    const { recoveryStrategy, serviceManagerName } = resolveRecoveryStrategy({
      daemon,
      automaticStartup: params.automaticStartup,
      currentCliReleaseChannel: params.currentCliReleaseChannel,
      driftKind,
      isOnActiveProfile: daemon.serverId === params.currentServerId,
    });
    const mismatch: RunningDaemonCliMismatch = {
      kind: 'running_daemon_cli_mismatch',
      severity: 'warning',
      autoApplyWithoutPrompt:
        (daemon.startedBy === 'automatic-startup' && driftKind === 'version-only')
        || recoveryStrategy === 'service-restart',
      daemon,
      currentCliReleaseChannel: params.currentCliReleaseChannel,
      currentCliVersion: params.currentCliVersion,
      driftKind,
      recoveryStrategy,
      serviceManagerName,
    };
    findings.push(mismatch);
  }

  // Background service on the current CLI's channel is configured but not
  // running, and no daemon is running on its serverId either. Before
  // emitting a plain "not running" finding, check the platform health
  // signals (runs count + last exit code) to see if it's actually
  // crash-looping. Crash-loop is a much more useful finding because it
  // carries the actual error message from the service's stderr.
  for (const service of params.automaticStartup) {
    if (service.isForeignHome) continue;
    if (service.releaseChannel !== params.currentCliReleaseChannel) continue;
    if (service.running === true) continue;
    // Use the service's REAL managed profile ids; `serverId` is a sentinel
    // for default-following services and never matches a running daemon.
    const managed = service.managedServerIds ?? [service.serverId];
    const hasDaemonOnSameProfile = params.running.some((d) => managed.includes(d.serverId));
    if (hasDaemonOnSameProfile) continue;

    const label = deriveServiceLabel(service);
    const errLogPath = deriveStderrLogPath(service);
    const health = readBackgroundServiceHealth({
      platform: params.platform,
      uid: params.uid,
      label,
      errLogPath,
      mode: service.mode,
    });

    if (health.isCrashLooping && health.runs !== null && health.lastExitCode !== null) {
      const conflictingPid = health.conflictingManualDaemonPid
        ?? findConflictingDaemonPid(service, params.running);
      const finding: BackgroundServiceCrashLooping = {
        kind: 'background_service_crash_looping',
        severity: 'warning',
        autoApplyWithoutPrompt: false,
        entry: service,
        runs: health.runs,
        lastExitCode: health.lastExitCode,
        lastErrorLine: health.lastErrorLine,
        suspectedCause: health.suspectedCause,
        conflictingDaemon: conflictingPid !== null
          ? { pid: conflictingPid, serverId: resolveConflictingServerId(service, params.running, conflictingPid) }
          : null,
      };
      findings.push(finding);
      continue;
    }

    const finding: BackgroundServiceNotRunning = {
      kind: 'background_service_not_running',
      severity: 'info',
      autoApplyWithoutPrompt: false,
      entry: service,
    };
    findings.push(finding);
  }

  return findings;
}

function deriveServiceLabel(service: AutomaticStartupEntry): string {
  // On macOS, the plist filename is `<label>.plist`. Strip directory + extension.
  const path = service.path;
  const base = path.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.plist$/i, '');
}

function deriveStderrLogPath(service: AutomaticStartupEntry): string | null {
  // We store logs at `<happier_home>/logs/daemon-service.<serverId>.err.log`
  // (or daemon-service.default.err.log for the default-following entry).
  const home = service.happierHomeDir;
  if (!home) return null;
  const logBase = service.targetMode === 'default-following'
    ? 'daemon-service.default.err.log'
    : `daemon-service.${service.serverId}.err.log`;
  return `${home}/logs/${logBase}`;
}

function findConflictingDaemonPid(
  service: AutomaticStartupEntry,
  running: readonly RunningDaemonEntry[],
): number | null {
  // If a manual daemon owns a profile this service actually manages, that's
  // almost certainly the conflict. Use `managedServerIds` — `serverId` is a
  // sentinel for default-following services.
  const managed = service.managedServerIds ?? [service.serverId];
  const match = running.find((d) => managed.includes(d.serverId) && d.startedBy === 'manual');
  return match?.pid ?? null;
}

function resolveConflictingServerId(
  service: AutomaticStartupEntry,
  running: readonly RunningDaemonEntry[],
  pid: number,
): string {
  const match = running.find((d) => d.pid === pid);
  if (match?.serverId) return match.serverId;
  const managed = service.managedServerIds ?? [service.serverId];
  return managed[0] ?? service.serverId;
}
