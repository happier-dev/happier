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

  constructor() {
    // Check if we're running as daemon based on process args
    const args = process.argv.slice(2)
    this.isDaemonProcess = args.length >= 2 && args[0] === 'daemon' && (args[1] === 'start-sync')

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
    if (envActiveServerIdRaw && !envActiveServerId) {
      console.warn('[config] Ignoring invalid HAPPIER_ACTIVE_SERVER_ID (must be filesystem-safe)');
    }
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
    this.activeServerId = sanitizeServerIdForFilesystem(resolved.activeServerId, 'official')

    this.activeServerDir = join(this.serversDir, this.activeServerId)
    this.legacyPrivateKeyFile = join(this.happyHomeDir, 'access.key')
    this.privateKeyFile = join(this.activeServerDir, 'access.key')
    this.daemonStateFile = join(this.activeServerDir, 'daemon.state.json')
    this.daemonLockFile = join(this.activeServerDir, 'daemon.state.json.lock')

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.HAPPIER_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.HAPPIER_DISABLE_CAFFEINATE?.toLowerCase() || '');

    this.currentCliVersion = packageJson.version

    // Validate variant configuration
    const variant = process.env.HAPPIER_VARIANT || 'stable'
    if (variant === 'dev' && !this.happyHomeDir.includes('dev')) {
      console.warn('⚠️  WARNING: HAPPIER_VARIANT=dev but HAPPIER_HOME_DIR does not contain "dev"')
      console.warn(`   Current: ${this.happyHomeDir}`)
      console.warn(`   Expected: Should contain "dev" (e.g., ~/.happier-dev)`)
    }

    // Visual indicator on CLI startup (only if not daemon process to avoid log clutter)
    if (!this.isDaemonProcess && variant === 'dev') {
      console.log('\x1b[33m🔧 DEV MODE\x1b[0m - Data: ' + this.happyHomeDir)
    }

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
    sanitizeServerIdForFilesystem(params.envActiveServerId ?? fallbackId, 'official');

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
          console.warn('[config] HAPPIER_SERVER_URL was set without HAPPIER_WEBAPP_URL; defaulting webappUrl to server origin');
        } catch {
          webappUrl = DEFAULT_WEBAPP_URL;
          console.warn('[config] HAPPIER_SERVER_URL was set without HAPPIER_WEBAPP_URL; defaulting webappUrl to DEFAULT_WEBAPP_URL');
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
    activeServerId: resolveActiveServerId('official'),
    serverUrl: DEFAULT_SERVER_URL,
    webappUrl: DEFAULT_WEBAPP_URL,
  };
}

export let configuration: Configuration = new Configuration()

export function reloadConfiguration(): void {
  configuration = new Configuration()
}
