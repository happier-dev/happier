import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isPidAlive } from '../proc/pids.mjs';
import { isTcpPortFree } from '../net/ports.mjs';

export { isPidAlive };

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

export async function isStateProcessRunning(statePath) {
  const state = await readPidState(statePath);
  if (!state) return { running: false, state: null };
  const pid = Number(state.pid);
  if (isPidAlive(pid)) {
    return { running: true, state, reason: 'pid' };
  }

  // Expo/Metro can sometimes be “up” even if the original wrapper pid exited (pm/yarn layers).
  // If we have a port and something is listening on it, treat it as running.
  const port = Number(state?.port);
  if (Number.isFinite(port) && port > 0) {
    try {
      const free = await isTcpPortFree(port, { host: '127.0.0.1' });
      if (!free) {
        return { running: true, state, reason: 'port' };
      }
    } catch {
      // ignore
    }
  }

  return { running: false, state };
}

export async function writePidState(statePath, state) {
  await mkdir(dirname(statePath), { recursive: true }).catch(() => {});
  await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
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
