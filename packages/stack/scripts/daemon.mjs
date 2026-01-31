import { spawnProc, run, runCapture } from './utils/proc/proc.mjs';
import { resolveAuthSeedFromEnv, resolveAutoCopyFromMainEnabled } from './utils/stack/startup.mjs';
import { getStacksStorageRoot } from './utils/paths/paths.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { runCaptureIfCommandExists } from './utils/proc/commands.mjs';
import { readLastLines } from './utils/fs/tail.mjs';
import { ensureCliBuilt } from './utils/proc/pm.mjs';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { getRootDir } from './utils/paths/paths.mjs';

/**
 * Daemon lifecycle helpers for happy-stacks.
 *
 * Centralizes:
 * - stopping old daemons (legacy + local home dirs)
 * - cleaning stale lock/state
 * - starting daemon and handling first-time auth
 * - printing actionable diagnostics
 */

export async function cleanupStaleDaemonState(homeDir) {
  const statePath = join(homeDir, 'daemon.state.json');
  const lockPath = join(homeDir, 'daemon.state.json.lock');

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

export function checkDaemonState(cliHomeDir) {
  const statePath = join(cliHomeDir, 'daemon.state.json');
  const lockPath = join(cliHomeDir, 'daemon.state.json.lock');

  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

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

  return { status: 'stopped', pid: null };
}

export function isDaemonRunning(cliHomeDir) {
  const s = checkDaemonState(cliHomeDir);
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
  if (home && !line.includes(`HAPPY_HOME_DIR=${home}`)) {
    return false;
  }
  // If we have a desired server URL, require it (prevents ephemeral port mismatches).
  if (server && !line.includes(`HAPPY_SERVER_URL=${server}`)) {
    return false;
  }
  // Public URL mismatch is less fatal, but prefer it stable too when provided.
  if (web && !line.includes(`HAPPY_WEBAPP_URL=${web}`)) {
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

function resolveHappyCliDistEntrypoint(cliBin) {
  const bin = String(cliBin ?? '').trim();
  if (!bin) return null;
  // In component checkouts/worktrees we launch via <cliDir>/bin/happy.mjs, which expects dist output.
  // Use this to protect restarts from bricking the running daemon if dist disappears mid-build.
  try {
    const binDir = dirname(bin);
    return join(binDir, '..', 'dist', 'index.mjs');
  } catch {
    return null;
  }
}

async function ensureHappyCliDistExists({ cliBin }) {
  const distEntrypoint = resolveHappyCliDistEntrypoint(cliBin);
  if (!distEntrypoint) return { ok: false, distEntrypoint: null, built: false, reason: 'unknown_cli_bin' };
  const cliDir = join(dirname(cliBin), '..');

  // Try to recover automatically: missing dist is a common first-run worktree issue.
  // We build in-place using the cliDir that owns this cliBin (../ from bin/).
  const buildCli =
    (process.env.HAPPY_STACKS_CLI_BUILD ?? process.env.HAPPY_LOCAL_CLI_BUILD ?? '1').toString().trim() !== '0';
  if (!buildCli) {
    return { ok: false, distEntrypoint, built: false, reason: 'build_disabled' };
  }

  let buildRes = null;
  try {
    // In auto mode, ensureCliBuilt() is a fast no-op when nothing changed.
    buildRes = await ensureCliBuilt(cliDir, { buildCli: true });
    if (buildRes?.built) {
      // eslint-disable-next-line no-console
      console.warn(`[local] happy-cli: rebuilt (${cliDir})`);
    }
  } catch (e) {
    return { ok: false, distEntrypoint, built: false, reason: String(e?.message ?? e) };
  }

  if (existsSync(distEntrypoint)) {
    return {
      ok: true,
      distEntrypoint,
      built: Boolean(buildRes?.built),
      reason: buildRes?.built ? (buildRes.reason ?? 'rebuilt') : 'exists',
    };
  }
  return { ok: false, distEntrypoint, built: Boolean(buildRes?.built), reason: buildRes?.built ? 'rebuilt_but_missing' : 'missing' };
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
  const raw = (process.env.HAPPY_STACKS_DAEMON_WAIT_FOR_AUTH ?? process.env.HAPPY_LOCAL_DAEMON_WAIT_FOR_AUTH ?? '')
    .toString()
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

function authLoginHint({ stackName, cliIdentity }) {
  const id = (cliIdentity ?? '').toString().trim();
  const suffix = id && id !== 'default' ? ` --identity=${id} --no-open` : '';
  return stackName === 'main' ? `happys auth login${suffix}` : `happys stack auth ${stackName} login${suffix}`;
}

function authCopyFromSeedHint({ stackName, cliIdentity }) {
  if (stackName === 'main') return null;
  // For multi-identity daemons, copying credentials defeats the purpose (multiple accounts).
  const id = (cliIdentity ?? '').toString().trim();
  if (id && id !== 'default') return null;
  const seed = resolveAuthSeedFromEnv(process.env);
  return `happys stack auth ${stackName} copy-from ${seed}`;
}

async function maybeAutoReseedInvalidAuth({ stackName, quiet = false }) {
  if (stackName === 'main') return { ok: false, skipped: true, reason: 'main' };
  const env = process.env;
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const enabled = resolveAutoCopyFromMainEnabled({ env, stackName, isInteractive });
  if (!enabled) return { ok: false, skipped: true, reason: 'disabled' };

  const seed = resolveAuthSeedFromEnv(env);
  if (!quiet) {
    console.log(`[local] auth: invalid token detected; re-seeding ${stackName} from ${seed}...`);
  }
  const rootDir = getRootDir(import.meta.url);

  // Use stack-scoped auth copy so env/database resolution is correct for the target stack.
  await run(process.execPath, [join(rootDir, 'scripts', 'stack.mjs'), 'auth', stackName, '--', 'copy-from', seed], {
    cwd: rootDir,
    env,
  });
  return { ok: true, skipped: false, seed };
}

async function seedCredentialsIfMissing({ cliHomeDir }) {
  const stacksRoot = getStacksStorageRoot();
  const allowGlobal = sandboxAllowsGlobalSideEffects();

  const sources = [
    // New layout: main stack credentials (preferred).
    join(stacksRoot, 'main', 'cli'),
    ...((!isSandboxed() || allowGlobal)
      ? [
          // Legacy happy-local storage root (most common for existing users).
          join(homedir(), '.happy', 'local', 'cli'),
          // Older global location.
          join(homedir(), '.happy'),
        ]
      : []),
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

  // access.key holds the auth token + encryption material (keep tight permissions)
  const access = await copyIfMissing({ relPath: 'access.key', mode: 0o600, label: 'CLI credentials (access.key)' })
    .catch((err) => {
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

async function killDaemonFromLockFile({ cliHomeDir }) {
  const lockPath = join(cliHomeDir, 'daemon.state.json.lock');
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
    ownsLock = out.includes(lockPath) || out.includes(join(cliHomeDir, 'daemon.state.json')) || out.includes(join(cliHomeDir, 'logs'));
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

async function waitForCredentialsFile({ path, timeoutMs, isShuttingDown }) {
  const deadline = Date.now() + timeoutMs;
  while (!isShuttingDown() && Date.now() < deadline) {
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
    await delay(500);
  }
  return false;
}

export function getDaemonEnv({ baseEnv, cliHomeDir, internalServerUrl, publicServerUrl }) {
  return {
    ...baseEnv,
    HAPPY_SERVER_URL: internalServerUrl,
    HAPPY_WEBAPP_URL: publicServerUrl,
    HAPPY_HOME_DIR: cliHomeDir,
  };
}

export async function stopLocalDaemon({ cliBin, internalServerUrl, cliHomeDir }) {
  const env = {
    ...process.env,
    HAPPY_SERVER_URL: internalServerUrl,
    HAPPY_HOME_DIR: cliHomeDir,
  };

  try {
    await new Promise((resolve) => {
      const proc = spawnProc('daemon', process.execPath, [cliBin, 'daemon', 'stop'], env, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('exit', () => resolve());
    });
  } catch {
    // ignore
  }

  // If the daemon never wrote daemon.state.json (e.g. it got stuck in auth in a non-interactive context),
  // stopLocalDaemon() can't find it. Fall back to the lock file PID.
  await killDaemonFromLockFile({ cliHomeDir });
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
    (env.HAPPY_STACKS_STACK ?? env.HAPPY_LOCAL_STACK ?? '').toString().trim() ||
    'main';
  const resolvedCliIdentity =
    (cliIdentity ?? '').toString().trim() ||
    (env.HAPPY_STACKS_CLI_IDENTITY ?? env.HAPPY_LOCAL_CLI_IDENTITY ?? '').toString().trim() ||
    'default';
  const baseEnv = { ...env };
  const daemonEnv = getDaemonEnv({ baseEnv, cliHomeDir, internalServerUrl, publicServerUrl });

  const distEntrypoint = resolveHappyCliDistEntrypoint(cliBin);
  const distCheck = await ensureHappyCliDistExists({ cliBin });
  if (!distCheck.ok) {
    throw new Error(
      `[local] happy-cli dist entrypoint is missing (${distEntrypoint}).\n` +
        `[local] Refusing to start/restart daemon because it would crash with MODULE_NOT_FOUND.\n` +
        `[local] Fix: rebuild happy-cli in the active checkout/worktree.\n` +
        (distCheck.reason ? `[local] Detail: ${distCheck.reason}\n` : '')
    );
  }

  // If this is a migrated/new stack home dir, seed credentials from the user's existing login (best-effort)
  // to avoid requiring an interactive auth flow under launchd.
  const migrateCreds = (baseEnv.HAPPY_STACKS_MIGRATE_CREDENTIALS ?? baseEnv.HAPPY_LOCAL_MIGRATE_CREDENTIALS ?? '1').trim() !== '0';
  if (migrateCreds) {
    await seedCredentialsIfMissing({ cliHomeDir });
  }

  const existing = checkDaemonState(cliHomeDir);
  // If the daemon is already running and we're restarting it, refuse to stop it unless the
  // happy-cli dist entrypoint exists. Otherwise a rebuild (rm -rf dist) can brick the stack.
  if (
    distEntrypoint &&
    !existsSync(distEntrypoint) &&
    (existing.status === 'running' || existing.status === 'starting')
  ) {
    console.warn(
      `[local] happy-cli dist entrypoint is missing (${distEntrypoint}).\n` +
        `[local] Refusing to restart daemon to avoid downtime. Rebuild happy-cli first.`
    );
    return;
  }

  if (!forceRestart && existing.status === 'running') {
    const pid = existing.pid;
    const matches = await daemonEnvMatches({ pid, cliHomeDir, internalServerUrl, publicServerUrl });
    if (matches === true) {
      // eslint-disable-next-line no-console
      console.log(`[local] daemon already running for stack home (pid=${pid})`);
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

  // Best-effort: for the main stack, also stop the legacy global daemon home (~/.happy) to prevent legacy overlap.
  if (resolvedStackName === 'main' && (!isSandboxed() || sandboxAllowsGlobalSideEffects())) {
    const legacyEnv = { ...daemonEnv, HAPPY_HOME_DIR: join(homedir(), '.happy') };
    try {
      await new Promise((resolve) => {
        const proc = spawnProc('daemon', process.execPath, [cliBin, 'daemon', 'stop'], legacyEnv, { stdio: ['ignore', 'pipe', 'pipe'] });
        proc.on('exit', () => resolve());
      });
    } catch {
      // ignore
    }
    // If state is missing and stop couldn't find it, force-stop the lock PID (otherwise repeated restarts accumulate daemons).
    await killDaemonFromLockFile({ cliHomeDir: join(homedir(), '.happy') });
    await cleanupStaleDaemonState(join(homedir(), '.happy'));
  }

  // If state is missing and stop couldn't find it, force-stop the lock PID (otherwise repeated restarts accumulate daemons).
  await killDaemonFromLockFile({ cliHomeDir });

  // Clean up stale lock/state files that can block daemon start.
  await cleanupStaleDaemonState(cliHomeDir);

  const credentialsPath = join(cliHomeDir, 'access.key');

  const startOnce = async () => {
    const exitCode = await new Promise((resolve) => {
      const proc = spawnProc('daemon', process.execPath, [cliBin, 'daemon', 'start'], daemonEnv, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('exit', (code) => resolve(code ?? 0));
    });

    if (exitCode === 0) {
      return { ok: true, exitCode, excerpt: null, logPath: null };
    }

    // Some daemon versions (or transient races) can return non-zero even if the daemon
    // is already running / starting for this stack home dir (e.g. "lock already held").
    // In those cases, fail-open and keep the stack running; callers can still surface
    // daemon status separately.
    await delay(500);
    const stateAfter = checkDaemonState(cliHomeDir);
    if (stateAfter.status === 'running') {
      return { ok: true, exitCode, excerpt: null, logPath: null };
    }

    const logPath =
      getLatestDaemonLogPath(cliHomeDir) ||
      ((!isSandboxed() || sandboxAllowsGlobalSideEffects()) ? getLatestDaemonLogPath(join(homedir(), '.happy')) : null);
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
      const copyHint = authCopyFromSeedHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity });
      const hint =
        `[local] daemon is not authenticated yet (expected on first run).\n` +
        `[local] In another terminal, run:\n` +
        `${authLoginHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity })}\n` +
        (copyHint ? `[local] Or (recommended if main is already logged in):\n${copyHint}\n` : '');
      if (!isInteractive) {
        throw new Error(`${hint}[local] Non-interactive mode: refusing to wait for credentials.`);
      }

      console.error(`${hint}[local] Keeping the server running so you can login.\n[local] Waiting for credentials at ${credentialsPath}...`);

      const ok = await waitForCredentialsFile({ path: credentialsPath, timeoutMs: 10 * 60_000, isShuttingDown });
      if (!ok) {
        throw new Error('Timed out waiting for daemon credentials (auth login not completed)');
      }

      // If a daemon start attempt was already in-flight (or a previous daemon is already running),
      // avoid a second concurrent start and treat it as success.
      await delay(500);
      const stateAfterCreds = checkDaemonState(cliHomeDir);
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
      try {
        await maybeAutoReseedInvalidAuth({ stackName });
      } catch (e) {
        const copyHint = authCopyFromSeedHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity });
        console.error(
          `[local] daemon credentials were rejected by the server (401).\n` +
            `[local] Fix:\n` +
            (copyHint ? `- ${copyHint}\n` : '') +
            `- ${authLoginHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity })}`
        );
        throw e;
      }

      console.log('[local] auth re-seeded, retrying daemon start...');
      const second = await startOnce();
      if (!second.ok) {
        if (second.excerpt) {
          console.error(`[local] daemon still failed to start; last daemon log (${second.logPath}):\n${second.excerpt}`);
        }
        throw new Error('Failed to start daemon (after auth re-seed)');
      }
    } else {
      const copyHint = authCopyFromSeedHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity });
      console.error(
        `[local] daemon failed to start (server returned an error).\n` +
          `[local] Try:\n` +
          `- happys doctor\n` +
          (copyHint ? `- ${copyHint}\n` : '') +
          `- ${authLoginHint({ stackName: resolvedStackName, cliIdentity: resolvedCliIdentity })}`
      );
      throw new Error('Failed to start daemon');
    }
  }

  // Confirm daemon status (best-effort)
  try {
    await run('node', [cliBin, 'daemon', 'status'], { env: daemonEnv });
  } catch {
    // ignore
  }
}

export async function daemonStatusSummary({ cliBin, cliHomeDir, internalServerUrl, publicServerUrl }) {
  const env = getDaemonEnv({ baseEnv: process.env, cliHomeDir, internalServerUrl, publicServerUrl });
  return await runCapture('node', [cliBin, 'daemon', 'status'], { env });
}
