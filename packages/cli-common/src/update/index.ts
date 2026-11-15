import { doesVersionMatchReleaseRing } from './releaseRingVersion.js';
export { doesVersionMatchReleaseRing } from './releaseRingVersion.js';
import { compareVersions } from './compareVersions.js';
export { compareVersions } from './compareVersions.js';
import { spawnSync, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { resolvePublicReleaseRingLabelForId, type PublicReleaseRingId } from '@happier-dev/release-runtime/releaseRings';

import { resolveWindowsCommandInvocation } from '../process/index.js';

export type UpdateCache = {
  checkedAt: number | null;
  latest: string | null;
  current: string | null;
  runtimeVersion: string | null;
  invokerVersion: string | null;
  updateAvailable: boolean;
  notifiedAt: number | null;
};

export function isValidNpmPackageName(raw: string): boolean {
  const s = String(raw ?? '').trim();
  if (!s) return false;
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(s)) return false;
  const parts = s.split('/');
  return parts.every((p) => p !== '.' && p !== '..');
}

export function resolveNpmPackageNameOverride(params: Readonly<{ envValue: string | undefined; fallback: string }>): string {
  const fallback = String(params.fallback ?? '').trim();
  const raw = String(params.envValue ?? '').trim();
  if (!raw) return fallback;
  return isValidNpmPackageName(raw) ? raw : fallback;
}

export function acquireSingleFlightLock(params: Readonly<{ lockPath: string; nowMs: number; ttlMs: number; pid: number }>): boolean {
  const lockPath = String(params.lockPath ?? '').trim();
  if (!lockPath) return false;
  const ttlMs = Number(params.ttlMs);
  const nowMs = Number(params.nowMs);
  const pid = Number(params.pid);
  if (!Number.isFinite(nowMs) || !Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(pid)) return false;

  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch {
    // ignore
  }

  const payload = JSON.stringify({ pid, acquiredAtMs: nowMs }, null, 2) + '\n';
  try {
    writeFileSync(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (e: any) {
    if (!e || e.code !== 'EEXIST') return false;
  }

  // Existing lock. If it's expired, best-effort delete and try again.
  let acquiredAt = 0;
  try {
    const raw = readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    acquiredAt = Number(parsed?.acquiredAtMs ?? 0);
  } catch {
    acquiredAt = 0;
  }

  if (Number.isFinite(acquiredAt) && acquiredAt > 0 && nowMs - acquiredAt <= ttlMs) {
    return false;
  }

  try {
    unlinkSync(lockPath);
  } catch {
    return false;
  }

  try {
    writeFileSync(lockPath, payload, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export function normalizeSemverBase(raw: string): string | null {
  const s = String(raw ?? '').trim();
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/.exec(s);
  if (!m) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

export function computePreviewVersion(params: Readonly<{ baseVersion: string; runNumber: number }>): string {
  const base = normalizeSemverBase(params.baseVersion);
  if (!base) {
    throw new Error(`Invalid baseVersion "${params.baseVersion}"`);
  }
  const run = Math.max(0, Math.floor(Number(params.runNumber)));
  if (!Number.isFinite(run)) {
    throw new Error(`Invalid runNumber "${params.runNumber}"`);
  }
  return `${base}-preview.${run}`;
}

export function shouldNotifyUpdate(params: Readonly<{
  isTTY: boolean;
  cmd: string;
  updateAvailable: boolean;
  latest: string | null;
  notifiedAt: number | null;
  notifyIntervalMs: number;
  nowMs?: number;
}>): boolean {
  const now = params.nowMs ?? Date.now();
  if (!params.isTTY) return false;
  if (!params.updateAvailable) return false;
  if (!params.latest) return false;
  if (params.cmd === 'self' || params.cmd === 'help' || params.cmd === '--help' || params.cmd === '-h') return false;
  const interval = Number(params.notifyIntervalMs);
  const last = Number(params.notifiedAt ?? 0);
  if (!last) return true;
  if (!Number.isFinite(interval) || interval <= 0) return true;
  return now - last > interval;
}

/**
 * The one location of the CLI's per-channel update-check cache, written by `happier self check`
 * and read by the update notice, `doctor repair`, and the desktop's status facts.
 */
export function resolveCliUpdateCachePath(params: Readonly<{
  happierHomeDir: string;
  /** Public channel label: `stable`, `preview`, or `dev`. */
  channelLabel: string;
}>): string {
  const fileName = params.channelLabel === 'stable' ? 'update.json' : `update.${params.channelLabel}.json`;
  return join(params.happierHomeDir, 'cache', fileName);
}

/** The single-flight lock that keeps one background `self check` per channel. */
export function resolveCliUpdateCheckLockPath(params: Readonly<{
  happierHomeDir: string;
  channelLabel: string;
}>): string {
  const fileName = params.channelLabel === 'stable' ? 'update.check.lock.json' : `update.check.${params.channelLabel}.lock.json`;
  return join(params.happierHomeDir, 'cache', fileName);
}

/** How long a `self check` result stays fresh before the background refresh runs again. */
export const CLI_UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * How long one background `self check` holds its per-channel single-flight lock before another may
 * start. One value for every starter — the terminal notice (which lets
 * `HAPPIER_CLI_UPDATE_CHECK_LOCK_TTL_MS` override it) and the desktop's status fact (plan R13 S-1).
 */
export const CLI_UPDATE_CHECK_LOCK_TTL_MS = 2 * 60 * 1000;

export function readUpdateCache(path: string): UpdateCache | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as UpdateCache;
  } catch {
    return null;
  }
}

export function writeUpdateCache(path: string, cache: UpdateCache): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(cache, null, 2) + '\n', 'utf-8');
  } catch {
    // ignore
  }
}

export function resolveSpawnDetachedNodeInvocation(params: Readonly<{ execPath: string; script: string; args: string[] }>): {
  file: string;
  args: string[];
  isRuntime: boolean;
} {
  const execPath = String(params.execPath ?? '').trim();
  const base = basename(execPath).toLowerCase();
  const isRuntime = base === 'node' || base === 'node.exe' || base === 'bun' || base === 'bun.exe';
  if (isRuntime) {
    return { file: execPath, args: [params.script, ...params.args], isRuntime };
  }
  return { file: execPath, args: [...params.args], isRuntime };
}

export type DetachedSpawnResult = Readonly<{
  started: boolean;
  /** The child's report pipe when `admissionFdEnvName` was given. */
  admission: NodeJS.ReadableStream | null;
}>;

/**
 * Start this program (the running binary, or `script` under the running Node/Bun) detached, so it
 * outlives the caller: the background update check, and the daemon-started CLI updater, which must
 * survive the service restart it performs. Output is discarded, or appended to `logPath`. Never
 * throws; reports whether the process started.
 */
export function spawnDetachedNode(params: Readonly<{
  script: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath?: string;
  /**
   * Give the child one extra pipe (fd 3, named to it by `admissionFdEnvName`) for a single report
   * back to this process — stdout/stderr stay on `logPath`, so the child never writes to a pipe
   * whose reader may be gone once it outlives this process.
   */
  admissionFdEnvName?: string;
}>): DetachedSpawnResult {
  let logFd: number | null = null;
  try {
    const resolved = resolveSpawnDetachedNodeInvocation({
      execPath: process.execPath,
      script: params.script,
      args: params.args,
    });
    if (params.logPath) {
      mkdirSync(dirname(params.logPath), { recursive: true });
      logFd = openSync(params.logPath, 'a');
    }
    const output = logFd === null ? 'ignore' : logFd;
    const child = spawn(resolved.file, resolved.args, {
      stdio: params.admissionFdEnvName ? ['ignore', output, output, 'pipe'] : ['ignore', output, output],
      cwd: resolved.isRuntime ? params.cwd : process.cwd(),
      env: { ...params.env, ...(params.admissionFdEnvName ? { [params.admissionFdEnvName]: '3' } : {}) },
      detached: true,
      windowsHide: true,
    });
    child.on('error', () => {
      // Reported through the return value's absent pid; never an unhandled error event.
    });
    child.unref();
    if (typeof child.pid !== 'number') return { started: false, admission: null };
    const admission = params.admissionFdEnvName ? child.stdio[3] : null;
    return { started: true, admission: admission && 'on' in admission ? admission as NodeJS.ReadableStream : null };
  } catch {
    return { started: false, admission: null };
  } finally {
    if (logFd !== null) {
      try {
        closeSync(logFd);
      } catch {
        // The child holds its own copy of the descriptor.
      }
    }
  }
}

export function readNpmDistTagVersion(params: Readonly<{
  packageName: string;
  distTag: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}>): string | null {
  try {
    const pkg = String(params.packageName ?? '').trim();
    const tag = String(params.distTag ?? '').trim();
    if (!pkg || !tag) return null;
    const invocation = resolveWindowsCommandInvocation({
      command: 'npm',
      args: ['view', `${pkg}@${tag}`, 'version'],
      env: params.env,
      resolveCommandOnPath: true,
    });
    const res = spawnSync(invocation.command, invocation.args, {
      encoding: 'utf8',
      cwd: params.cwd,
      env: params.env,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    if (typeof res.status === 'number' && res.status !== 0) return null;
    const out = String(res.stdout ?? '').trim();
    return out || null;
  } catch {
    return null;
  }
}

export function installRuntimeFromNpm(params: Readonly<{
  runtimeDir: string;
  spec: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}>): { ok: true } | { ok: false; errorMessage: string } {
  const spec = String(params.spec ?? '').trim();
  if (!spec) return { ok: false, errorMessage: 'Missing spec' };
  try {
    mkdirSync(params.runtimeDir, { recursive: true });
  } catch {
    // ignore
  }
  try {
    const invocation = resolveWindowsCommandInvocation({
      command: 'npm',
      args: ['install', '--no-audit', '--no-fund', '--silent', '--prefix', params.runtimeDir, spec],
      env: params.env,
      resolveCommandOnPath: true,
    });
    const res = spawnSync(invocation.command, invocation.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: 'inherit',
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    if (typeof res.status === 'number' && res.status !== 0) {
      return { ok: false, errorMessage: `npm install exited with status ${res.status}` };
    }
    if (res.error) {
      return { ok: false, errorMessage: String(res.error.message || res.error) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, errorMessage: e instanceof Error ? e.message : String(e) };
  }
}

export function formatUpdateNotice(params: Readonly<{
  toolName: string;
  from: string;
  to: string;
  updateCommand: string;
}>): string {
  const tool = String(params.toolName ?? '').trim() || 'tool';
  const from = String(params.from ?? '').trim() || 'current';
  const to = String(params.to ?? '').trim() || 'latest';
  const cmd = String(params.updateCommand ?? '').trim() || 'self update';
  return `[${tool}] update available: ${from} -> ${to} (run: ${cmd})`;
}

/**
 * The one owner of "is a newer Happier CLI available on this ring?" as cached on disk (plan R13
 * S-1). `happier self check` is the only writer (`recordCliUpdateCheck`); the terminal notice,
 * doctor repair, the desktop's status fact and the per-machine update facts all read through
 * `readCachedCliUpdateState`.
 *
 * The `next` npm dist-tag is shared by preview and dev, so a looked-up version can belong to the
 * other ring. A version belongs to a ring by its prerelease identifier: none for stable,
 * `preview.*` for preview, `dev.*` for dev.
 */

export type CachedCliUpdateState = Readonly<{
  currentVersion: string;
  /** The ring's newest version from the last check; `null` when unknown or from another ring. */
  latestVersion: string | null;
  updateAvailable: boolean;
  /** When that check ran (epoch ms); `null` when the cache does not say. */
  checkedAt: number | null;
}>;

function ringCachePath(happierHomeDir: string, ring: PublicReleaseRingId): string {
  return resolveCliUpdateCachePath({ happierHomeDir, channelLabel: resolvePublicReleaseRingLabelForId(ring) });
}

/**
 * The running CLI's update state from the ring's cached check. Read-only and offline. `latest` is
 * filtered to the ring and compared with the version actually running (never the cached
 * `updateAvailable`), so a CLI updated since the check reports no update and a cache an older
 * writer filled with another ring's version reads as unknown. `null` when nothing was cached.
 */
export function readCachedCliUpdateState(params: Readonly<{
  happierHomeDir: string;
  publicReleaseRing: PublicReleaseRingId;
  currentVersion: string;
}>): CachedCliUpdateState | null {
  const cached = readUpdateCache(ringCachePath(params.happierHomeDir, params.publicReleaseRing));
  if (!cached) return null;
  const cachedLatest = typeof cached.latest === 'string' ? cached.latest.trim() : null;
  const latestVersion = doesVersionMatchReleaseRing(cachedLatest, params.publicReleaseRing) ? cachedLatest : null;
  return {
    currentVersion: params.currentVersion,
    latestVersion,
    updateAvailable: Boolean(latestVersion && compareVersions(latestVersion, params.currentVersion) > 0),
    checkedAt: typeof cached.checkedAt === 'number' ? cached.checkedAt : null,
  };
}

/** Record one update check (`happier self check`, the only writer), keeping the notice time. */
export function recordCliUpdateCheck(params: Readonly<{
  happierHomeDir: string;
  publicReleaseRing: PublicReleaseRingId;
  /** What the lookup answered; another ring's version is recorded as unknown. */
  latest: string | null;
  current: string | null;
  runtimeVersion: string | null;
  invokerVersion: string | null;
  nowMs?: number;
}>): void {
  const cachePath = ringCachePath(params.happierHomeDir, params.publicReleaseRing);
  const latest = doesVersionMatchReleaseRing(params.latest, params.publicReleaseRing) ? params.latest : null;
  writeUpdateCache(cachePath, {
    checkedAt: params.nowMs ?? Date.now(),
    latest,
    current: params.current,
    runtimeVersion: params.runtimeVersion,
    invokerVersion: params.invokerVersion,
    updateAvailable: Boolean(params.current && latest && compareVersions(latest, params.current) > 0),
    notifiedAt: readUpdateCache(cachePath)?.notifiedAt ?? null,
  });
}
