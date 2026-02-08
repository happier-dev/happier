import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

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

export function compareVersions(a: string, b: string): number {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();

  type Parsed = {
    major: number;
    minor: number;
    patch: number;
    prerelease: Array<string | number>;
  };

  const parse = (raw: string): Parsed | null => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+.*)?$/.exec(raw);
    if (!m) return null;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    const patch = Number(m[3]);
    if (![major, minor, patch].every((n) => Number.isFinite(n))) return null;
    const preRaw = String(m[4] ?? '').trim();
    const prerelease = preRaw
      ? preRaw.split('.').filter(Boolean).map((id) => (/^\d+$/.test(id) ? Number(id) : id))
      : [];
    return { major, minor, patch, prerelease };
  };

  const pa = parse(sa);
  const pb = parse(sb);
  if (!pa || !pb) return sa.localeCompare(sb);

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

  const aPre = pa.prerelease;
  const bPre = pb.prerelease;
  if (aPre.length === 0 && bPre.length === 0) return 0;
  if (aPre.length === 0) return 1; // release > prerelease
  if (bPre.length === 0) return -1;

  const len = Math.max(aPre.length, bPre.length);
  for (let i = 0; i < len; i++) {
    const ai = aPre[i];
    const bi = bPre[i];
    if (ai == null && bi == null) return 0;
    if (ai == null) return -1; // shorter prerelease has lower precedence
    if (bi == null) return 1;

    const aNum = typeof ai === 'number';
    const bNum = typeof bi === 'number';
    if (aNum && bNum) {
      if (ai !== bi) return ai > bi ? 1 : -1;
      continue;
    }
    if (aNum && !bNum) return -1; // numeric < non-numeric
    if (!aNum && bNum) return 1;

    const as = String(ai);
    const bs = String(bi);
    if (as === bs) continue;
    return as.localeCompare(bs);
  }

  return 0;
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

export function spawnDetachedNode(params: Readonly<{ script: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }>): void {
  try {
    const child = spawn(process.execPath, [params.script, ...params.args], {
      stdio: 'ignore',
      cwd: params.cwd,
      env: { ...params.env },
      detached: true,
    });
    child.unref();
  } catch {
    // ignore
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
    const res = spawnSync('npm', ['view', `${pkg}@${tag}`, 'version'], {
      encoding: 'utf8',
      cwd: params.cwd,
      env: params.env,
      stdio: ['ignore', 'pipe', 'ignore'],
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
    const res = spawnSync(
      'npm',
      ['install', '--no-audit', '--no-fund', '--silent', '--prefix', params.runtimeDir, spec],
      { cwd: params.cwd, env: params.env, stdio: 'inherit' },
    );
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
