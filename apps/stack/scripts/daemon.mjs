import { killProcessTree, spawnProc, run, runCapture } from './utils/proc/proc.mjs';
import { resolveAuthSeedFromEnv, resolveAutoCopyFromMainEnabled } from './utils/stack/startup.mjs';
import { coerceHappyMonorepoRootFromPath, getStacksStorageRoot } from './utils/paths/paths.mjs';
import { readLastLines } from './utils/fs/tail.mjs';
import { ensureCliBuilt, isCliDistBuildLockActive } from './utils/proc/pm.mjs';
import { resolveJavaScriptRuntimeCommand } from '@happier-dev/cli-common/agents/managedJavaScriptRuntime';
import { readCliNodeWorkspaceRuntimeIdentity } from '@happier-dev/cli-common/componentArtifacts/copyCliNodeRuntimePayload';
import { resolveNewestReadyPinnedRunnerSnapshot } from './utils/cli/pinnedRunnerSnapshotLoader.mjs';
import {
  findAnyCredentialPathInCliHome,
  findExistingStackCredentialPath,
  resolvePreferredStackDaemonStatePaths,
  resolveStackDaemonStatePaths,
  resolveStackCredentialPaths,
} from './utils/auth/credentials_paths.mjs';
import { ensureActiveAccessKeyValid } from './utils/auth/ensure_active_access_key_valid.mjs';
import { decodeJwtPayloadUnsafe } from './utils/auth/decode_jwt_payload_unsafe.mjs';
import { formatDaemonAuthScopeDiagnostic, formatDaemonCredentialsTokenSubChangedWarning } from './utils/auth/format_daemon_auth_scope_diagnostic.mjs';
import { applyStackActiveServerScopeEnv, applyStackDaemonLifecycleScopeEnv } from './utils/auth/stable_scope_id.mjs';
import { resolveReusableAuthSeedCandidates, resolveReusableAuthSeedSource } from './utils/auth/sources.mjs';
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getComponentDir, getRootDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { parseEnvToObject } from './utils/env/dotenv.mjs';
import { ensureEnvFileUpdated } from './utils/env/env_file.mjs';
import { getCliHomeDirFromEnvOrDefault } from './utils/stack/dirs.mjs';
import {
  isCliDirectExecutableCommand,
  probeCliDistRuntimeImport,
  readCliDistBuildManifest,
  readCliDistIntegrity,
  resolveCliDistEntrypointFromBin,
} from './utils/cli/cliDistIntegrity.mjs';
import { withStackDaemonLifecycleLock } from './utils/stack/daemon_lifecycle_lock.mjs';
import {
  resolveCliDistBuildLockPath,
  withCliDistBuildLock,
} from './utils/proc/cliDistBuildLock.mjs';
import { recordStackRuntimeDaemonPid, syncStackRuntimeDaemonPidFromDaemonState } from './utils/stack/runtime_daemon_state.mjs';
import {
  getStackRuntimeProcessInstanceFingerprint,
  readStackRuntimeStateFile,
} from './utils/stack/runtime_state.mjs';
import { killPidOwnedByStack } from './utils/proc/ownership.mjs';
import { pingDaemon } from './utils/stack/daemonControlClient.mjs';

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

function readSourceCliWorkspaceRuntimeReadiness({
  distEntrypoint,
  repoRoot,
  readCliWorkspaceRuntimeIdentityImpl = readCliNodeWorkspaceRuntimeIdentity,
}) {
  if (!repoRoot) return { current: true, reason: 'not-source-monorepo' };
  const distClosure = readCliDistBuildManifest(distEntrypoint);
  const expectedFingerprint = String(
    distClosure.manifest?.workspaceRuntimeIdentity ?? '',
  ).trim().toLowerCase();
  if (!expectedFingerprint) return { current: true, reason: 'no-workspace-runtime' };
  if (!/^[a-f0-9]{64}$/.test(expectedFingerprint)) {
    return { current: false, reason: 'workspace_runtime_unavailable' };
  }
  try {
    const actualFingerprint = String(
      readCliWorkspaceRuntimeIdentityImpl({ repoRoot })?.fingerprint ?? '',
    ).trim().toLowerCase();
    return actualFingerprint === expectedFingerprint
      ? { current: true, reason: 'workspace-runtime-current' }
      : { current: false, reason: 'workspace_runtime_unavailable' };
  } catch {
    return { current: false, reason: 'workspace_runtime_unavailable' };
  }
}

function assertSourceCliWorkspaceRuntimeStillCurrent({ cliBin, distEntrypoint }) {
  const workspaceRuntimeReadiness = readSourceCliWorkspaceRuntimeReadiness({
    distEntrypoint,
    repoRoot: coerceHappyMonorepoRootFromPath(
      resolveCliDistOwnerDirForDaemonLaunch({ cliBin, distEntrypoint }),
    ),
  });
  if (workspaceRuntimeReadiness.current) return;
  const error = new Error(
    '[local] happier-cli workspace runtime closure changed after source generation admission; refusing to launch a different generation.',
  );
  error.code = 'ECLIDISTSTALECOLDSTART';
  throw error;
}

export function applyDaemonDistClosureRuntimeEnv(env, {
  runtimeStatePath = '',
  distEntrypoint = '',
  distClosureFingerprint = null,
  runtimeBacked = false,
} = {}) {
  const fingerprint = String(distClosureFingerprint ?? '').trim();
  const entrypoint = String(distEntrypoint ?? '').trim();
  const statePath = String(runtimeStatePath ?? '').trim();
  if (!fingerprint || !entrypoint || !statePath) {
    delete env.HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH;
    delete env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT;
    delete env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT;
    delete env.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED;
    return env;
  }
  env.HAPPIER_CLI_SUBPROCESS_STACK_RUNTIME_STATE_PATH = statePath;
  env.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT = entrypoint;
  env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT = fingerprint;
  if (runtimeBacked === true) {
    env.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED = '1';
  } else {
    delete env.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED;
  }
  return env;
}

export function isGuardedSourceCliDistEntrypoint({ cliBin, cliEntrypoint = '', cliNodeEntrypoint = '', cliCommand = '', distEntrypoint = '', activeCliDir = null }) {
  if (String(cliCommand ?? '').trim()) return false;
  if (String(cliEntrypoint ?? '').trim()) return false;
  if (String(cliNodeEntrypoint ?? '').trim()) return false;
  if (isCliDirectExecutableCommand(cliBin)) return false;
  const entrypoint = String(distEntrypoint ?? '').trim();
  if (!entrypoint) return false;
  const entrypointPath = resolve(entrypoint);
  const cliBinDistPath = resolve(join(dirname(cliBin), '..', 'dist', 'index.mjs'));
  const activeDistPath = activeCliDir ? resolve(resolveActiveCliDistEntrypoint(activeCliDir)) : '';
  if (entrypointPath !== cliBinDistPath && (!activeDistPath || entrypointPath !== activeDistPath)) return false;
  return resolveGuardedLocalCliDistEntrypoint({ cliBin, distEntrypoint: entrypoint, activeCliDir }).ok;
}

function canonicalizePathForContainment(pathLike) {
  const resolvedPath = resolve(String(pathLike ?? ''));
  if (!resolvedPath) return '';

  let existingAncestor = resolvedPath;
  const missingSegments = [];
  while (true) {
    try {
      return resolve(realpathSync.native(existingAncestor), ...missingSegments.reverse());
    } catch {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) return resolvedPath;
      missingSegments.push(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
}

function isPathInsideDir(pathLike, dirLike) {
  const target = canonicalizePathForContainment(pathLike);
  const dir = canonicalizePathForContainment(dirLike);
  if (!target || !dir) return false;
  const rel = relative(dir, target);
  return isContainedRelativePath(rel);
}

function isPathLexicallyInsideDir(pathLike, dirLike) {
  const target = resolve(String(pathLike ?? ''));
  const dir = resolve(String(dirLike ?? ''));
  if (!target || !dir) return false;
  const rel = relative(dir, target);
  return isContainedRelativePath(rel);
}

function isContainedRelativePath(rel) {
  const driveRooted = /^[a-zA-Z]:[\\/]/.test(rel);
  return rel === '' || Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel) && !driveRooted && !rel.startsWith('/') && !rel.startsWith('\\'));
}

function resolveActiveCliDirForDaemonLaunch(env = process.env) {
  const repoDir = String(env?.HAPPIER_STACK_REPO_DIR ?? '').trim();
  const cliRootDir = String(env?.HAPPIER_STACK_CLI_ROOT_DIR ?? '').trim();
  if (!repoDir && !cliRootDir) return null;
  try {
    const rootDir = getRootDir(import.meta.url);
    if (repoDir) return getComponentDir(rootDir, 'happier-cli', env);
    const monorepoRoot = coerceHappyMonorepoRootFromPath(cliRootDir);
    if (!monorepoRoot) return null;
    return getComponentDir(rootDir, 'happier-cli', {
      ...env,
      HAPPIER_STACK_REPO_DIR: monorepoRoot,
    });
  } catch {
    return null;
  }
}

export function resolveGuardedLocalCliDistEntrypoint({
  cliBin,
  distEntrypoint = null,
  activeCliDir = null,
} = {}) {
  const resolvedDistEntrypoint = String(distEntrypoint ?? resolveCliDistEntrypointFromBin(cliBin) ?? '').trim();
  if (!resolvedDistEntrypoint) {
    return { ok: false, distEntrypoint: null, reason: 'unknown_cli_bin' };
  }

  const activeDir = String(activeCliDir ?? '').trim();
  if (activeDir && !isPathInsideDir(resolvedDistEntrypoint, activeDir)) {
    return {
      ok: false,
      distEntrypoint: resolvedDistEntrypoint,
      reason: `outside_active_cli_dir:${resolvedDistEntrypoint}:${activeDir}`,
    };
  }

  return { ok: true, distEntrypoint: resolvedDistEntrypoint, reason: 'active_cli_dist' };
}

function resolveActiveCliDistEntrypoint(activeCliDir) {
  const activeDir = String(activeCliDir ?? '').trim();
  if (!activeDir) return null;
  return join(activeDir, 'dist', 'index.mjs');
}

export function resolveGuardedLocalCliDistSelection({ cliBin, activeCliDir = null } = {}) {
  const guardedDist = resolveGuardedLocalCliDistEntrypoint({ cliBin, activeCliDir });
  const activeDist = resolveGuardedLocalCliDistEntrypoint({
    distEntrypoint: resolveActiveCliDistEntrypoint(activeCliDir),
    activeCliDir,
  });
  if (
    guardedDist.ok &&
    activeCliDir &&
    !isPathLexicallyInsideDir(guardedDist.distEntrypoint, activeCliDir) &&
    activeDist.ok
  ) {
    return {
      guardedDist,
      activeDist,
      resolvedDist: activeDist,
    };
  }
  return {
    guardedDist,
    activeDist: guardedDist.ok ? null : activeDist,
    resolvedDist: guardedDist.ok ? guardedDist : activeDist,
  };
}

function resolveCliDistOwnerDirForDaemonLaunch({ cliBin, distEntrypoint = '' } = {}) {
  const resolvedDistEntrypoint = String(distEntrypoint ?? '').trim();
  return resolvedDistEntrypoint
    ? dirname(dirname(resolvedDistEntrypoint))
    : join(dirname(cliBin), '..');
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
    (normalizedReason.startsWith('outside_active_cli_dir:')
      ? `[local] The resolved dist entrypoint is outside the active stack repo/worktree.\n`
      : '') +
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
  const repoRoot = coerceHappyMonorepoRootFromPath(cliDir);
  const lockPath = repoRoot
    ? resolveCliDistBuildLockPath(repoRoot)
    : join(cliDir, '.dist.hstack-build.lock');
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

export async function checkDaemonStatePingAware(cliHomeDir, options = {}) {
  const state = checkDaemonState(cliHomeDir, options);
  if (state.status !== 'running') return state;

  const serverUrl = resolveServerUrlFromOptions(options);
  const env = resolveEnvFromOptions(options);
  const ping = await pingDaemon({
    cliHomeDir,
    serverUrl,
    env,
    stackName: options?.stackName ?? null,
    timeoutMs: options.pingTimeoutMs ?? 1500,
  });
  if (ping.ok === true) {
    return {
      status: 'running',
      pid: Number(ping.pid) || state.pid,
      processInstanceFingerprint: ping.processInstanceFingerprint ?? null,
      distClosureFingerprint: ping.distClosureFingerprint ?? null,
    };
  }
  return {
    status: 'unreachable',
    pid: Number(ping.pid) || state.pid,
    reason: String(ping.reason ?? 'ping_failed'),
  };
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

export function resolveDaemonDistRestartReason({
  distEntrypoint = '',
  distClosure = null,
  runtimeStatePath = '',
  observedDaemonDistFingerprint = undefined,
  runtimeBacked = false,
  cliHomeDir,
  serverUrl = '',
  env = process.env,
}) {
  const entrypoint = String(distEntrypoint ?? '').trim();
  if (!entrypoint || !distClosure?.ok || !distClosure?.fingerprint) {
    return null;
  }
  const admittedFingerprint = String(distClosure.fingerprint).trim().toLowerCase();
  const observedFingerprint = String(observedDaemonDistFingerprint ?? '').trim().toLowerCase();
  if (runtimeBacked === true) {
    if (!/^[a-f0-9]{16}$/.test(observedFingerprint)) {
      return `runtime-backed daemon is missing a valid authenticated dist closure fingerprint (${entrypoint})`;
    }
    return observedFingerprint === admittedFingerprint
      ? null
      : `runtime-backed daemon reports a different authenticated dist closure fingerprint (${entrypoint})`;
  }
  try {
    const runtimeState = JSON.parse(readFileSync(runtimeStatePath, 'utf-8'));
    const recordedFingerprint = String(runtimeState?.daemon?.distClosureFingerprint ?? '').trim();
    if (recordedFingerprint && recordedFingerprint !== distClosure.fingerprint) {
      return `source dist closure fingerprint changed after daemon start (${entrypoint})`;
    }
  } catch {
    // Older runtime state files do not record a dist fingerprint.
  }
  return null;
}

export function assertFinalSourceDaemonDistAdmission({
  admittedDistClosureFingerprint = null,
  finalFingerprint = null,
} = {}) {
  const explicitFingerprint = String(admittedDistClosureFingerprint ?? '').trim().toLowerCase();
  const observedFinalFingerprint = String(finalFingerprint ?? '').trim().toLowerCase();
  if (
    explicitFingerprint
    && (
      !/^[a-f0-9]{16}$/.test(explicitFingerprint)
      || observedFinalFingerprint !== explicitFingerprint
    )
  ) {
    const error = new Error(
      '[local] happier-cli dist changed after source generation admission; refusing to launch a different generation.',
    );
    error.code = 'ECLIDISTSTALECOLDSTART';
    throw error;
  }
  return /^[a-f0-9]{16}$/.test(observedFinalFingerprint)
    ? observedFinalFingerprint
    : null;
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

const parseNonNegativeInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

export const DEFAULT_STACK_DAEMON_START_VERIFY_TIMEOUT_MS = 120_000;
const PRIOR_DIST_PUBLICATION_RETRY_DELAYS_MS = [25, 50, 100, 200];

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveStackDaemonStartVerifyTimeoutMs(env = process.env) {
  return parseNonNegativeInt(
    env?.HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS,
    DEFAULT_STACK_DAEMON_START_VERIFY_TIMEOUT_MS,
  );
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

export function matchDaemonEnvLine({ line, cliHomeDir, internalServerUrl, publicServerUrl }) {
  const raw = String(line ?? '');
  if (!raw) return null;
  const home = String(cliHomeDir ?? '').trim();
  const server = String(internalServerUrl ?? '').trim();
  const web = String(publicServerUrl ?? '').trim();
  const backgroundServiceOwned = raw.includes('HAPPIER_DAEMON_STARTUP_SOURCE=background-service');
  const daemonServerUrlPresent = raw.includes('HAPPIER_SERVER_URL=');
  const daemonWebappUrlPresent = raw.includes('HAPPIER_WEBAPP_URL=');

  // Must be for the same stack home dir.
  if (home && !raw.includes(`HAPPIER_HOME_DIR=${home}`)) {
    return { matches: false, reason: 'home', key: 'HAPPIER_HOME_DIR', expected: home };
  }
  // If we have a desired server URL, require it (prevents ephemeral port mismatches).
  if (
    server
    && !raw.includes(`HAPPIER_SERVER_URL=${server}`)
    && (!backgroundServiceOwned || daemonServerUrlPresent)
  ) {
    return { matches: false, reason: 'server', key: 'HAPPIER_SERVER_URL', expected: server };
  }
  // Public URL mismatch is less fatal, but prefer it stable too when provided.
  if (
    web
    && !raw.includes(`HAPPIER_WEBAPP_URL=${web}`)
    && (!backgroundServiceOwned || daemonWebappUrlPresent)
  ) {
    return { matches: false, reason: 'webapp', key: 'HAPPIER_WEBAPP_URL', expected: web };
  }
  return { matches: true };
}

async function readDaemonEnvMatch({ pid, cliHomeDir, internalServerUrl, publicServerUrl }) {
  const line = await readDaemonPsEnv(pid);
  if (!line) return null; // unknown
  return matchDaemonEnvLine({ line, cliHomeDir, internalServerUrl, publicServerUrl });
}

async function daemonEnvMatches({ pid, cliHomeDir, internalServerUrl, publicServerUrl }) {
  const match = await readDaemonEnvMatch({ pid, cliHomeDir, internalServerUrl, publicServerUrl });
  return match ? match.matches === true : null;
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
  activeCliDir = resolveActiveCliDirForDaemonLaunch(env),
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
  const { guardedDist, activeDist, resolvedDist } = resolveGuardedLocalCliDistSelection({ cliBin, activeCliDir });
  const distEntrypoint = resolvedDist?.ok ? resolvedDist.distEntrypoint : null;
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
  if (!guardedDist.ok && activeCliDir) {
    const reason = activeDist?.reason?.startsWith('outside_active_cli_dir:')
      ? activeDist.reason
      : guardedDist.reason;
    throw new Error(formatCliDistUnavailableForDaemonStart({
      distEntrypoint: activeDist?.distEntrypoint ?? guardedDist.distEntrypoint,
      reason,
    }));
  }
  return {
    command: process.execPath,
    argsPrefix: [cliBin],
    mode: 'node',
  };
}

export async function ensureHappierCliDistExists(
  {
    cliBin,
    cliEntrypoint = '',
    cliNodeEntrypoint = '',
    cliCommand = '',
    admittedDistClosureFingerprint = null,
    admitPriorDistImmediately = false,
    env = process.env,
  },
  {
    ensureCliBuiltImpl = ensureCliBuilt,
    probeCliDistRuntimeImportImpl = probeCliDistRuntimeImport,
    sleepImpl = sleepMs,
    readCliWorkspaceRuntimeIdentityImpl = readCliNodeWorkspaceRuntimeIdentity,
    resolveNewestReadyPinnedSnapshotLocationImpl = resolveNewestReadyPinnedRunnerSnapshot,
  } = {},
) {
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
  const activeCliDir = resolveActiveCliDirForDaemonLaunch(env);
  const { guardedDist, activeDist, resolvedDist } = resolveGuardedLocalCliDistSelection({ cliBin, activeCliDir });
  if (!resolvedDist?.ok) {
    const reason = activeDist?.reason?.startsWith('outside_active_cli_dir:')
      ? activeDist.reason
      : guardedDist.reason;
    return {
      ok: false,
      distEntrypoint: activeDist?.distEntrypoint ?? guardedDist.distEntrypoint,
      built: false,
      reason,
    };
  }
  const distEntrypoint = resolvedDist.distEntrypoint;
  const cliDir = resolveCliDistOwnerDirForDaemonLaunch({ cliBin, distEntrypoint });
  const sourceRepoRoot = coerceHappyMonorepoRootFromPath(cliDir);
  const buildCli =
    (env.HAPPIER_STACK_CLI_BUILD ?? process.env.HAPPIER_STACK_CLI_BUILD ?? '1').toString().trim() !== '0';

  const readIntegrity = () => readCliDistIntegrity(distEntrypoint);
  const readWorkspaceRuntimeReadiness = () => readSourceCliWorkspaceRuntimeReadiness({
    distEntrypoint,
    repoRoot: sourceRepoRoot,
    readCliWorkspaceRuntimeIdentityImpl,
  });

  if (activeCliDir) {
    const admittedFingerprint = String(admittedDistClosureFingerprint ?? '').trim().toLowerCase();
    if (admittedFingerprint) {
      const integrity = readIntegrity();
      const exactAdmission =
        /^[a-f0-9]{16}$/.test(admittedFingerprint)
        && integrity.ok === true
        && integrity.fingerprint === admittedFingerprint;
      return {
        ok: integrity.ok,
        current: exactAdmission,
        generationAdmissionRequired: true,
        distEntrypoint,
        built: false,
        reason: exactAdmission
          ? 'admitted-dist-closure'
          : `admitted_dist_mismatch:${integrity.reason ?? 'unknown'}`,
      };
    }
    let priorIntegrity = readIntegrity();
    if (admitPriorDistImmediately && !priorIntegrity.ok) {
      for (const delayMs of PRIOR_DIST_PUBLICATION_RETRY_DELAYS_MS) {
        await sleepImpl(delayMs);
        priorIntegrity = readIntegrity();
        if (priorIntegrity.ok) break;
      }
    }
    const priorReleaseBackupIntegrity = priorIntegrity.ok
      ? null
      : readCliDistIntegrity(join(cliDir, '.dist.hstack-backup', 'index.mjs'));
    const priorFallbackIntegrity = priorIntegrity.ok
      ? priorIntegrity
      : priorReleaseBackupIntegrity;
    if (admitPriorDistImmediately && priorIntegrity.ok && readWorkspaceRuntimeReadiness().current) {
      try {
        await probeCliDistRuntimeImportImpl(distEntrypoint, {
          cwd: cliDir,
          env,
          timeoutMs: resolveStackDaemonStartVerifyTimeoutMs(env),
        });
        if (readWorkspaceRuntimeReadiness().current) {
          return {
            ok: true,
            current: true,
            degraded: true,
            fallbackFingerprint: priorIntegrity.fingerprint,
            fallbackRejectedReason: null,
            generationAdmissionRequired: true,
            distEntrypoint,
            built: false,
            reason: 'admitted-prior-dist-for-watch-startup',
          };
        }
        // The source workspace payload advanced while the asynchronous probe was running.
        // Re-enter the canonical publisher rather than admitting a no-longer-current closure.
      } catch {
        // The prior publication is not runnable. Fall through to canonical freshness
        // admission, which may repair it before the daemon is allowed to start.
      }
    }
    if (admitPriorDistImmediately) {
      const pinnedRunner = resolveNewestReadyPinnedSnapshotLocationImpl(distEntrypoint);
      if (pinnedRunner?.snapshotEntrypoint && pinnedRunner?.fingerprint) {
        try {
          await probeCliDistRuntimeImportImpl(pinnedRunner.snapshotEntrypoint, {
            cwd: cliDir,
            env,
            timeoutMs: resolveStackDaemonStartVerifyTimeoutMs(env),
          });
          return {
            ok: true,
            current: true,
            degraded: true,
            immutableRunner: true,
            fallbackFingerprint: pinnedRunner.fingerprint,
            fallbackRejectedReason: null,
            generationAdmissionRequired: true,
            distEntrypoint: pinnedRunner.snapshotEntrypoint,
            built: false,
            reason: 'admitted-pinned-runner-for-watch-startup',
          };
        } catch {
          // A ready marker is necessary but the import probe is the final cold-start
          // admission. Fall through to the normal publisher when the snapshot cannot run.
        }
      }
    }
    let buildResult = null;
    let buildError = null;
    try {
      buildResult = await ensureCliBuiltImpl(cliDir, { buildCli, env });
    } catch (error) {
      buildError = error;
    }
    let integrity = readIntegrity();
    if (!buildCli && !integrity.ok) {
      try {
        buildResult = await ensureCliBuiltImpl(cliDir, { buildCli: true, env });
        buildError = null;
      } catch (error) {
        buildError = error;
      }
      integrity = readIntegrity();
    }
    const workspaceRuntimeReadiness = readWorkspaceRuntimeReadiness();
    const workspaceRuntimeCurrent = workspaceRuntimeReadiness.current === true;
    const current = buildResult?.current === true && workspaceRuntimeCurrent;
    const reason = buildError
      ? `build_failed:${String(buildError?.message ?? buildError)}`
      : workspaceRuntimeCurrent
        ? String(buildResult?.reason ?? integrity.reason ?? 'unknown')
        : workspaceRuntimeReadiness.reason;
    let degraded = false;
    let fallbackFingerprint = null;
    let fallbackRejectedReason = null;
    if (buildError) {
      if (!workspaceRuntimeCurrent) {
        fallbackRejectedReason = workspaceRuntimeReadiness.reason;
      } else if (priorFallbackIntegrity?.ok !== true) {
        fallbackRejectedReason = 'no_usable_prior_dist';
      } else if (integrity.ok !== true) {
        fallbackRejectedReason = 'dist_invalid_after_failed_build';
      } else if (integrity.fingerprint !== priorFallbackIntegrity.fingerprint) {
        fallbackRejectedReason = 'dist_identity_changed_during_failed_build';
      } else {
        try {
          await probeCliDistRuntimeImportImpl(distEntrypoint, {
            cwd: cliDir,
            env,
            timeoutMs: resolveStackDaemonStartVerifyTimeoutMs(env),
          });
          degraded = true;
          fallbackFingerprint = integrity.fingerprint;
        } catch (error) {
          fallbackRejectedReason = `runtime_probe_failed:${String(error?.message ?? error)}`;
        }
      }
    } else if (!current && integrity.ok === true && workspaceRuntimeCurrent) {
      if (buildResult?.built === true) {
        // ensureCliBuilt only reports a successful build after validating the atomically
        // published daemon command closure. Later edits affect freshness, not runnability.
        degraded = true;
        fallbackFingerprint = integrity.fingerprint;
      } else {
        try {
          await probeCliDistRuntimeImportImpl(distEntrypoint, {
            cwd: cliDir,
            env,
            timeoutMs: resolveStackDaemonStartVerifyTimeoutMs(env),
          });
          degraded = true;
          fallbackFingerprint = integrity.fingerprint;
        } catch (error) {
          fallbackRejectedReason = `runtime_probe_failed:${String(error?.message ?? error)}`;
        }
      }
    }
    return {
      ok: integrity.ok && workspaceRuntimeCurrent,
      current: integrity.ok && current,
      degraded,
      fallbackFingerprint,
      fallbackRejectedReason,
      generationAdmissionRequired: true,
      distEntrypoint,
      built: Boolean(buildResult?.built),
      reason,
    };
  }

  // Fast path: if dist exists and import graph is complete, never trigger rebuild here.
  // Rebuilding inside daemon restart can race with live restarts and transiently remove dist/.
  const before = readIntegrity();
  if (before.ok) {
    return { ok: true, current: true, distEntrypoint, built: false, reason: before.reason };
  }

  const concurrentBuildReady = await waitForConcurrentCliDistBuild({
    cliDir,
    readIntegrity,
  });
  if (concurrentBuildReady?.ok) {
    return {
      ok: true,
      current: true,
      distEntrypoint,
      built: false,
      reason: concurrentBuildReady.reason,
    };
  }

  // Try to recover automatically: missing dist is a common first-run worktree issue.
  // Build in-place using the checkout that owns the resolved dist entrypoint.
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
      current: true,
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
  const sourceScopedEnv = applyStackActiveServerScopeEnv({
    env: { ...env },
    stackName: seed,
    cliIdentity: 'default',
  });
  const sourceCredentialPath =
    findExistingStackCredentialPath({
      cliHomeDir: sourceCliHomeDir,
      serverUrl: internalServerUrl,
      env: sourceScopedEnv,
    }) ??
    findAnyCredentialPathInCliHome({ cliHomeDir: sourceCliHomeDir });
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

async function seedCredentialsIfMissing({ cliHomeDir, internalServerUrl, env = process.env }) {
  const stacksRoot = getStacksStorageRoot(env);

  const sources = [
    // New layout: main stack credentials (preferred).
    { stackName: 'main', cliHomeDir: join(stacksRoot, 'main', 'cli') },
  ];

  const copyIfMissing = async ({ relPath, mode, label }) => {
    const target = join(cliHomeDir, relPath);
    if (existsSync(target)) {
      return { copied: false, source: null, target };
    }
    const source = sources
      .map(({ cliHomeDir: sourceCliHomeDir }) => join(sourceCliHomeDir, relPath))
      .find((candidate) => existsSync(candidate));
    if (!source) {
      return { copied: false, source: null, target };
    }
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
    const existingCredentialForServer = findExistingStackCredentialPath({
      cliHomeDir,
      serverUrl: internalServerUrl,
      env,
    });
    if (existingCredentialForServer) {
      return { copied: false, source: null, target };
    }
    const source = sources
      .map(({ stackName, cliHomeDir: sourceCliHomeDir }) => {
        const sourceScopedEnv = applyStackActiveServerScopeEnv({
          env: { ...env },
          stackName,
          cliIdentity: 'default',
        });
        return findExistingStackCredentialPath({
          cliHomeDir: sourceCliHomeDir,
          serverUrl: internalServerUrl,
          env: sourceScopedEnv,
        }) ?? findAnyCredentialPathInCliHome({ cliHomeDir: sourceCliHomeDir });
      })
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

async function killDaemonPidSafely({
  pid,
  cliHomeDir,
  serverUrl = '',
  env = process.env,
  sourcePath = '',
  sourceLabel = 'state file',
  processInstanceFingerprint = null,
}) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  const terminated = await killPidOwnedByStack(pid, {
    stackName: String(env?.HAPPIER_STACK_STACK ?? '').trim(),
    envPath: String(env?.HAPPIER_STACK_ENV_FILE ?? '').trim(),
    cliHomeDir,
    label: `daemon from ${sourceLabel}`,
    json: true,
    signal: 'SIGTERM',
    graceMs: 500,
    processInstanceFingerprint,
  });
  if (!terminated.killed) {
    console.warn(
      `[local] refusing to kill pid ${pid} from ${sourceLabel} (${terminated.reason ?? 'ownership or termination was not proven'})`
    );
    return false;
  }
  if (terminated.reason === 'already_exited') return false;
  console.log(`[local] killed stuck daemon pid ${pid} (from ${sourcePath || sourceLabel})`);
  return true;
}

async function readRuntimeDaemonProcessInstance(runtimeStatePath, pid) {
  const statePath = String(runtimeStatePath ?? '').trim();
  if (!statePath) return null;
  const runtimeState = await readStackRuntimeStateFile(statePath).catch(() => null);
  return getStackRuntimeProcessInstanceFingerprint(runtimeState, 'daemonPid', pid)
    ?? getStackRuntimeProcessInstanceFingerprint(runtimeState, 'daemonPids', pid);
}

async function killDaemonFromStateFile({
  cliHomeDir,
  serverUrl = '',
  env = process.env,
  runtimeStatePath = null,
}) {
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
    processInstanceFingerprint: await readRuntimeDaemonProcessInstance(runtimeStatePath, pid),
  });
}

async function killDaemonFromLockFile({
  cliHomeDir,
  serverUrl = '',
  env = process.env,
  runtimeStatePath = null,
}) {
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
    processInstanceFingerprint: await readRuntimeDaemonProcessInstance(runtimeStatePath, pid),
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
  const scopedEnv = applyStackDaemonLifecycleScopeEnv({
    env: applyStackActiveServerScopeEnv({
      env: baseEnv,
      stackName,
      cliIdentity,
    }),
    stackName,
    cliIdentity,
  });
  const explicitStartupSource = String(baseEnv?.HAPPIER_DAEMON_STARTUP_SOURCE ?? '').trim();
  const explicitServiceLabel = String(baseEnv?.HAPPIER_DAEMON_SERVICE_LABEL ?? '').trim();
  const startupSource =
    explicitStartupSource ||
    (String(baseEnv?.HAPPIER_STACK_SERVICE_MODE ?? '').trim() === '1' ? 'background-service' : 'manual');
  const stackNameForOwnership =
    String(stackName ?? '').trim() ||
    String(scopedEnv.HAPPIER_STACK_STACK ?? '').trim();
  if (stackNameForOwnership) {
    scopedEnv.HAPPIER_STACK_STACK = stackNameForOwnership;
  }
  const hasStackOwnershipContext =
    Boolean(stackNameForOwnership) ||
    Boolean(String(scopedEnv.HAPPIER_STACK_ENV_FILE ?? '').trim()) ||
    Boolean(String(scopedEnv.HAPPIER_STACK_REPO_DIR ?? '').trim());
  if (hasStackOwnershipContext) {
    scopedEnv.HAPPIER_STACK_PROCESS_KIND = 'daemon';
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
  const scopedDaemonState = checkDaemonState(cliHomeDir, {
    serverUrl: internalServerUrl,
    env: daemonEnv,
  });

  // When we're shutting down due to a service manager restart (launchd/systemd),
  // a previous `hstack start` instance can race the new instance and accidentally stop the
  // newly-started daemon. Guard against that by only stopping when the caller believes it owns
  // the currently-running daemon PID.
  if (expectedPid != null) {
    const expected = Number(expectedPid);
    if (Number.isFinite(expected) && expected > 0) {
      const current = typeof scopedDaemonState?.pid === 'number' ? scopedDaemonState.pid : null;
      if (!current || current !== expected) {
        return;
      }
    }
  }

  const explicitCommand = String(cliCommand ?? '').trim();
  const explicitEntrypoint = String(cliEntrypoint ?? '').trim();
  const activeCliDir = resolveActiveCliDirForDaemonLaunch(daemonEnv);
  const { resolvedDist } = resolveGuardedLocalCliDistSelection({ cliBin, activeCliDir });
  const distEntrypoint =
    explicitCommand
      ? ''
      : explicitEntrypoint || resolvedDist?.distEntrypoint || resolveCliDistEntrypointFromBin(cliBin);
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
  if (distIntegrity.ok && scopedDaemonState.status !== 'stopped') {
    try {
      const daemonCommand = resolveDaemonCommandSpec({ cliBin, cliEntrypoint, cliNodeEntrypoint, cliCommand, cliCommandArgs, env: daemonEnv });
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

  await killDaemonFromStateFile({ cliHomeDir, serverUrl: internalServerUrl, env: daemonEnv, runtimeStatePath });
  // If the daemon never wrote daemon.state.json (e.g. it got stuck in auth in a non-interactive context),
  // stopLocalDaemon() can't find it. Fall back to the lock file PID.
  await killDaemonFromLockFile({ cliHomeDir, serverUrl: internalServerUrl, env: daemonEnv, runtimeStatePath });
  await syncStackRuntimeDaemonPidFromDaemonState(
    {
      runtimeStatePath,
      cliHomeDir,
      internalServerUrl,
      env: daemonEnv,
    },
    { checkDaemonStateImpl: checkDaemonStatePingAware },
  ).catch(() => {});
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
  preserveExistingRunning = false,
  env = process.env,
  stackName = null,
  cliIdentity = 'default',
  runtimeBacked = false,
  admittedDistClosureFingerprint = null,
  admitPriorDistImmediately = false,
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
      { checkDaemonStateImpl: checkDaemonStatePingAware },
    ).catch(() => {});
  };
  const explicitCommand = String(cliCommand ?? '').trim();
  const explicitEntrypoint = String(cliEntrypoint ?? '').trim();
  const initialDistEntrypoint = explicitCommand ? '' : explicitEntrypoint || resolveCliDistEntrypointFromBin(cliBin);
  const distCheck = await ensureHappierCliDistExists({
    cliBin,
    cliEntrypoint,
    cliNodeEntrypoint,
    cliCommand,
    admittedDistClosureFingerprint,
    admitPriorDistImmediately,
    env: baseEnv,
  });
  const distEntrypoint =
    explicitCommand
      ? ''
      : explicitEntrypoint || distCheck.distEntrypoint || initialDistEntrypoint;
  const immutableRunnerEntrypoint = distCheck.immutableRunner === true
    ? distEntrypoint
    : '';
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
    const error = new Error(formatCliDistUnavailableForDaemonStart({ distEntrypoint, reason: distCheck.reason }));
    if (distCheck.generationAdmissionRequired === true) {
      error.code = 'ECLIDISTSTALECOLDSTART';
    }
    throw error;
  }
  const guardSourceCliDistRestart = isGuardedSourceCliDistEntrypoint({
    cliBin,
    cliEntrypoint,
    cliNodeEntrypoint,
    cliCommand,
    distEntrypoint,
    activeCliDir: resolveActiveCliDirForDaemonLaunch(baseEnv),
  });
  const sourceCliDir = resolveCliDistOwnerDirForDaemonLaunch({ cliBin, distEntrypoint });
  const sourceRepoRoot = coerceHappyMonorepoRootFromPath(sourceCliDir);
  const sourcePublicationLockPath = sourceRepoRoot
    ? resolveCliDistBuildLockPath(sourceRepoRoot)
    : join(sourceCliDir, '.dist.hstack-build.lock');
  const withSourcePublicationLease = async (callback) => {
    if (!guardSourceCliDistRestart) return await callback();
    return await withCliDistBuildLock(
      async ({ heldLockValue }) => {
        const previousHeldLockValue = daemonEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
        daemonEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD = heldLockValue;
        try {
          return await callback();
        } finally {
          if (previousHeldLockValue === undefined) {
            delete daemonEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD;
          } else {
            daemonEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD = previousHeldLockValue;
          }
        }
      },
      {
        lockPath: sourcePublicationLockPath,
        env: baseEnv,
      },
    );
  };

  const runDaemonLifecycleWithResolvedCommand = async () => {
  const runnerDistEntrypoint = runtimeBacked === true
    ? String(cliNodeEntrypoint ?? '').trim()
    : distEntrypoint;
  let currentDistClosure = runnerDistEntrypoint
    ? readCliDistBuildManifest(runnerDistEntrypoint)
    : null;
  const admittedFingerprint = String(admittedDistClosureFingerprint ?? '').trim().toLowerCase();
  if (
    runtimeBacked === true
    && (
      !/^[a-f0-9]{16}$/.test(admittedFingerprint)
      || currentDistClosure?.ok !== true
      || currentDistClosure.fingerprint !== admittedFingerprint
    )
  ) {
    const error = new Error('[runtime] admitted daemon dist closure fingerprint does not match the immutable runtime entrypoint.');
    error.code = 'EIMMUTABLERUNTIMEDAEMONCLOSURE';
    throw error;
  }
  let currentDistFingerprint = currentDistClosure?.ok ? currentDistClosure.fingerprint : null;
  const daemonClosureOriginEntrypoint = immutableRunnerEntrypoint
    ? initialDistEntrypoint
    : runnerDistEntrypoint;
  const resolveDaemonCommandForClosure = (distClosure) => {
    currentDistFingerprint = distClosure?.ok ? distClosure.fingerprint : null;
    applyDaemonDistClosureRuntimeEnv(daemonEnv, {
      runtimeStatePath,
      distEntrypoint: daemonClosureOriginEntrypoint,
      distClosureFingerprint: currentDistFingerprint,
      runtimeBacked,
    });
    if (immutableRunnerEntrypoint) {
      // Execute the last-known-good runner directly, but keep the admitted dist as the closure
      // origin. Existing runners resolve that fingerprint in the stack's mutable runner store;
      // treating the runner copy itself as the origin would instead search for a nested snapshot
      // and reject the otherwise valid closure.
      delete daemonEnv.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT;
      daemonEnv.HAPPIER_CLI_SUBPROCESS_PREFER_TSX = '0';
    }
    return resolveDaemonCommandSpec({
      cliBin,
      cliEntrypoint,
      cliNodeEntrypoint: cliNodeEntrypoint || immutableRunnerEntrypoint,
      cliCommand,
      cliCommandArgs,
      env: daemonEnv,
    });
  };
  let daemonCommand = resolveDaemonCommandForClosure(currentDistClosure);
  // Daemon startup can outlive the CLI's short foreground "still starting" window: source
  // daemons reattach sessions and hydrate local state, and packaged daemons may warm runtime state.
  const startVerifyTimeoutMs = resolveStackDaemonStartVerifyTimeoutMs(baseEnv);
  const startVerifyPollMs = parseNonNegativeInt(baseEnv.HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS, 125);
  const startVerifyStableMs = parseNonNegativeInt(baseEnv.HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS, 750);
  const daemonLifecycleLockTimeoutMs = parseNonNegativeInt(baseEnv.HAPPIER_STACK_DAEMON_LIFECYCLE_LOCK_TIMEOUT_MS, 180_000);
  const daemonLifecycleLockPollMs = parseNonNegativeInt(baseEnv.HAPPIER_STACK_DAEMON_LIFECYCLE_LOCK_POLL_MS, 125);

  return await withStackDaemonLifecycleLock(
    { cliHomeDir, internalServerUrl, stackName: resolvedStackName },
    async () => {

  if (distCheck.generationAdmissionRequired && distCheck.current !== true) {
    const existingAtAdmission = await checkDaemonStatePingAware(cliHomeDir, {
      serverUrl: internalServerUrl,
      env: daemonEnv,
      stackName: resolvedStackName,
    });
    const hasLiveDaemon = ['running', 'starting', 'unreachable'].includes(existingAtAdmission.status);
    const hasHealthyDaemon = existingAtAdmission.status === 'running';
    if (distCheck.degraded === true && hasHealthyDaemon) {
      console.warn(
        `[local] WARNING: happier-cli current build failed (${distCheck.reason ?? 'unknown'}); ` +
          'preserving the healthy daemon already running from the last usable dist ' +
          `(fingerprint=${distCheck.fallbackFingerprint ?? 'unknown'}). Source changes are not active.`
      );
      await syncRuntimeDaemonState({ runtimeDaemonPid: existingAtAdmission.pid });
      return;
    }
    if (!forceRestart && hasLiveDaemon) {
      console.warn(
        `[local] happier-cli current build is unavailable (${distCheck.reason ?? 'unknown'}); ` +
          'preserving the already-live daemon without launching stale output.'
      );
      await syncRuntimeDaemonState({ runtimeDaemonPid: existingAtAdmission.pid });
      return;
    }
    if (distCheck.degraded === true) {
      console.warn(
        `[local] WARNING: happier-cli current build failed (${distCheck.reason ?? 'unknown'}); ` +
          `starting the daemon from the last usable dist at ${distEntrypoint} ` +
          `(fingerprint=${distCheck.fallbackFingerprint ?? 'unknown'}). Source changes are not active.`
      );
    } else {
      const error = new Error(
        `[local] happier-cli dist is not proven current (${distCheck.reason ?? 'unknown'}); ` +
        `refusing to cold-start or restart the daemon from stale or invalid build output at ${distEntrypoint}.` +
        (distCheck.fallbackRejectedReason ? ` Fallback rejected: ${distCheck.fallbackRejectedReason}.` : '')
      );
      error.code = 'ECLIDISTSTALECOLDSTART';
      throw error;
    }
  }

  const waitForRunningStable = async ({ shouldStop = null } = {}) => {
    const deadline = Date.now() + startVerifyTimeoutMs;
    while (Date.now() < deadline) {
      if (typeof shouldStop === 'function' && shouldStop()) return false;
      const stateNow = await checkDaemonStatePingAware(cliHomeDir, { serverUrl: internalServerUrl, env: daemonEnv });
      if (stateNow.status === 'running') {
        if (startVerifyStableMs <= 0) return true;
        await delay(startVerifyStableMs);
        const stableState = await checkDaemonStatePingAware(cliHomeDir, { serverUrl: internalServerUrl, env: daemonEnv });
        if (stableState.status === 'running') return true;
      }
      if (typeof shouldStop === 'function' && shouldStop()) return false;
      await delay(startVerifyPollMs);
    }
    return false;
  };

  // If this is a migrated/new stack home dir, seed credentials from the user's existing login (best-effort)
  // to avoid requiring an interactive auth flow under launchd.
  const migrateCreds = (baseEnv.HAPPIER_STACK_MIGRATE_CREDENTIALS ?? '1').trim() !== '0';
  if (migrateCreds) {
    await seedCredentialsIfMissing({ cliHomeDir, internalServerUrl, env: daemonEnv });
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

  const existing = await checkDaemonStatePingAware(cliHomeDir, { serverUrl: internalServerUrl, env: daemonEnv });
  if (
    preserveExistingRunning &&
    !forceRestart &&
    runtimeBacked !== true &&
    (existing.status === 'running' || existing.status === 'starting')
  ) {
    const pid = existing.pid;
    console.warn(
      `[local] daemon is ${existing.status} during dev reload fallback` +
        (pid ? ` (pid=${pid})` : '') +
        '; keeping existing daemon running to avoid downtime.'
    );
    await syncRuntimeDaemonState({ runtimeDaemonPid: pid, daemonDistFingerprint: currentDistFingerprint });
    return;
  }
  // Join any in-flight source publication before deciding to stop the current daemon.
  // The lease is deliberately released again before the stop command: publishers must
  // not wait on daemon shutdown, while the existing final start lease still prevents a
  // different generation from reaching the new child.
  if (guardSourceCliDistRestart) {
    let sourceAdmissionError = null;
    try {
      await withSourcePublicationLease(async () => {
        const guardedDistIntegrity = readCliDistIntegrity(distEntrypoint);
        if (!guardedDistIntegrity.ok) {
          throw new Error(formatCliDistUnavailableForDaemonStart({
            distEntrypoint,
            reason: guardedDistIntegrity.reason,
          }));
        }
        assertFinalSourceDaemonDistAdmission({
          admittedDistClosureFingerprint,
          finalFingerprint: guardedDistIntegrity.fingerprint,
        });
        assertSourceCliWorkspaceRuntimeStillCurrent({ cliBin, distEntrypoint });
      });
    } catch (error) {
      sourceAdmissionError = error;
    }
    if (sourceAdmissionError) {
      if (existing.status === 'running' || existing.status === 'starting') {
        console.warn(
          `${sourceAdmissionError instanceof Error ? sourceAdmissionError.message : String(sourceAdmissionError)}\n` +
            `[local] Keeping the existing daemon running to avoid downtime.`
        );
        await syncRuntimeDaemonState({ runtimeDaemonPid: existing.pid });
        return;
      }
      throw sourceAdmissionError;
    }
  } else if (
    runnerDistEntrypoint &&
    !existsSync(runnerDistEntrypoint) &&
    (existing.status === 'running' || existing.status === 'starting')
  ) {
    console.warn(
      `[local] happier-cli dist entrypoint is missing (${runnerDistEntrypoint}).\n` +
        `[local] Refusing to restart daemon to avoid downtime. Rebuild happier-cli first.`
    );
    await syncRuntimeDaemonState({ runtimeDaemonPid: existing.pid });
    return;
  }

  if (!forceRestart && existing.status === 'running') {
    const pid = existing.pid;
    const envMatch = await readDaemonEnvMatch({ pid, cliHomeDir, internalServerUrl, publicServerUrl });
    const matches = envMatch ? envMatch.matches === true : null;
    const distRestartReason = resolveDaemonDistRestartReason({
      distEntrypoint: runnerDistEntrypoint,
      distClosure: currentDistClosure,
      runtimeStatePath,
      observedDaemonDistFingerprint: existing.distClosureFingerprint,
      runtimeBacked,
      cliHomeDir,
      serverUrl: internalServerUrl,
      env: daemonEnv,
    });
    if (runtimeBacked === true && distRestartReason) {
      console.warn(`[local] daemon is running with stale runtime; restarting (pid=${pid}).\n[local] ${distRestartReason}`);
    } else if (matches === true) {
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
      const mismatchLabel = envMatch?.key ? `${envMatch.key} mismatch` : 'environment mismatch';
      const expectedLine = envMatch?.expected
        ? `[local] expected ${envMatch.key}: ${envMatch.expected}\n`
        : `[local] expected server URL: ${internalServerUrl}\n`;
      // eslint-disable-next-line no-console
      console.warn(
        `[local] daemon is running with a different stack ${mismatchLabel}; restarting (pid=${pid}).\n` +
          expectedLine
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
  await killDaemonFromStateFile({ cliHomeDir, serverUrl: internalServerUrl, env: daemonEnv, runtimeStatePath });
  await killDaemonFromLockFile({ cliHomeDir, serverUrl: internalServerUrl, env: daemonEnv, runtimeStatePath });

  await recordStackRuntimeDaemonPid(runtimeStatePath, null, { daemonDistFingerprint: null }).catch(() => {});

  const runStartOnce = async () => {
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
    if (guardSourceCliDistRestart) {
      const guardedDistIntegrity = readCliDistIntegrity(distEntrypoint);
      if (!guardedDistIntegrity.ok) {
        throw new Error(formatCliDistUnavailableForDaemonStart({
          distEntrypoint,
          reason: guardedDistIntegrity.reason,
        }));
      }
      assertFinalSourceDaemonDistAdmission({
        admittedDistClosureFingerprint,
        finalFingerprint: guardedDistIntegrity.fingerprint,
      });
      assertSourceCliWorkspaceRuntimeStillCurrent({ cliBin, distEntrypoint });
      // The source publisher lease makes this the single current generation that can reach the
      // spawned child. Re-read every launch-derived value after admission rather than carrying
      // the pre-stop A generation into a B publication that completed while stop was running.
      currentDistClosure = readCliDistBuildManifest(runnerDistEntrypoint);
      if (
        currentDistClosure?.ok !== true
        || currentDistClosure.fingerprint !== guardedDistIntegrity.fingerprint
      ) {
        throw new Error(formatCliDistUnavailableForDaemonStart({
          distEntrypoint,
          reason: currentDistClosure?.reason ?? 'changed_after_final_admission',
        }));
      }
      daemonCommand = resolveDaemonCommandForClosure(currentDistClosure);
    }
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
    proc.on('exit', (code, signal) => {
      resolvedExitCode = code ?? (signal ? 1 : 0);
    });
    const outputDrainedPromise = proc.completion;

    // Some launch paths keep the start command itself alive after the daemon is already
    // healthy (for example synchronous start-sync mode). Success must be keyed off stable
    // daemon state, not only the wrapper process exiting.
    const runningStable = await waitForRunningStable({
      shouldStop: () => isShuttingDown?.() === true || excerptIndicatesInstalledServiceConflict(startOutput),
    });
    if (runningStable) {
      return { ok: true, exitCode: resolvedExitCode, excerpt: null, logPath: null };
    }

    // The health deadline classifies this attempt as failed, but the owned start wrapper is still
    // the attempt's lifecycle boundary. Cancel and join it before releasing the Stack lifecycle
    // lock; otherwise a later reconciliation can launch a second wrapper while this one is still
    // retrying its internal daemon lifecycle path.
    if (resolvedExitCode === null && proc.exitCode === null && proc.signalCode === null) {
      await killProcessTree(proc, 'SIGTERM');
    }
    await outputDrainedPromise;

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

  const startOnce = async () => await withSourcePublicationLease(runStartOnce);

  const first = await startOnce();
  if (!first.ok) {
    if (first.excerpt) {
      console.error(`[local] daemon failed to start; last daemon log (${first.logPath}):\n${first.excerpt}`);
    } else {
      console.error('[local] daemon failed to start; no daemon log found');
    }

    if (isTui) {
      if (excerptIndicatesInstalledServiceConflict(first.startOutput) || excerptIndicatesInstalledServiceConflict(first.excerpt)) {
        // Keep the TUI alive so the daemon pane can continue showing the ownership guidance
        // that the start command already streamed.
        console.log('[daemon] installed background service conflict detected; keeping TUI running.');
      } else {
        const noticeLine = extractFirstDaemonStartNoticeLine(first.startOutput);
        if (noticeLine) {
          console.log(`[daemon] ${noticeLine}`);
        }
        console.log('[daemon] daemon start failed before the relay came up; keeping TUI running.');
      }
      return;
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
      const stateAfterCreds = await checkDaemonStatePingAware(cliHomeDir, { serverUrl: internalServerUrl, env: daemonEnv });
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
  const activeCliDir = resolveActiveCliDirForDaemonLaunch(daemonEnv);
  const { resolvedDist } = resolveGuardedLocalCliDistSelection({ cliBin, activeCliDir });
  const activeSourceDist =
    activeCliDir &&
    !String(cliEntrypoint ?? '').trim() &&
    !String(cliNodeEntrypoint ?? '').trim() &&
    !String(cliCommand ?? '').trim() &&
    !isCliDirectExecutableCommand(cliBin) &&
    resolvedDist?.ok
      ? resolvedDist.distEntrypoint
      : null;
  if (activeSourceDist && !existsSync(activeSourceDist)) {
    return buildDistMissingStatusFallback({
      cliHomeDir,
      internalServerUrl,
      env: daemonEnv,
      distEntrypoint: activeSourceDist,
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
