import { spawnProc, run, runCapture } from './utils/proc/proc.mjs';
import { resolveAuthSeedFromEnv, resolveAutoCopyFromMainEnabled } from './utils/stack/startup.mjs';
import { coerceHappyMonorepoRootFromPath, getStacksStorageRoot } from './utils/paths/paths.mjs';
import { runCaptureIfCommandExists } from './utils/proc/commands.mjs';
import { readLastLines } from './utils/fs/tail.mjs';
import { ensureCliBuilt, isCliDistBuildLockActive } from './utils/proc/pm.mjs';
import { withCliDistBuildLock } from './utils/proc/cliDistBuildLock.mjs';
import { resolveJavaScriptRuntimeCommand } from '@happier-dev/cli-common/providers/managedJavaScriptRuntime';
import {
  findAnyCredentialPathInCliHome,
  findExistingStackCredentialPath,
  resolvePreferredStackServerIdFromCliSettings,
  resolvePreferredStackDaemonStatePaths,
  resolveStackDaemonStatePaths,
  resolveStackCredentialPaths,
} from './utils/auth/credentials_paths.mjs';
import { ensureActiveAccessKeyValid } from './utils/auth/ensure_active_access_key_valid.mjs';
import { decodeJwtPayloadUnsafe } from './utils/auth/decode_jwt_payload_unsafe.mjs';
import { formatDaemonAuthScopeDiagnostic, formatDaemonCredentialsTokenSubChangedWarning } from './utils/auth/format_daemon_auth_scope_diagnostic.mjs';
import { applyStackActiveServerScopeEnv } from './utils/auth/stable_scope_id.mjs';
import { resolveReusableAuthSeedCandidates, resolveReusableAuthSeedSource } from './utils/auth/sources.mjs';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getRootDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { parseEnvToObject } from './utils/env/dotenv.mjs';
import { ensureEnvFileUpdated } from './utils/env/env_file.mjs';
import { getCliHomeDirFromEnvOrDefault } from './utils/stack/dirs.mjs';
import {
  isCliDirectExecutableCommand,
  readCliDistClosureFingerprint,
  readCliDistIntegrity,
  resolveCliDistEntrypointFromBin,
} from './utils/cli/cliDistIntegrity.mjs';
import { withStackDaemonLifecycleLock } from './utils/stack/daemon_lifecycle_lock.mjs';
import { recordStackRuntimeDaemonPid, syncStackRuntimeDaemonPidFromDaemonState } from './utils/stack/runtime_daemon_state.mjs';

/**
 * Daemon lifecycle helpers for hstack.
 *
 * Centralizes:
 * - stopping old daemons (stack-scoped)
 * - cleaning stale lock/state
 * - starting daemon and handling first-time auth
 * - printing actionable diagnostics
 */

const STACK_DAEMON_MACHINE_TRANSFER_ENV_KEYS = [
  'HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES',
  'HAPPIER_FEATURE_MACHINES_TRANSFER_DIRECT_PEER__ENABLED',
  'HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED',
  'HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_BIND_PORT',
  'HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS',
];

function resolveServerUrlFromOptions(options) {
  if (typeof options === 'string') {
    return options.trim();
  }
  return String(options?.serverUrl ?? '').trim();
}

function resolveEnvFromOptions(options) {
  if (options && typeof options === 'object' && options.env && typeof options.env === 'object') {
    return options.env;
  }
  return process.env;
}

function resolveCliDistBuildLockPath(cliDir) {
  const monorepoRoot = coerceHappyMonorepoRootFromPath(cliDir);
  return monorepoRoot
    ? join(monorepoRoot, '.project', 'tmp', 'cli-dist-build.lock')
    : join(cliDir, '.dist.hstack-build.lock');
}

function isGuardedSourceCliDistEntrypoint({ cliBin, cliEntrypoint = '', cliNodeEntrypoint = '', cliCommand = '', distEntrypoint = '' }) {
  if (String(cliCommand ?? '').trim()) return false;
  if (String(cliEntrypoint ?? '').trim()) return false;
  if (String(cliNodeEntrypoint ?? '').trim()) return false;
  if (isCliDirectExecutableCommand(cliBin)) return false;
  const entrypoint = String(distEntrypoint ?? '').trim();
  if (!entrypoint) return false;
  return resolve(entrypoint) === resolve(join(dirname(cliBin), '..', 'dist', 'index.mjs'));
}

function formatCliDistUnavailableForDaemonStart({ distEntrypoint, reason = '' }) {
  const normalizedReason = String(reason ?? '').trim();
  const missingModule = normalizedReason.startsWith('incomplete:')
    ? normalizedReason.slice('incomplete:'.length)
    : '';
  const detail = missingModule
    ? `[local] Missing module referenced by dist entrypoint: ${missingModule}\n`
    : '';
  return (
    `[local] happier-cli dist entrypoint is missing or incomplete (${distEntrypoint}).\n` +
    `[local] Refusing to start/restart daemon because it would crash with MODULE_NOT_FOUND.\n` +
    detail +
    `[local] Fix: rebuild happier-cli in the active checkout/worktree.\n` +
    (normalizedReason ? `[local] Detail: ${normalizedReason}\n` : '')
  );
}

async function waitForConcurrentCliDistBuild({
  cliDir,
  readIntegrity,
  timeoutMs = 30_000,
  pollIntervalMs = 100,
}) {
  const lockPath = resolveCliDistBuildLockPath(cliDir);
  if (!isCliDistBuildLockActive(lockPath)) {
    return null;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const integrity = readIntegrity();
    if (integrity.ok) {
      return integrity;
    }
    if (!isCliDistBuildLockActive(lockPath)) {
      break;
    }
    await delay(pollIntervalMs);
  }

  const finalIntegrity = readIntegrity();
  return finalIntegrity.ok ? finalIntegrity : null;
}

function hasExplicitServerContext({ serverUrl = '', env = process.env }) {
  return String(serverUrl ?? '').trim() !== '' || String(env?.HAPPIER_ACTIVE_SERVER_ID ?? '').trim() !== '';
}

async function persistStackDaemonMachineTransferEnv({ stackName, env = process.env } = {}) {
  const name = String(stackName ?? '').trim();
  if (!name) return { ok: false, changed: false, reason: 'missing_stack_name' };

  const { envPath } = resolveStackEnvPath(name, env);
  let existing = {};
  try {
    if (existsSync(envPath)) {
      existing = parseEnvToObject(readFileSync(envPath, 'utf-8'));
    }
  } catch {
    existing = {};
  }

  const updates = [];
  for (const key of STACK_DAEMON_MACHINE_TRANSFER_ENV_KEYS) {
    const rawValue = env?.[key];
    if (rawValue == null) continue;
    const value = String(rawValue).trim();
    if (!value) continue;
    if (String(existing?.[key] ?? '').trim() === value) continue;
    updates.push({ key, value });
  }

  if (!updates.length) {
    return { ok: true, changed: false, envPath, updatedKeys: [] };
  }

  await ensureEnvFileUpdated({ envPath, updates });
  return { ok: true, changed: true, envPath, updatedKeys: updates.map(({ key }) => key) };
}

export async function cleanupStaleDaemonState(homeDir, options = {}) {
  const serverUrl = resolveServerUrlFromOptions(options);
  const env = resolveEnvFromOptions(options);
  const { statePath, lockPath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir: homeDir, serverUrl, env });

  if (!existsSync(lockPath) && !existsSync(statePath)) {
    return;
  }

  const lsofHasPath = async (pid, pathNeedle) => {
    try {
      const out = await runCaptureIfCommandExists('lsof', ['-nP', '-p', String(pid)]);
      return out.includes(pathNeedle);
    } catch {
      return false;
    }
  };

  const canProveLsofOwnership = async (pid, pathNeedle) => {
    try {
      const out = await runCaptureIfCommandExists('lsof', ['-nP', '-p', String(pid)], { env });
      // runCaptureIfCommandExists returns '' when lsof is not found
      if (out === '') {
        return { available: false, owns: false };
      }
      return { available: true, owns: out.includes(pathNeedle) };
    } catch {
      return { available: false, owns: false };
    }
  };

  // If lock PID exists and is running, keep lock/state ONLY if it still owns the lock file path.
  try {
    const raw = readFileSync(lockPath, 'utf-8').trim();
    const pid = Number(raw);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        // If PID was recycled, refuse to trust it unless we can prove it's associated with this home dir.
        // This prevents cross-stack daemon kills due to stale lock files.
        const ownership = await canProveLsofOwnership(pid, lockPath);
        if (ownership.owns) {
          return;
        }
        // CRITICAL: If lsof is unavailable and the PID is running, fail-safe by keeping the files.
        // This prevents a second daemon from starting while the first is still running.
        if (!ownership.available) {
          return;
        }
      } catch {
        // stale pid
      }
    }
  } catch {
    // ignore
  }

  // If state PID exists and is running, keep lock/state.
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      const pid = typeof state?.pid === 'number' ? state.pid : null;
      if (pid) {
        try {
          process.kill(pid, 0);
          // Only keep if we can prove it still uses this home dir (via state path).
          const ownership = await canProveLsofOwnership(pid, statePath);
          if (ownership.owns) {
            return;
          }
          // CRITICAL: If lsof is unavailable and the PID is running, fail-safe by keeping the files.
          // This prevents a second daemon from starting while the first is still running.
          if (!ownership.available) {
            return;
          }
        } catch {
          // stale pid
        }
      }
    } catch {
      // ignore
    }
  }

  try { unlinkSync(lockPath); } catch { /* ignore */ }
  try { unlinkSync(statePath); } catch { /* ignore */ }
}

export function checkDaemonState(cliHomeDir, options = {}) {
  const serverUrl = resolveServerUrlFromOptions(options);
  const env = resolveEnvFromOptions(options);
  const { statePath, lockPath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl, env });
  const allowAnyRunningFallback = !hasExplicitServerContext({ serverUrl, env });

  const alive = isPidAlive;

  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      const pid = Number(state?.pid);
      if (Number.isFinite(pid) && pid > 0) {
        if (alive(pid)) {
          return { status: 'running', pid };
        }
        const fallback = resolveFallbackRunningDaemon(cliHomeDir, allowAnyRunningFallback, alive);
        return fallback ?? { status: 'stale_state', pid };
      }
      return { status: 'bad_state', pid: null };
    } catch {
      return { status: 'bad_state', pid: null };
    }
  }

  if (existsSync(lockPath)) {
    try {
      const pid = Number(readFileSync(lockPath, 'utf-8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        if (alive(pid)) {
          return { status: 'starting', pid };
        }
        const fallback = resolveFallbackRunningDaemon(cliHomeDir, allowAnyRunningFallback, alive);
        return fallback ?? { status: 'stale_lock', pid };
      }
      return { status: 'bad_lock', pid: null };
    } catch {
      return { status: 'bad_lock', pid: null };
    }
  }

  const fallback = resolveFallbackRunningDaemon(cliHomeDir, allowAnyRunningFallback, alive);
  if (fallback) {
    return fallback;
  }

  return { status: 'stopped', pid: null };
}

function resolveFallbackRunningDaemon(cliHomeDir, allowAnyRunningFallback, alive) {
  if (!allowAnyRunningFallback) {
    return null;
  }
  return findRunningDaemonStateInHome(cliHomeDir, alive);
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readDaemonStateStartedAtMs({ cliHomeDir, serverUrl = '', env = process.env }) {
  const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl, env });
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    const startedAt = Number(state?.startedAt);
    if (Number.isFinite(startedAt) && startedAt > 0) {
      return startedAt;
    }
    const startTimeMs = Date.parse(String(state?.startTime ?? ''));
    return Number.isFinite(startTimeMs) && startTimeMs > 0 ? startTimeMs : null;
  } catch {
    return null;
  }
}

function resolveDaemonDistRestartReason({
  distEntrypoint = '',
  distClosure = null,
  runtimeStatePath = '',
  cliHomeDir,
  serverUrl = '',
  env = process.env,
}) {
  const entrypoint = String(distEntrypoint ?? '').trim();
  if (!entrypoint || !distClosure?.ok || !distClosure?.fingerprint) {
    return null;
  }
  try {
    const runtimeState = JSON.parse(readFileSync(runtimeStatePath, 'utf-8'));
    const recordedFingerprint = String(runtimeState?.daemon?.distClosureFingerprint ?? '').trim();
    if (recordedFingerprint && recordedFingerprint !== distClosure.fingerprint) {
      return `source dist closure fingerprint changed after daemon start (${entrypoint})`;
    }
  } catch {
    // Fall back to startedAt-based closure freshness for older runtime state files.
  }
  const startedAtMs = readDaemonStateStartedAtMs({ cliHomeDir, serverUrl, env });
  if (!startedAtMs) {
    return null;
  }
  const maxMtimeMs = Number(distClosure?.maxMtimeMs);
  if (Number.isFinite(maxMtimeMs) && maxMtimeMs > startedAtMs) {
    return `source dist closure rebuilt after daemon start (${entrypoint})`;
  }
  return null;
}

function findRunningDaemonStateInHome(cliHomeDir, alive) {
  try {
    const serversDir = join(cliHomeDir, 'servers');
    const entries = readdirSync(serversDir, { withFileTypes: true }).filter((ent) => ent.isDirectory());
    const matches = [];
    for (const entry of entries) {
      const statePath = join(serversDir, entry.name, 'daemon.state.json');
      if (!existsSync(statePath)) continue;
      let state;
      try {
        state = JSON.parse(readFileSync(statePath, 'utf-8'));
      } catch {
        continue;
      }
      const pid = Number(state?.pid);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      if (!alive(pid)) continue;
      matches.push({ status: 'running', pid });
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1 && process.env.DEBUG) {
      const pids = matches.map((m) => m.pid).join(', ');
      console.warn(`[daemon] multiple running daemons detected for ${cliHomeDir} (pids: ${pids}); reporting stopped`);
    }
    return null;
  } catch {
    return null;
  }
}

export function isDaemonRunning(cliHomeDir, options = {}) {
  const s = checkDaemonState(cliHomeDir, options);
  return s.status === 'running' || s.status === 'starting';
}

async function readDaemonPsEnv(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return null;
  if (process.platform === 'win32') return null;
  try {
    const out = await runCapture('ps', ['eww', '-p', String(n)]);
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    // Usually: header + one line.
    return lines.length >= 2 ? lines[1] : lines[0] ?? null;
  } catch {
    return null;
  }
}

async function daemonEnvMatches({ pid, cliHomeDir, internalServerUrl, publicServerUrl }) {
  const line = await readDaemonPsEnv(pid);
  if (!line) return null; // unknown
  const home = String(cliHomeDir ?? '').trim();
  const server = String(internalServerUrl ?? '').trim();
  const web = String(publicServerUrl ?? '').trim();
  const backgroundServiceOwned = line.includes('HAPPIER_DAEMON_STARTUP_SOURCE=background-service');
  const daemonServerUrlPresent = line.includes('HAPPIER_SERVER_URL=');
  const daemonWebappUrlPresent = line.includes('HAPPIER_WEBAPP_URL=');

  // Must be for the same stack home dir.
  if (home && !line.includes(`HAPPIER_HOME_DIR=${home}`)) {
    return false;
  }
  // If we have a desired server URL, require it (prevents ephemeral port mismatches).
  if (
    server
    && !line.includes(`HAPPIER_SERVER_URL=${server}`)
    && (!backgroundServiceOwned || daemonServerUrlPresent)
  ) {
    return false;
  }
  // Public URL mismatch is less fatal, but prefer it stable too when provided.
  if (
    web
    && !line.includes(`HAPPIER_WEBAPP_URL=${web}`)
    && (!backgroundServiceOwned || daemonWebappUrlPresent)
  ) {
    return false;
  }
  return true;
}

function getLatestDaemonLogPath(homeDir) {
  try {
    const logsDir = join(homeDir, 'logs');
    const files = readdirSync(logsDir).filter((f) => f.endsWith('-daemon.log')).sort();
    if (!files.length) return null;
    return join(logsDir, files[files.length - 1]);
  } catch {
    return null;
  }
}

function resolveJavaScriptRuntimeForStackDaemon({ env = process.env } = {}) {
  const runtimeName = String(process.release?.name ?? '').trim().toLowerCase();
  return resolveJavaScriptRuntimeCommand({
    isBunRuntime: runtimeName === 'bun',
    processEnv: env,
    currentExecPath: process.execPath,
  });
}

function isJavaScriptEntrypoint(command) {
  return /\.(?:cjs|js|mjs)$/i.test(String(command ?? '').trim());
}

function hasExplicitRuntimeLaunchSpec({ cliEntrypoint = '', cliNodeEntrypoint = '', cliCommand = '' }) {
  if (String(cliEntrypoint ?? '').trim()) return true;
  if (String(cliNodeEntrypoint ?? '').trim()) return true;
  return isJavaScriptEntrypoint(cliCommand);
}

function looksLikeFilesystemCommandPath(command) {
  const value = String(command ?? '').trim();
  if (!value) return false;
  return value.includes('/') || value.includes('\\') || value.startsWith('.');
}

function resolveExplicitRuntimeLaunchValidation({ cliEntrypoint = '', cliNodeEntrypoint = '', cliCommand = '' }) {
  const explicitNodeEntrypoint = String(cliNodeEntrypoint ?? '').trim();
  if (explicitNodeEntrypoint && existsSync(explicitNodeEntrypoint)) {
    return { ok: true, source: 'node-entrypoint', path: explicitNodeEntrypoint };
  }

  const explicitCommand = String(cliCommand ?? '').trim();
  if (explicitCommand) {
    if (!looksLikeFilesystemCommandPath(explicitCommand) || existsSync(explicitCommand)) {
      return { ok: true, source: 'command', path: explicitCommand };
    }
  }

  const explicitEntrypoint = String(cliEntrypoint ?? '').trim();
  if (explicitEntrypoint && existsSync(explicitEntrypoint)) {
    return { ok: true, source: 'entrypoint', path: explicitEntrypoint };
  }

  const missingPath =
    explicitNodeEntrypoint
    || (looksLikeFilesystemCommandPath(explicitCommand) ? explicitCommand : '')
    || explicitEntrypoint
    || '';

  if (!missingPath) {
    return { ok: true, source: null, path: '' };
  }

  return {
    ok: false,
    source:
      explicitNodeEntrypoint
        ? 'node-entrypoint'
        : looksLikeFilesystemCommandPath(explicitCommand)
          ? 'command'
          : 'entrypoint',
    path: missingPath,
    reason: `missing_runtime_launch_path:${missingPath}`,
  };
}

function resolveDaemonCommandSpec({
  cliBin,
  cliEntrypoint = '',
  cliNodeEntrypoint = '',
  cliCommand = '',
  cliCommandArgs = [],
  env = process.env,
}) {
  const javaScriptRuntime = resolveJavaScriptRuntimeForStackDaemon({ env });
  const explicitNodeEntrypoint = String(cliNodeEntrypoint ?? '').trim();
  if (explicitNodeEntrypoint && javaScriptRuntime && existsSync(explicitNodeEntrypoint)) {
    return {
      command: javaScriptRuntime,
      argsPrefix: ['--no-warnings', '--no-deprecation', explicitNodeEntrypoint],
      mode: 'node',
    };
  }
  const explicitCommand = String(cliCommand ?? '').trim();
  if (explicitCommand) {
    if (isJavaScriptEntrypoint(explicitCommand) && javaScriptRuntime) {
      return {
        command: javaScriptRuntime,
        argsPrefix: ['--no-warnings', '--no-deprecation', explicitCommand, ...Array.isArray(cliCommandArgs) ? cliCommandArgs.map((value) => String(value)) : []],
        mode: 'node',
      };
    }
    return {
      command: explicitCommand,
      argsPrefix: Array.isArray(cliCommandArgs) ? cliCommandArgs.map((value) => String(value)) : [],
      mode: 'binary',
    };
  }
  const explicitEntrypoint = String(cliEntrypoint ?? '').trim();
  if (explicitEntrypoint && javaScriptRuntime) {
    return {
      command: javaScriptRuntime,
      argsPrefix: ['--no-warnings', '--no-deprecation', explicitEntrypoint],
      mode: 'node',
    };
  }
  if (isCliDirectExecutableCommand(cliBin)) {
    return {
      command: cliBin,
      argsPrefix: [],
      mode: 'binary',
    };
  }
  const distEntrypoint = resolveCliDistEntrypointFromBin(cliBin);
  if (distEntrypoint && existsSync(distEntrypoint) && javaScriptRuntime) {
    // Prefer launching the daemon via dist entrypoint directly.
    // This avoids coupling stack daemon lifecycle to the dev-only bin wrapper (which may perform
    // extra preflight checks or rely on package.json subpath resolution).
    return {
      command: javaScriptRuntime,
      argsPrefix: ['--no-warnings', '--no-deprecation', distEntrypoint],
      mode: 'node',
    };
  }
  return {
    command: process.execPath,
    argsPrefix: [cliBin],
    mode: 'node',
  };
}

async function ensureHappierCliDistExists({ cliBin, cliEntrypoint = '', cliNodeEntrypoint = '', cliCommand = '' }) {
  const explicitRuntimeLaunch = resolveExplicitRuntimeLaunchValidation({ cliEntrypoint, cliNodeEntrypoint, cliCommand });
  if (!explicitRuntimeLaunch.ok) {
    return { ok: false, distEntrypoint: explicitRuntimeLaunch.path, built: false, reason: explicitRuntimeLaunch.reason };
  }
  if (String(cliCommand ?? '').trim()) {
    return { ok: true, distEntrypoint: cliCommand, built: false, reason: 'runtime-command' };
  }
  if (String(cliEntrypoint ?? '').trim()) {
    return { ok: true, distEntrypoint: cliEntrypoint, built: false, reason: 'runtime-entrypoint' };
  }
  if (isCliDirectExecutableCommand(cliBin)) {
    return { ok: true, distEntrypoint: cliBin, built: false, reason: 'direct-cli-command' };
  }
  const distEntrypoint = resolveCliDistEntrypointFromBin(cliBin);
  if (!distEntrypoint) return { ok: false, distEntrypoint: null, built: false, reason: 'unknown_cli_bin' };
  const cliDir = join(dirname(cliBin), '..');
  const buildCli =
    (process.env.HAPPIER_STACK_CLI_BUILD ?? '1').toString().trim() !== '0';

  const readIntegrity = () => readCliDistIntegrity(distEntrypoint);

  // Fast path: if dist exists and import graph is complete, never trigger rebuild here.
  // Rebuilding inside daemon restart can race with live restarts and transiently remove dist/.
  const before = readIntegrity();
  if (before.ok) {
    return { ok: true, distEntrypoint, built: false, reason: before.reason };
  }

  const concurrentBuildReady = await waitForConcurrentCliDistBuild({
    cliDir,
    readIntegrity,
  });
  if (concurrentBuildReady?.ok) {
    return {
      ok: true,
      distEntrypoint,
      built: false,
      reason: concurrentBuildReady.reason,
    };
  }

  // Try to recover automatically: missing dist is a common first-run worktree issue.
  // We build in-place using the cliDir that owns this cliBin (../ from bin/).
  if (!buildCli) {
    return { ok: false, distEntrypoint, built: false, reason: before.reason };
  }

  let buildRes = null;
  try {
    // In auto mode, ensureCliBuilt() is a fast no-op when nothing changed.
    buildRes = await ensureCliBuilt(cliDir, { buildCli: true });
    if (buildRes?.built) {
      // eslint-disable-next-line no-console
      console.warn(`[local] happier-cli: rebuilt (${cliDir})`);
    }
  } catch (e) {
    return { ok: false, distEntrypoint, built: false, reason: String(e?.message ?? e) };
  }

  const after = readIntegrity();
  if (after.ok) {
    return {
      ok: true,
      distEntrypoint,
      built: Boolean(buildRes?.built),
      reason: buildRes?.built ? (buildRes.reason ?? 'rebuilt') : 'exists',
    };
  }
  return {
    ok: false,
    distEntrypoint,
    built: Boolean(buildRes?.built),
    reason: after.reason,
  };
}

function excerptIndicatesMissingAuth(excerpt) {
  if (!excerpt) return false;
  return (
    excerpt.includes('[AUTH] No credentials found') ||
    excerpt.includes('No credentials found, starting authentication flow')
  );
}

function excerptIndicatesInvalidAuth(excerpt) {
  if (!excerpt) return false;
  return (
    excerpt.includes('Auth failed - invalid token') ||
    excerpt.includes('Request failed with status code 401') ||
    excerpt.includes('"status":401') ||
    excerpt.includes('[DAEMON RUN][FATAL]') && excerpt.includes('status code 401')
  );
}

function excerptIndicatesInstalledServiceConflict(excerpt) {
  if (!excerpt) return false;
  return (
    excerpt.includes('A background service is already installed for this relay.') ||
    excerpt.includes('The current relay owner is managed by a background service.') ||
    excerpt.includes('Use `happier service start` to start the installed background service instead of starting a new relay runtime.') ||
    excerpt.includes('Use `happier service stop` instead of `happier daemon stop`.') ||
    excerpt.includes('If you want to start a manual relay runtime')
  );
}

function extractFirstDaemonStartNoticeLine(excerpt) {
  const lines = String(excerpt ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[daemon\]\s*/, '').trim())
    .filter(Boolean);
  return lines[0] ?? null;
}

function extractInstalledServiceConflictGuidance(excerpt) {
  if (!excerptIndicatesInstalledServiceConflict(excerpt)) {
    return null;
  }

  const guidanceLines = String(excerpt ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[daemon\]\s*/, '').trim())
    .filter((line) =>
      line === 'A background service is already installed for this relay.' ||
      line === 'The current relay owner is managed by a background service.' ||
      line === 'Use `happier service start` to start the installed background service instead of starting a new relay runtime.' ||
      line === 'Use `happier service stop` instead of `happier daemon stop`.' ||
      line === 'If you want to start a manual relay runtime, stop or replace the installed background service first.'
    );

  if (guidanceLines.length === 0) {
    return null;
  }

  return guidanceLines.join('\n');
}

function parseInstalledServiceConflictOwner(excerpt) {
  const candidateLine = String(excerpt ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[daemon\]\s*/, '').trim())
    .find((line) => line.includes(' — ') && line.includes('(') && line.includes(')'));

  if (!candidateLine) {
    return null;
  }

  const match = candidateLine.match(/^(.+?)\s+\((.+?)\)\s+—\s+(.+)$/);
  if (!match) {
    return null;
  }

  return {
    label: match[1]?.trim() || '',
    descriptor: match[2]?.trim() || '',
    definitionPath: match[3]?.trim() || '',
  };
}

function resolveInstalledServiceConflictRepairHint(excerpt) {
  const owner = parseInstalledServiceConflictOwner(excerpt);
  const definitionPath = owner?.definitionPath?.trim();
  if (!definitionPath || existsSync(definitionPath)) {
    return null;
  }

  const definitionKind = process.platform === 'darwin'
    ? 'LaunchAgent plist'
    : process.platform === 'linux'
      ? 'systemd user unit'
      : 'service definition';

  return (
    `Installed background service ${definitionKind} is missing at ${definitionPath}.\n` +
    'Run `hstack service repair --yes` to restore it before retrying source-dev startup.'
  );
}

async function resolveInstalledServiceConflictMaterializationHint(excerpt, { env = process.env } = {}) {
  const owner = parseInstalledServiceConflictOwner(excerpt);
  const label = owner?.label?.trim();
  const definitionPath = owner?.definitionPath?.trim();
  if (!label || !definitionPath || !existsSync(definitionPath)) {
    return null;
  }

  if (process.platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid == null) {
      return null;
    }

    const launchctlTarget = `gui/${uid}/${label}`;
    try {
      await runCapture('launchctl', ['print', launchctlTarget], { env });
      return null;
    } catch (error) {
      const out = String(error?.out ?? '');
      const err = String(error?.err ?? '');
      const combined = `${out}\n${err}`.trim();
      if (!/could not find service/i.test(combined)) {
        return null;
      }

      return (
        `Installed background service LaunchAgent plist exists on disk at ${definitionPath}, ` +
        `but launchd does not currently know label ${label}.\n` +
        'This points to external launchd/service state rather than a new source-dev code regression.\n' +
        'Minimal external next step: run `hstack service repair --yes` (or re-bootstrap the LaunchAgent) before retrying source-dev startup.'
      );
    }
  }

  return null;
}

async function tryStartInstalledBackgroundServiceFromConflict({
  excerpt,
  env = process.env,
}) {
  const owner = parseInstalledServiceConflictOwner(excerpt);
  if (!owner?.label) {
    return false;
  }

  if (process.platform === 'darwin') {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (uid == null) {
      return false;
    }
    const launchctlDomain = `gui/${uid}`;

    try {
      await run('launchctl', ['kickstart', '-k', `${launchctlDomain}/${owner.label}`], { env });
      return true;
    } catch {
      try {
        await run('launchctl', ['start', owner.label], { env });
        return true;
      } catch {
        return false;
      }
    }
  }

  if (process.platform === 'linux') {
    const unitName = owner.definitionPath ? owner.definitionPath.split('/').pop() : '';
    if (!unitName) {
      return false;
    }
    try {
      await run('systemctl', ['--user', 'start', unitName], { env });
      return true;
    } catch {
      return false;
    }
  }

  if (process.platform === 'win32') {
    try {
      await run('schtasks', ['/Run', '/TN', `Happier\\${owner.label}`], { env });
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function allowDaemonWaitForAuthWithoutTty() {
  const raw = (process.env.HAPPIER_STACK_DAEMON_WAIT_FOR_AUTH ?? '').toString().trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

function authLoginHint({ stackName, cliIdentity }) {
  const id = (cliIdentity ?? '').toString().trim();
  const suffix = id && id !== 'default' ? ` --identity=${id} --no-open` : '';
  return stackName === 'main' ? `hstack auth login${suffix}` : `hstack stack auth ${stackName} login${suffix}`;
}

function authCopyFromSeedHint({ stackName, cliIdentity, env = process.env }) {
  if (stackName === 'main') return null;
  // For multi-identity daemons, copying credentials defeats the purpose (multiple accounts).
  const id = (cliIdentity ?? '').toString().trim();
  if (id && id !== 'default') return null;
  const requestedSeed = resolveAuthSeedFromEnv(env);
  const { seed } = resolveReusableAuthSeedSource({
    env,
    requestedSeed,
    excludeStackNames: [stackName],
  });
  if (!seed) return null;
  return `hstack stack auth ${stackName} copy-from ${seed}`;
}

function logInvalidDaemonCredentialsGuidance({
  stackName,
  cliIdentity,
  env = process.env,
  skippedReason = null,
  staleSeed = null,
}) {
  const copyHint = authCopyFromSeedHint({ stackName, cliIdentity, env });
  if (staleSeed) {
    console.error(
      `[local] auth re-seed source "${staleSeed}" appears stale (still 401).\n` +
        `[local] Auto fallback to another auth source is disabled.\n` +
        `[local] Fix:\n` +
        (copyHint ? `- ${copyHint} --force\n` : '') +
        `- ${authLoginHint({ stackName, cliIdentity })}`
    );
    return;
  }

  if (!skippedReason) {
    console.error(
      `[local] daemon credentials were rejected by the server (401).\n` +
        `[local] Fix:\n` +
        (copyHint ? `- ${copyHint}\n` : '') +
        `- ${authLoginHint({ stackName, cliIdentity })}`
    );
    return;
  }

  const guardedSkip =
    skippedReason === 'different-account' || skippedReason === 'different-token';
  console.error(
    `[local] daemon credentials were rejected by the server (401).\n` +
      (guardedSkip
        ? `[local] Auto re-seed was skipped to avoid overwriting credentials that do not match the configured seed (${skippedReason}).\n`
        : `[local] Auto re-seed was skipped (${skippedReason}).\n`) +
      `[local] Fix:\n` +
      (guardedSkip ? '' : copyHint ? `- ${copyHint} --force\n` : '') +
      (guardedSkip && copyHint ? `- ${copyHint} --force  # only if you explicitly want to replace this stack auth\n` : '') +
      `- ${authLoginHint({ stackName, cliIdentity })}`
  );
}

async function maybeAutoReseedInvalidAuth({
  stackName,
  cliHomeDir,
  internalServerUrl,
  env = process.env,
  quiet = false,
}) {
  if (stackName === 'main') return { ok: false, skipped: true, reason: 'main' };
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const enabled = resolveAutoCopyFromMainEnabled({ env, stackName, isInteractive });
  if (!enabled) return { ok: false, skipped: true, reason: 'disabled' };

  const requestedSeed = resolveAuthSeedFromEnv(env);
  const seedResolution = resolveReusableAuthSeedSource({
    env,
    requestedSeed,
    excludeStackNames: [stackName],
  });
  const seedCandidates = resolveReusableAuthSeedCandidates({
    env,
    requestedSeed,
    excludeStackNames: [stackName],
  });
  if (!seedCandidates.length) {
    return { ok: false, skipped: true, reason: seedResolution.reason, seed: requestedSeed || null };
  }
  const allowAccountSwitch =
    (env.HAPPIER_STACK_AUTO_AUTH_RESEED_ALLOW_ACCOUNT_SWITCH ?? '').toString().trim() === '1';
  let lastReason = seedResolution.reason;

  for (const seed of seedCandidates) {
    const guard = shouldSkipAutoReseedForDifferentAccount({
      stackName,
      seed,
      cliHomeDir,
      internalServerUrl,
      env,
    });
    if (guard.skip && !allowAccountSwitch) {
      lastReason = guard.reason;
      continue;
    }

    const seedCliHomeDir = resolveStackCliHomeDirFromStackEnv({ stackName: seed, env });
    const seedScopedEnv = applyStackActiveServerScopeEnv({
      env: { ...env },
      stackName: seed,
      cliIdentity: 'default',
    });
    const seedCredentialPath =
      findExistingStackCredentialPath({ cliHomeDir: seedCliHomeDir, serverUrl: internalServerUrl, env: seedScopedEnv }) ??
      findAnyCredentialPathInCliHome({ cliHomeDir: seedCliHomeDir });
    const seedToken = seedCredentialPath ? readAuthTokenFromCredentialFile(seedCredentialPath) : null;
    const seedValidation = await validateBearerTokenAgainstServer({ internalServerUrl, token: seedToken });
    if (!seedValidation.checked || seedValidation.valid !== true) {
      lastReason = seedValidation.code;
      continue;
    }

    if (!quiet) {
      console.log(`[local] auth: invalid token detected; re-seeding ${stackName} from ${seed}...`);
    }
    const rootDir = getRootDir(import.meta.url);

    // Use stack-scoped auth copy so env/database resolution is correct for the target stack.
    await run(
      process.execPath,
      [join(rootDir, 'scripts', 'stack.mjs'), 'auth', stackName, '--', 'copy-from', seed, '--force', '--offline-ok', '--no-secret'],
      {
        cwd: rootDir,
        env,
      }
    );
    return { ok: true, skipped: false, seed };
  }

  return { ok: false, skipped: true, reason: lastReason ?? seedResolution.reason, seed: seedCandidates[0] ?? (requestedSeed || null) };
}

function readAuthTokenFromCredentialFile(path) {
  const p = String(path ?? '').trim();
  if (!p || !existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf-8').trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.token === 'string' && parsed.token.trim()) return parsed.token.trim();
    } catch {
      // fall back below
    }
    // Legacy fallback: treat plain file content as token.
    return raw;
  } catch {
    return null;
  }
}

async function validateBearerTokenAgainstServer({ internalServerUrl, token }) {
  const baseUrl = String(internalServerUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) return { checked: false, valid: null, status: null, code: 'missing-server-url', error: null };

  const t = String(token ?? '').trim();
  if (!t) return { checked: false, valid: null, status: null, code: 'missing-token', error: null };

  try {
    const res = await fetch(`${baseUrl}/v1/account/profile`, {
      method: 'GET',
      headers: { authorization: `Bearer ${t}` },
    });
    if (res.status === 200) return { checked: true, valid: true, status: 200, code: 'ok', error: null };
    if (res.status === 401) return { checked: true, valid: false, status: 401, code: 'invalid-token', error: null };
    return { checked: true, valid: false, status: res.status, code: 'unexpected-status', error: null };
  } catch (e) {
    return {
      checked: false,
      valid: null,
      status: null,
      code: 'server-unreachable',
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function resolveStackCliHomeDirFromStackEnv({ stackName, env = process.env }) {
  const { baseDir, envPath } = resolveStackEnvPath(stackName, env);
  let stackEnv = {};
  try {
    if (existsSync(envPath)) {
      stackEnv = parseEnvToObject(readFileSync(envPath, 'utf-8'));
    }
  } catch {
    stackEnv = {};
  }
  return getCliHomeDirFromEnvOrDefault({ stackBaseDir: baseDir, env: stackEnv });
}

function shouldSkipAutoReseedForDifferentAccount({
  stackName,
  seed,
  cliHomeDir,
  internalServerUrl,
  env = process.env,
}) {
  const targetCredentialPath =
    findExistingStackCredentialPath({ cliHomeDir, serverUrl: internalServerUrl, env }) ??
    findAnyCredentialPathInCliHome({ cliHomeDir });
  if (!targetCredentialPath) return { skip: false, reason: null };

  const sourceCliHomeDir = resolveStackCliHomeDirFromStackEnv({ stackName: seed, env });
  const sourceCredentialPath =
    findAnyCredentialPathInCliHome({ cliHomeDir: sourceCliHomeDir }) ??
    findExistingStackCredentialPath({ cliHomeDir: sourceCliHomeDir, serverUrl: internalServerUrl, env });
  if (!sourceCredentialPath) return { skip: false, reason: null };

  const targetToken = readAuthTokenFromCredentialFile(targetCredentialPath);
  const sourceToken = readAuthTokenFromCredentialFile(sourceCredentialPath);
  if (!targetToken || !sourceToken) return { skip: false, reason: null };

  const targetPayload = decodeJwtPayloadUnsafe(targetToken);
  const sourcePayload = decodeJwtPayloadUnsafe(sourceToken);

  if (
    targetPayload?.sub &&
    sourcePayload?.sub &&
    String(targetPayload.sub) !== String(sourcePayload.sub)
  ) {
    return { skip: true, reason: 'different-account' };
  }

  // Conservative guard for non-JWT/opaque tokens: if values differ, avoid silently overwriting
  // potentially manual credentials.
  if (!targetPayload?.sub && !sourcePayload?.sub && targetToken !== sourceToken) {
    return { skip: true, reason: 'different-token' };
  }

  return { skip: false, reason: null };
}

async function seedCredentialsIfMissing({ cliHomeDir }) {
  const stacksRoot = getStacksStorageRoot();

  const sources = [
    // New layout: main stack credentials (preferred).
    join(stacksRoot, 'main', 'cli'),
  ];

  const copyIfMissing = async ({ relPath, mode, label }) => {
    const target = join(cliHomeDir, relPath);
    if (existsSync(target)) {
      return { copied: false, source: null, target };
    }
    const sourceDir = sources.find((d) => existsSync(join(d, relPath)));
    if (!sourceDir) {
      return { copied: false, source: null, target };
    }
    const source = join(sourceDir, relPath);
    await mkdir(cliHomeDir, { recursive: true });
    await copyFile(source, target);
    await chmod(target, mode).catch(() => {});
    console.log(`[local] migrated ${label}: ${source} -> ${target}`);
    return { copied: true, source, target };
  };

  const copyCredentialIfMissing = async () => {
    const target = join(cliHomeDir, 'access.key');
    if (existsSync(target)) {
      return { copied: false, source: null, target };
    }
    const existingCredentialInHome = findAnyCredentialPathInCliHome({ cliHomeDir });
    if (existingCredentialInHome) {
      return { copied: false, source: null, target };
    }
    const source = sources
      .map((sourceCli) => findAnyCredentialPathInCliHome({ cliHomeDir: sourceCli }))
      .find(Boolean);
    if (!source) {
      return { copied: false, source: null, target };
    }
    await mkdir(cliHomeDir, { recursive: true });
    await copyFile(source, target);
    await chmod(target, 0o600).catch(() => {});
    console.log(`[local] migrated CLI credentials (access.key): ${source} -> ${target}`);
    return { copied: true, source, target };
  };

  // access.key holds the auth token + encryption material (keep tight permissions)
  const access = await copyCredentialIfMissing().catch((err) => {
    console.warn(`[local] failed to migrate CLI credentials into ${cliHomeDir}:`, err);
    return { copied: false, source: null, target: join(cliHomeDir, 'access.key') };
  });

  // settings.json holds machineId and other client state; migrate to keep your machine identity stable.
  const settings = await copyIfMissing({ relPath: 'settings.json', mode: 0o600, label: 'CLI settings (settings.json)' })
    .catch((err) => {
      console.warn(`[local] failed to migrate CLI settings into ${cliHomeDir}:`, err);
      return { copied: false, source: null, target: join(cliHomeDir, 'settings.json') };
    });

  return { ok: true, copied: access.copied || settings.copied, access, settings };
}

async function ensureServerScopedCredentialsFromLegacy({ cliHomeDir, internalServerUrl, env = process.env }) {
  const resolved = resolveStackCredentialPaths({ cliHomeDir, serverUrl: internalServerUrl, env });
  if (existsSync(resolved.serverScopedPath) || !existsSync(resolved.legacyPath)) {
    return { copied: false, source: null, target: resolved.serverScopedPath, paths: resolved.paths };
  }
  try {
    await mkdir(dirname(resolved.serverScopedPath), { recursive: true });
    await copyFile(resolved.legacyPath, resolved.serverScopedPath);
    await chmod(resolved.serverScopedPath, 0o600).catch(() => {});
    return { copied: true, source: resolved.legacyPath, target: resolved.serverScopedPath, paths: resolved.paths };
  } catch {
    return { copied: false, source: null, target: resolved.serverScopedPath, paths: resolved.paths };
  }
}

async function daemonPidOwnsStackHome({ pid, cliHomeDir, serverUrl = '', env = process.env, preferredPath = '' }) {
  const envMatch = await daemonEnvMatches({
    pid,
    cliHomeDir,
    internalServerUrl: serverUrl,
    publicServerUrl: '',
  });
  if (envMatch === true) return true;
  if (envMatch === false) return false;

  const { statePath, lockPath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl, env });
  const daemonStatePaths = resolveStackDaemonStatePaths({ cliHomeDir, serverUrl, env });
  try {
    const out = await runCaptureIfCommandExists('lsof', ['-nP', '-p', String(pid)]);
    return (
      (preferredPath && out.includes(preferredPath)) ||
      out.includes(lockPath) ||
      out.includes(statePath) ||
      out.includes(daemonStatePaths.legacyStatePath) ||
      out.includes(daemonStatePaths.serverScopedStatePath) ||
      out.includes(join(cliHomeDir, 'logs'))
    );
  } catch {
    return false;
  }
}

async function killDaemonPidSafely({
  pid,
  cliHomeDir,
  serverUrl = '',
  env = process.env,
  sourcePath = '',
  sourceLabel = 'state file',
}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  let cmd = '';
  try {
    cmd = await runCapture('ps', ['-p', String(pid), '-o', 'command=']);
  } catch {
    cmd = '';
  }
  const looksLikeDaemon = cmd.includes(' daemon ') || cmd.includes('daemon start') || cmd.includes('daemon start-sync');
  if (!looksLikeDaemon) {
    console.warn(`[local] refusing to kill pid ${pid} from ${sourceLabel} (doesn't look like daemon): ${cmd.trim()}`);
    return false;
  }

  const ownsStackHome = await daemonPidOwnsStackHome({ pid, cliHomeDir, serverUrl, env, preferredPath: sourcePath });
  if (!ownsStackHome) {
    console.warn(
      `[local] refusing to kill pid ${pid} from ${sourceLabel} (could be unrelated; ownership could not be proven for ${cliHomeDir})`
    );
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  await delay(500);
  try {
    process.kill(pid, 0);
    process.kill(pid, 'SIGKILL');
  } catch {
    // exited
  }
  console.log(`[local] killed stuck daemon pid ${pid} (from ${sourcePath || sourceLabel})`);
  return true;
}

async function killDaemonFromStateFile({ cliHomeDir, serverUrl = '', env = process.env }) {
  const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl, env });
  if (!existsSync(statePath)) {
    return false;
  }

  let pid = null;
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    const n = Number(state?.pid);
    if (Number.isFinite(n) && n > 0) {
      pid = n;
    }
  } catch {
    pid = null;
  }

  return await killDaemonPidSafely({
    pid,
    cliHomeDir,
    serverUrl,
    env,
    sourcePath: statePath,
    sourceLabel: 'daemon.state.json',
  });
}

async function killDaemonFromLockFile({ cliHomeDir, serverUrl = '', env = process.env }) {
  const { lockPath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl, env });
  if (!existsSync(lockPath)) {
    return false;
  }

  let pid = null;
  try {
    const raw = readFileSync(lockPath, 'utf-8').trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      pid = n;
    }
  } catch {
    // ignore
  }
  if (!pid) {
    return false;
  }

  return await killDaemonPidSafely({
    pid,
    cliHomeDir,
    serverUrl,
    env,
    sourcePath: lockPath,
    sourceLabel: 'lock file',
  });
}

async function waitForCredentialsFiles({ paths, timeoutMs, isShuttingDown }) {
  const uniquePaths = Array.from(new Set((paths ?? []).map((p) => String(p ?? '').trim()).filter(Boolean)));
  const deadline = Date.now() + timeoutMs;
  while (!isShuttingDown() && Date.now() < deadline) {
    for (const path of uniquePaths) {
      try {
        if (existsSync(path)) {
          const raw = readFileSync(path, 'utf-8').trim();
          if (raw.length > 0) {
            return true;
          }
        }
      } catch {
        // ignore
      }
    }
    await delay(500);
  }
  return false;
}

export function getDaemonEnv({
  baseEnv,
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  stackName = null,
  cliIdentity = null,
}) {
  const scopedEnv = applyStackActiveServerScopeEnv({
    env: baseEnv,
    stackName,
    cliIdentity,
  });
  const explicitStartupSource = String(baseEnv?.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim();
  const explicitServiceLabel = String(baseEnv?.HAPPIER_DAEMON_SERVICE_LABEL ?? '').trim();
  const startupSource =
    explicitStartupSource ||
    (String(baseEnv?.HAPPIER_STACK_SERVICE_MODE ?? '').trim() === '1' ? 'background-service' : 'manual');
  // Prefer the canonical server id from the CLI settings when it matches this stack's server URL.
  // This keeps daemon state/locks aligned with the active stack server profile (and avoids leaking
  // the stable-scope id into the daemon's persisted server-scoped directories).
  const settingsServerId = resolvePreferredStackServerIdFromCliSettings({
    cliHomeDir,
    serverUrl: internalServerUrl,
    env: scopedEnv,
  });
  if (settingsServerId) {
    scopedEnv.HAPPIER_ACTIVE_SERVER_ID = settingsServerId;
  }
  return {
    ...scopedEnv,
    HAPPIER_SERVER_URL: internalServerUrl,
    HAPPIER_WEBAPP_URL: publicServerUrl,
    HAPPIER_HOME_DIR: cliHomeDir,
    HAPPIER_DAEMON_STARTUP_SOURCE: startupSource,
    HAPPIER_DAEMON_SERVICE_LABEL: explicitServiceLabel,
  };
}

export async function stopLocalDaemon({
  cliBin,
  cliEntrypoint = '',
  cliNodeEntrypoint = '',
  cliCommand = '',
  cliCommandArgs = [],
  internalServerUrl,
  cliHomeDir,
  publicServerUrl = '',
  runtimeStatePath = null,
  env = process.env,
  stackName = null,
  cliIdentity = null,
  expectedPid = null,
}) {
  const daemonEnv = getDaemonEnv({
    baseEnv: env,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl: publicServerUrl || internalServerUrl,
    stackName,
    cliIdentity,
  });

  // When we're shutting down due to a service manager restart (launchd/systemd),
  // a previous `hstack start` instance can race the new instance and accidentally stop the
  // newly-started daemon. Guard against that by only stopping when the caller believes it owns
  // the currently-running daemon PID.
  if (expectedPid != null) {
    const expected = Number(expectedPid);
    if (Number.isFinite(expected) && expected > 0) {
      const state = checkDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env: daemonEnv });
      const current = typeof state?.pid === 'number' ? state.pid : null;
      if (!current || current !== expected) {
        return;
      }
    }
  }

  const explicitCommand = String(cliCommand ?? '').trim();
  const explicitEntrypoint = String(cliEntrypoint ?? '').trim();
  const distEntrypoint = explicitCommand ? '' : explicitEntrypoint || resolveCliDistEntrypointFromBin(cliBin);
  const explicitRuntimeLaunch = resolveExplicitRuntimeLaunchValidation({ cliEntrypoint, cliNodeEntrypoint, cliCommand });
  const distIntegrity = explicitCommand
    ? explicitRuntimeLaunch.ok
      ? { ok: true, reason: 'runtime-command' }
      : { ok: false, reason: explicitRuntimeLaunch.reason }
    : explicitEntrypoint
      ? explicitRuntimeLaunch.ok
        ? { ok: true, reason: 'runtime-entrypoint' }
        : { ok: false, reason: explicitRuntimeLaunch.reason }
      : distEntrypoint
        ? readCliDistIntegrity(distEntrypoint)
        : { ok: false, reason: 'unknown_cli_bin' };
  if (distIntegrity.ok) {
    const daemonCommand = resolveDaemonCommandSpec({ cliBin, cliEntrypoint, cliNodeEntrypoint, cliCommand, cliCommandArgs, env: daemonEnv });
    try {
      await new Promise((resolve) => {
        const proc = spawnProc('daemon', daemonCommand.command, [...daemonCommand.argsPrefix, 'daemon', 'stop'], daemonEnv, {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.on('exit', () => resolve());
      });
    } catch {
      // ignore
    }
  }

  await killDaemonFromStateFile({ cliHomeDir, serverUrl: internalServerUrl, env: daemonEnv });
  // If the daemon never wrote daemon.state.json (e.g. it got stuck in auth in a non-interactive context),
  // stopLocalDaemon() can't find it. Fall back to the lock file PID.
  await killDaemonFromLockFile({ cliHomeDir, serverUrl: internalServerUrl, env: daemonEnv });
  await recordStackRuntimeDaemonPid(runtimeStatePath, null).catch(() => {});
}

export async function startLocalDaemonWithAuth({
  cliBin,
  cliEntrypoint = '',
  cliNodeEntrypoint = '',
  cliCommand = '',
  cliCommandArgs = [],
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  runtimeStatePath = null,
  isShuttingDown,
  forceRestart = false,
  env = process.env,
  stackName = null,
  cliIdentity = 'default',
}) {
  const resolvedStackName =
    (stackName ?? '').toString().trim() ||
    (env.HAPPIER_STACK_STACK ?? '').toString().trim() ||
    'main';
  const resolvedCliIdentity =
    (cliIdentity ?? '').toString().trim() ||
    (env.HAPPIER_STACK_CLI_IDENTITY ?? '').toString().trim() ||
    'default';
  const baseEnv = { ...env };
  await persistStackDaemonMachineTransferEnv({
    stackName: resolvedStackName,
    env: baseEnv,
  }).catch(() => {});
  const daemonEnv = getDaemonEnv({
    baseEnv,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    stackName: resolvedStackName,
    cliIdentity: resolvedCliIdentity,
  });
  const parseNonNegativeInt = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  const isTui = (baseEnv.HAPPIER_STACK_TUI ?? '').toString().trim() === '1';
  const syncRuntimeDaemonState = async ({ runtimeDaemonPid = null, daemonDistFingerprint = undefined } = {}) => {
    await syncStackRuntimeDaemonPidFromDaemonState(
      {
        runtimeStatePath,
        cliHomeDir,
        internalServerUrl,
        runtimeDaemonPid,
        daemonDistFingerprint,
        env: daemonEnv,
      },
      { checkDaemonStateImpl: checkDaemonState },
    ).catch(() => {});
  };
  const explicitCommand = String(cliCommand ?? '').trim();
  const explicitEntrypoint = String(cliEntrypoint ?? '').trim();
  const initialDistEntrypoint = explicitCommand ? '' : explicitEntrypoint || resolveCliDistEntrypointFromBin(cliBin);
  const distCheck = await ensureHappierCliDistExists({ cliBin, cliEntrypoint, cliNodeEntrypoint, cliCommand });
  const distEntrypoint =
    explicitCommand
      ? ''
      : explicitEntrypoint || distCheck.distEntrypoint || initialDistEntrypoint;
  if (!distCheck.ok) {
    const reason = String(distCheck.reason ?? '').trim();
    if (reason.startsWith('missing_runtime_launch_path:')) {
      const missingPath = reason.slice('missing_runtime_launch_path:'.length);
      throw new Error(
        `[local] runtime launch path is missing (${missingPath}).\n` +
          `[local] Refusing to start/restart daemon because the active runtime snapshot is incomplete.\n` +
          `[local] Fix: rebuild or reactivate the stack runtime snapshot before starting the daemon.\n`,
      );
    }
    throw new Error(formatCliDistUnavailableForDaemonStart({ distEntrypoint, reason: distCheck.reason }));
  }
  const guardSourceCliDistRestart = isGuardedSourceCliDistEntrypoint({
    cliBin,
    cliEntrypoint,
    cliNodeEntrypoint,
    cliCommand,
    distEntrypoint,
  });

  const runDaemonLifecycleWithResolvedCommand = async () => {
    const currentDistClosure =
      distEntrypoint && !explicitCommand && !explicitEntrypoint
        ? readCliDistClosureFingerprint(distEntrypoint)
        : null;
    const currentDistFingerprint = currentDistClosure?.ok ? currentDistClosure.fingerprint : null;

    const daemonCommand = resolveDaemonCommandSpec({ cliBin, cliEntrypoint, cliNodeEntrypoint, cliCommand, cliCommandArgs, env: daemonEnv });
    // Binary/runtime-started daemons can take materially longer than direct node-entrypoint starts
    // because the packaged CLI may need to warm bundled workspace/runtime state before the daemon
    // reaches a stable running state.
    const defaultStartVerifyTimeoutMs =
      daemonCommand.mode === 'binary'
        || hasExplicitRuntimeLaunchSpec({ cliEntrypoint, cliNodeEntrypoint, cliCommand })
        ? 30_000
        : 5_000;
    const startVerifyTimeoutMs = parseNonNegativeInt(
      baseEnv.HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS,
      defaultStartVerifyTimeoutMs,
    );
    const startVerifyPollMs = parseNonNegativeInt(baseEnv.HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS, 125);
    const startVerifyStableMs = parseNonNegativeInt(baseEnv.HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS, 750);
    const daemonLifecycleLockTimeoutMs = parseNonNegativeInt(baseEnv.HAPPIER_STACK_DAEMON_LIFECYCLE_LOCK_TIMEOUT_MS, 120_000);
    const daemonLifecycleLockPollMs = parseNonNegativeInt(baseEnv.HAPPIER_STACK_DAEMON_LIFECYCLE_LOCK_POLL_MS, 125);

    return await withStackDaemonLifecycleLock(
    { cliHomeDir, internalServerUrl, stackName: resolvedStackName },
    async () => {

  const waitForRunningStable = async () => {
    const deadline = Date.now() + startVerifyTimeoutMs;
    while (Date.now() < deadline) {
      const stateNow = checkDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env: daemonEnv });
      if (stateNow.status === 'running') {
        if (startVerifyStableMs <= 0) return true;
        await delay(startVerifyStableMs);
        const stableState = checkDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env: daemonEnv });
        if (stableState.status === 'running') return true;
      }
      await delay(startVerifyPollMs);
    }
    return false;
  };

  // If this is a migrated/new stack home dir, seed credentials from the user's existing login (best-effort)
  // to avoid requiring an interactive auth flow under launchd.
  const migrateCreds = (baseEnv.HAPPIER_STACK_MIGRATE_CREDENTIALS ?? '1').trim() !== '0';
  if (migrateCreds) {
    await seedCredentialsIfMissing({ cliHomeDir });
  }
  const credentialPaths = resolveStackCredentialPaths({ cliHomeDir, serverUrl: internalServerUrl, env: daemonEnv });
  const mirrored = await ensureServerScopedCredentialsFromLegacy({ cliHomeDir, internalServerUrl, env: daemonEnv });
  if (mirrored.copied) {
    console.log(`[local] migrated daemon credentials to server profile: ${mirrored.source} -> ${mirrored.target}`);
  }
  // Repair: if the active server-scoped access key is stale/unauthorized (common when switching server scope ids),
  // copy a valid fallback credential (url-hash scoped or legacy) into the active server scope before daemon start.
  let tokenSubBeforeRepair = null;
  try {
    const tokenBefore = readAuthTokenFromCredentialFile(credentialPaths.serverScopedPath);
    tokenSubBeforeRepair = tokenBefore ? decodeJwtPayloadUnsafe(tokenBefore)?.sub ?? null : null;
  } catch {
    // best-effort only
  }
  let credentialRepair = null;
  const credentialValidateTimeoutMs = parseNonNegativeInt(baseEnv.HAPPIER_STACK_CREDENTIAL_VALIDATE_TIMEOUT_MS, 2_500);
  try {
    credentialRepair = await ensureActiveAccessKeyValid({
      cliHomeDir,
      serverUrl: internalServerUrl,
      env: daemonEnv,
      timeoutMs: credentialValidateTimeoutMs,
    });
    if (credentialRepair.kind === 'repaired') {
      console.log(`[local] repaired daemon credentials: ${credentialRepair.sourcePath} -> ${credentialRepair.activePath}`);
    }
  } catch {
    // best-effort only; daemon start can still proceed and surface auth errors if any remain.
  }
  if (credentialRepair?.kind === 'unresolved' && credentialRepair.status === 401) {
    let reseedResult = null;
    try {
      reseedResult = await maybeAutoReseedInvalidAuth({
        stackName: resolvedStackName,
        cliHomeDir,
        internalServerUrl,
        env: daemonEnv,
        quiet: true,
      });
    } catch (error) {
      logInvalidDaemonCredentialsGuidance({
        stackName: resolvedStackName,
        cliIdentity: resolvedCliIdentity,
        env: daemonEnv,
      });
      throw error;
    }

    if (!reseedResult?.ok || reseedResult?.skipped) {
      logInvalidDaemonCredentialsGuidance({
        stackName: resolvedStackName,
        cliIdentity: resolvedCliIdentity,
        env: daemonEnv,
        skippedReason: reseedResult?.reason ?? 'unknown',
      });
      throw new Error(`Failed to auto re-seed daemon credentials (${reseedResult?.reason ?? 'unknown'})`);
    }

    console.log(`[local] auth re-seeded from ${reseedResult.seed} before daemon start...`);
    credentialRepair = await ensureActiveAccessKeyValid({
      cliHomeDir,
      serverUrl: internalServerUrl,
      env: daemonEnv,
      timeoutMs: credentialValidateTimeoutMs,
    });
    if (credentialRepair.kind === 'repaired') {
      console.log(`[local] repaired daemon credentials: ${credentialRepair.sourcePath} -> ${credentialRepair.activePath}`);
    }
    if (credentialRepair.kind === 'unresolved' && credentialRepair.status === 401) {
      logInvalidDaemonCredentialsGuidance({
        stackName: resolvedStackName,
        cliIdentity: resolvedCliIdentity,
        env: daemonEnv,
        staleSeed: reseedResult.seed,
      });
      throw new Error('Failed to start daemon (after auth re-seed)');
    }
  }
  try {
    const token = readAuthTokenFromCredentialFile(credentialPaths.serverScopedPath);
    const tokenSub = token ? decodeJwtPayloadUnsafe(token)?.sub ?? null : null;
    const repairedFromSub =
      credentialRepair?.kind === 'repaired'
        ? (decodeJwtPayloadUnsafe(readAuthTokenFromCredentialFile(credentialRepair.sourcePath) ?? '')?.sub ?? null)
        : null;
    console.log(
      formatDaemonAuthScopeDiagnostic({
        activeServerId: daemonEnv.HAPPIER_ACTIVE_SERVER_ID,
        activeCredentialPath: credentialPaths.serverScopedPath,
        tokenSub: tokenSub ? String(tokenSub) : null,
        tokenSubBeforeRepair: tokenSubBeforeRepair ? String(tokenSubBeforeRepair) : null,
        repairedFromPath: credentialRepair?.kind === 'repaired' ? credentialRepair.sourcePath : null,
        repairedFromSub: repairedFromSub ? String(repairedFromSub) : null,
      })
    );
    if (
      tokenSub &&
      tokenSubBeforeRepair &&
      String(tokenSubBeforeRepair) !== String(tokenSub)
    ) {
      const warn = formatDaemonCredentialsTokenSubChangedWarning({ tokenSubBeforeRepair, tokenSub });
      if (warn) console.warn(warn);
    }
  } catch {
    // best-effort only
  }

  const existing = checkDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env: daemonEnv });
  // If a source dist build moved dist/ after the first validation, keep the old daemon.
  if (guardSourceCliDistRestart) {
    const guardedDistIntegrity = readCliDistIntegrity(distEntrypoint);
    if (!guardedDistIntegrity.ok) {
      if (existing.status === 'running' || existing.status === 'starting') {
        console.warn(
          formatCliDistUnavailableForDaemonStart({ distEntrypoint, reason: guardedDistIntegrity.reason }) +
            `[local] Keeping the existing daemon running to avoid downtime.`
        );
        await syncRuntimeDaemonState({ runtimeDaemonPid: existing.pid });
        return;
      }
      throw new Error(formatCliDistUnavailableForDaemonStart({ distEntrypoint, reason: guardedDistIntegrity.reason }));
    }
  } else if (
    distEntrypoint &&
    !existsSync(distEntrypoint) &&
    (existing.status === 'running' || existing.status === 'starting')
  ) {
    console.warn(
      `[local] happier-cli dist entrypoint is missing (${distEntrypoint}).\n` +
        `[local] Refusing to restart daemon to avoid downtime. Rebuild happier-cli first.`
    );
    await syncRuntimeDaemonState({ runtimeDaemonPid: existing.pid });
    return;
  }

  if (!forceRestart && existing.status === 'running') {
    const pid = existing.pid;
    const matches = await daemonEnvMatches({ pid, cliHomeDir, internalServerUrl, publicServerUrl });
    const distRestartReason = resolveDaemonDistRestartReason({
      distEntrypoint,
      distClosure: currentDistClosure,
      runtimeStatePath,
      cliHomeDir,
      serverUrl: internalServerUrl,
      env: daemonEnv,
    });
    if (matches === true) {
      if (distRestartReason) {
        console.warn(`[local] daemon is running with stale runtime; restarting (pid=${pid}).\n[local] ${distRestartReason}`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`[local] daemon already running for stack home (pid=${pid})`);
        if (isTui) {
        // Emit a daemon-labeled line so `hstack tui` can route it to the daemon pane.
        // (The daemon itself logs to cliHomeDir/logs/*-daemon.log.)
        // eslint-disable-next-line no-console
          console.log(`[daemon] already running (pid=${pid})`);
        }
        await syncRuntimeDaemonState({ runtimeDaemonPid: pid, daemonDistFingerprint: currentDistFingerprint });
        return;
      }
    } else if (matches === false) {
      // eslint-disable-next-line no-console
      console.warn(
        `[local] daemon is running but pointed at a different server URL; restarting (pid=${pid}).\n` +
          `[local] expected: ${internalServerUrl}\n`
      );
    } else {
      // unknown: best-effort keep running to avoid killing an unrelated process
      // eslint-disable-next-line no-console
      console.warn(`[local] daemon status is running but could not verify env; not restarting (pid=${pid})`);
      await syncRuntimeDaemonState({ runtimeDaemonPid: pid, daemonDistFingerprint: currentDistFingerprint });
      return;
    }
  }
  if (!forceRestart && existing.status === 'starting') {
    // A lock file without a stable daemon.state.json usually means the daemon never finished starting
    // (common when auth is required but daemon start is non-interactive). Attempt a safe restart.
    // eslint-disable-next-line no-console
    console.warn(`[local] daemon appears stuck starting for stack home (pid=${existing.pid}); restarting...`);
  }

  // Stop any existing daemon for THIS stack home dir.
  try {
    await new Promise((resolve) => {
      const proc = spawnProc('daemon', daemonCommand.command, [...daemonCommand.argsPrefix, 'daemon', 'stop'], daemonEnv, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      proc.on('exit', () => resolve());
    });
  } catch {
    // ignore
  }

  // If state is missing and stop couldn't find it, force-stop the lock PID (otherwise repeated restarts accumulate daemons).
  await killDaemonFromStateFile({ cliHomeDir, serverUrl: internalServerUrl, env: daemonEnv });
  await killDaemonFromLockFile({ cliHomeDir, serverUrl: internalServerUrl, env: daemonEnv });

  // Clean up stale lock/state files that can block daemon start.
  await cleanupStaleDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env: daemonEnv });
  await recordStackRuntimeDaemonPid(runtimeStatePath, null, { daemonDistFingerprint: null }).catch(() => {});

  const startOnce = async () => {
    let resolvedExitCode = null;
    let startOutput = '';
    const startOutputTeePath = join(cliHomeDir, 'logs', `${Date.now()}-pid-${process.pid}-daemon-start-attempt.log`);
    await mkdir(dirname(startOutputTeePath), { recursive: true }).catch(() => {});
    const appendStartOutput = (chunk) => {
      if (!chunk) return;
      startOutput += chunk.toString();
      if (startOutput.length > 16_000) {
        startOutput = startOutput.slice(-16_000);
      }
    };
    const exitPromise = new Promise((resolve) => {
      const proc = spawnProc('daemon', daemonCommand.command, [...daemonCommand.argsPrefix, 'daemon', 'start'], daemonEnv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // In TUI mode, stream the daemon-start output so it routes to the daemon pane.
        // (The background daemon itself still logs to files.)
        silent: !isTui,
        teeFile: startOutputTeePath,
        teeLabel: 'daemon',
      });
      proc.stdout?.on('data', appendStartOutput);
      proc.stderr?.on('data', appendStartOutput);
      proc.on('exit', (code) => {
        resolvedExitCode = code ?? 0;
        resolve(resolvedExitCode);
      });
    });

    // Some launch paths keep the start command itself alive after the daemon is already
    // healthy (for example synchronous start-sync mode). Success must be keyed off stable
    // daemon state, not only the wrapper process exiting.
    const runningStable = await waitForRunningStable();
    if (runningStable) {
      return { ok: true, exitCode: resolvedExitCode, excerpt: null, logPath: null };
    }

    // Give quick failures a brief chance to flush their start output before we classify
    // the failure, but do not block indefinitely for long-lived wrapper processes.
    const startExitSettleGraceMs = 50;
    await Promise.race([exitPromise, delay(startExitSettleGraceMs)]);

    const logPath = getLatestDaemonLogPath(cliHomeDir);
    const excerpt = logPath ? await readLastLines(logPath, 120) : null;
    const teeExcerpt = existsSync(startOutputTeePath) ? await readLastLines(startOutputTeePath, 120).catch(() => null) : null;
    return {
      ok: false,
      exitCode: resolvedExitCode,
      excerpt,
      logPath,
      startOutput: startOutput.trim() || teeExcerpt || null,
    };
  };

  const first = await startOnce();
  if (!first.ok) {
    if (first.excerpt) {
      console.error(`[local] daemon failed to start; last daemon log (${first.logPath}):\n${first.excerpt}`);
    } else {
      console.error('[local] daemon failed to start; no daemon log found');
    }

    if (excerptIndicatesMissingAuth(first.excerpt)) {
      const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY) || allowDaemonWaitForAuthWithoutTty();
      const copyHint = authCopyFromSeedHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity, env: baseEnv });
      const hint =
        `[local] daemon is not authenticated yet (expected on first run).\n` +
        `[local] In another terminal, run:\n` +
        `${authLoginHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity })}\n` +
        (copyHint ? `[local] Or (recommended if main is already logged in):\n${copyHint}\n` : '');
      if (!isInteractive) {
        throw new Error(`${hint}[local] Non-interactive mode: refusing to wait for credentials.`);
      }

      console.error(
        `${hint}[local] Keeping the server running so you can login.\n` +
          `[local] Waiting for credentials at one of:\n` +
          `${credentialPaths.paths.map((p) => `[local] - ${p}`).join('\n')}`
      );

      const ok = await waitForCredentialsFiles({
        paths: credentialPaths.paths,
        timeoutMs: 10 * 60_000,
        isShuttingDown,
      });
      if (!ok) {
        throw new Error('Timed out waiting for daemon credentials (auth login not completed)');
      }
      await ensureServerScopedCredentialsFromLegacy({ cliHomeDir, internalServerUrl });

      // If a daemon start attempt was already in-flight (or a previous daemon is already running),
      // avoid a second concurrent start and treat it as success.
      await delay(500);
      const stateAfterCreds = checkDaemonState(cliHomeDir, { serverUrl: internalServerUrl });
      if (stateAfterCreds.status === 'running' || stateAfterCreds.status === 'starting') {
        await syncRuntimeDaemonState({ runtimeDaemonPid: stateAfterCreds.pid, daemonDistFingerprint: currentDistFingerprint });
        return;
      }

      console.log('[local] credentials detected, retrying daemon start...');
      const second = await startOnce();
      if (!second.ok) {
        if (second.excerpt) {
          console.error(`[local] daemon still failed to start; last daemon log (${second.logPath}):\n${second.excerpt}`);
        }
        throw new Error('Failed to start daemon (after credentials were created)');
      }
    } else if (excerptIndicatesInvalidAuth(first.excerpt)) {
      // Credentials exist but are rejected by this server (common when a stack's env/DB was reset,
      // or credentials were copied from a different stack identity).
      let reseedResult = null;
      try {
        reseedResult = await maybeAutoReseedInvalidAuth({
          stackName: resolvedStackName,
          cliHomeDir,
          internalServerUrl,
          env: baseEnv,
        });
      } catch (e) {
        logInvalidDaemonCredentialsGuidance({
          stackName: resolvedStackName,
          cliIdentity: resolvedCliIdentity,
          env: baseEnv,
        });
        throw e;
      }
      if (!reseedResult?.ok || reseedResult?.skipped) {
        const skippedReason = reseedResult?.reason ?? 'unknown';
        logInvalidDaemonCredentialsGuidance({
          stackName: resolvedStackName,
          cliIdentity: resolvedCliIdentity,
          env: baseEnv,
          skippedReason,
        });
        throw new Error(`Failed to auto re-seed daemon credentials (${skippedReason})`);
      }

      console.log(`[local] auth re-seeded from ${reseedResult.seed}, retrying daemon start...`);
      const second = await startOnce();
      if (!second.ok) {
        if (excerptIndicatesInvalidAuth(second.excerpt)) {
          logInvalidDaemonCredentialsGuidance({
            stackName: resolvedStackName,
            cliIdentity: resolvedCliIdentity,
            env: baseEnv,
            staleSeed: reseedResult.seed,
          });
        }

        if (second.excerpt) {
          console.error(`[local] daemon still failed to start; last daemon log (${second.logPath}):\n${second.excerpt}`);
        }
        throw new Error('Failed to start daemon (after auth re-seed)');
      }
    } else if (excerptIndicatesInstalledServiceConflict(first.startOutput) || excerptIndicatesInstalledServiceConflict(first.excerpt)) {
      if (isTui) {
        // Keep the TUI alive so the daemon pane can continue showing the ownership guidance
        // that the start command already streamed.
        console.log('[daemon] installed background service conflict detected; keeping TUI running.');
        return;
      }

      const recovered = await tryStartInstalledBackgroundServiceFromConflict({
        excerpt: first.startOutput || first.excerpt || '',
        env: daemonEnv,
      });
      if (recovered && await waitForRunningStable()) {
        await syncRuntimeDaemonState({ daemonDistFingerprint: currentDistFingerprint });
        return;
      }

      const conflictExcerpt = first.startOutput || first.excerpt || '';
      const conflictGuidance = extractInstalledServiceConflictGuidance(first.startOutput)
        ?? extractInstalledServiceConflictGuidance(first.excerpt);
      const repairHint = resolveInstalledServiceConflictRepairHint(conflictExcerpt);
      const materializationHint = await resolveInstalledServiceConflictMaterializationHint(conflictExcerpt, { env: daemonEnv });
      if (conflictGuidance || repairHint || materializationHint) {
        const detailLines = [conflictGuidance, repairHint, materializationHint].filter(Boolean);
        throw new Error(
          `Failed to start daemon due to an installed background service conflict.\n${detailLines.join('\n')}`
        );
      }

      throw new Error('Failed to start daemon');
    } else if (isTui && first.exitCode !== 0) {
      const noticeLine = extractFirstDaemonStartNoticeLine(first.startOutput);
      if (noticeLine) {
        console.log(`[daemon] ${noticeLine}`);
      }
      console.log('[daemon] daemon start failed before the relay came up; keeping TUI running.');
      return;
    } else {
      const copyHint = authCopyFromSeedHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity, env: baseEnv });
      console.error(
        `[local] daemon failed to start (server returned an error).\n` +
          `[local] Try:\n` +
          `- hstack doctor\n` +
          (copyHint ? `- ${copyHint}\n` : '') +
          `- ${authLoginHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity })}`
      );
      throw new Error('Failed to start daemon');
    }
  }

  // Confirm daemon status (best-effort)
  try {
    await syncRuntimeDaemonState({ daemonDistFingerprint: currentDistFingerprint });
    await run(daemonCommand.command, [...daemonCommand.argsPrefix, 'daemon', 'status'], { env: daemonEnv, stdio: 'ignore' });
  } catch {
    // ignore
  }
    },
    {
      timeoutMs: daemonLifecycleLockTimeoutMs,
      pollIntervalMs: daemonLifecycleLockPollMs,
    },
  );
  };

  if (guardSourceCliDistRestart) {
    const cliDir = join(dirname(cliBin), '..');
    return await withCliDistBuildLock(runDaemonLifecycleWithResolvedCommand, {
      lockPath: resolveCliDistBuildLockPath(cliDir),
    });
  }

  return await runDaemonLifecycleWithResolvedCommand();
}

export async function daemonStatusSummary({
  cliBin,
  cliEntrypoint = '',
  cliNodeEntrypoint = '',
  cliCommand = '',
  cliCommandArgs = [],
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  env = process.env,
  stackName = null,
  cliIdentity = null,
}) {
  const daemonEnv = getDaemonEnv({
    baseEnv: env,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    stackName,
    cliIdentity,
  });
  const distEntrypoint = resolveDaemonStatusLoadTarget({ cliBin, cliEntrypoint, cliNodeEntrypoint, cliCommand });
  const explicitRuntimeLaunch = resolveExplicitRuntimeLaunchValidation({ cliEntrypoint, cliNodeEntrypoint, cliCommand });
  if (!explicitRuntimeLaunch.ok) {
    return buildRuntimeMissingStatusFallback({
      cliHomeDir,
      internalServerUrl,
      env: daemonEnv,
      missingPath: explicitRuntimeLaunch.path,
    });
  }
  const daemonCommand = resolveDaemonCommandSpec({ cliBin, cliEntrypoint, cliNodeEntrypoint, cliCommand, cliCommandArgs, env: daemonEnv });
  try {
    return await runCapture(daemonCommand.command, [...daemonCommand.argsPrefix, 'daemon', 'status'], { env: daemonEnv });
  } catch (error) {
    if (isMissingDistStatusError({ error, distEntrypoint })) {
      return buildDistMissingStatusFallback({
        cliHomeDir,
        internalServerUrl,
        env: daemonEnv,
        distEntrypoint,
      });
    }
    throw error;
  }
}

function resolveDaemonStatusLoadTarget({ cliBin, cliEntrypoint = '', cliNodeEntrypoint = '', cliCommand = '' }) {
  const explicitNodeEntrypoint = String(cliNodeEntrypoint ?? '').trim();
  if (explicitNodeEntrypoint) return explicitNodeEntrypoint;

  const explicitEntrypoint = String(cliEntrypoint ?? '').trim();
  if (explicitEntrypoint) return explicitEntrypoint;

  const distEntrypoint = resolveCliDistEntrypointFromBin(cliBin);
  if (distEntrypoint) return distEntrypoint;

  return String(cliCommand ?? '').trim();
}

function isMissingDistStatusError({ error, distEntrypoint }) {
  const text = [String(error?.message ?? error ?? ''), String(error?.err ?? ''), String(error?.out ?? '')]
    .filter(Boolean)
    .join('\n');
  const loadFailureMarkers = [
    'MODULE_NOT_FOUND',
    'ERR_MODULE_NOT_FOUND',
    'does not provide an export named',
    'Cannot find module',
  ];
  if (!loadFailureMarkers.some((marker) => text.includes(marker))) return false;
  if (distEntrypoint && text.includes(distEntrypoint)) return true;
  return text.includes('/dist/index.mjs') || text.includes('/package-dist/index.mjs');
}

function buildDistMissingStatusFallback({ cliHomeDir, internalServerUrl, env, distEntrypoint }) {
  const state = checkDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env });
  const { statePath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl: internalServerUrl, env });

  let stateData = null;
  try {
    if (existsSync(statePath)) {
      stateData = JSON.parse(readFileSync(statePath, 'utf-8'));
    }
  } catch {
    stateData = null;
  }

  const statusLine =
    state.status === 'running'
      ? '✓ Daemon is running'
      : state.status === 'starting'
        ? '⚠ Daemon is starting'
        : '❌ Daemon is not running';

  const redactedState =
    stateData && typeof stateData === 'object'
      ? {
          ...stateData,
          ...(Object.prototype.hasOwnProperty.call(stateData, 'controlToken') ? { controlToken: '<redacted>' } : {}),
        }
      : null;

  const lines = [
    '🩺 Happier CLI Doctor',
    '',
    '',
    '🤖 Daemon Status',
    statusLine,
  ];

  const pid = Number(stateData?.pid ?? state?.pid);
  if (Number.isFinite(pid) && pid > 0) {
    lines.push(`  PID: ${pid}`);
  }
  const startedAtRaw = stateData?.startedAt;
  const startedAtNum =
    typeof startedAtRaw === 'string'
      ? (() => {
          const trimmed = startedAtRaw.trim();
          const asNumber = Number(trimmed);
          if (Number.isFinite(asNumber)) return asNumber;
          return Date.parse(trimmed);
        })()
      : Number(startedAtRaw);
  if (Number.isFinite(startedAtNum) && startedAtNum > 0) {
    lines.push(`  Started: ${new Date(startedAtNum).toLocaleString()}`);
  }
  if (typeof stateData?.startedWithCliVersion === 'string' && stateData.startedWithCliVersion.trim()) {
    lines.push(`  CLI Version: ${stateData.startedWithCliVersion}`);
  }
  const httpPort = Number(stateData?.httpPort);
  if (Number.isFinite(httpPort) && httpPort > 0) {
    lines.push(`  HTTP Port: ${httpPort}`);
  }

  lines.push('');
  lines.push('📄 Daemon State:');
  lines.push(`Location: ${statePath}`);
  lines.push(redactedState ? JSON.stringify(redactedState, null, 2) : '(missing or unreadable)');
  lines.push('');
  lines.push(`ℹ️ Fallback status used because CLI dist entrypoint is missing: ${distEntrypoint ?? 'unknown'}`);
  lines.push('');
  lines.push('✅ Doctor diagnosis complete!');
  return lines.join('\n');
}

function buildRuntimeMissingStatusFallback({ cliHomeDir, internalServerUrl, env, missingPath }) {
  const fallback = buildDistMissingStatusFallback({
    cliHomeDir,
    internalServerUrl,
    env,
    distEntrypoint: missingPath,
  });
  return `${fallback}\n[runtime] active runtime launch path is missing: ${missingPath}`;
}
