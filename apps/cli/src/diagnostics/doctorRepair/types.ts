import type { PublicReleaseRingId, PublicReleaseRingLabel } from '@happier-dev/release-runtime/releaseRings';

import type { DaemonServiceMode, DaemonServiceTargetMode } from '@/daemon/service/plan';

/**
 * The canonical analysis output for `happier doctor repair`.
 *
 * It aggregates a read of the four user-facing surfaces plus a first-class list
 * of findings that the guided flow renders/prompts about.
 *
 * Build via `buildDoctorRepairReport()`. Consumers: the `doctor repair` command
 * family, the future verbose `doctor` command, the installer (over --json).
 */
export type DoctorRepairReport = Readonly<{
  currentCli: CurrentCliInfo;
  automaticStartup: readonly AutomaticStartupEntry[];
  currentlyRunning: readonly RunningDaemonEntry[];
  localRelays: readonly LocalRelayEntry[];
  authProfiles: readonly AuthProfileSnapshot[];
  hasAnyServerProfile: boolean;
  findings: readonly RepairFinding[];
  manualWarnings: readonly string[];
}>;

/**
 * Per-server-profile auth snapshot rendered in the Authentication section.
 * Mirrors `AuthSignalsForProfile` but lives in the report shape so the
 * renderer doesn't reach back into the classifier.
 */
export type AuthProfileSnapshot = Readonly<{
  serverId: string;
  serverName: string;
  serverUrl: string;
  hasCredentials: boolean;
  isExpired: boolean;
  machineRegistered: boolean;
  isActive: boolean;
  /**
   * Verification state for the section renderer:
   *  - 'verified'     — we did a live check and got a definitive answer.
   *  - 'unreachable'  — we attempted a live check but the server didn't
   *                     respond; credential state is assumed, not confirmed.
   *  - 'not-probed'   — we didn't attempt a live check (non-active profile).
   */
  reachability: 'verified' | 'unreachable' | 'not-probed';
}>;

export type CurrentCliInfo = Readonly<{
  releaseChannel: PublicReleaseRingLabel;
  ringId: PublicReleaseRingId;
  version: string;
  binaryPath: string | null;
  /**
   * Channel-derived shim name (`happier` for stable, `hprev` for preview,
   * `hdev` for dev). Used for rendering the CLI inventory summary.
   */
  shim: 'happier' | 'hprev' | 'hdev' | null;
  /**
   * The actual invocation name observed from `process.argv` / env. May
   * differ from `shim` when the user runs the dev binary directly (e.g.
   * `node apps/cli/bin/happier.mjs`) or via a custom alias. Used in repair
   * copy so command suggestions match the binary the user actually ran —
   * if they invoked via `hdev`, suggestions should say `hdev daemon start`,
   * not the hardcoded `happier`. Falls back to `shim ?? 'happier'` when
   * the invoker can't be resolved.
   */
  invoker: string;
  pathWinnerShim: 'happier' | 'hprev' | 'hdev' | null;
  pathWinnerResolvesToThisBinary: boolean | null;
}>;

export type AutomaticStartupEntry = Readonly<{
  /**
   * The `serverId` field on the installed service definition. For
   * `targetMode: 'default-following'` this is a SENTINEL ('default' or a
   * legacy env_* label) — it doesn't equal the real profile id of whatever
   * daemon the service is currently managing. Do NOT compare this directly
   * with a `RunningDaemonEntry.serverId`; use `managedServerIds` below.
   */
  serverId: string;
  /** Canonical name — never "Default background service". */
  name: string;
  releaseChannel: PublicReleaseRingLabel;
  ringId: PublicReleaseRingId;
  mode: DaemonServiceMode;
  targetMode: DaemonServiceTargetMode;
  relayUrl: string | null;
  running: boolean | null;
  configuredCliVersion: string | null;
  runningCliVersion: string | null;
  path: string;
  happierHomeDir: string | null;
  isForeignHome: boolean;
  installedDefinitionMatchesExpected: boolean | null;
  /** True when the label/filename matches the legacy per-channel-scoped convention. */
  isLegacyChannelScoped: boolean;
  /**
   * The set of REAL profile serverIds this service actually manages right now.
   *
   * - `targetMode: 'default-following'` → `[currentActiveServerId]`
   *   (the default-following service tracks whichever profile is active).
   * - `targetMode: 'pinned'`            → `[serverId]`
   *   (pinned services hard-code their target profile).
   *
   * Use this, not `serverId`, when asking "is this service managing that
   * running daemon?". Optional for backwards-compat with test fixtures;
   * live builder always populates it.
   */
  managedServerIds?: readonly string[];
}>;

export type RunningDaemonEntry = Readonly<{
  serverId: string;
  pid: number;
  httpPort: number | null;
  startedBy: 'automatic-startup' | 'manual' | 'unknown';
  startedWithReleaseChannel: PublicReleaseRingLabel | null;
  startedWithCliVersion: string | null;
  matchesCurrentCli: boolean | null;
  staleStateFile: boolean;
  /**
   * The relay URL the daemon's active server profile points at (looked up
   * from settings when the entry is built). Shown in the row's sub-line so
   * users can tell which relay the daemon is talking to — useful when the
   * daemon's CLI channel differs from the relay's channel (e.g. a preview
   * CLI daemon connected to the dev local relay).
   *
   * Optional so existing test fixtures compile without churn; the live
   * builder always populates it (or sets to null when not resolvable).
   */
  relayUrl?: string | null;
}>;

export type LocalRelayEntry = Readonly<{
  releaseChannel: PublicReleaseRingLabel;
  ringId: PublicReleaseRingId;
  mode: DaemonServiceMode;
  version: string | null;
  serviceActive: boolean | null;
  serviceEnabled: boolean | null;
  healthy: boolean | null;
  relayUrl: string | null;
  port: number | null;
  installRoot: string | null;
}>;

// ────────────────────────────────────────────────────────────────────────────
// Findings
// ────────────────────────────────────────────────────────────────────────────

export type RepairFindingSeverity = 'info' | 'warning';

type RepairFindingBase = Readonly<{
  kind: string;
  severity: RepairFindingSeverity;
  /**
   * If true, `doctor repair --yes` and installer `--yes` mode will apply this
   * finding without prompting. False findings are surfaced but require an
   * explicit prompt-yes or interactive run to apply.
   */
  autoApplyWithoutPrompt: boolean;
}>;

export type AutomaticStartupLaneMismatch = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_lane_mismatch';
  existing: readonly AutomaticStartupEntry[];
  targetReleaseChannel: PublicReleaseRingLabel;
}>;

export type AutomaticStartupVersionStale = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_version_stale';
  entry: AutomaticStartupEntry;
  currentCliVersion: string;
}>;

export type AutomaticStartupStaleDefinition = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_stale_definition';
  entry: AutomaticStartupEntry;
}>;

export type AutomaticStartupLegacyChannelScoped = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_legacy_channel_scoped';
  entry: AutomaticStartupEntry;
}>;

export type AutomaticStartupLegacyPinnedCurrentServer = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_legacy_pinned_current_server';
  entry: AutomaticStartupEntry;
}>;

export type AutomaticStartupDuplicateDefaultFollowing = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_duplicate_default_following';
  keeper: AutomaticStartupEntry;
  duplicates: readonly AutomaticStartupEntry[];
}>;

export type AutomaticStartupDuplicatePinnedSameServer = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_duplicate_pinned_same_server';
  serverId: string;
  keeper: AutomaticStartupEntry;
  duplicates: readonly AutomaticStartupEntry[];
}>;

export type AutomaticStartupMissing = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_missing';
  targetReleaseChannel: PublicReleaseRingLabel;
  preferredMode: DaemonServiceMode;
}>;

/**
 * A configured automatic-startup service on the current CLI's channel is
 * stopped even though it's supposed to auto-start on boot. Fires when there
 * is no daemon running on the service's own serverId. Recommending to start
 * the service is always safe: the service install path handles re-bootstrap
 * and the daemon will register itself.
 */
export type BackgroundServiceNotRunning = RepairFindingBase & Readonly<{
  kind: 'background_service_not_running';
  entry: AutomaticStartupEntry;
}>;

/**
 * A background service is respawning repeatedly because every launch exits
 * with a non-zero code. To the user this looks like "stopped" — we detect
 * the crash-loop via `launchctl print` (runs count + last exit code) and
 * surface the last error line from the service's stderr log so the user
 * can see WHY it's failing without having to grep the log themselves.
 */
export type BackgroundServiceCrashLooping = RepairFindingBase & Readonly<{
  kind: 'background_service_crash_looping';
  entry: AutomaticStartupEntry;
  runs: number;
  lastExitCode: number;
  lastErrorLine: string | null;
  suspectedCause: 'conflicting_manual_daemon' | 'port_in_use' | 'auth_missing' | 'unknown';
  /**
   * When `suspectedCause === 'conflicting_manual_daemon'` and we can resolve
   * which running daemon is the conflict, this is its pid + serverId so the
   * dispatcher can offer a targeted stop.
   */
  conflictingDaemon: Readonly<{ pid: number; serverId: string }> | null;
}>;

/**
 * A running daemon on a different release channel than the current CLI, on
 * a profile that no current-channel service targets. Informational only —
 * the user almost certainly has this running intentionally (it's a separate
 * stack, e.g. a preview daemon on a local preview relay while the user
 * experiments with the dev CLI). We surface it but don't recommend replacing.
 */
export type OrphanDaemonOnOtherChannel = RepairFindingBase & Readonly<{
  kind: 'orphan_daemon_on_other_channel';
  daemon: RunningDaemonEntry;
  currentCliReleaseChannel: PublicReleaseRingLabel;
}>;

export type AutomaticStartupForeignHome = RepairFindingBase & Readonly<{
  kind: 'automatic_startup_foreign_home';
  entries: readonly AutomaticStartupEntry[];
  messages: readonly string[];
}>;

export type RunningDaemonCliMismatch = RepairFindingBase & Readonly<{
  kind: 'running_daemon_cli_mismatch';
  daemon: RunningDaemonEntry;
  currentCliReleaseChannel: PublicReleaseRingLabel;
  currentCliVersion: string;
  /**
   * `version-only` — same channel, older version. Restarting picks up the fix.
   * `cross-channel` — daemon is on a different release channel entirely.
   *   Takeover doesn't switch channels (it preserves the daemon's recorded
   *   channel), so the correct action is to STOP the daemon and let the user
   *   decide whether to start a current-CLI daemon afterwards.
   */
  driftKind: 'version-only' | 'cross-channel';
  /**
   * How this daemon should be restarted / stopped to align with the current CLI:
   *  - `service-restart`: an auto-starting background service owns the same
   *    relay profile on the current CLI's channel. Restart the service.
   *  - `daemon-takeover`: same channel, older version; `daemon restart --takeover`
   *    picks up the fix.
   *  - `daemon-stop`: cross-channel orphan — stop the daemon; don't restart.
   */
  recoveryStrategy: 'service-restart' | 'daemon-takeover' | 'daemon-stop';
  /**
   * When `recoveryStrategy === 'service-restart'`, which auto-starting service
   * will handle the restart (for prompt copy context).
   */
  serviceManagerName: string | null;
}>;

export type RunningDaemonDuplicateProfile = RepairFindingBase & Readonly<{
  kind: 'running_daemon_duplicate_profile';
  serverId: string;
  daemons: readonly RunningDaemonEntry[];
}>;

export type LocalRelayLaneMissing = RepairFindingBase & Readonly<{
  kind: 'local_relay_lane_missing';
  targetReleaseChannel: PublicReleaseRingLabel;
  installed: readonly LocalRelayEntry[];
}>;

export type LocalRelayVersionStale = RepairFindingBase & Readonly<{
  kind: 'local_relay_version_stale';
  entry: LocalRelayEntry;
  /** The latest version known for the relay's channel (from cache/GitHub). */
  latestVersion: string;
}>;

/**
 * The current CLI's channel has a matching local relay AND there are one or
 * more relays installed for other channels. Those extras don't conflict on
 * port (ports are ephemeral), but each runs as its own LaunchAgent/systemd
 * unit and shows up separately in macOS Login Items / Systemd user units —
 * easy to forget and confusing when switching channels. Informational.
 */
export type LocalRelayOffChannelLeftovers = RepairFindingBase & Readonly<{
  kind: 'local_relay_off_channel_leftovers';
  currentChannelEntry: LocalRelayEntry;
  leftovers: readonly LocalRelayEntry[];
}>;

export type CliSelfUpdateAvailable = RepairFindingBase & Readonly<{
  kind: 'cli_self_update_available';
  releaseChannel: PublicReleaseRingLabel;
  currentVersion: string;
  latestVersion: string;
}>;

// ─── Stack-level (Round 2a) ───────────────────────────────────────────────

/**
 * Which components of a full Happier "stack" are present on a given channel
 * on this machine. A stack is consistent when all non-null pieces agree on
 * the same channel; archetypes below describe which kind of setup the user
 * has so the switch/repair actions adapt.
 */
export type StackArchetype =
  | 'cli-only'                    // only the CLI (no daemon, no relay)
  | 'cli-daemon-hosted'           // CLI + daemon + hosted cloud (api.happier.dev) — no local relay
  | 'cli-daemon-local-relay'      // CLI + daemon + local relay (installed by us)
  | 'cli-daemon-self-hosted'      // CLI + daemon + relay running elsewhere (Docker, self-hosted server)
  | 'unknown';

export type StackEntry = Readonly<{
  releaseChannel: PublicReleaseRingLabel;
  ringId: PublicReleaseRingId;
  hasCurrentCli: boolean;                       // true if the CLI the user just invoked is on this channel
  archetype: StackArchetype;
  runningDaemon: RunningDaemonEntry | null;
  localRelay: LocalRelayEntry | null;
  automaticStartup: AutomaticStartupEntry | null;
  activeServerUrl: string | null;
  isHostedCloudActive: boolean;
}>;

export type ChannelSwitchRecommended = RepairFindingBase & Readonly<{
  kind: 'channel_switch_recommended';
  fromStack: StackEntry;                        // the currently-active stack on the "other" channel
  toChannel: PublicReleaseRingLabel;            // the installed CLI's channel
  willActiveServerChange: boolean;              // adapts the account/session warning wording
  /** Whether a matching-channel local relay is present (for follow-up prompt after switch). */
  targetChannelHasLocalRelay: boolean;
}>;

export type NoActiveStackYet = RepairFindingBase & Readonly<{
  kind: 'no_active_stack_yet';
  releaseChannel: PublicReleaseRingLabel;       // the installed CLI's channel — offer to start a stack here
}>;

export type DevOnHostedCloudInformational = RepairFindingBase & Readonly<{
  kind: 'dev_on_hosted_cloud_informational';
  activeServerUrl: string;
}>;

export type MultiStackDetectedInformational = RepairFindingBase & Readonly<{
  kind: 'multi_stack_detected_informational';
  stacks: readonly StackEntry[];
}>;

// ─── Auth-level (Round 2b) ────────────────────────────────────────────────

export type NoServersConfigured = RepairFindingBase & Readonly<{
  kind: 'no_servers_configured';
}>;

export type AuthMissingForProfile = RepairFindingBase & Readonly<{
  kind: 'auth_missing_for_profile';
  serverId: string;
  serverName: string;
  serverUrl: string;
}>;

export type AuthExpiredForActiveProfile = RepairFindingBase & Readonly<{
  kind: 'auth_expired_for_active_profile';
  serverId: string;
  serverName: string;
  serverUrl: string;
}>;

export type MachineNotRegisteredForProfile = RepairFindingBase & Readonly<{
  kind: 'machine_not_registered_for_profile';
  serverId: string;
  serverName: string;
  serverUrl: string;
}>;

/**
 * Fires only when the report was scoped via `--server <id>` AND no server
 * profile exists with that id.
 *
 * The most common trigger is `auth pair-remote` running its post-pair check
 * before the remote machine has caught up, OR a user typing
 * `happier doctor repair --server some-id` for an id they haven't configured
 * yet. The action is "configure this server" — possible routes are
 * `${invoker} server add <url>`, `${invoker} relay use --local`, or
 * `${invoker} auth pair-remote ...` depending on the user's setup.
 */
export type ServerProfileMissing = RepairFindingBase & Readonly<{
  kind: 'server_profile_missing';
  serverId: string;
}>;

export type RepairFinding =
  // Top-level: "do you want to switch your active stack?"
  | ChannelSwitchRecommended
  | NoActiveStackYet
  // CLI self
  | CliSelfUpdateAvailable
  // Auth (before doing anything else, make sure the user is signed in)
  | NoServersConfigured
  | ServerProfileMissing
  | AuthMissingForProfile
  | AuthExpiredForActiveProfile
  | MachineNotRegisteredForProfile
  // Automatic-startup drift (within the active stack)
  | AutomaticStartupLaneMismatch
  | AutomaticStartupVersionStale
  | AutomaticStartupStaleDefinition
  | AutomaticStartupLegacyChannelScoped
  | AutomaticStartupLegacyPinnedCurrentServer
  // Informational (soft advice)
  | DevOnHostedCloudInformational
  | MultiStackDetectedInformational
  | AutomaticStartupDuplicateDefaultFollowing
  | AutomaticStartupDuplicatePinnedSameServer
  | AutomaticStartupMissing
  | AutomaticStartupForeignHome
  | BackgroundServiceNotRunning
  | BackgroundServiceCrashLooping
  | OrphanDaemonOnOtherChannel
  | RunningDaemonCliMismatch
  | RunningDaemonDuplicateProfile
  | LocalRelayLaneMissing
  | LocalRelayVersionStale
  | LocalRelayOffChannelLeftovers;

export type RepairFindingKind = RepairFinding['kind'];

/** Canonical ordering used by the guided walk and any deterministic rendering. */
export const REPAIR_FINDING_ORDER: readonly RepairFindingKind[] = [
  // Top-level stack decisions go first — they influence what subsequent
  // drift findings even mean (some findings are on the soon-to-be-replaced stack).
  'channel_switch_recommended',
  'no_active_stack_yet',
  // Auth is prerequisite for most daemon actions.
  'no_servers_configured',
  'server_profile_missing',
  'auth_missing_for_profile',
  'auth_expired_for_active_profile',
  'machine_not_registered_for_profile',
  // CLI self-update.
  'cli_self_update_available',
  // Within-active-stack drift.
  'automatic_startup_foreign_home',
  'automatic_startup_duplicate_default_following',
  'automatic_startup_duplicate_pinned_same_server',
  'automatic_startup_lane_mismatch',
  'automatic_startup_legacy_pinned_current_server',
  'automatic_startup_legacy_channel_scoped',
  'automatic_startup_stale_definition',
  'automatic_startup_missing',
  'automatic_startup_version_stale',
  // "Start this configured-but-stopped service" goes BEFORE cross-channel
  // orphan — starting the service is the material action; the orphan is
  // informational context.
  // Crash-loop must be surfaced FIRST of the service-state findings because
  // it overrides "not running" (the service IS trying — it's just failing).
  'background_service_crash_looping',
  'background_service_not_running',
  'running_daemon_duplicate_profile',
  'running_daemon_cli_mismatch',
  'orphan_daemon_on_other_channel',
  // Informational (shown last — no prompts, just advice).
  'dev_on_hosted_cloud_informational',
  'multi_stack_detected_informational',
  'local_relay_lane_missing',
  'local_relay_version_stale',
  'local_relay_off_channel_leftovers',
];

export function compareFindingByOrder(a: RepairFinding, b: RepairFinding): number {
  return REPAIR_FINDING_ORDER.indexOf(a.kind) - REPAIR_FINDING_ORDER.indexOf(b.kind);
}
