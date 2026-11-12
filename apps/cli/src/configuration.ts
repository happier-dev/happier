/**
 * Global configuration for Happier CLI
 * 
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveCliHomeStoragePaths } from './configuration/homeStoragePaths'
import { readCliProcessArgs } from './cli/parseArgs'
import { applyRuntimeContextPrefixEnv, parseRuntimeContextPrefixArgs } from './utils/env/runtimeContextArgv'
import {
  resolveManagedCliReleaseChannelSync,
  applyPersistedManagedToolsRoot,
} from '@happier-dev/cli-common/firstPartyRuntime'
import { CANONICAL_DAEMON_STATE_BASENAME } from './daemon/ownership/daemonOwnershipPaths'
import { isServerIdFilesystemSafe, sanitizeServerIdForFilesystem } from './server/serverId'
import packageJson from '../package.json'
import type { PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings'
import { resolveIntEnvWithBounds } from './configuration/resolveIntEnvWithBounds'
import { HappierReplayWritableMaxSeedCharsSchema } from '@happier-dev/protocol/sessions/replay-seed-budget';
import { resolveCliHappyHomeDir } from './configuration/resolveCliHappyHomeDir'
import { ensurePrivateDirectoryPreservingTraversalSync } from './utils/fs/protectedLocalState'
import {
  readActiveServerFromSettingsFile,
  resolveServerSelection,
} from './configuration/serverSelection'
import { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } from '@happier-dev/protocol/sessions/creation/sessionSpawnBudget';
import type { ClientEncryptionRequirement } from '@happier-dev/protocol';
import { readFiniteTransferConfig } from '@happier-dev/transfers/node'
import type { OrganizationPolicyLoadResult } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { loadOrganizationPolicy } from '@happier-dev/cli-common/organizationPolicy/readOrganizationPolicyFile';

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

export function isDaemonProcessArgv(args: readonly string[]): boolean {
  if (args.length < 2) return false
  if (args[0] !== 'daemon') return false
  return args[1] === 'start'
    || args[1] === 'start-sync'
    || args[1] === 'plugin-packed-test-host'
}

function normalizeDaemonProcessInheritedEnv(params: Readonly<{
  env: NodeJS.ProcessEnv;
  isDaemonProcess: boolean;
}>): void {
  if (!params.isDaemonProcess) return;

  const hasStackContext =
    Boolean(String(params.env.HAPPIER_STACK_STACK ?? '').trim()) ||
    Boolean(String(params.env.HAPPIER_STACK_ENV_FILE ?? '').trim()) ||
    Boolean(String(params.env.HAPPIER_STACK_REPO_DIR ?? '').trim());
  if (hasStackContext) {
    params.env.HAPPIER_STACK_PROCESS_KIND = 'daemon';
    return;
  }

  if (String(params.env.HAPPIER_STACK_PROCESS_KIND ?? '').trim() === 'session') {
    delete params.env.HAPPIER_STACK_PROCESS_KIND;
  }
}

class Configuration {
  public readonly organizationPolicy: OrganizationPolicyLoadResult;
  /** Canonical Home identity for profiles, enrollment and links; not the runtime HTTP destination. */
  public readonly serverUrl: string
  /** Configured profile route. Runtime requests use resolveServerHttpBaseUrl() instead. */
  public readonly apiServerUrl: string
  /**
   * Deprecated alias: historically used as “public URL for QR/deep links”.
   * In schema v6+ the canonical/share URL is `serverUrl`, so this is always equal to `serverUrl`.
   */
  public readonly publicServerUrl: string
  public readonly webappUrl: string
  public readonly activeServerId: string
  public readonly isDaemonProcess: boolean
  public readonly publicReleaseRing: PublicReleaseRingId;

  // Directories and paths (from persistence)
  public readonly happyHomeDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly serversDir: string
  public readonly activeServerDir: string
  public readonly legacyPrivateKeyFile: string
  public readonly privateKeyFile: string
  public readonly installationIdentityFile: string
  public readonly deviceLocalSecretKeyFile: string
  public readonly daemonStateFile: string
  public readonly daemonLockFile: string
  // Session attach file pruning (best-effort; defense-in-depth for crash-before-read scenarios).
  public readonly sessionAttachFileMaxAgeMs: number
  // Session control HTTP timeouts (v2 sessions endpoints; archive/unarchive, list, etc).
  public readonly sessionControlHttpTimeoutMs: number
  // Spawn/restart coordination: when resuming an existing session while a stop is in-flight, wait
  // briefly for the runner to exit so we don't strand the session stopped due to idempotency.
  public readonly daemonSpawnExistingSessionWaitForExitMs: number
  public readonly daemonSpawnExistingSessionWaitForExitPollIntervalMs: number
  // Plugin daemon-spawn hook dispatch budget. Spawn prerequisites must fail closed before the
  // caller's broader spawn RPC budget is exhausted.
  public readonly daemonSpawnHookDispatchTimeoutMs: number
  // Stop coordination: after requesting a tracked session stop, wait briefly for exit observation
  // so server-side active=false can be published before callers continue with archive/delete flows.
  public readonly daemonStopSessionWaitForExitMs: number
  public readonly daemonStopSessionWaitForExitPollIntervalMs: number
  // Managed runtime installable auto-update background check interval.
  public readonly installablesRuntimeAutoUpdateCheckIntervalMs: number
  // File system RPC limits (Files tab + transfers).
  public readonly filesReadMaxBytes: number
  public readonly filesDirectoryListMaxEntries: number
  public readonly filesDirectoryTreeMaxDepth: number
  public readonly filesDirectoryTreeMaxNodes: number
  // Prompt transfer payload limits (prompt assets + prompt registry items).
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
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly socketForceWebsocketOnly: boolean
  public readonly socketIoTransports: string[]

  // Session connection keep-alive (ephemeral thinking state + online presence).
  public readonly sessionKeepAliveIdleMs: number
  public readonly sessionKeepAliveThinkingMs: number

  public readonly pendingQueueStateReconcileThrottleMs: number

  // MCP server SSE keepalive (prevents client idle timeouts on long-lived streams).
  public readonly mcpSseKeepAliveIntervalMs: number | null
  // MCP client request timeouts for tool calls proxied by Happier-owned bridges.
  public readonly mcpToolCallTimeoutMs: number
  public readonly mcpExecutionRunWaitTimeoutGraceMs: number

  // Transcript lookup / recovery (fallback path when socket ACK/broadcast is missed).
  public readonly transcriptLookupRequestTimeoutMs: number
  public readonly transcriptLookupPollIntervalMs: number
  public readonly transcriptLookupErrorBackoffBaseMs: number
  public readonly transcriptLookupErrorBackoffMaxMs: number
  public readonly transcriptLookupKeepAliveEnabled: boolean

  public readonly transcriptRecoveryDelayMs: number
  public readonly transcriptRecoveryMaxWaitMs: number
  public readonly transcriptRecoveryMaxConcurrent: number

  // Startup transcript catch-up (avoids missing early prompts; prevents replaying entire history into the agent queue).
  public readonly startupTranscriptCatchUpSeqRewind: number

  // Permission-request push notifications (best-effort; bounded retries).
  public readonly permissionRequestPushRetryDelaysMs: readonly number[]
  public readonly permissionRequestPushRetryMaxMs: number
  public readonly permissionRequestPushDedupeMaxEntries: number
  public readonly readyNotificationAssistantTextMaxChars: number
  public readonly voiceAgentResponseTimeoutMs: number | null

  // Memory search (daemon-local indexing) limits.
  public readonly memoryMaxTranscriptWindowMessages: number
  public readonly memoryEmbeddingsRemoteRequestTimeoutMs: number
  public readonly replaySynopsisScanPageSize: number
  // Replay seed prompt budget (prevents oversized provider prompts).
  public readonly replaySeedMaxChars: number
  // Replay transcript fetch size for seed hydration (best-effort; bounded by server /v1/messages limit).
  public readonly replaySeedCandidateLimit: number
  // Requests ONE seed hydration may spend walking the transcript backwards.
  public readonly replaySeedMaxTranscriptRequests: number
  // Wall clock for that whole walk (it runs while the user is waiting).
  public readonly replaySeedTranscriptDeadlineMs: number

  // Startup coordinator / deferred session buffering (fast-start).
  public readonly startupTimingEnabled: boolean
  public readonly startupDeferredSessionBufferMaxEntries: number
  public readonly startupDeferredSessionBufferMaxBytes: number
  public readonly startupPermissionSeedTranscriptTake: number
  public readonly startupOverridesCacheMaxAgeMs: number
  // Retained opt-in current-user Windows shell-bridge context (default: off).
  public readonly shellBridgeContextEnvMode: ShellBridgeContextEnvMode
  public readonly clientEncryptionRequirement: ClientEncryptionRequirement

  constructor(organizationPolicy: OrganizationPolicyLoadResult = loadOrganizationPolicy()) {
    this.organizationPolicy = organizationPolicy;
    // Check if we're running as daemon based on process args
    const { args } = parseRuntimeContextPrefixArgs(readCliProcessArgs())
    this.isDaemonProcess = isDaemonProcessArgv(args)
    normalizeDaemonProcessInheritedEnv({
      env: process.env,
      isDaemonProcess: this.isDaemonProcess,
    })
    this.publicReleaseRing = resolveManagedCliReleaseChannelSync({ processEnv: process.env, argv: process.argv }).ringId

    // Directory configuration - Priority: HAPPIER_HOME_DIR env > default home dir
    this.happyHomeDir = resolveCliHappyHomeDir(process.env)
    applyPersistedManagedToolsRoot({ env: process.env, happyHomeDir: this.happyHomeDir })

    const homeStoragePaths = resolveCliHomeStoragePaths(this.happyHomeDir)
    this.logsDir = homeStoragePaths.logsDir
    this.settingsFile = homeStoragePaths.settingsFile
    this.serversDir = homeStoragePaths.serversDir

    const envServerUrl = (process.env.HAPPIER_SERVER_URL ?? '').toString().trim();
    const envLocalServerUrl = (process.env.HAPPIER_LOCAL_SERVER_URL ?? '').toString().trim();
    const envWebappUrl = (process.env.HAPPIER_WEBAPP_URL ?? '').toString().trim();
    const envPublicServerUrl = (process.env.HAPPIER_PUBLIC_SERVER_URL ?? '').toString().trim();
    const envActiveServerIdRaw = (process.env.HAPPIER_ACTIVE_SERVER_ID ?? '').toString().trim();
    const envActiveServerId = isServerIdFilesystemSafe(envActiveServerIdRaw)
      ? envActiveServerIdRaw
      : null;
    const daemonLifecycleScopeIdRaw = (process.env.HAPPIER_DAEMON_LIFECYCLE_SCOPE_ID ?? '').toString().trim();
    const daemonLifecycleScopeId = isServerIdFilesystemSafe(daemonLifecycleScopeIdRaw)
      ? daemonLifecycleScopeIdRaw
      : null;
    const persisted = readActiveServerFromSettingsFile(this.settingsFile);
    const resolved = resolveServerSelection({
      envServerUrl: envServerUrl || null,
      envLocalServerUrl: envLocalServerUrl || null,
      envPublicServerUrl: envPublicServerUrl || null,
      envWebappUrl: envWebappUrl || null,
      envActiveServerId,
      persisted,
      serversDir: this.serversDir,
      organizationPolicy: this.organizationPolicy,
    });

    this.serverUrl = resolved.serverUrl
    this.apiServerUrl = resolved.apiServerUrl
    this.publicServerUrl = resolved.serverUrl
    this.webappUrl = resolved.webappUrl
    this.activeServerId = sanitizeServerIdForFilesystem(resolved.activeServerId, 'cloud')

    this.activeServerDir = join(this.serversDir, this.activeServerId)
    this.shellBridgeContextEnvMode = resolveShellBridgeContextEnvMode(process.env)
    this.clientEncryptionRequirement = resolveClientEncryptionRequirementEnv(process.env)
    this.legacyPrivateKeyFile = join(this.happyHomeDir, 'access.key')
    this.privateKeyFile = join(this.activeServerDir, 'access.key')
    this.installationIdentityFile = join(this.happyHomeDir, 'installation-identity.json')
    this.deviceLocalSecretKeyFile = join(this.happyHomeDir, 'device-local-secret-key.json')
    const daemonLifecycleDir = daemonLifecycleScopeId
      ? join(this.serversDir, daemonLifecycleScopeId)
      : this.activeServerDir
    this.daemonStateFile = join(daemonLifecycleDir, CANONICAL_DAEMON_STATE_BASENAME)
    this.daemonLockFile = join(daemonLifecycleDir, `${CANONICAL_DAEMON_STATE_BASENAME}.lock`)

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


    // Default: 5s. Set to 0 to disable waiting.
    this.daemonSpawnExistingSessionWaitForExitMs = resolveIntEnvWithBounds(
      'HAPPIER_DAEMON_SPAWN_EXISTING_SESSION_WAIT_FOR_EXIT_MS',
      { min: 0, max: 60_000, default: 5_000 },
    );
    // Default: 50ms. Defensive bounds protect against busy-wait.
    this.daemonSpawnExistingSessionWaitForExitPollIntervalMs = resolveIntEnvWithBounds(
      'HAPPIER_DAEMON_SPAWN_EXISTING_SESSION_WAIT_FOR_EXIT_POLL_INTERVAL_MS',
      { min: 10, max: 2_000, default: 50 },
    );
    this.daemonSpawnHookDispatchTimeoutMs = resolveIntEnvWithBounds(
      'HAPPIER_DAEMON_SPAWN_HOOK_DISPATCH_TIMEOUT_MS',
      { min: 1_000, max: 600_000, default: DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS },
    );
    // Default: 15s. Set to 0 to disable waiting.
    this.daemonStopSessionWaitForExitMs = resolveIntEnvWithBounds(
      'HAPPIER_DAEMON_STOP_SESSION_WAIT_FOR_EXIT_MS',
      { min: 0, max: 60_000, default: 15_000 },
    );
    // Default: 100ms. Defensive bounds protect against busy-wait.
    this.daemonStopSessionWaitForExitPollIntervalMs = resolveIntEnvWithBounds(
      'HAPPIER_DAEMON_STOP_SESSION_WAIT_FOR_EXIT_POLL_INTERVAL_MS',
      { min: 10, max: 2_000, default: 100 },
    );

    // Default: 6 hours. Defensive minimum: 1 minute.
    this.installablesRuntimeAutoUpdateCheckIntervalMs = resolveIntEnvWithBounds(
      'HAPPIER_INSTALLABLES_AUTO_UPDATE_CHECK_INTERVAL_MS',
      { min: 60_000, default: 6 * 60 * 60_000 },
    );

    // Default: 2.5MB. Defensive minimum: 1 byte.
    this.filesReadMaxBytes = resolveIntEnvWithBounds('HAPPIER_FILES_READ_MAX_BYTES', {
      min: 1, default: 2_500_000,
    });
    this.filesDirectoryListMaxEntries = resolveIntEnvWithBounds('HAPPIER_FILES_DIRECTORY_LIST_MAX_ENTRIES', {
      min: 1, max: 20_000, default: 500,
    });
    this.filesDirectoryTreeMaxDepth = resolveIntEnvWithBounds('HAPPIER_FILES_DIRECTORY_TREE_MAX_DEPTH', {
      min: 0, max: 25, default: 5,
    });
    this.filesDirectoryTreeMaxNodes = resolveIntEnvWithBounds('HAPPIER_FILES_DIRECTORY_TREE_MAX_NODES', {
      min: 1, max: 100_000, default: 2_000,
    });

    // Default: 2.5MB. Defensive min: 1 byte; max: 10MB.
    this.promptTransferJsonMaxBytes = resolveIntEnvWithBounds('HAPPIER_PROMPT_TRANSFER_JSON_MAX_BYTES', {
      min: 1, max: 10_000_000, default: 2_500_000,
    });

    const fileTransferConfig = readFiniteTransferConfig(process.env);
    this.filesTransferChunkBytes = fileTransferConfig.chunkSizeBytes;
    this.filesTransferSessionTtlMs = fileTransferConfig.ttlMs;

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

    // Default: 512MB per session and 2GB per workspace for local session media.
    this.sessionMediaMaxBytesPerSession = resolveIntEnvWithBounds('HAPPIER_SESSION_MEDIA_MAX_BYTES_PER_SESSION', {
      min: 1, default: 512 * 1024 * 1024,
    });
    this.sessionMediaMaxBytesPerWorkspace = resolveIntEnvWithBounds('HAPPIER_SESSION_MEDIA_MAX_BYTES_PER_WORKSPACE', {
      min: 1, default: 2 * 1024 * 1024 * 1024,
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
    });
    this.sessionKeepAliveThinkingMs = resolveIntEnvWithBounds('HAPPIER_SESSION_KEEPALIVE_THINKING_MS', {
      min: 500, default: 2_000,
    });

    this.pendingQueueStateReconcileThrottleMs = resolveIntEnvWithBounds(
      'HAPPIER_PENDING_QUEUE_STATE_RECONCILE_THROTTLE_MS',
      { min: 1_000, max: 60_000, default: 15_000 },
    );

    const mcpKeepAliveRaw = String(process.env.HAPPIER_MCP_SSE_KEEPALIVE_INTERVAL_MS ?? '').trim();
    const mcpKeepAliveMs = Number.parseInt(mcpKeepAliveRaw, 10);
    // Default: 15s. Must be < client idle timeouts (~5 minutes observed in Claude Code logs).
    // Set to 0 to disable (not recommended).
    this.mcpSseKeepAliveIntervalMs =
      mcpKeepAliveRaw === '0' ? null : (Number.isFinite(mcpKeepAliveMs) && mcpKeepAliveMs >= 10 ? mcpKeepAliveMs : 15_000);
    this.mcpToolCallTimeoutMs = resolveIntEnvWithBounds('HAPPIER_MCP_TOOL_CALL_TIMEOUT_MS', {
      min: 1,
      max: MAX_SAFE_NODE_TIMEOUT_MS,
      default: DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
    });
    this.mcpExecutionRunWaitTimeoutGraceMs = resolveIntEnvWithBounds(
      'HAPPIER_MCP_EXECUTION_RUN_WAIT_TIMEOUT_GRACE_MS',
      {
        min: 0,
        max: MAX_SAFE_NODE_TIMEOUT_MS,
        default: DEFAULT_EXECUTION_RUN_WAIT_MCP_TIMEOUT_GRACE_MS,
      },
    );

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
    this.readyNotificationAssistantTextMaxChars = resolveIntEnvWithBounds(
      'HAPPIER_READY_NOTIFICATION_ASSISTANT_TEXT_MAX_CHARS',
      { min: 40, max: 2_000, default: 500 },
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

    this.startupTranscriptCatchUpSeqRewind = resolveIntEnvWithBounds(
      'HAPPIER_STARTUP_TRANSCRIPT_CATCH_UP_SEQ_REWIND',
      { min: 0, default: 1, max: 1000 },
    );
    this.voiceAgentResponseTimeoutMs = resolveIntEnvWithBounds('HAPPIER_VOICE_AGENT_RESPONSE_TIMEOUT_MS', {
      min: 1_000,
      default: 0,
    }) || null;

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
    // Default: 500 (server max). Min 1; max 500 to match server enforcement.
    this.replaySynopsisScanPageSize = resolveIntEnvWithBounds('HAPPIER_REPLAY_SYNOPSIS_SCAN_PAGE_SIZE', {
      min: 1, max: 500, default: 500,
    });
    // The operator's total cap remains authoritative at dispatch, including
    // for an already-sealed seed. A positive configured total is kept exactly;
    // the actual frame and reservation determine whether context can fit.
    const replaySeedMaxChars = HappierReplayWritableMaxSeedCharsSchema.safeParse(
      Number(process.env.HAPPIER_REPLAY_MAX_SEED_CHARS),
    );
    this.replaySeedMaxChars = replaySeedMaxChars.success ? replaySeedMaxChars.data : 120_000;
    // Default: 500 (server max). Min 50 ensures meaningful context; max 500 matches server enforcement.
    this.replaySeedCandidateLimit = resolveIntEnvWithBounds('HAPPIER_REPLAY_SEED_CANDIDATE_LIMIT', {
      min: 50, max: 500, default: 500,
    });
    // Default: 8 requests per hydration. `/v1/sessions/:id/messages` is shared and
    // rate-limited per user, and the walk is bounded by CHARACTERS, not requests —
    // 8 full pages is what it takes to fill the default 120k budget even when the
    // server ignores the role filter and the yield collapses to raw-row density.
    // The ceiling is per hydration, never per chain segment.
    this.replaySeedMaxTranscriptRequests = resolveIntEnvWithBounds('HAPPIER_REPLAY_SEED_MAX_TRANSCRIPT_REQUESTS', {
      min: 1, max: 24, default: 8,
    });
    // Default: 15s for the whole walk. The per-request timeout is 10s, so an
    // unbounded walk could sit for 80s in a path that runs AFTER the source
    // runtime was stopped and while the user is waiting for the switch.
    this.replaySeedTranscriptDeadlineMs = resolveIntEnvWithBounds('HAPPIER_REPLAY_SEED_TRANSCRIPT_DEADLINE_MS', {
      min: 1_000, max: 120_000, default: 15_000,
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
        ensurePrivateDirectoryPreservingTraversalSync(this.happyHomeDir)
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
        this.installationIdentityFile,
        this.deviceLocalSecretKeyFile,
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

applyRuntimeContextPrefixEnv(readCliProcessArgs(), process.env)
export let configuration: Configuration = new Configuration()

export function reloadConfiguration(): void {
  configuration = new Configuration(configuration.organizationPolicy)
}
