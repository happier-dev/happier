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
import packageJson from '../package.json'

export function isDaemonProcessArgv(args: readonly string[]): boolean {
  if (args.length < 2) return false
  if (args[0] !== 'daemon') return false
  return args[1] === 'start' || args[1] === 'start-sync'
}

class Configuration {
  public readonly serverUrl: string
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
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean

  // Session connection keep-alive (ephemeral thinking state + online presence).
  public readonly sessionKeepAliveIdleMs: number
  public readonly sessionKeepAliveThinkingMs: number

  // Claude remote TaskOutput sidechain import limits (defense-in-depth against huge transcripts).
  public readonly claudeTaskOutputMaxPendingPerAgent: number
  public readonly claudeTaskOutputMaxSeenUuidsPerSidechain: number
  public readonly claudeTaskOutputMaxToolUseEntries: number
  public readonly claudeTaskOutputMaxAgentMappings: number

  // Claude subagent local JSONL follower (used in remote mode when Task returns output_file).
  public readonly claudeSubagentJsonlPollIntervalMs: number

  // Execution runs and ephemeral tasks (session-process budgets).
  public readonly executionRunsMaxConcurrentPerSession: number
  public readonly ephemeralTasksMaxConcurrentPerSession: number
  public readonly executionRunsBoundedTimeoutMs: number
  public readonly executionRunsMaxTurns: number
  public readonly executionRunsMaxDepth: number
  public readonly executionBudgetMaxConcurrentTotalPerSession: number | null
  public readonly executionBudgetMaxConcurrentByClass: Readonly<Record<string, number>>

  // Memory search (daemon-local indexing) limits.
  public readonly memoryMaxTranscriptWindowMessages: number

  constructor() {
    // Check if we're running as daemon based on process args
    const args = process.argv.slice(2)
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
    const envWebappUrl = (process.env.HAPPIER_WEBAPP_URL ?? '').toString().trim();
    const envPublicServerUrl = (process.env.HAPPIER_PUBLIC_SERVER_URL ?? '').toString().trim();
    const envActiveServerIdRaw = (process.env.HAPPIER_ACTIVE_SERVER_ID ?? '').toString().trim();
    const envActiveServerId = isServerIdFilesystemSafe(envActiveServerIdRaw)
      ? envActiveServerIdRaw
      : null;
    const persisted = readActiveServerFromSettingsFile(this.settingsFile);
    const resolved = resolveServerSelection({
      envServerUrl: envServerUrl || null,
      envWebappUrl: envWebappUrl || null,
      envActiveServerId,
      persisted,
    });

    this.serverUrl = resolved.serverUrl
    this.publicServerUrl = (envPublicServerUrl || resolved.serverUrl).replace(/\/+$/, '')
    this.webappUrl = resolved.webappUrl
    this.activeServerId = sanitizeServerIdForFilesystem(resolved.activeServerId, 'cloud')

    this.activeServerDir = join(this.serversDir, this.activeServerId)
    this.legacyPrivateKeyFile = join(this.happyHomeDir, 'access.key')
    this.privateKeyFile = join(this.activeServerDir, 'access.key')
    this.daemonStateFile = join(this.activeServerDir, 'daemon.state.json')
    this.daemonLockFile = join(this.activeServerDir, 'daemon.state.json.lock')

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.HAPPIER_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.HAPPIER_DISABLE_CAFFEINATE?.toLowerCase() || '');

    const idleMsRaw = Number.parseInt(String(process.env.HAPPIER_SESSION_KEEPALIVE_IDLE_MS ?? ''), 10);
    const thinkingMsRaw = Number.parseInt(String(process.env.HAPPIER_SESSION_KEEPALIVE_THINKING_MS ?? ''), 10);
    // Defaults chosen to balance UI responsiveness and background traffic:
    // - thinking: ~2s so UI connecting mid-turn sees 'thinking' quickly
    // - idle: ~15s to reduce noise while maintaining presence
    this.sessionKeepAliveIdleMs = Number.isFinite(idleMsRaw) && idleMsRaw >= 1000 ? idleMsRaw : 15_000;
    this.sessionKeepAliveThinkingMs = Number.isFinite(thinkingMsRaw) && thinkingMsRaw >= 500 ? thinkingMsRaw : 2_000;

    const maxPendingRaw = Number.parseInt(String(process.env.HAPPIER_CLAUDE_TASKOUTPUT_MAX_PENDING_PER_AGENT ?? ''), 10);
    const maxSeenUuidsRaw = Number.parseInt(String(process.env.HAPPIER_CLAUDE_TASKOUTPUT_MAX_SEEN_UUIDS_PER_SIDECHAIN ?? ''), 10);
    const maxToolUseRaw = Number.parseInt(String(process.env.HAPPIER_CLAUDE_TASKOUTPUT_MAX_TOOLUSE_ENTRIES ?? ''), 10);
    const maxAgentMappingsRaw = Number.parseInt(String(process.env.HAPPIER_CLAUDE_TASKOUTPUT_MAX_AGENT_MAPPINGS ?? ''), 10);

    this.claudeTaskOutputMaxPendingPerAgent = Number.isFinite(maxPendingRaw) && maxPendingRaw >= 0 ? maxPendingRaw : 2000;
    this.claudeTaskOutputMaxSeenUuidsPerSidechain = Number.isFinite(maxSeenUuidsRaw) && maxSeenUuidsRaw >= 0 ? maxSeenUuidsRaw : 5000;
    this.claudeTaskOutputMaxToolUseEntries = Number.isFinite(maxToolUseRaw) && maxToolUseRaw >= 0 ? maxToolUseRaw : 5000;
    this.claudeTaskOutputMaxAgentMappings = Number.isFinite(maxAgentMappingsRaw) && maxAgentMappingsRaw >= 0 ? maxAgentMappingsRaw : 2000;

    const subagentPollRaw = Number.parseInt(String(process.env.HAPPIER_CLAUDE_SUBAGENT_JSONL_POLL_INTERVAL_MS ?? ''), 10);
    // Default: 250ms. Most imports will be watcher-driven; this is a safety net if fs watch misses events.
    this.claudeSubagentJsonlPollIntervalMs =
      Number.isFinite(subagentPollRaw) && subagentPollRaw >= 25 ? subagentPollRaw : 250;

    const maxConcurrentRunsRaw = Number.parseInt(String(process.env.HAPPIER_EXECUTION_RUNS_MAX_CONCURRENT_PER_SESSION ?? ''), 10);
    const maxConcurrentTasksRaw = Number.parseInt(String(process.env.HAPPIER_EPHEMERAL_TASKS_MAX_CONCURRENT_PER_SESSION ?? ''), 10);
    const boundedTimeoutRaw = Number.parseInt(String(process.env.HAPPIER_EXECUTION_RUNS_BOUNDED_TIMEOUT_MS ?? ''), 10);
    const maxTurnsRaw = Number.parseInt(String(process.env.HAPPIER_EXECUTION_RUNS_MAX_TURNS ?? ''), 10);
    const maxDepthRaw = Number.parseInt(String(process.env.HAPPIER_EXECUTION_RUNS_MAX_DEPTH ?? ''), 10);
    const budgetTotalRaw = Number.parseInt(String(process.env.HAPPIER_EXECUTION_BUDGET_MAX_CONCURRENT_TOTAL_PER_SESSION ?? ''), 10);
    const budgetByClassRaw = String(process.env.HAPPIER_EXECUTION_BUDGET_MAX_CONCURRENT_BY_CLASS_JSON ?? '').trim();

    this.executionRunsMaxConcurrentPerSession =
      Number.isFinite(maxConcurrentRunsRaw) && maxConcurrentRunsRaw >= 1 ? maxConcurrentRunsRaw : 4;
    this.ephemeralTasksMaxConcurrentPerSession =
      Number.isFinite(maxConcurrentTasksRaw) && maxConcurrentTasksRaw >= 1 ? maxConcurrentTasksRaw : 2;
    this.executionRunsBoundedTimeoutMs =
      Number.isFinite(boundedTimeoutRaw) && boundedTimeoutRaw >= 1_000 ? boundedTimeoutRaw : 120_000;
    this.executionRunsMaxTurns =
      Number.isFinite(maxTurnsRaw) && maxTurnsRaw >= 1 ? maxTurnsRaw : 32;
    // Depth 0 means "no nested runs allowed". Default 1 allows one nested hop when explicitly linked.
    this.executionRunsMaxDepth =
      Number.isFinite(maxDepthRaw) && maxDepthRaw >= 0 ? maxDepthRaw : 1;

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

    const memoryWindowRaw = Number.parseInt(String(process.env.HAPPIER_MEMORY_MAX_TRANSCRIPT_WINDOW_MESSAGES ?? ''), 10);
    // Default: 250 messages. Hard bounds protect daemon from excessive replay windows.
    // Min 50 ensures meaningful windows; max 500 matches server enforcement.
    if (Number.isFinite(memoryWindowRaw) && memoryWindowRaw >= 50) {
      this.memoryMaxTranscriptWindowMessages = Math.min(500, Math.trunc(memoryWindowRaw));
    } else {
      this.memoryMaxTranscriptWindowMessages = 250;
    }

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
    for (const [id, v] of Object.entries(serversRaw as Record<string, any>)) {
      const sid = sanitizeServerIdForFilesystem((v as any)?.id ?? id, '');
      const serverUrl = String((v as any)?.serverUrl ?? '').trim();
      const webappUrl = String((v as any)?.webappUrl ?? '').trim();
      if (!sid || !serverUrl || !webappUrl) continue;
      servers[sid] = { id: sid, serverUrl, webappUrl };
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
  envWebappUrl: string | null;
  envActiveServerId: string | null;
  persisted: PersistedServerSettings | null;
}>): Readonly<{ activeServerId: string; serverUrl: string; webappUrl: string }> {
  const DEFAULT_SERVER_URL = 'https://api.happier.dev';
  const DEFAULT_WEBAPP_URL = 'https://app.happier.dev';
  const resolveActiveServerId = (fallbackId: string): string =>
    sanitizeServerIdForFilesystem(params.envActiveServerId ?? fallbackId, 'cloud');

  // If env vars are set, treat them as an explicit (non-persisted) override for this invocation.
  if (params.envServerUrl) {
    const serverUrl = normalizeServerUrl(params.envServerUrl);
    const persistedMatch = params.persisted
      ? Object.values(params.persisted.servers).find((s) => normalizeServerUrl(s.serverUrl) === serverUrl) ?? null
      : null;
    let webappUrl = params.envWebappUrl;
    if (!webappUrl) {
      if (persistedMatch?.webappUrl) {
        webappUrl = persistedMatch.webappUrl;
      } else if (serverUrl === DEFAULT_SERVER_URL) {
        webappUrl = DEFAULT_WEBAPP_URL;
      } else {
        try {
          webappUrl = new URL(serverUrl).origin;
        } catch {
          webappUrl = DEFAULT_WEBAPP_URL;
        }
      }
    }
    const activeServerId = resolveActiveServerId(persistedMatch?.id ?? deriveServerIdFromUrl(serverUrl));
    return { activeServerId, serverUrl, webappUrl };
  }

  if (params.persisted) {
    const active = params.persisted.servers[params.persisted.activeServerId];
    if (active) {
      return {
        activeServerId: resolveActiveServerId(active.id),
        serverUrl: normalizeServerUrl(active.serverUrl),
        webappUrl: active.webappUrl,
      };
    }
  }

  return {
    activeServerId: resolveActiveServerId('cloud'),
    serverUrl: DEFAULT_SERVER_URL,
    webappUrl: DEFAULT_WEBAPP_URL,
  };
}

export let configuration: Configuration = new Configuration()

export function reloadConfiguration(): void {
  configuration = new Configuration()
}
