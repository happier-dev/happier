/**
 * Global configuration for Happier CLI
 * 
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isServerIdFilesystemSafe, sanitizeServerIdForFilesystem } from '@/server/serverId'
import { isLocalishServerUrl } from '@/server/serverUrlClassification'
import { normalizeCliArgv } from '@/cli/parseArgs'
import packageJson from '../package.json'

/**
 * Parse an environment variable as an integer and clamp it within optional bounds.
 *
 * - Reads `process.env[envVar]`, trims, and parses as base-10 integer.
 * - If the parsed value is finite and >= `opts.min` (default 1), it is accepted.
 * - If `opts.max` is specified, the value is clamped to that upper bound.
 * - Otherwise the `opts.default` value is returned.
 */
function resolveIntEnvWithBounds(
  envVar: string,
  opts: { min?: number; max?: number; default: number },
): number {
  const raw = String(process.env[envVar] ?? '').trim()
  const parsed = Number.parseInt(raw, 10)
  const min = opts.min ?? 1
  if (!Number.isFinite(parsed) || parsed < min) return opts.default
  return opts.max != null ? Math.min(parsed, opts.max) : parsed
}

export function isDaemonProcessArgv(args: readonly string[]): boolean {
  if (args.length < 2) return false
  if (args[0] !== 'daemon') return false
  return args[1] === 'start' || args[1] === 'start-sync'
}

class Configuration {
  public readonly serverUrl: string
  public readonly apiServerUrl: string
  /**
   * Deprecated alias: historically used as “public URL for QR/deep links”.
   * In schema v6+ the canonical/share URL is `serverUrl`, so this is always equal to `serverUrl`.
   */
  public readonly publicServerUrl: string
  public readonly webappUrl: string
  public readonly activeServerId: string
  public readonly isDaemonProcess: boolean

  // Directories and paths (from persistence)
  public readonly happyHomeDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly serversDir: string
  public readonly activeServerDir: string
  public readonly legacyPrivateKeyFile: string
  public readonly privateKeyFile: string
  public readonly daemonStateFile: string
  public readonly daemonLockFile: string
  // Session attach file pruning (best-effort; defense-in-depth for crash-before-read scenarios).
  public readonly sessionAttachFileMaxAgeMs: number
  // Session control HTTP timeouts (v2 sessions endpoints; archive/unarchive, list, etc).
  public readonly sessionControlHttpTimeoutMs: number
  // Vendor CLI `--help` invocation timeout (defense-in-depth against hung vendor CLIs).
  public readonly vendorCliHelpTimeoutMs: number
  // Managed runtime installable auto-update background check interval.
  public readonly installablesRuntimeAutoUpdateCheckIntervalMs: number
  // File system RPC limits (Files tab + transfers).
  public readonly filesReadMaxBytes: number
  public readonly filesTransferChunkBytes: number
  public readonly filesTransferSessionTtlMs: number
  public readonly filesUploadMaxFileBytes: number
  public readonly filesDownloadMaxFileBytes: number
  public readonly filesZipMaxTotalBytes: number
  public readonly filesZipMaxEntryCount: number
  public readonly filesZipExcludedTopLevelDirs: readonly string[]
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean
  public readonly socketForceWebsocketOnly: boolean
  public readonly socketIoTransports: string[]

  // Session connection keep-alive (ephemeral thinking state + online presence).
  public readonly sessionKeepAliveIdleMs: number
  public readonly sessionKeepAliveThinkingMs: number

  // Pending queue V2: idle wake polling (ensures queued prompts are materialized even if socket wakeups are missed).
  public readonly pendingQueueIdleWakePollIntervalMs: number

  // MCP server SSE keepalive (prevents client idle timeouts on long-lived streams).
  public readonly mcpSseKeepAliveIntervalMs: number | null

  // Transcript lookup / recovery (fallback path when socket ACK/broadcast is missed).
  public readonly transcriptLookupRequestTimeoutMs: number
  public readonly transcriptLookupPollIntervalMs: number
  public readonly transcriptLookupErrorBackoffBaseMs: number
  public readonly transcriptLookupErrorBackoffMaxMs: number
  public readonly transcriptLookupKeepAliveEnabled: boolean

  public readonly transcriptRecoveryDelayMs: number
  public readonly transcriptRecoveryMaxWaitMs: number
  public readonly transcriptRecoveryMaxConcurrent: number
  public readonly transcriptRecoveryErrorLogThrottleMs: number

  // Startup transcript catch-up (avoids missing early prompts; prevents replaying entire history into the agent queue).
  public readonly startupTranscriptCatchUpLookbackMs: number

  // Claude remote TaskOutput sidechain import limits (defense-in-depth against huge transcripts).
  public readonly claudeTaskOutputMaxPendingPerAgent: number
  public readonly claudeTaskOutputMaxSeenUuidsPerSidechain: number
  public readonly claudeTaskOutputMaxToolUseEntries: number
  public readonly claudeTaskOutputMaxAgentMappings: number

  // Claude subagent local JSONL follower (used in remote mode when Task returns output_file).
  public readonly claudeSubagentJsonlPollIntervalMs: number

  // Claude permission handler metadata watcher (prevents tight loops when metadata updates are unavailable).
  public readonly claudeMetadataWatcherIdleBackoffMs: number

  // Claude local transcript scanner (UI-facing missing-transcript warning delay).
  public readonly claudeTranscriptMissingWarningMs: number

  // Claude Task tool policy (remote mode).
  public readonly claudeTaskAllowRunInBackground: boolean
  /**
   * When a user aborts a Claude session, the vendor SDK may surface a cancellation as a process-level
   * unhandledRejection (known "Operation aborted" error). Within this short window after a user abort,
   * the CLI treats that specific error as non-fatal so the session runner does not crash and respawn.
   */
  public readonly claudeAbortUnhandledRejectionIgnoreWindowMs: number
  /**
   * When a user approves ExitPlanMode, the UI/metadata update that clears plan mode may arrive slightly
   * after Claude resumes tool execution. This latch window ensures same-turn tool calls are not denied
   * as "still in plan mode" while the metadata update propagates.
   */
  public readonly claudeExitPlanModeLatchMs: number
  /** Max number of per-message localIds remembered for ExitPlanMode latch. */
  public readonly claudeExitPlanModeLatchMaxEntries: number

  // Permission-request push notifications (best-effort; bounded retries).
  public readonly permissionRequestPushRetryDelaysMs: readonly number[]
  public readonly permissionRequestPushRetryMaxMs: number
  public readonly permissionRequestPushDedupeMaxEntries: number

  // Execution runs and ephemeral tasks (session-process budgets).
  public readonly executionRunsMaxConcurrentPerSession: number | null
  public readonly ephemeralTasksMaxConcurrentPerSession: number | null
  public readonly executionRunsBoundedTimeoutMs: number | null
  public readonly executionRunsReviewBoundedTimeoutMs: number | null
  public readonly executionRunsMaxTurns: number | null
  public readonly executionRunsMaxDepth: number
  public readonly executionBudgetMaxConcurrentTotalPerSession: number | null
  public readonly executionBudgetMaxConcurrentByClass: Readonly<Record<string, number>>

  // Memory search (daemon-local indexing) limits.
  public readonly memoryMaxTranscriptWindowMessages: number
  public readonly memoryEmbeddingsRemoteRequestTimeoutMs: number

  // Replay-fork synopsis lookup (memory artifacts may be older than the most recent replay page).
  public readonly replaySynopsisScanMaxPages: number
  public readonly replaySynopsisScanPageSize: number
  // Replay seed prompt budget (prevents oversized provider prompts).
  public readonly replaySeedMaxChars: number
  // Replay transcript fetch size for seed hydration (best-effort; bounded by server /v1/messages limit).
  public readonly replaySeedCandidateLimit: number

  // Startup coordinator / deferred session buffering (fast-start).
  public readonly startupTimingEnabled: boolean
  public readonly startupDeferredSessionBufferMaxEntries: number
  public readonly startupDeferredSessionBufferMaxBytes: number
  public readonly startupPermissionSeedTranscriptTake: number
  public readonly startupOverridesCacheMaxAgeMs: number

  constructor() {
    // Check if we're running as daemon based on process args
    const args = normalizeCliArgv(process.argv.slice(2))
    this.isDaemonProcess = isDaemonProcessArgv(args)

    // Directory configuration - Priority: HAPPIER_HOME_DIR env > default home dir
    if (process.env.HAPPIER_HOME_DIR) {
      // Expand ~ to home directory if present
      const expandedPath = process.env.HAPPIER_HOME_DIR.replace(/^~/, homedir())
      this.happyHomeDir = expandedPath
    } else {
      this.happyHomeDir = join(homedir(), '.happier')
    }

    this.logsDir = join(this.happyHomeDir, 'logs')
    this.settingsFile = join(this.happyHomeDir, 'settings.json')
    this.serversDir = join(this.happyHomeDir, 'servers')

    const envServerUrl = (process.env.HAPPIER_SERVER_URL ?? '').toString().trim();
    const envLocalServerUrl = (process.env.HAPPIER_LOCAL_SERVER_URL ?? '').toString().trim();
    const envWebappUrl = (process.env.HAPPIER_WEBAPP_URL ?? '').toString().trim();
    const envPublicServerUrl = (process.env.HAPPIER_PUBLIC_SERVER_URL ?? '').toString().trim();
    const envActiveServerIdRaw = (process.env.HAPPIER_ACTIVE_SERVER_ID ?? '').toString().trim();
    const envActiveServerId = isServerIdFilesystemSafe(envActiveServerIdRaw)
      ? envActiveServerIdRaw
      : null;
    const persisted = readActiveServerFromSettingsFile(this.settingsFile);
    const resolved = resolveServerSelection({
      envServerUrl: envServerUrl || null,
      envLocalServerUrl: envLocalServerUrl || null,
      envPublicServerUrl: envPublicServerUrl || null,
      envWebappUrl: envWebappUrl || null,
      envActiveServerId,
      persisted,
    });

    this.serverUrl = resolved.serverUrl
    this.apiServerUrl = resolved.apiServerUrl
    this.publicServerUrl = resolved.serverUrl
    this.webappUrl = resolved.webappUrl
    this.activeServerId = sanitizeServerIdForFilesystem(resolved.activeServerId, 'cloud')

    this.activeServerDir = join(this.serversDir, this.activeServerId)
    this.legacyPrivateKeyFile = join(this.happyHomeDir, 'access.key')
    this.privateKeyFile = join(this.activeServerDir, 'access.key')
    this.daemonStateFile = join(this.activeServerDir, 'daemon.state.json')
    this.daemonLockFile = join(this.activeServerDir, 'daemon.state.json.lock')

    const attachMaxAgeRaw = String(process.env.HAPPIER_SESSION_ATTACH_FILE_MAX_AGE_MS ?? '').trim();
    const attachMaxAgeMs = Number.parseInt(attachMaxAgeRaw, 10);
    // Default: 10 minutes. Set to 0 to disable pruning.
    this.sessionAttachFileMaxAgeMs =
      attachMaxAgeRaw === '0'
        ? 0
        : Number.isFinite(attachMaxAgeMs) && attachMaxAgeMs >= 1
          ? attachMaxAgeMs
          : 10 * 60_000;

    // Default: 60s. Defensive minimum: 1s.
    this.sessionControlHttpTimeoutMs = resolveIntEnvWithBounds('HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS', {
      min: 1000, default: 60_000,
    });

    const vendorHelpTimeoutRaw = String(process.env.HAPPIER_VENDOR_CLI_HELP_TIMEOUT_MS ?? '').trim();
    const vendorHelpTimeoutMs = Number.parseInt(vendorHelpTimeoutRaw, 10);
    // Default: 5s. Set to 0 to disable timeouts.
    this.vendorCliHelpTimeoutMs =
      vendorHelpTimeoutRaw === '0'
        ? 0
        : Number.isFinite(vendorHelpTimeoutMs) && vendorHelpTimeoutMs >= 250
          ? Math.min(vendorHelpTimeoutMs, 60_000)
          : 5_000;

    // Default: 6 hours. Defensive minimum: 1 minute.
    this.installablesRuntimeAutoUpdateCheckIntervalMs = resolveIntEnvWithBounds(
      'HAPPIER_INSTALLABLES_AUTO_UPDATE_CHECK_INTERVAL_MS',
      { min: 60_000, default: 6 * 60 * 60_000 },
    );

    // Default: 2.5MB. Defensive minimum: 1 byte.
    this.filesReadMaxBytes = resolveIntEnvWithBounds('HAPPIER_FILES_READ_MAX_BYTES', {
      min: 1, default: 2_500_000,
    });

    // Default: 256KB. Defensive min: 1KB; max: 5MB.
    this.filesTransferChunkBytes = resolveIntEnvWithBounds('HAPPIER_FILES_TRANSFER_CHUNK_BYTES', {
      min: 1024, max: 5_000_000, default: 256_000,
    });

    // Default: 10 minutes. Defensive min: 1s; max: 60 minutes.
    this.filesTransferSessionTtlMs = resolveIntEnvWithBounds('HAPPIER_FILES_TRANSFER_SESSION_TTL_MS', {
      min: 1000, max: 60 * 60_000, default: 10 * 60_000,
    });

    // Default: 50MB. Defensive minimum: 1 byte.
    this.filesUploadMaxFileBytes = resolveIntEnvWithBounds('HAPPIER_FILES_UPLOAD_MAX_FILE_BYTES', {
      min: 1, default: 50 * 1024 * 1024,
    });

    // Default: 50MB. Defensive minimum: 1 byte.
    this.filesDownloadMaxFileBytes = resolveIntEnvWithBounds('HAPPIER_FILES_DOWNLOAD_MAX_FILE_BYTES', {
      min: 1, default: 50 * 1024 * 1024,
    });

    // Default: 100MB. Defensive minimum: 1 byte.
    this.filesZipMaxTotalBytes = resolveIntEnvWithBounds('HAPPIER_FILES_ZIP_MAX_TOTAL_BYTES', {
      min: 1, default: 100 * 1024 * 1024,
    });

    // Default: 10k. Defensive minimum: 1 entry; max: 100k.
    this.filesZipMaxEntryCount = resolveIntEnvWithBounds('HAPPIER_FILES_ZIP_MAX_ENTRY_COUNT', {
      min: 1, max: 100_000, default: 10_000,
    });

    const defaultZipExcludedTopLevelDirs = '.git,.sl,node_modules,.happier';
    const filesZipExcludedTopLevelDirsRaw = String(process.env.HAPPIER_FILES_ZIP_EXCLUDED_TOP_LEVEL_DIRS ?? '').trim();
    const zipExcludedTopLevelDirsCsv = filesZipExcludedTopLevelDirsRaw || defaultZipExcludedTopLevelDirs;
    const zipExcludedTopLevelDirs = zipExcludedTopLevelDirsCsv
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
    const zipExcludedUnique = new Set<string>();
    const zipExcludedOut: string[] = [];
    for (const value of zipExcludedTopLevelDirs) {
      if (zipExcludedUnique.has(value)) continue;
      zipExcludedUnique.add(value);
      zipExcludedOut.push(value);
    }
    this.filesZipExcludedTopLevelDirs = zipExcludedOut;

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.HAPPIER_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.HAPPIER_DISABLE_CAFFEINATE?.toLowerCase() || '');
    const forceWebsocketRaw = (process.env.HAPPIER_SOCKET_FORCE_WEBSOCKET ?? '').toString().trim().toLowerCase();
    this.socketForceWebsocketOnly = ['true', '1', 'yes', 'on'].includes(forceWebsocketRaw);

    const socketTransportsRaw = (process.env.HAPPIER_SOCKET_TRANSPORTS ?? '').toString().trim().toLowerCase();
    const parsedSocketTransports = (() => {
      if (!socketTransportsRaw) return null;
      const allowed = new Set(['websocket', 'polling']);
      const seen = new Set<string>();
      const out: string[] = [];
      for (const raw of socketTransportsRaw.split(',')) {
        const value = raw.trim().toLowerCase();
        if (!value) continue;
        if (!allowed.has(value)) continue;
        if (seen.has(value)) continue;
        seen.add(value);
        out.push(value);
      }
      return out.length > 0 ? out : null;
    })();

    this.socketIoTransports =
      parsedSocketTransports
      ?? (this.socketForceWebsocketOnly ? ['websocket'] : ['websocket', 'polling']);

    // Defaults chosen to balance UI responsiveness and background traffic:
    // - thinking: ~2s so UI connecting mid-turn sees 'thinking' quickly
    // - idle: ~15s to reduce noise while maintaining presence
    this.sessionKeepAliveIdleMs = resolveIntEnvWithBounds('HAPPIER_SESSION_KEEPALIVE_IDLE_MS', {
      min: 1000, default: 15_000,
    });
    this.sessionKeepAliveThinkingMs = resolveIntEnvWithBounds('HAPPIER_SESSION_KEEPALIVE_THINKING_MS', {
      min: 500, default: 2_000,
    });

    const pendingWakeRaw = String(process.env.HAPPIER_PENDING_QUEUE_IDLE_WAKE_POLL_INTERVAL_MS ?? '').trim();
    const pendingWakeMs = Number.parseInt(pendingWakeRaw, 10);
    // Default: 1s. Set to 0 to disable.
    this.pendingQueueIdleWakePollIntervalMs =
      pendingWakeRaw === '0'
        ? 0
        : (Number.isFinite(pendingWakeMs) && pendingWakeMs >= 50
            ? Math.min(pendingWakeMs, 60_000)
            : 1_000);

    const mcpKeepAliveRaw = String(process.env.HAPPIER_MCP_SSE_KEEPALIVE_INTERVAL_MS ?? '').trim();
    const mcpKeepAliveMs = Number.parseInt(mcpKeepAliveRaw, 10);
    // Default: 15s. Must be < client idle timeouts (~5 minutes observed in Claude Code logs).
    // Set to 0 to disable (not recommended).
    this.mcpSseKeepAliveIntervalMs =
      mcpKeepAliveRaw === '0' ? null : (Number.isFinite(mcpKeepAliveMs) && mcpKeepAliveMs >= 10 ? mcpKeepAliveMs : 15_000);

    const parseCsvNumberList = (raw: string, opts: { min: number; max: number }): number[] | null => {
      const value = raw.trim();
      if (!value) return null;
      const out: number[] = [];
      const seen = new Set<number>();
      for (const part of value.split(',')) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const parsed = Number.parseInt(trimmed, 10);
        if (!Number.isFinite(parsed)) continue;
        const clamped = Math.max(opts.min, Math.min(opts.max, parsed));
        if (seen.has(clamped)) continue;
        seen.add(clamped);
        out.push(clamped);
      }
      return out.length > 0 ? out : null;
    };

    const pushRetryDelays =
      parseCsvNumberList(String(process.env.HAPPIER_PERMISSION_REQUEST_PUSH_RETRY_DELAYS_MS ?? ''), { min: 0, max: 600_000 })
      ?? [2_500, 10_000, 30_000, 60_000];
    this.permissionRequestPushRetryDelaysMs = pushRetryDelays;

    this.permissionRequestPushRetryMaxMs = resolveIntEnvWithBounds(
      'HAPPIER_PERMISSION_REQUEST_PUSH_RETRY_MAX_MS',
      { min: 0, max: 60 * 60_000, default: 10 * 60_000 },
    );
    this.permissionRequestPushDedupeMaxEntries = resolveIntEnvWithBounds(
      'HAPPIER_PERMISSION_REQUEST_PUSH_DEDUPE_MAX',
      { min: 0, max: 50_000, default: 2_000 },
    );

    this.transcriptLookupRequestTimeoutMs = resolveIntEnvWithBounds(
      'HAPPIER_TRANSCRIPT_LOOKUP_REQUEST_TIMEOUT_MS',
      { min: 250, default: 10_000 },
    );
    this.transcriptLookupPollIntervalMs = resolveIntEnvWithBounds(
      'HAPPIER_TRANSCRIPT_LOOKUP_POLL_INTERVAL_MS',
      { min: 10, default: 150 },
    );

    const transcriptLookupErrorBackoffBaseRaw = Number.parseInt(
      String(process.env.HAPPIER_TRANSCRIPT_LOOKUP_ERROR_BACKOFF_BASE_MS ?? ''),
      10,
    );
    this.transcriptLookupErrorBackoffBaseMs =
      Number.isFinite(transcriptLookupErrorBackoffBaseRaw) && transcriptLookupErrorBackoffBaseRaw >= 10
        ? transcriptLookupErrorBackoffBaseRaw
        : Math.max(50, this.transcriptLookupPollIntervalMs);

    const transcriptLookupErrorBackoffMaxRaw = Number.parseInt(
      String(process.env.HAPPIER_TRANSCRIPT_LOOKUP_ERROR_BACKOFF_MAX_MS ?? ''),
      10,
    );
    this.transcriptLookupErrorBackoffMaxMs =
      Number.isFinite(transcriptLookupErrorBackoffMaxRaw) && transcriptLookupErrorBackoffMaxRaw >= this.transcriptLookupErrorBackoffBaseMs
        ? transcriptLookupErrorBackoffMaxRaw
        : Math.max(this.transcriptLookupErrorBackoffBaseMs, 2_000);

    const transcriptLookupKeepAliveRaw = String(process.env.HAPPIER_TRANSCRIPT_LOOKUP_KEEPALIVE ?? '').trim().toLowerCase();
    this.transcriptLookupKeepAliveEnabled =
      transcriptLookupKeepAliveRaw.length === 0 ? true : ['1', 'true', 'yes', 'on'].includes(transcriptLookupKeepAliveRaw);

    this.transcriptRecoveryDelayMs = resolveIntEnvWithBounds('HAPPIER_TRANSCRIPT_RECOVERY_DELAY_MS', {
      min: 0, default: 500,
    });
    this.transcriptRecoveryMaxWaitMs = resolveIntEnvWithBounds('HAPPIER_TRANSCRIPT_RECOVERY_MAX_WAIT_MS', {
      min: 250, default: 7_500,
    });

    this.transcriptRecoveryMaxConcurrent = resolveIntEnvWithBounds('HAPPIER_TRANSCRIPT_RECOVERY_MAX_CONCURRENT', {
      min: 1, default: 3,
    });

    this.transcriptRecoveryErrorLogThrottleMs = resolveIntEnvWithBounds(
      'HAPPIER_TRANSCRIPT_RECOVERY_ERROR_LOG_THROTTLE_MS',
      { min: 0, default: 5_000 },
    );

    this.startupTranscriptCatchUpLookbackMs = resolveIntEnvWithBounds(
      'HAPPIER_STARTUP_TRANSCRIPT_CATCH_UP_LOOKBACK_MS',
      { min: 0, default: 10_000 },
    );

    this.claudeTaskOutputMaxPendingPerAgent = resolveIntEnvWithBounds(
      'HAPPIER_CLAUDE_TASKOUTPUT_MAX_PENDING_PER_AGENT', { min: 0, default: 2000 },
    );
    this.claudeTaskOutputMaxSeenUuidsPerSidechain = resolveIntEnvWithBounds(
      'HAPPIER_CLAUDE_TASKOUTPUT_MAX_SEEN_UUIDS_PER_SIDECHAIN', { min: 0, default: 5000 },
    );
    this.claudeTaskOutputMaxToolUseEntries = resolveIntEnvWithBounds(
      'HAPPIER_CLAUDE_TASKOUTPUT_MAX_TOOLUSE_ENTRIES', { min: 0, default: 5000 },
    );
    this.claudeTaskOutputMaxAgentMappings = resolveIntEnvWithBounds(
      'HAPPIER_CLAUDE_TASKOUTPUT_MAX_AGENT_MAPPINGS', { min: 0, default: 2000 },
    );

    // Default: 250ms. Most imports will be watcher-driven; this is a safety net if fs watch misses events.
    this.claudeSubagentJsonlPollIntervalMs = resolveIntEnvWithBounds(
      'HAPPIER_CLAUDE_SUBAGENT_JSONL_POLL_INTERVAL_MS', { min: 25, default: 250 },
    );

    // Default: 250ms. Prevents tight loops when waitForMetadataUpdate returns false (e.g. detached session client).
    this.claudeMetadataWatcherIdleBackoffMs = resolveIntEnvWithBounds(
      'HAPPIER_CLAUDE_METADATA_WATCHER_IDLE_BACKOFF_MS',
      { min: 25, max: 60_000, default: 250 },
    );

    // Default: 15s. Set to 0 to disable.
    this.claudeTranscriptMissingWarningMs = resolveIntEnvWithBounds(
      'HAPPIER_CLAUDE_TRANSCRIPT_MISSING_WARNING_MS',
      { min: 0, max: 2 * 60_000, default: 15_000 },
    );

    const allowTaskBackgroundRaw = String(process.env.HAPPIER_CLAUDE_TASK_ALLOW_RUN_IN_BACKGROUND ?? '').trim().toLowerCase();
    this.claudeTaskAllowRunInBackground = ['1', 'true', 'yes', 'on'].includes(allowTaskBackgroundRaw);

    // Default: 10s. Set to 0 to disable suppression.
    this.claudeAbortUnhandledRejectionIgnoreWindowMs = resolveIntEnvWithBounds(
      'HAPPIER_CLAUDE_ABORT_UNHANDLED_REJECTION_IGNORE_WINDOW_MS',
      { min: 0, max: 60_000, default: 10_000 },
    );

    // Default: 15s. Needs to be long enough to cover same-turn tool calls while metadata update propagates.
    this.claudeExitPlanModeLatchMs = resolveIntEnvWithBounds('HAPPIER_CLAUDE_EXIT_PLAN_MODE_LATCH_MS', {
      min: 0, max: 5 * 60_000, default: 15_000,
    });
    this.claudeExitPlanModeLatchMaxEntries = resolveIntEnvWithBounds(
      'HAPPIER_CLAUDE_EXIT_PLAN_MODE_LATCH_MAX_ENTRIES',
      { min: 1, max: 2_000, default: 100 },
    );

    const maxConcurrentRunsRaw = Number.parseInt(String(process.env.HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION ?? ''), 10);
    const boundedTimeoutRaw = Number.parseInt(String(process.env.HAPPIER_EXECUTION_RUNS_BOUNDED_TIMEOUT_MS ?? ''), 10);
    const reviewBoundedTimeoutRaw = Number.parseInt(
      String(process.env.HAPPIER_EXECUTION_RUNS_REVIEW_BOUNDED_TIMEOUT_MS ?? ''),
      10,
    );
    const maxTurnsRaw = Number.parseInt(String(process.env.HAPPIER_EXECUTION_RUNS_MAX_TURNS ?? ''), 10);
    const budgetTotalRaw = Number.parseInt(String(process.env.HAPPIER_EXECUTION_BUDGET_MAX_CONCURRENT_TOTAL_PER_SESSION ?? ''), 10);
    const budgetByClassRaw = String(process.env.HAPPIER_EXECUTION_BUDGET_MAX_CONCURRENT_BY_CLASS_JSON ?? '').trim();

    // Intentionally unlimited by default: execution runs are first-class sub-sessions and should not
    // inherit an arbitrary product cap unless an operator explicitly configures one.
    this.executionRunsMaxConcurrentPerSession =
      Number.isFinite(maxConcurrentRunsRaw) && maxConcurrentRunsRaw >= 1 ? maxConcurrentRunsRaw : null;
    const maxConcurrentEphemeralTasksRaw = Number.parseInt(
      String(process.env.HAPPIER_EPHEMERAL_TASKS_MAX_CONCURRENT_PER_SESSION ?? ''),
      10,
    );
    // Intentionally unlimited by default: ephemeral tasks (including reviews and automation helpers) can be long-lived,
    // and concurrency limits should only be applied when an operator explicitly configures them.
    this.ephemeralTasksMaxConcurrentPerSession =
      Number.isFinite(maxConcurrentEphemeralTasksRaw) && maxConcurrentEphemeralTasksRaw >= 1
        ? maxConcurrentEphemeralTasksRaw
        : null;
    // Intentionally no wall-clock timeout by default: users should stop long-running plan/delegate/review
    // runs explicitly, while operators can still opt into caps via env overrides.
    this.executionRunsBoundedTimeoutMs =
      Number.isFinite(boundedTimeoutRaw) && boundedTimeoutRaw >= 1_000 ? boundedTimeoutRaw : null;
    this.executionRunsReviewBoundedTimeoutMs =
      Number.isFinite(reviewBoundedTimeoutRaw) && reviewBoundedTimeoutRaw >= 1_000 ? reviewBoundedTimeoutRaw : null;
    // Intentionally unlimited by default: long-lived execution runs should not stop unexpectedly.
    this.executionRunsMaxTurns = Number.isFinite(maxTurnsRaw) && maxTurnsRaw >= 1 ? Math.trunc(maxTurnsRaw) : null;
    // Depth 0 means "no nested runs allowed". Default 1 allows one nested hop when explicitly linked.
    this.executionRunsMaxDepth = resolveIntEnvWithBounds('HAPPIER_EXECUTION_RUNS_MAX_DEPTH', {
      min: 0, default: 1,
    });

    this.executionBudgetMaxConcurrentTotalPerSession =
      Number.isFinite(budgetTotalRaw) && budgetTotalRaw >= 1 ? budgetTotalRaw : null;

    const parsedBudgetByClass: Record<string, number> = {};
    if (budgetByClassRaw) {
      try {
        const parsed = JSON.parse(budgetByClassRaw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            const cls = String(key ?? '').trim();
            if (!cls) continue;
            const num = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
            if (!Number.isFinite(num)) continue;
            const int = Math.floor(num);
            if (int < 1) continue;
            parsedBudgetByClass[cls] = int;
          }
        }
      } catch {
        // ignore invalid json
      }
    }
    this.executionBudgetMaxConcurrentByClass = Object.freeze(parsedBudgetByClass);

    // Default: 250 messages. Hard bounds protect daemon from excessive replay windows.
    // Min 50 ensures meaningful windows; max 500 matches server enforcement.
    this.memoryMaxTranscriptWindowMessages = resolveIntEnvWithBounds(
      'HAPPIER_MEMORY_MAX_TRANSCRIPT_WINDOW_MESSAGES',
      { min: 50, max: 500, default: 250 },
    );
    this.memoryEmbeddingsRemoteRequestTimeoutMs = resolveIntEnvWithBounds(
      'HAPPIER_MEMORY_EMBEDDINGS_REMOTE_REQUEST_TIMEOUT_MS',
      { min: 1_000, default: 15_000 },
    );

    // Default: 6 pages (enough to find the latest memory synopsis without scanning arbitrarily far back).
    // Min 0 disables the scan; max 25 is a hard safety cap.
    this.replaySynopsisScanMaxPages = resolveIntEnvWithBounds('HAPPIER_REPLAY_SYNOPSIS_SCAN_MAX_PAGES', {
      min: 0, max: 25, default: 6,
    });
    // Default: 500 (server max). Min 1; max 500 to match server enforcement.
    this.replaySynopsisScanPageSize = resolveIntEnvWithBounds('HAPPIER_REPLAY_SYNOPSIS_SCAN_PAGE_SIZE', {
      min: 1, max: 500, default: 500,
    });
    // Default: 120k chars. Hard bounds protect providers from oversized replay seeds.
    // Min 500 keeps the prompt meaningful; max 200k is a safety cap.
    this.replaySeedMaxChars = resolveIntEnvWithBounds('HAPPIER_REPLAY_MAX_SEED_CHARS', {
      min: 500, max: 200_000, default: 120_000,
    });
    // Default: 500 (server max). Min 50 ensures meaningful context; max 500 matches server enforcement.
    this.replaySeedCandidateLimit = resolveIntEnvWithBounds('HAPPIER_REPLAY_SEED_CANDIDATE_LIMIT', {
      min: 50, max: 500, default: 500,
    });

    const startupTimingRaw = String(process.env.HAPPIER_STARTUP_TIMING_ENABLED ?? '').trim().toLowerCase();
    this.startupTimingEnabled = startupTimingRaw === '1' || startupTimingRaw === 'true' || startupTimingRaw === 'yes' || startupTimingRaw === 'on';

    // Defaults: conservative bounds to buffer early startup writes until the server session attaches.
    this.startupDeferredSessionBufferMaxEntries = resolveIntEnvWithBounds(
      'HAPPIER_STARTUP_DEFERRED_SESSION_MAX_ENTRIES', { min: 10, default: 500 },
    );
    this.startupDeferredSessionBufferMaxBytes = resolveIntEnvWithBounds(
      'HAPPIER_STARTUP_DEFERRED_SESSION_MAX_BYTES', { min: 1024, default: 256_000 },
    );

    // Default: 50 messages (enough to recover the latest permission intent without excessive transcript fetches).
    this.startupPermissionSeedTranscriptTake = resolveIntEnvWithBounds(
      'HAPPIER_STARTUP_PERMISSION_SEED_TRANSCRIPT_TAKE',
      { min: 1, max: 500, default: 50 },
    );

    // Default: 7 days. Used only to seed fast-start permission/model defaults when explicit args are missing.
    this.startupOverridesCacheMaxAgeMs = resolveIntEnvWithBounds(
      'HAPPIER_STARTUP_OVERRIDES_CACHE_MAX_AGE_MS',
      { min: 0, default: 7 * 24 * 60 * 60 * 1000 },
    );

    this.currentCliVersion = packageJson.version

    // Variant configuration is handled by caller/UX; configuration must not write to stdout/stderr.

    if (!existsSync(this.happyHomeDir)) {
      mkdirSync(this.happyHomeDir, { recursive: true })
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(this.happyHomeDir, 0o700)
      } catch {
        // best-effort
      }
    }

    // Ensure directories exist
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true })
    }
    if (!existsSync(this.serversDir)) {
      mkdirSync(this.serversDir, { recursive: true })
    }
    if (!existsSync(this.activeServerDir)) {
      mkdirSync(this.activeServerDir, { recursive: true })
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(this.logsDir, 0o700)
      } catch {
        // best-effort
      }
      try {
        chmodSync(this.serversDir, 0o700)
      } catch {
        // best-effort
      }
      try {
        chmodSync(this.activeServerDir, 0o700)
      } catch {
        // best-effort
      }
    }

    // Best-effort tightening for existing sensitive files (covers upgrades from older versions).
    if (process.platform !== 'win32') {
      const maybeSensitiveFiles = [
        this.settingsFile,
        this.legacyPrivateKeyFile,
        this.privateKeyFile,
        this.daemonStateFile,
        this.daemonLockFile,
      ]
      for (const file of maybeSensitiveFiles) {
        try {
          if (existsSync(file)) chmodSync(file, 0o600)
        } catch {
          // best-effort
        }
      }
    }
  }
}

type PersistedServerProfile = Readonly<{
  id: string;
  serverUrl: string;
  localServerUrl?: string;
  webappUrl: string;
}>;

type PersistedServerSettings = Readonly<{
  activeServerId: string;
  servers: Record<string, PersistedServerProfile>;
}>;

function readActiveServerFromSettingsFile(path: string): PersistedServerSettings | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const schemaVersion = Number((raw as any).schemaVersion ?? 0);
    if (!Number.isFinite(schemaVersion) || schemaVersion < 5) return null;
    const activeServerId = sanitizeServerIdForFilesystem((raw as any).activeServerId ?? '', '');
    const serversRaw = (raw as any).servers;
    if (!activeServerId || !serversRaw || typeof serversRaw !== 'object') return null;
        const servers: Record<string, PersistedServerProfile> = {};
        const normalizeUrl = (value: unknown): string => String(value ?? '').trim().replace(/\/+$/, '');
        for (const [id, v] of Object.entries(serversRaw as Record<string, any>)) {
          const sid = sanitizeServerIdForFilesystem((v as any)?.id ?? id, '');
          const serverUrlRaw = normalizeUrl((v as any)?.serverUrl);
          const legacyPublicServerUrl = normalizeUrl((v as any)?.publicServerUrl);
      const localServerUrlRaw = normalizeUrl((v as any)?.localServerUrl);
      const webappUrl = normalizeUrl((v as any)?.webappUrl);
      if (!sid || !serverUrlRaw || !webappUrl) continue;

      const serverUrl =
        legacyPublicServerUrl && legacyPublicServerUrl !== serverUrlRaw
          ? legacyPublicServerUrl
          : serverUrlRaw;

          const localServerUrl =
            localServerUrlRaw
              ? localServerUrlRaw
              : (legacyPublicServerUrl && legacyPublicServerUrl !== serverUrlRaw && isLocalishServerUrl(serverUrlRaw) ? serverUrlRaw : '');

          servers[sid] = {
            id: sid,
            serverUrl,
        ...(localServerUrl ? { localServerUrl } : {}),
        webappUrl,
      };
    }
    if (!servers[activeServerId]) return null;
    return { activeServerId, servers };
  } catch {
    return null;
  }
}

function deriveServerIdFromUrl(url: string): string {
  // Deterministic, filesystem-safe id for ad-hoc server URLs (used when env overrides are set).
  // Not cryptographic; intended only for local directory names.
  let h = 2166136261;
  for (let i = 0; i < url.length; i += 1) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `env_${(h >>> 0).toString(16)}`;
}

function normalizeServerUrl(url: string): string {
  return String(url ?? '').trim().replace(/\/+$/, '');
}

function resolveServerSelection(params: Readonly<{
  envServerUrl: string | null;
  envLocalServerUrl: string | null;
  envPublicServerUrl: string | null;
  envWebappUrl: string | null;
  envActiveServerId: string | null;
  persisted: PersistedServerSettings | null;
}>): Readonly<{ activeServerId: string; serverUrl: string; apiServerUrl: string; webappUrl: string }> {
  const DEFAULT_SERVER_URL = 'https://api.happier.dev';
  const DEFAULT_WEBAPP_URL = 'https://app.happier.dev';
  const resolveActiveServerId = (fallbackId: string): string =>
    sanitizeServerIdForFilesystem(params.envActiveServerId ?? fallbackId, 'cloud');

  const normalizeUrl = (value: string | null): string | null => {
    const out = normalizeServerUrl(value ?? '');
    return out ? out : null;
  };

  // Env override semantics (compat):
  // - If HAPPIER_PUBLIC_SERVER_URL is set: treat it as canonical serverUrl and use HAPPIER_LOCAL_SERVER_URL/HAPPIER_SERVER_URL for apiServerUrl.
  // - Else: treat HAPPIER_SERVER_URL as canonical serverUrl (legacy), and use HAPPIER_LOCAL_SERVER_URL as apiServerUrl override if provided.
  const envCanonicalServerUrl = normalizeUrl(params.envPublicServerUrl) ?? normalizeUrl(params.envServerUrl);
  if (envCanonicalServerUrl) {
    const envPublicServerUrl = normalizeUrl(params.envPublicServerUrl);
    const envLocalServerUrl = normalizeUrl(params.envLocalServerUrl);
    const ignoreStaleLocalOverride =
      !envPublicServerUrl &&
      isLocalishServerUrl(envCanonicalServerUrl) &&
      !!envLocalServerUrl &&
      normalizeServerUrl(envLocalServerUrl) !== normalizeServerUrl(envCanonicalServerUrl);
    const envApiServerUrl =
      (ignoreStaleLocalOverride ? null : envLocalServerUrl)
      ?? (envPublicServerUrl ? normalizeUrl(params.envServerUrl) : null)
      ?? envCanonicalServerUrl;

    const persistedMatch = params.persisted
      ? Object.values(params.persisted.servers).find((s) => normalizeServerUrl(s.serverUrl) === envCanonicalServerUrl) ?? null
      : null;

    let webappUrl = params.envWebappUrl;
    if (!webappUrl) {
      if (persistedMatch?.webappUrl) {
        webappUrl = persistedMatch.webappUrl;
      } else if (envCanonicalServerUrl === DEFAULT_SERVER_URL) {
        webappUrl = DEFAULT_WEBAPP_URL;
      } else {
        try {
          webappUrl = new URL(envCanonicalServerUrl).origin;
        } catch {
          webappUrl = DEFAULT_WEBAPP_URL;
        }
      }
    }
    const activeServerId = resolveActiveServerId(persistedMatch?.id ?? deriveServerIdFromUrl(envCanonicalServerUrl));
    return { activeServerId, serverUrl: envCanonicalServerUrl, apiServerUrl: envApiServerUrl, webappUrl };
  }

  if (params.persisted) {
    const active = params.persisted.servers[params.persisted.activeServerId];
    if (active) {
      const canonical = normalizeServerUrl(active.serverUrl);
      const apiServerUrl = normalizeServerUrl(active.localServerUrl ?? '') || canonical;
      return {
        activeServerId: resolveActiveServerId(active.id),
        serverUrl: canonical,
        apiServerUrl,
        webappUrl: active.webappUrl,
      };
    }
  }

  return {
    activeServerId: resolveActiveServerId('cloud'),
    serverUrl: DEFAULT_SERVER_URL,
    apiServerUrl: DEFAULT_SERVER_URL,
    webappUrl: DEFAULT_WEBAPP_URL,
  };
}

export let configuration: Configuration = new Configuration()

export function reloadConfiguration(): void {
  configuration = new Configuration()
}
