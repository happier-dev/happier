import type { ClientEncryptionRequirement } from '@happier-dev/protocol';
import { HappierReplayWritableMaxSeedCharsSchema } from '@happier-dev/protocol/sessions/replay-seed-budget';
import { readFiniteTransferConfig } from '@happier-dev/transfers/node';

import { resolveIntEnvWithBounds } from './resolveIntEnvWithBounds';
import { resolveFileLogLevel, type FileLogLevel } from '../ui/logFileLevel';

export const DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS = 100_000_000;
export const DEFAULT_EXECUTION_RUN_WAIT_MCP_TIMEOUT_GRACE_MS = 60_000;
const MAX_SAFE_NODE_TIMEOUT_MS = 2_147_000_000;

export type ShellBridgeContextEnvMode = 'off' | 'home' | 'full';

function resolveShellBridgeContextEnvMode(env: NodeJS.ProcessEnv): ShellBridgeContextEnvMode {
  const raw = String(env.HAPPIER_SHELL_BRIDGE_CONTEXT_ENV ?? '').trim().toLowerCase();
  if (raw === 'home' || raw === 'full') return raw;
  return 'off';
}

function resolveClientEncryptionRequirementEnv(env: NodeJS.ProcessEnv): ClientEncryptionRequirement {
  const raw = String(env.HAPPIER_ENCRYPTION_REQUIREMENT ?? '').trim().toLowerCase();
  if (!raw || raw === 'follow_account') return 'follow_account';
  if (raw === 'require_e2ee') return 'require_e2ee';
  throw new Error(
    'Invalid HAPPIER_ENCRYPTION_REQUIREMENT; expected "follow_account" or "require_e2ee"',
  );
}

/** Pure runtime policy: one projection per admitted Session, without host storage initialization. */
export class SessionRuntimeConfiguration {
  public readonly fileLogLevel: FileLogLevel
  public readonly debugEnabled: boolean
  public readonly dangerousRemoteLoggingUrl: string | undefined
  public readonly shellBridgeContextEnvMode: ShellBridgeContextEnvMode
  public readonly clientEncryptionRequirement: ClientEncryptionRequirement
  public readonly sessionControlHttpTimeoutMs: number
  public readonly filesReadMaxBytes: number
  public readonly filesDirectoryListMaxEntries: number
  public readonly filesDirectoryTreeMaxDepth: number
  public readonly filesDirectoryTreeMaxNodes: number
  public readonly promptTransferJsonMaxBytes: number
  public readonly filesTransferChunkBytes: number
  public readonly filesTransferSessionTtlMs: number
  public readonly filesUploadMaxFileBytes: number
  public readonly filesDownloadMaxFileBytes: number
  public readonly filesZipMaxTotalBytes: number
  public readonly filesZipMaxEntryCount: number
  public readonly sessionMediaMaxBytesPerSession: number
  public readonly sessionMediaMaxBytesPerWorkspace: number
  public readonly filesZipExcludedTopLevelDirs: readonly string[]
  public readonly isExperimentalEnabled: boolean
  public readonly socketForceWebsocketOnly: boolean
  public readonly socketIoTransports: string[]
  public readonly sessionKeepAliveIdleMs: number
  public readonly sessionKeepAliveThinkingMs: number
  public readonly pendingQueueStateReconcileThrottleMs: number
  public readonly mcpSseKeepAliveIntervalMs: number | null
  public readonly mcpToolCallTimeoutMs: number
  public readonly mcpExecutionRunWaitTimeoutGraceMs: number
  public readonly permissionRequestPushRetryDelaysMs: readonly number[]
  public readonly permissionRequestPushRetryMaxMs: number
  public readonly permissionRequestPushDedupeMaxEntries: number
  public readonly readyNotificationAssistantTextMaxChars: number
  public readonly transcriptLookupRequestTimeoutMs: number
  public readonly transcriptLookupPollIntervalMs: number
  public readonly transcriptLookupErrorBackoffBaseMs: number
  public readonly transcriptLookupErrorBackoffMaxMs: number
  public readonly transcriptLookupKeepAliveEnabled: boolean
  public readonly transcriptRecoveryDelayMs: number
  public readonly transcriptRecoveryMaxWaitMs: number
  public readonly transcriptRecoveryMaxConcurrent: number
  public readonly startupTranscriptCatchUpSeqRewind: number
  public readonly voiceAgentResponseTimeoutMs: number | null
  public readonly memoryMaxTranscriptWindowMessages: number
  public readonly replaySynopsisScanPageSize: number
  public readonly replaySeedMaxChars: number
  public readonly replaySeedCandidateLimit: number
  public readonly replaySeedMaxTranscriptRequests: number
  public readonly replaySeedTranscriptDeadlineMs: number
  public readonly startupTimingEnabled: boolean
  public readonly startupDeferredSessionBufferMaxEntries: number
  public readonly startupDeferredSessionBufferMaxBytes: number
  public readonly startupPermissionSeedTranscriptTake: number
  public readonly startupOverridesCacheMaxAgeMs: number

  constructor(env: NodeJS.ProcessEnv) {
    this.fileLogLevel = resolveFileLogLevel({ env, isDaemonProcess: false });
    this.debugEnabled = Boolean(env.DEBUG);
    const remoteLoggingUrl = env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING && env.HAPPIER_SERVER_URL;
    this.dangerousRemoteLoggingUrl = remoteLoggingUrl || undefined;
    this.shellBridgeContextEnvMode = resolveShellBridgeContextEnvMode(env)
    this.clientEncryptionRequirement = resolveClientEncryptionRequirementEnv(env)

    // Default: 60s. Defensive minimum: 1s.
    this.sessionControlHttpTimeoutMs = resolveIntEnvWithBounds('HAPPIER_SESSION_CONTROL_HTTP_TIMEOUT_MS', {
      min: 1000, default: 60_000,
    }, env);


    // Default: 2.5MB. Defensive minimum: 1 byte.
    this.filesReadMaxBytes = resolveIntEnvWithBounds('HAPPIER_FILES_READ_MAX_BYTES', {
      min: 1, default: 2_500_000,
    }, env);
    this.filesDirectoryListMaxEntries = resolveIntEnvWithBounds('HAPPIER_FILES_DIRECTORY_LIST_MAX_ENTRIES', {
      min: 1, max: 20_000, default: 500,
    }, env);
    this.filesDirectoryTreeMaxDepth = resolveIntEnvWithBounds('HAPPIER_FILES_DIRECTORY_TREE_MAX_DEPTH', {
      min: 0, max: 25, default: 5,
    }, env);
    this.filesDirectoryTreeMaxNodes = resolveIntEnvWithBounds('HAPPIER_FILES_DIRECTORY_TREE_MAX_NODES', {
      min: 1, max: 100_000, default: 2_000,
    }, env);

    // Default: 2.5MB. Defensive min: 1 byte; max: 10MB.
    this.promptTransferJsonMaxBytes = resolveIntEnvWithBounds('HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES', {
      min: 1, max: 10_000_000, default: 2_500_000,
    }, env);

    const fileTransferConfig = readFiniteTransferConfig(env);
    this.filesTransferChunkBytes = fileTransferConfig.chunkSizeBytes;
    this.filesTransferSessionTtlMs = fileTransferConfig.ttlMs;

    // Default: 50MB. Defensive minimum: 1 byte.
    this.filesUploadMaxFileBytes = resolveIntEnvWithBounds('HAPPIER_FILES_UPLOAD_MAX_FILE_BYTES', {
      min: 1, default: 50 * 1024 * 1024,
    }, env);

    // Default: 50MB. Defensive minimum: 1 byte.
    this.filesDownloadMaxFileBytes = resolveIntEnvWithBounds('HAPPIER_FILES_DOWNLOAD_MAX_FILE_BYTES', {
      min: 1, default: 50 * 1024 * 1024,
    }, env);

    // Default: 100MB. Defensive minimum: 1 byte.
    this.filesZipMaxTotalBytes = resolveIntEnvWithBounds('HAPPIER_FILES_ZIP_MAX_TOTAL_BYTES', {
      min: 1, default: 100 * 1024 * 1024,
    }, env);

    // Default: 10k. Defensive minimum: 1 entry; max: 100k.
    this.filesZipMaxEntryCount = resolveIntEnvWithBounds('HAPPIER_FILES_ZIP_MAX_ENTRY_COUNT', {
      min: 1, max: 100_000, default: 10_000,
    }, env);

    // Default: 512MB per session and 2GB per workspace for local session media.
    this.sessionMediaMaxBytesPerSession = resolveIntEnvWithBounds('HAPPIER_SESSION_MEDIA_MAX_BYTES_PER_SESSION', {
      min: 1, default: 512 * 1024 * 1024,
    }, env);
    this.sessionMediaMaxBytesPerWorkspace = resolveIntEnvWithBounds('HAPPIER_SESSION_MEDIA_MAX_BYTES_PER_WORKSPACE', {
      min: 1, default: 2 * 1024 * 1024 * 1024,
    }, env);

    const defaultZipExcludedTopLevelDirs = '.git,.sl,node_modules,.happier';
    const filesZipExcludedTopLevelDirsRaw = String(env.HAPPIER_FILES_ZIP_EXCLUDED_TOP_LEVEL_DIRS ?? '').trim();
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

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(env.HAPPIER_EXPERIMENTAL?.toLowerCase() || '');
    const forceWebsocketRaw = (env.HAPPIER_SOCKET_FORCE_WEBSOCKET ?? '').toString().trim().toLowerCase();
    this.socketForceWebsocketOnly = ['true', '1', 'yes', 'on'].includes(forceWebsocketRaw);

    const socketTransportsRaw = (env.HAPPIER_SOCKET_TRANSPORTS ?? '').toString().trim().toLowerCase();
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

    // Default to polling-first so Socket.IO can reliably upgrade to websocket when the reverse proxy supports it.
    // This avoids "websocket-first" failure modes where some proxies/CDNs break the upgrade path and do not cleanly
    // fall back, which can leave machines appearing offline even though HTTP polling is functional.
    this.socketIoTransports =
      parsedSocketTransports
      ?? (this.socketForceWebsocketOnly ? ['websocket'] : ['polling', 'websocket']);

    // Defaults chosen to balance UI responsiveness and background traffic:
    // - thinking: ~2s so UI connecting mid-turn sees 'thinking' quickly
    // - idle: ~15s to reduce noise while maintaining presence
    this.sessionKeepAliveIdleMs = resolveIntEnvWithBounds('HAPPIER_SESSION_KEEPALIVE_IDLE_MS', {
      min: 1000, default: 15_000,
    }, env);
    this.sessionKeepAliveThinkingMs = resolveIntEnvWithBounds('HAPPIER_SESSION_KEEPALIVE_THINKING_MS', {
      min: 500, default: 2_000,
    }, env);

    this.pendingQueueStateReconcileThrottleMs = resolveIntEnvWithBounds(
      'HAPPIER_PENDING_QUEUE_STATE_RECONCILE_THROTTLE_MS',
      { min: 1_000, max: 60_000, default: 15_000 }, env);

    const mcpKeepAliveRaw = String(env.HAPPIER_MCP_SSE_KEEPALIVE_INTERVAL_MS ?? '').trim();
    const mcpKeepAliveMs = Number.parseInt(mcpKeepAliveRaw, 10);
    // Default: 15s. Must be < client idle timeouts (~5 minutes observed in Claude Code logs).
    // Set to 0 to disable (not recommended).
    this.mcpSseKeepAliveIntervalMs =
      mcpKeepAliveRaw === '0' ? null : (Number.isFinite(mcpKeepAliveMs) && mcpKeepAliveMs >= 10 ? mcpKeepAliveMs : 15_000);
    this.mcpToolCallTimeoutMs = resolveIntEnvWithBounds('HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS', {
      min: 1,
      max: MAX_SAFE_NODE_TIMEOUT_MS,
      default: DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
    }, env);
    this.mcpExecutionRunWaitTimeoutGraceMs = resolveIntEnvWithBounds(
      'HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS',
      {
        min: 0,
        max: MAX_SAFE_NODE_TIMEOUT_MS,
        default: DEFAULT_EXECUTION_RUN_WAIT_MCP_TIMEOUT_GRACE_MS,
      }, env);

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
      parseCsvNumberList(String(env.HAPPIER_PERMISSION_REQUEST_PUSH_RETRY_DELAYS_MS ?? ''), { min: 0, max: 600_000 })
      ?? [2_500, 10_000, 30_000, 60_000];
    this.permissionRequestPushRetryDelaysMs = pushRetryDelays;

    this.permissionRequestPushRetryMaxMs = resolveIntEnvWithBounds(
      'HAPPIER_PERMISSION_REQUEST_PUSH_RETRY_MAX_MS',
      { min: 0, max: 60 * 60_000, default: 10 * 60_000 }, env);
    this.permissionRequestPushDedupeMaxEntries = resolveIntEnvWithBounds(
      'HAPPIER_PERMISSION_REQUEST_PUSH_DEDUPE_MAX',
      { min: 0, max: 50_000, default: 2_000 }, env);
    this.readyNotificationAssistantTextMaxChars = resolveIntEnvWithBounds(
      'HAPPIER_READY_NOTIFICATION_ASSISTANT_TEXT_MAX_CHARS',
      { min: 40, max: 2_000, default: 500 }, env);

    this.transcriptLookupRequestTimeoutMs = resolveIntEnvWithBounds(
      'HAPPIER_TRANSCRIPT_LOOKUP_REQUEST_TIMEOUT_MS',
      { min: 250, default: 10_000 }, env);
    this.transcriptLookupPollIntervalMs = resolveIntEnvWithBounds(
      'HAPPIER_TRANSCRIPT_LOOKUP_POLL_INTERVAL_MS',
      { min: 10, default: 150 }, env);

    const transcriptLookupErrorBackoffBaseRaw = Number.parseInt(
      String(env.HAPPIER_TRANSCRIPT_LOOKUP_ERROR_BACKOFF_BASE_MS ?? ''),
      10,
    );
    this.transcriptLookupErrorBackoffBaseMs =
      Number.isFinite(transcriptLookupErrorBackoffBaseRaw) && transcriptLookupErrorBackoffBaseRaw >= 10
        ? transcriptLookupErrorBackoffBaseRaw
        : Math.max(50, this.transcriptLookupPollIntervalMs);

    const transcriptLookupErrorBackoffMaxRaw = Number.parseInt(
      String(env.HAPPIER_TRANSCRIPT_LOOKUP_ERROR_BACKOFF_MAX_MS ?? ''),
      10,
    );
    this.transcriptLookupErrorBackoffMaxMs =
      Number.isFinite(transcriptLookupErrorBackoffMaxRaw) && transcriptLookupErrorBackoffMaxRaw >= this.transcriptLookupErrorBackoffBaseMs
        ? transcriptLookupErrorBackoffMaxRaw
        : Math.max(this.transcriptLookupErrorBackoffBaseMs, 2_000);

    const transcriptLookupKeepAliveRaw = String(env.HAPPIER_TRANSCRIPT_LOOKUP_KEEPALIVE ?? '').trim().toLowerCase();
    this.transcriptLookupKeepAliveEnabled =
      transcriptLookupKeepAliveRaw.length === 0 ? true : ['1', 'true', 'yes', 'on'].includes(transcriptLookupKeepAliveRaw);

    this.transcriptRecoveryDelayMs = resolveIntEnvWithBounds('HAPPIER_TRANSCRIPT_RECOVERY_DELAY_MS', {
      min: 0, default: 500,
    }, env);
    this.transcriptRecoveryMaxWaitMs = resolveIntEnvWithBounds('HAPPIER_TRANSCRIPT_RECOVERY_MAX_WAIT_MS', {
      min: 250, default: 7_500,
    }, env);

    this.transcriptRecoveryMaxConcurrent = resolveIntEnvWithBounds('HAPPIER_TRANSCRIPT_RECOVERY_MAX_CONCURRENT', {
      min: 1, default: 3,
    }, env);

    this.startupTranscriptCatchUpSeqRewind = resolveIntEnvWithBounds(
      'HAPPIER_STARTUP_TRANSCRIPT_CATCH_UP_SEQ_REWIND',
      { min: 0, default: 1, max: 1000 }, env);
    this.voiceAgentResponseTimeoutMs = resolveIntEnvWithBounds('HAPPIER_VOICE_AGENT_RESPONSE_TIMEOUT_MS', {
      min: 1_000,
      default: 0,
    }, env) || null;

    // Default: 250 messages. Hard bounds protect daemon from excessive replay windows.
    // Min 50 ensures meaningful windows; max 500 matches server enforcement.
    this.memoryMaxTranscriptWindowMessages = resolveIntEnvWithBounds(
      'HAPPIER_MEMORY_MAX_TRANSCRIPT_WINDOW_MESSAGES',
      { min: 50, max: 500, default: 250 }, env);
    // Default: 500 (server max). Min 1; max 500 to match server enforcement.
    this.replaySynopsisScanPageSize = resolveIntEnvWithBounds('HAPPIER_REPLAY_SYNOPSIS_SCAN_PAGE_SIZE', {
      min: 1, max: 500, default: 500,
    }, env);
    // The operator's total cap remains authoritative at dispatch, including
    // for an already-sealed seed. A positive configured total is kept exactly;
    // the actual frame and reservation determine whether context can fit.
    const replaySeedMaxChars = HappierReplayWritableMaxSeedCharsSchema.safeParse(
      Number(env.HAPPIER_REPLAY_MAX_SEED_CHARS),
    );
    this.replaySeedMaxChars = replaySeedMaxChars.success ? replaySeedMaxChars.data : 120_000;
    // Default: 500 (server max). Min 50 ensures meaningful context; max 500 matches server enforcement.
    this.replaySeedCandidateLimit = resolveIntEnvWithBounds('HAPPIER_REPLAY_SEED_CANDIDATE_LIMIT', {
      min: 50, max: 500, default: 500,
    }, env);
    // Default: 8 requests per hydration. `/v1/sessions/:id/messages` is shared and
    // rate-limited per user, and the walk is bounded by CHARACTERS, not requests —
    // 8 full pages is what it takes to fill the default 120k budget even when the
    // server ignores the role filter and the yield collapses to raw-row density.
    // The ceiling is per hydration, never per chain segment.
    this.replaySeedMaxTranscriptRequests = resolveIntEnvWithBounds('HAPPIER_REPLAY_SEED_MAX_TRANSCRIPT_REQUESTS', {
      min: 1, max: 24, default: 8,
    }, env);
    // Default: 15s for the whole walk. The per-request timeout is 10s, so an
    // unbounded walk could sit for 80s in a path that runs AFTER the source
    // runtime was stopped and while the user is waiting for the switch.
    this.replaySeedTranscriptDeadlineMs = resolveIntEnvWithBounds('HAPPIER_REPLAY_SEED_TRANSCRIPT_DEADLINE_MS', {
      min: 1_000, max: 120_000, default: 15_000,
    }, env);

    const startupTimingRaw = String(env.HAPPIER_STARTUP_TIMING_ENABLED ?? '').trim().toLowerCase();
    this.startupTimingEnabled = startupTimingRaw === '1' || startupTimingRaw === 'true' || startupTimingRaw === 'yes' || startupTimingRaw === 'on';

    // Defaults: conservative bounds to buffer early startup writes until the server session attaches.
    this.startupDeferredSessionBufferMaxEntries = resolveIntEnvWithBounds(
      'HAPPIER_STARTUP_DEFERRED_SESSION_MAX_ENTRIES', { min: 10, default: 500 }, env);
    this.startupDeferredSessionBufferMaxBytes = resolveIntEnvWithBounds(
      'HAPPIER_STARTUP_DEFERRED_SESSION_MAX_BYTES', { min: 1024, default: 256_000 }, env);

    // Default: 50 messages (enough to recover the latest permission intent without excessive transcript fetches).
    this.startupPermissionSeedTranscriptTake = resolveIntEnvWithBounds(
      'HAPPIER_STARTUP_PERMISSION_SEED_TRANSCRIPT_TAKE',
      { min: 1, max: 500, default: 50 }, env);

    // Default: 7 days. Used only to seed fast-start permission/model defaults when explicit args are missing.
    this.startupOverridesCacheMaxAgeMs = resolveIntEnvWithBounds(
      'HAPPIER_STARTUP_OVERRIDES_CACHE_MAX_AGE_MS',
      { min: 0, default: 7 * 24 * 60 * 60 * 1000 }, env);

  }
}
