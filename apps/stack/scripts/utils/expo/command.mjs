import { join } from 'node:path';

import { ensureDepsInstalled, ensureWorkspacePackagesBuiltForComponent } from '../proc/pm.mjs';
import { run } from '../proc/proc.mjs';
import { spawnProc } from '../proc/proc.mjs';
import { ensureExpoIsolationEnv, getExpoStatePaths, resolveExpoTmpDir, wantsExpoClearCache } from './expo.mjs';
import { coerceHappyMonorepoRootFromPath } from '../paths/paths.mjs';
import { pathExists } from '../fs/fs.mjs';
import { applyExpoNodeHeapEnv } from '../../../../../scripts/expo/expoNodeHeapEnv.mjs';

const DEFAULT_EXPO_EXPORT_MAX_WORKERS_NONINTERACTIVE = 1;

async function resolveExpoBin(runnerDir) {
  const workspaceBin = join(runnerDir, 'node_modules', '.bin', 'expo');
  if (await pathExists(workspaceBin)) return workspaceBin;

  const monorepoRoot = coerceHappyMonorepoRootFromPath(runnerDir);
  if (monorepoRoot) {
    const rootBin = join(monorepoRoot, 'node_modules', '.bin', 'expo');
    if (await pathExists(rootBin)) return rootBin;
  }

  return workspaceBin;
}

function hasFlag(args, name) {
  const needle = String(name ?? '').trim();
  if (!needle) return false;
  for (const a of args ?? []) {
    if (a === needle) return true;
    if (typeof a === 'string' && a.startsWith(`${needle}=`)) return true;
  }
  return false;
}

function coerceNonNegativeInt(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
}

function parseExpoExportMaxWorkers(env) {
  const raw = (env?.HAPPIER_STACK_EXPO_EXPORT_MAX_WORKERS ?? '').toString().trim();
  if (!raw) return { explicit: false, value: null };
  if (raw === '0') return { explicit: true, value: 0 };
  const n = coerceNonNegativeInt(raw);
  return { explicit: true, value: n };
}

function resolveDefaultExpoExportMaxWorkers() {
  // Only apply a conservative default in non-interactive contexts, where Expo/Metro
  // can be more sensitive to high worker fan-out (e.g. in Docker/CI).
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (isInteractive) return null;
  return DEFAULT_EXPO_EXPORT_MAX_WORKERS_NONINTERACTIVE;
}

function applyExpoExportMaxWorkersArgs(args, env) {
  const a = Array.isArray(args) ? [...args] : [];
  if (a[0] !== 'export') return a;
  if (hasFlag(a, '--max-workers')) return a;

  const { explicit, value } = parseExpoExportMaxWorkers(env);
  if (explicit) {
    // Explicit disable (0) or invalid value: do not inject a default.
    if (value === 0 || value == null) return a;
    a.push('--max-workers', String(value));
    return a;
  }

  const def = resolveDefaultExpoExportMaxWorkers();
  if (def == null) return a;
  a.push('--max-workers', String(def));
  return a;
}

export async function prepareExpoCommandEnv({
  baseDir,
  kind,
  projectDir,
  baseEnv,
  stateFileName,
}) {
  const env = { ...(baseEnv ?? process.env) };
  const paths = getExpoStatePaths({ baseDir, kind, projectDir, stateFileName });
  const tmpDir = resolveExpoTmpDir({ env, defaultTmpDir: paths.tmpDir, kind, projectDir });
  await ensureExpoIsolationEnv({ env, stateDir: paths.stateDir, expoHomeDir: paths.expoHomeDir, tmpDir });
  return { env, paths };
}

export function maybeAddExpoClear({ args, env }) {
  const next = [...(args ?? [])];
  if (wantsExpoClearCache({ env: env ?? process.env })) {
    // Expo supports `--clear` for start, and `-c` for export.
    // Callers should pass the right flag for their subcommand; we only add when missing.
    if (!next.includes('--clear') && !next.includes('-c')) {
      // Prefer `--clear` as a safe default; callers can override per-command.
      next.push('--clear');
    }
  }
  return next;
}

export async function expoExec({
  dir,
  projectDir,
  args,
  env,
  ensureDepsLabel = 'happy',
  quiet = false,
}) {
  const runnerDir = dir;
  const cwd = projectDir ?? runnerDir;
  await ensureDepsInstalled(runnerDir, ensureDepsLabel, { quiet, env });
  const workspaceDepsDir = projectDir ?? runnerDir;
  await ensureWorkspacePackagesBuiltForComponent(workspaceDepsDir, { quiet, env });
  const expoBin = await resolveExpoBin(runnerDir);
  const effectiveEnv = applyExpoNodeHeapEnv(env, {
    envKey: 'HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB',
  });
  const effectiveArgs = applyExpoExportMaxWorkersArgs(args, effectiveEnv);
  await run(expoBin, effectiveArgs, { cwd, env: effectiveEnv, stdio: quiet ? 'ignore' : 'inherit' });
}

export async function expoSpawn({
  label,
  dir,
  projectDir,
  args,
  env,
  ensureDepsLabel = 'happy',
  quiet = false,
  options,
}) {
  const runnerDir = dir;
  const cwd = projectDir ?? runnerDir;
  await ensureDepsInstalled(runnerDir, ensureDepsLabel, { quiet, env });
  const workspaceDepsDir = projectDir ?? runnerDir;
  await ensureWorkspacePackagesBuiltForComponent(workspaceDepsDir, { quiet, env });
  const expoBin = await resolveExpoBin(runnerDir);
  const effectiveEnv = applyExpoNodeHeapEnv(env, {
    envKey: 'HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB',
  });
  const effectiveArgs = applyExpoExportMaxWorkersArgs(args, effectiveEnv);
  return spawnProc(label, expoBin, effectiveArgs, effectiveEnv, { cwd, ...(options ?? {}) });
}
