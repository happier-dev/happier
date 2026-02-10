import { spawnProc, run, runCapture } from './utils/proc/proc.mjs';
import { resolveAuthSeedFromEnv, resolveAutoCopyFromMainEnabled } from './utils/stack/startup.mjs';
import { getStacksStorageRoot } from './utils/paths/paths.mjs';
import { runCaptureIfCommandExists } from './utils/proc/commands.mjs';
import { readLastLines } from './utils/fs/tail.mjs';
import { ensureCliBuilt } from './utils/proc/pm.mjs';
import {
  findAnyCredentialPathInCliHome,
  findExistingStackCredentialPath,
  resolvePreferredStackDaemonStatePaths,
  resolveStackDaemonStatePaths,
  resolveStackCredentialPaths,
} from './utils/auth/credentials_paths.mjs';
import { decodeJwtPayloadUnsafe } from './utils/auth/decode_jwt_payload_unsafe.mjs';
import { applyStackActiveServerScopeEnv } from './utils/auth/stable_scope_id.mjs';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getRootDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { parseEnvToObject } from './utils/env/dotenv.mjs';
import { getCliHomeDirFromEnvOrDefault } from './utils/stack/dirs.mjs';

/**
 * Daemon lifecycle helpers for hstack.
 *
 * Centralizes:
 * - stopping old daemons (stack-scoped)
 * - cleaning stale lock/state
 * - starting daemon and handling first-time auth
 * - printing actionable diagnostics
 */

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

export async function cleanupStaleDaemonState(homeDir, options = {}) {
  const serverUrl = resolveServerUrlFromOptions(options);
  const env = resolveEnvFromOptions(options);
  const { statePath, lockPath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir: homeDir, serverUrl, env });

  if (!existsSync(lockPath)) {
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

  // If lock PID exists and is running, keep lock/state ONLY if it still owns the lock file path.
  try {
    const raw = readFileSync(lockPath, 'utf-8').trim();
    const pid = Number(raw);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        // If PID was recycled, refuse to trust it unless we can prove it's associated with this home dir.
        // This prevents cross-stack daemon kills due to stale lock files.
        if (await lsofHasPath(pid, lockPath)) {
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
          if (await lsofHasPath(pid, statePath)) {
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

  const alive = isPidAlive;

  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      const pid = Number(state?.pid);
      if (Number.isFinite(pid) && pid > 0) {
        return alive(pid) ? { status: 'running', pid } : { status: 'stale_state', pid };
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
        return alive(pid) ? { status: 'starting', pid } : { status: 'stale_lock', pid };
      }
      return { status: 'bad_lock', pid: null };
    } catch {
      return { status: 'bad_lock', pid: null };
    }
  }

  const fallback = findRunningDaemonStateInHome(cliHomeDir, alive);
  if (fallback) {
    return fallback;
  }

  return { status: 'stopped', pid: null };
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

  // Must be for the same stack home dir.
  if (home && !line.includes(`HAPPIER_HOME_DIR=${home}`)) {
    return false;
  }
  // If we have a desired server URL, require it (prevents ephemeral port mismatches).
  if (server && !line.includes(`HAPPIER_SERVER_URL=${server}`)) {
    return false;
  }
  // Public URL mismatch is less fatal, but prefer it stable too when provided.
  if (web && !line.includes(`HAPPIER_WEBAPP_URL=${web}`)) {
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

function resolveHappierCliDistEntrypoint(cliBin) {
  const bin = String(cliBin ?? '').trim();
  if (!bin) return null;
  // In component checkouts/worktrees we launch via <cliDir>/bin/happier.mjs, which expects dist output.
  // Use this to protect restarts from bricking the running daemon if dist disappears mid-build.
  try {
    const binDir = dirname(bin);
    return join(binDir, '..', 'dist', 'index.mjs');
  } catch {
    return null;
  }
}

function extractRelativeMjsImportSpecifiers(source) {
  const specs = new Set();
  const patterns = [
    /(?:^|[^\w$])import\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]/gm,
    /(?:^|[^\w$])export\s+[^'"]*?\s+from\s*['"]([^'"]+)['"]/gm,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm,
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      const spec = String(match?.[1] ?? '').trim();
      if (!spec || !spec.startsWith('.')) continue;
      if (!spec.endsWith('.mjs')) continue;
      specs.add(spec);
    }
  }
  return [...specs];
}

function findMissingDistModules(entrypoint, maxFiles = 400) {
  const missing = [];
  const seen = new Set();
  const queue = [entrypoint];
  while (queue.length > 0 && seen.size < maxFiles) {
    const filePath = queue.shift();
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);

    let source = '';
    try {
      source = readFileSync(filePath, 'utf-8');
    } catch {
      missing.push(filePath);
      continue;
    }

    const imports = extractRelativeMjsImportSpecifiers(source);
    for (const spec of imports) {
      const target = join(dirname(filePath), spec);
      if (!existsSync(target)) {
        missing.push(target);
        continue;
      }
      if (!seen.has(target)) {
        queue.push(target);
      }
    }
  }
  return missing;
}

async function ensureHappierCliDistExists({ cliBin }) {
  const distEntrypoint = resolveHappierCliDistEntrypoint(cliBin);
  if (!distEntrypoint) return { ok: false, distEntrypoint: null, built: false, reason: 'unknown_cli_bin' };
  const cliDir = join(dirname(cliBin), '..');
  const buildCli =
    (process.env.HAPPIER_STACK_CLI_BUILD ?? '1').toString().trim() !== '0';

  const readIntegrity = () => {
    if (!existsSync(distEntrypoint)) return { ok: false, reason: 'missing_entrypoint' };
    const missing = findMissingDistModules(distEntrypoint);
    if (missing.length === 0) return { ok: true, reason: 'exists' };
    return { ok: false, reason: `incomplete:${missing[0]}` };
  };

  // Fast path: if dist exists and import graph is complete, never trigger rebuild here.
  // Rebuilding inside daemon restart can race with live restarts and transiently remove dist/.
  const before = readIntegrity();
  if (before.ok) {
    return { ok: true, distEntrypoint, built: false, reason: before.reason };
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
  const seed = resolveAuthSeedFromEnv(env);
  return `hstack stack auth ${stackName} copy-from ${seed}`;
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

  const seed = resolveAuthSeedFromEnv(env);
  const allowAccountSwitch =
    (env.HAPPIER_STACK_AUTO_AUTH_RESEED_ALLOW_ACCOUNT_SWITCH ?? '').toString().trim() === '1';
  const guard = shouldSkipAutoReseedForDifferentAccount({
    stackName,
    seed,
    cliHomeDir,
    internalServerUrl,
    env,
  });
  if (guard.skip && !allowAccountSwitch) {
    return { ok: false, skipped: true, reason: guard.reason, seed };
  }
  if (!quiet) {
    console.log(`[local] auth: invalid token detected; re-seeding ${stackName} from ${seed}...`);
  }
  const rootDir = getRootDir(import.meta.url);

  // Use stack-scoped auth copy so env/database resolution is correct for the target stack.
  await run(process.execPath, [join(rootDir, 'scripts', 'stack.mjs'), 'auth', stackName, '--', 'copy-from', seed, '--force'], {
    cwd: rootDir,
    env,
  });
  return { ok: true, skipped: false, seed };
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

async function killDaemonFromLockFile({ cliHomeDir, serverUrl = '', env = process.env }) {
  const { statePath, lockPath } = resolvePreferredStackDaemonStatePaths({ cliHomeDir, serverUrl, env });
  const daemonStatePaths = resolveStackDaemonStatePaths({ cliHomeDir, serverUrl, env });
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

  // If pid is alive, confirm it looks like a happier daemon and terminate it.
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
    console.warn(`[local] refusing to kill pid ${pid} from lock file (doesn't look like daemon): ${cmd.trim()}`);
    return false;
  }

  // Hard safety: only kill if we can prove the PID is associated with this stack home dir.
  // We do this by checking that `lsof -p <pid>` includes the lock path (or state file path).
  let ownsLock = false;
  try {
    const out = await runCaptureIfCommandExists('lsof', ['-nP', '-p', String(pid)]);
    ownsLock =
      out.includes(lockPath) ||
      out.includes(statePath) ||
      out.includes(daemonStatePaths.legacyStatePath) ||
      out.includes(daemonStatePaths.serverScopedStatePath) ||
      out.includes(join(cliHomeDir, 'logs'));
  } catch {
    ownsLock = false;
  }
  if (!ownsLock) {
    console.warn(
      `[local] refusing to kill pid ${pid} from lock file (could be unrelated; lsof did not show ownership of ${cliHomeDir})`
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
    // Still alive: hard kill.
    process.kill(pid, 'SIGKILL');
  } catch {
    // exited
  }
  console.log(`[local] killed stuck daemon pid ${pid} (from ${lockPath})`);
  return true;
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
  return {
    ...scopedEnv,
    HAPPIER_SERVER_URL: internalServerUrl,
    HAPPIER_WEBAPP_URL: publicServerUrl,
    HAPPIER_HOME_DIR: cliHomeDir,
  };
}

export async function stopLocalDaemon({
  cliBin,
  internalServerUrl,
  cliHomeDir,
  publicServerUrl = '',
  env = process.env,
  stackName = null,
  cliIdentity = null,
}) {
  const daemonEnv = getDaemonEnv({
    baseEnv: env,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl: publicServerUrl || internalServerUrl,
    stackName,
    cliIdentity,
  });

  try {
    await new Promise((resolve) => {
      const proc = spawnProc('daemon', process.execPath, [cliBin, 'daemon', 'stop'], daemonEnv, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('exit', () => resolve());
    });
  } catch {
    // ignore
  }

  // If the daemon never wrote daemon.state.json (e.g. it got stuck in auth in a non-interactive context),
  // stopLocalDaemon() can't find it. Fall back to the lock file PID.
  await killDaemonFromLockFile({ cliHomeDir, serverUrl: internalServerUrl, env: daemonEnv });
}

export async function startLocalDaemonWithAuth({
  cliBin,
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
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
  const startVerifyTimeoutMs = parseNonNegativeInt(baseEnv.HAPPIER_STACK_DAEMON_START_VERIFY_TIMEOUT_MS, 5_000);
  const startVerifyPollMs = parseNonNegativeInt(baseEnv.HAPPIER_STACK_DAEMON_START_VERIFY_POLL_MS, 125);
  const startVerifyStableMs = parseNonNegativeInt(baseEnv.HAPPIER_STACK_DAEMON_START_VERIFY_STABLE_MS, 750);
  const isTui = (baseEnv.HAPPIER_STACK_TUI ?? '').toString().trim() === '1';

  const distEntrypoint = resolveHappierCliDistEntrypoint(cliBin);
  const distCheck = await ensureHappierCliDistExists({ cliBin });
  if (!distCheck.ok) {
    const reason = String(distCheck.reason ?? '').trim();
    const missingModule = reason.startsWith('incomplete:') ? reason.slice('incomplete:'.length) : '';
    const detail = missingModule
      ? `[local] Missing module referenced by dist entrypoint: ${missingModule}\n`
      : '';
    throw new Error(
      `[local] happier-cli dist entrypoint is missing or incomplete (${distEntrypoint}).\n` +
        `[local] Refusing to start/restart daemon because it would crash with MODULE_NOT_FOUND.\n` +
        detail +
        `[local] Fix: rebuild happier-cli in the active checkout/worktree.\n` +
        (distCheck.reason ? `[local] Detail: ${distCheck.reason}\n` : '')
    );
  }

  // If this is a migrated/new stack home dir, seed credentials from the user's existing login (best-effort)
  // to avoid requiring an interactive auth flow under launchd.
  const migrateCreds = (baseEnv.HAPPIER_STACK_MIGRATE_CREDENTIALS ?? '1').trim() !== '0';
  if (migrateCreds) {
    await seedCredentialsIfMissing({ cliHomeDir });
  }
  const credentialPaths = resolveStackCredentialPaths({ cliHomeDir, serverUrl: internalServerUrl, env: baseEnv });
  const mirrored = await ensureServerScopedCredentialsFromLegacy({ cliHomeDir, internalServerUrl, env: baseEnv });
  if (mirrored.copied) {
    console.log(`[local] migrated daemon credentials to server profile: ${mirrored.source} -> ${mirrored.target}`);
  }

  const existing = checkDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env: daemonEnv });
  // If the daemon is already running and we're restarting it, refuse to stop it unless the
  // happier-cli dist entrypoint exists. Otherwise a rebuild (rm -rf dist) can brick the stack.
  if (
    distEntrypoint &&
    !existsSync(distEntrypoint) &&
    (existing.status === 'running' || existing.status === 'starting')
  ) {
    console.warn(
      `[local] happier-cli dist entrypoint is missing (${distEntrypoint}).\n` +
        `[local] Refusing to restart daemon to avoid downtime. Rebuild happier-cli first.`
    );
    return;
  }

  if (!forceRestart && existing.status === 'running') {
    const pid = existing.pid;
    const matches = await daemonEnvMatches({ pid, cliHomeDir, internalServerUrl, publicServerUrl });
    if (matches === true) {
      // eslint-disable-next-line no-console
      console.log(`[local] daemon already running for stack home (pid=${pid})`);
      if (isTui) {
        // Emit a daemon-labeled line so `hstack tui` can route it to the daemon pane.
        // (The daemon itself logs to cliHomeDir/logs/*-daemon.log.)
        // eslint-disable-next-line no-console
        console.log(`[daemon] already running (pid=${pid})`);
      }
      return;
    }
    if (matches === false) {
      // eslint-disable-next-line no-console
      console.warn(
        `[local] daemon is running but pointed at a different server URL; restarting (pid=${pid}).\n` +
          `[local] expected: ${internalServerUrl}\n`
      );
    } else {
      // unknown: best-effort keep running to avoid killing an unrelated process
      // eslint-disable-next-line no-console
      console.warn(`[local] daemon status is running but could not verify env; not restarting (pid=${pid})`);
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
      const proc = spawnProc('daemon', process.execPath, [cliBin, 'daemon', 'stop'], daemonEnv, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('exit', () => resolve());
    });
  } catch {
    // ignore
  }

  // If state is missing and stop couldn't find it, force-stop the lock PID (otherwise repeated restarts accumulate daemons).
  await killDaemonFromLockFile({ cliHomeDir, serverUrl: internalServerUrl, env: daemonEnv });

  // Clean up stale lock/state files that can block daemon start.
  await cleanupStaleDaemonState(cliHomeDir, { serverUrl: internalServerUrl, env: daemonEnv });

  const startOnce = async () => {
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

    const exitCode = await new Promise((resolve) => {
      const proc = spawnProc('daemon', process.execPath, [cliBin, 'daemon', 'start'], daemonEnv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // In TUI mode, stream the daemon-start output so it routes to the daemon pane.
        // (The background daemon itself still logs to files.)
        silent: !isTui,
      });
      proc.on('exit', (code) => resolve(code ?? 0));
    });

    if (exitCode === 0) {
      const runningStable = await waitForRunningStable();
      if (runningStable) {
        return { ok: true, exitCode, excerpt: null, logPath: null };
      }
      const logPath = getLatestDaemonLogPath(cliHomeDir);
      const excerpt = logPath ? await readLastLines(logPath, 120) : null;
      return { ok: false, exitCode, excerpt, logPath };
    }

    // Some daemon versions (or transient races) can return non-zero even if the daemon
    // is already running / starting for this stack home dir (e.g. "lock already held").
    // In those cases, fail-open and keep the stack running; callers can still surface
    // daemon status separately.
    await delay(500);
    const stateAfter = checkDaemonState(cliHomeDir, { serverUrl: internalServerUrl });
    if (stateAfter.status === 'running') {
      return { ok: true, exitCode, excerpt: null, logPath: null };
    }

    const logPath = getLatestDaemonLogPath(cliHomeDir);
    const excerpt = logPath ? await readLastLines(logPath, 120) : null;
    return { ok: false, exitCode, excerpt, logPath };
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
        const copyHint = authCopyFromSeedHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity, env: baseEnv });
        console.error(
          `[local] daemon credentials were rejected by the server (401).\n` +
            `[local] Fix:\n` +
            (copyHint ? `- ${copyHint}\n` : '') +
            `- ${authLoginHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity })}`
        );
        throw e;
      }
      if (!reseedResult?.ok || reseedResult?.skipped) {
        const copyHint = authCopyFromSeedHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity, env: baseEnv });
        const skippedReason = reseedResult?.reason ?? 'unknown';
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
            `- ${authLoginHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity })}`
        );
        throw new Error(`Failed to auto re-seed daemon credentials (${skippedReason})`);
      }

      console.log(`[local] auth re-seeded from ${reseedResult.seed}, retrying daemon start...`);
      const second = await startOnce();
      if (!second.ok) {
        if (excerptIndicatesInvalidAuth(second.excerpt)) {
          const copyHint = authCopyFromSeedHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity, env: baseEnv });
          console.error(
            `[local] auth re-seed source "${reseedResult.seed}" appears stale (still 401).\n` +
              `[local] Auto fallback to another auth source is disabled.\n` +
              `[local] Fix:\n` +
              (copyHint ? `- ${copyHint} --force\n` : '') +
              `- ${authLoginHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity })}`
          );
        }

        if (second.excerpt) {
          console.error(`[local] daemon still failed to start; last daemon log (${second.logPath}):\n${second.excerpt}`);
        }
        throw new Error('Failed to start daemon (after auth re-seed)');
      }
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
    await run(process.execPath, [cliBin, 'daemon', 'status'], { env: daemonEnv, stdio: 'ignore' });
  } catch {
    // ignore
  }
}

export async function daemonStatusSummary({
  cliBin,
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
  const distEntrypoint = resolveHappierCliDistEntrypoint(cliBin);
  try {
    return await runCapture(process.execPath, [cliBin, 'daemon', 'status'], { env: daemonEnv });
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

function isMissingDistStatusError({ error, distEntrypoint }) {
  const text = String(error?.message ?? error ?? '');
  if (!text.includes('MODULE_NOT_FOUND') && !text.includes('ERR_MODULE_NOT_FOUND')) return false;
  if (distEntrypoint && text.includes(distEntrypoint)) return true;
  return text.includes('/dist/index.mjs');
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
