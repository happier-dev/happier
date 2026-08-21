import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isPidAlive } from '../proc/pids.mjs';
import { isTcpPortFree, listListenPidsWithStatus } from '../net/ports.mjs';
import { runCapture } from '../proc/proc.mjs';
import { writeJsonAtomic } from '../fs/json.mjs';
import { withJsonOwnerFileLock } from '../proc/jsonOwnerFileLock.mjs';

export { isPidAlive };

function resolveMetroStatusTimeoutMsFromEnv(env = process.env) {
  const raw = (env.HAPPIER_STACK_EXPO_METRO_STATUS_TIMEOUT_MS ?? '').toString().trim();
  const n = raw ? Number(raw) : null;
  if (Number.isFinite(n) && n > 0) return n;
  return 800;
}

export async function looksLikeExpoMetro({ port, timeoutMs = null, env = process.env } = {}) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) return false;
  const ms = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : resolveMetroStatusTimeoutMsFromEnv(env);
  const url = `http://127.0.0.1:${p}/status`;
  try {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = setTimeout(() => controller?.abort(), ms);
    try {
      const res = await fetch(url, { signal: controller?.signal });
      const txt = await res.text().catch(() => '');
      return res.ok && String(txt).toLowerCase().includes('packager-status:running');
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

function resolveMetroWaitTimeoutMsFromEnv(env = process.env) {
  const raw = (env.HAPPIER_STACK_EXPO_METRO_WAIT_TIMEOUT_MS ?? '').toString().trim();
  const n = raw ? Number(raw) : null;
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 120_000;
}

function resolveMetroWaitIntervalMsFromEnv(env = process.env) {
  const raw = (env.HAPPIER_STACK_EXPO_METRO_WAIT_INTERVAL_MS ?? '').toString().trim();
  const n = raw ? Number(raw) : null;
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 500;
}

async function getProcessGroupIdForReadiness(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1 || process.platform === 'win32') return null;
  try {
    const out = await runCapture('ps', ['-o', 'pgid=', '-p', String(n)]);
    const pgid = Number(String(out ?? '').trim());
    return Number.isFinite(pgid) && pgid > 1 ? pgid : null;
  } catch {
    return null;
  }
}

async function isWindowsDescendantProcess(listenerPid, ownerPid) {
  if (process.platform !== 'win32') return false;
  const script = [
    `$target=${Number(listenerPid)};`,
    `$owner=${Number(ownerPid)};`,
    'while ($target -gt 1) {',
    '  $p=Get-CimInstance Win32_Process -Filter "ProcessId=$target";',
    '  if (-not $p) { break };',
    '  $target=[int]$p.ParentProcessId;',
    '  if ($target -eq $owner) { Write-Output owned; exit 0 }',
    '};',
    'exit 1',
  ].join(' ');
  try {
    const out = await runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 4000 });
    return String(out ?? '').trim() === 'owned';
  } catch {
    return false;
  }
}

async function observeMetroListenerOwnership(
  { port, ownerPid, env },
  {
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    getProcessGroupIdImpl = getProcessGroupIdForReadiness,
    isWindowsDescendantProcessImpl = isWindowsDescendantProcess,
    platform = process.platform,
  } = {},
) {
  const listeners = await listListenPidsWithStatusImpl(port, { timeoutMs: 4000, env });
  if (listeners.status !== 'ok') {
    return { status: 'inconclusive', reason: listeners.reason ?? listeners.status, observation: listeners };
  }
  const listenerPids = listeners.pids;
  if (!listenerPids.length) return { status: 'not_ready', reason: 'listener_not_observed', listenerPids };
  const ownedListenerPids = [];
  const foreignListenerPids = [];
  if (platform === 'win32') {
    for (const listenerPid of listenerPids) {
      if (listenerPid === Number(ownerPid)) {
        ownedListenerPids.push(listenerPid);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      if (await isWindowsDescendantProcessImpl(listenerPid, ownerPid)) {
        ownedListenerPids.push(listenerPid);
      } else {
        foreignListenerPids.push(listenerPid);
      }
    }
  } else {
    const ownerPgid = await getProcessGroupIdImpl(ownerPid);
    for (const listenerPid of listenerPids) {
      if (listenerPid === Number(ownerPid)) {
        ownedListenerPids.push(listenerPid);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const listenerPgid = await getProcessGroupIdImpl(listenerPid);
      if (ownerPgid && listenerPgid && listenerPgid === ownerPgid) {
        ownedListenerPids.push(listenerPid);
      } else {
        foreignListenerPids.push(listenerPid);
      }
    }
  }
  if (foreignListenerPids.length) {
    return {
      status: 'not_owned',
      reason: ownedListenerPids.length ? 'competing_listener' : 'listener_not_owned',
      listenerPids,
      ownedListenerPids,
      foreignListenerPids,
    };
  }
  if (!ownedListenerPids.length) {
    return { status: 'not_owned', reason: 'listener_not_owned', listenerPids };
  }
  return { status: 'owned', reason: 'all_listeners_owned', listenerPids, ownedListenerPids };
}

export async function waitForExpoMetroRunning(
  {
    port,
    ownerPid = null,
    ownerProc = null,
    timeoutMs = null,
    intervalMs = null,
    env = process.env,
    onTimeoutCheckpoint = ({ timeoutMs: checkpointMs }) => {
      console.warn(`[stack] Metro is still starting on port ${port} after ${checkpointMs}ms; continuing to wait (TUI is attended)`);
    },
  } = {},
  {
    looksLikeExpoMetroImpl = looksLikeExpoMetro,
    delayImpl = delay,
    nowMsImpl = () => Date.now(),
    listListenPidsWithStatusImpl = listListenPidsWithStatus,
    getProcessGroupIdImpl = getProcessGroupIdForReadiness,
    isWindowsDescendantProcessImpl = isWindowsDescendantProcess,
    platform = process.platform,
  } = {},
) {
  const p = Number(port);
  if (!Number.isFinite(p) || p <= 0) {
    return { ok: false, reason: 'invalid_port', probes: 0 };
  }
  const resolvedTimeoutMs =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : resolveMetroWaitTimeoutMsFromEnv(env);
  const resolvedIntervalMs =
    Number.isFinite(Number(intervalMs)) && Number(intervalMs) > 0
      ? Number(intervalMs)
      : resolveMetroWaitIntervalMsFromEnv(env);

  let checkpointStartMs = nowMsImpl();
  let probes = 0;
  let lastOwnership = null;
  const ownershipRequired = typeof ownerPid === 'function' || (Number.isFinite(Number(ownerPid)) && Number(ownerPid) > 1);
  while (true) {
    if (ownerProc && (ownerProc.exitCode !== null || ownerProc.signalCode !== null)) {
      return { ok: false, reason: 'owner_process_exited', probes };
    }
    if (nowMsImpl() - checkpointStartMs > resolvedTimeoutMs) {
      const attendedOwnerAlive = env?.HAPPIER_STACK_TUI === '1'
        && ownerProc
        && ownerProc.exitCode == null
        && ownerProc.signalCode == null;
      if (!attendedOwnerAlive) break;
      onTimeoutCheckpoint?.({ timeoutMs: resolvedTimeoutMs, port: p, probes });
      checkpointStartMs = nowMsImpl();
    }
    // eslint-disable-next-line no-await-in-loop
    const statusProbe = looksLikeExpoMetroImpl({ port: p, env });
    // eslint-disable-next-line no-await-in-loop
    const statusResult = ownerProc
      ? await new Promise((resolvePromise) => {
          const onExit = () => resolvePromise({ kind: 'exit' });
          ownerProc.once('exit', onExit);
          statusProbe.then((ok) => {
            ownerProc.removeListener('exit', onExit);
            resolvePromise({ kind: 'status', ok });
          });
        })
      : { kind: 'status', ok: await statusProbe };
    if (statusResult.kind === 'exit') {
      return { ok: false, reason: 'owner_process_exited', probes };
    }
    const ok = statusResult.ok;
    probes += 1;
    if (ok) {
      const currentOwnerPid = typeof ownerPid === 'function' ? ownerPid() : ownerPid;
      if (!ownershipRequired) {
        return { ok: true, probes };
      }
      if (!Number.isFinite(Number(currentOwnerPid)) || Number(currentOwnerPid) <= 1) {
        lastOwnership = { status: 'not_owned', reason: 'owner_process_missing', listenerPids: [] };
        // eslint-disable-next-line no-await-in-loop
        await delayImpl(resolvedIntervalMs);
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      lastOwnership = await observeMetroListenerOwnership(
        { port: p, ownerPid: Number(currentOwnerPid), env },
        { listListenPidsWithStatusImpl, getProcessGroupIdImpl, isWindowsDescendantProcessImpl, platform },
      );
      if (lastOwnership.status === 'owned') {
        return {
          ok: true,
          probes,
          ownerPid: Number(currentOwnerPid),
          listenerPid: lastOwnership.ownedListenerPids.includes(Number(currentOwnerPid))
            ? Number(currentOwnerPid)
            : lastOwnership.ownedListenerPids[0],
          ownedListenerPids: Object.freeze([...lastOwnership.ownedListenerPids]),
          listenerPids: lastOwnership.listenerPids,
          port: p,
        };
      }
      if (lastOwnership.status === 'not_owned') {
        return {
          ok: false,
          reason: lastOwnership.reason,
          probes,
          listenerPids: lastOwnership.listenerPids,
          ownedListenerPids: lastOwnership.ownedListenerPids ?? [],
          foreignListenerPids: lastOwnership.foreignListenerPids ?? [],
        };
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await delayImpl(resolvedIntervalMs);
  }
  if (lastOwnership?.status === 'inconclusive') {
    return {
      ok: false,
      reason: 'listener_ownership_inconclusive',
      probes,
      observation: lastOwnership.observation,
    };
  }
  if (lastOwnership?.status === 'not_owned') {
    return {
      ok: false,
      reason: lastOwnership.reason,
      probes,
      listenerPids: lastOwnership.listenerPids,
      ownedListenerPids: lastOwnership.ownedListenerPids ?? [],
      foreignListenerPids: lastOwnership.foreignListenerPids ?? [],
    };
  }
  return { ok: false, reason: lastOwnership?.reason ?? 'timeout', probes };
}

function hashDir(dir) {
  return createHash('sha1').update(String(dir ?? '')).digest('hex').slice(0, 12);
}

export function getExpoStatePaths({ baseDir, kind, projectDir, stateFileName = 'expo.state.json' }) {
  const key = hashDir(projectDir);
  const stateDir = join(baseDir, kind, key);
  return {
    key,
    stateDir,
    statePath: join(stateDir, stateFileName),
    expoHomeDir: join(stateDir, 'expo-home'),
    tmpDir: join(stateDir, 'tmp'),
  };
}

export function resolveExpoTmpDir({ env = process.env, defaultTmpDir, kind, projectDir } = {}) {
  const def = String(defaultTmpDir ?? '').trim();
  const base = (env?.HAPPIER_STACK_EXPO_SHARED_TMPDIR_BASE_DIR ?? '').toString().trim();
  if (!base) return def;

  const keyRaw = (env?.HAPPIER_STACK_EXPO_SHARED_TMPDIR_KEY ?? '').toString().trim();
  const keySource = keyRaw || String(projectDir ?? '').trim() || def;
  if (!keySource) return def;

  const k = String(kind ?? '').trim() || 'expo';
  const key = hashDir(keySource);
  return join(base, 'tmp', k, key);
}

export async function ensureExpoIsolationEnv({ env, stateDir, expoHomeDir, tmpDir }) {
  await mkdir(stateDir, { recursive: true });
  await mkdir(expoHomeDir, { recursive: true });
  await mkdir(tmpDir, { recursive: true });

  // Expo CLI uses this to override ~/.expo.
  // Always override: stack/worktree isolation must not fall back to the user's global ~/.expo.
  env.__UNSAFE_EXPO_HOME_DIRECTORY = expoHomeDir;

  // Metro default cache root is `path.join(os.tmpdir(), 'metro-cache')`, so TMPDIR isolates it.
  // Always override: macOS sets TMPDIR by default, so a "set-if-missing" guard would not isolate Metro.
  env.TMPDIR = tmpDir;
}

export function wantsExpoClearCache({ env }) {
  const raw = (env.HAPPIER_STACK_EXPO_CLEAR_CACHE ?? '').trim();
  if (raw) {
    return raw !== '0';
  }
  // Default: clear cache when non-interactive (LLMs/services), keep fast iteration in TTY shells.
  return !(process.stdin.isTTY && process.stdout.isTTY);
}

export async function readPidState(statePath) {
  try {
    if (!existsSync(statePath)) return null;
    const raw = await readFile(statePath, 'utf-8');
    const state = JSON.parse(raw);
    const pid = Number(state?.pid);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    return state;
  } catch {
    return null;
  }
}

async function readProcessIdentityLine(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return null;
  if (process.platform === 'win32') return null;
  if (process.platform === 'linux') {
    const [cmdline, environ] = await Promise.all([
      readFile(`/proc/${n}/cmdline`, 'utf-8')
        .then((raw) => String(raw ?? '').replaceAll('\0', ' ').trim())
        .catch(() => ''),
      readFile(`/proc/${n}/environ`, 'utf-8')
        .then((raw) => String(raw ?? '').replaceAll('\0', ' ').trim())
        .catch(() => ''),
    ]);
    const line = `${cmdline} ${environ}`.trim();
    return line || null;
  }
  try {
    const out = await runCapture('ps', ['eww', '-p', String(n)]);
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length >= 2) return lines[1];
    if (lines.length === 1) return lines[0];
    return null;
  } catch {
    return null;
  }
}

async function verifyStatePidIdentity({ pid, state, statePath, readProcessIdentityLineImpl = readProcessIdentityLine }) {
  const line = await readProcessIdentityLineImpl(pid);
  if (!line) {
    return { ok: process.platform === 'win32', reason: 'pid_unverified' };
  }

  const expectedExpoHomeDir = join(dirname(statePath), 'expo-home');
  const expectedExpoHomeDirs = new Set([expectedExpoHomeDir, resolve(expectedExpoHomeDir)]);
  const expoHomeNeedle = '__UNSAFE_EXPO_HOME_DIRECTORY=';
  if (line.includes(expoHomeNeedle)) {
    for (const candidate of expectedExpoHomeDirs) {
      if (line.includes(`${expoHomeNeedle}${candidate}`)) {
        return { ok: true, reason: 'pid' };
      }
    }
    return { ok: false, reason: 'pid_identity_mismatch' };
  }

  const projectDir = String(state?.projectDir ?? state?.uiDir ?? '').trim();
  if (projectDir && line.includes(resolve(projectDir))) {
    return { ok: true, reason: 'pid' };
  }
  if (projectDir) {
    return { ok: false, reason: 'pid_identity_mismatch' };
  }
  return { ok: true, reason: 'pid' };
}

export async function isStateProcessRunning(
  statePath,
  { readProcessIdentityLineImpl = readProcessIdentityLine } = {},
) {
  const state = await readPidState(statePath);
  if (!state) return { running: false, state: null };
  const pid = Number(state.pid);
  if (isPidAlive(pid)) {
    const identity = await verifyStatePidIdentity({ pid, state, statePath, readProcessIdentityLineImpl });
    if (!identity.ok) {
      return { running: false, state, reason: identity.reason };
    }
    return { running: true, state, reason: identity.reason };
  }

  async function looksOwnedByProjectDir(port, projectDir) {
    const p = Number(port);
    const raw = String(projectDir ?? '').trim();
    if (!Number.isFinite(p) || p <= 0) return false;
    if (!raw) return false;
    const needle = resolve(raw);
    const listenerObservation = await listListenPidsWithStatus(p, { timeoutMs: 4000 });
    if (listenerObservation.status !== 'ok') return false;
    const pids = listenerObservation.pids;
    for (const listenPid of pids) {
      // eslint-disable-next-line no-await-in-loop
      const line = await runCapture('ps', ['-o', 'command=', '-p', String(listenPid)]).catch(() => '');
      if (line && String(line).includes(needle)) {
        return true;
      }
    }
    return false;
  }

  // Expo/Metro can sometimes be “up” even if the original wrapper pid exited (pm/yarn layers).
  // If we have a port and something is listening on it, treat it as running only if it looks like Metro.
  const port = Number(state?.port);
  if (Number.isFinite(port) && port > 0) {
    try {
      const free = await isTcpPortFree(port, { host: '127.0.0.1' });
      if (!free) {
        const ok = await looksLikeExpoMetro({ port });
        if (ok) {
          const projectDir = String(state?.projectDir ?? '').trim() || String(state?.uiDir ?? '').trim();
          if (projectDir) {
            const owned = await looksOwnedByProjectDir(port, projectDir);
            if (!owned) {
              return { running: false, state, reason: 'port_project_mismatch' };
            }
          }
          return { running: true, state, reason: 'port' };
        }
        return { running: false, state };
      }
    } catch {
      // ignore
    }
  }

  return { running: false, state };
}

export async function writePidState(statePath, state) {
  await withJsonOwnerFileLock(
    () => writeJsonAtomic(statePath, state),
    {
      lockPath: `${statePath}.publication.lock`,
      timeoutMs: 30_000,
      pollIntervalMs: 50,
      staleAfterMs: 60_000,
      errorLabel: 'Expo PID state publication',
    },
  );
}

async function readExpoPidStateForMutation(statePath) {
  try {
    return JSON.parse(await readFile(statePath, 'utf-8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function commitExpoPidStatePublication(statePath, {
  publicationToken,
  expectedPreviousToken = null,
  generation,
  state,
} = {}) {
  const token = String(publicationToken ?? '').trim();
  const expectedGeneration = Number(generation);
  if (!token) throw new Error('[expo] missing PID publication token');
  if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
    throw new Error('[expo] invalid PID publication generation');
  }
  return await withJsonOwnerFileLock(async () => {
    const current = await readExpoPidStateForMutation(statePath);
    if ((current?.publicationToken ?? null) !== expectedPreviousToken) {
      const error = new Error('[expo] PID state publication generation was superseded');
      error.code = 'EEXPOPIDGENERATION';
      throw error;
    }
    const next = {
      ...(state ?? {}),
      publicationGeneration: expectedGeneration,
      publicationToken: token,
    };
    await writeJsonAtomic(statePath, next);
    return next;
  }, {
    lockPath: `${statePath}.publication.lock`,
    timeoutMs: 30_000,
    pollIntervalMs: 50,
    staleAfterMs: 60_000,
    errorLabel: 'Expo PID state publication',
  });
}

export async function restoreExpoPidStatePublication(statePath, { publicationToken, priorState } = {}) {
  return await withJsonOwnerFileLock(async () => {
    const current = await readExpoPidStateForMutation(statePath);
    if (current?.publicationToken !== publicationToken) return false;
    if (priorState == null) {
      await unlink(statePath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    } else {
      await writeJsonAtomic(statePath, priorState);
    }
    return true;
  }, {
    lockPath: `${statePath}.publication.lock`,
    timeoutMs: 30_000,
    pollIntervalMs: 50,
    staleAfterMs: 60_000,
    errorLabel: 'Expo PID state rollback',
  });
}

export async function findRunningExpoStateInRoot({ expoDevRoot, requireWeb = false, expectedProjectDir = '' } = {}) {
  const root = String(expoDevRoot ?? '').trim();
  if (!root) return null;
  if (!existsSync(root)) return null;
  const expected = String(expectedProjectDir ?? '').trim();
  const expectedResolved = expected ? resolve(expected) : '';
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const statePath = join(root, ent.name, 'expo.state.json');
    if (!existsSync(statePath)) continue;
    // eslint-disable-next-line no-await-in-loop
    const res = await isStateProcessRunning(statePath);
    if (!res?.running) continue;
    if (requireWeb && res?.state?.webEnabled === false) continue;
    if (expectedResolved) {
      const projectDirRaw = String(res?.state?.projectDir ?? res?.state?.uiDir ?? '').trim();
      if (!projectDirRaw) continue;
      if (resolve(projectDirRaw) !== expectedResolved) continue;
    }
    return { statePath, state: res.state };
  }
  return null;
}

export async function killPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return;
  try {
    process.kill(n, 'SIGTERM');
  } catch {
    return;
  }
  await delay(500);
  try {
    process.kill(n, 0);
    process.kill(n, 'SIGKILL');
  } catch {
    // exited
  }
}
