/**
 * Host identity and Session runtime configuration for Happier CLI
 * 
 * Host bootstrap owns persisted paths; hosted Sessions supply their admitted runtime policy.
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
import { resolveCliHappyHomeDir } from './configuration/resolveCliHappyHomeDir'
import { ensurePrivateDirectoryPreservingTraversalSync } from './utils/fs/protectedLocalState'
import {
  readActiveServerFromSettingsFile,
  resolveServerSelection,
} from './configuration/serverSelection'
import { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } from '@happier-dev/protocol/sessions/creation/sessionSpawnBudget';
import type { OrganizationPolicyLoadResult } from '@happier-dev/protocol/organizationPolicy/organizationPolicyV1';
import { loadOrganizationPolicy } from '@happier-dev/cli-common/organizationPolicy/readOrganizationPolicyFile';
import { SessionRuntimeConfiguration } from './configuration/sessionRuntimeConfiguration';
import { readHostedSessionScope } from './agent/runtime/lifecycle/hostedSessionScope';

export { DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS, DEFAULT_EXECUTION_RUN_WAIT_MCP_TIMEOUT_GRACE_MS } from './configuration/sessionRuntimeConfiguration';
export type { ShellBridgeContextEnvMode } from './configuration/sessionRuntimeConfiguration';

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

class Configuration extends SessionRuntimeConfiguration {
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
  public readonly currentCliVersion: string
  // Daemon-local memory embedding requests; transcript window policy is Session-scoped.
  public readonly memoryEmbeddingsRemoteRequestTimeoutMs: number

  constructor(organizationPolicy: OrganizationPolicyLoadResult = loadOrganizationPolicy()) {
    super(process.env);
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

    this.memoryEmbeddingsRemoteRequestTimeoutMs = resolveIntEnvWithBounds(
      'HAPPIER_MEMORY_EMBEDDINGS_REMOTE_REQUEST_TIMEOUT_MS',
      { min: 1_000, default: 15_000 },
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

/** Keep existing typed property consumers while selecting policy at its Session owner. */
function configurationView(host: Configuration): Configuration {
  return new Proxy(host, {
    get(target, property, receiver) {
      const policy = readHostedSessionScope()?.runtimeConfiguration;
      return policy && Object.hasOwn(policy, property)
        ? Reflect.get(policy, property)
        : Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      const policy = readHostedSessionScope()?.runtimeConfiguration;
      return policy && Object.hasOwn(policy, property)
        ? Reflect.set(policy, property, value)
        : Reflect.set(target, property, value, receiver);
    },
  });
}

export let configuration: Configuration = configurationView(new Configuration())

export function reloadConfiguration(): void {
  configuration = configurationView(new Configuration(configuration.organizationPolicy))
  const scope = readHostedSessionScope();
  if (scope) scope.runtimeConfiguration = new SessionRuntimeConfiguration(scope.environment);
}
