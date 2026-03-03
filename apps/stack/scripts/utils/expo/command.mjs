import { join } from 'node:path';

import { ensureDepsInstalled, ensureWorkspacePackagesBuiltForComponent } from '../proc/pm.mjs';
import { run } from '../proc/proc.mjs';
import { spawnProc } from '../proc/proc.mjs';
import { ensureExpoIsolationEnv, getExpoStatePaths, resolveExpoTmpDir, wantsExpoClearCache } from './expo.mjs';

const DEFAULT_EXPO_MAX_OLD_SPACE_SIZE_MB = 8192;

function coercePositiveInt(v) {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function parseExpoMaxOldSpaceSizeMb(env) {
  const raw = (env?.HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB ?? '').toString().trim();
  if (!raw) return { explicit: false, value: null };
  if (raw === '0') return { explicit: true, value: 0 };
  const n = coercePositiveInt(raw);
  return { explicit: true, value: n ?? null };
}

function hasMaxOldSpaceSizeFlag(nodeOptions) {
  const s = String(nodeOptions ?? '');
  return /(^|\s)--max-old-space-size(=|\s)\d+(\s|$)/.test(s);
}

function setOrReplaceMaxOldSpaceSizeFlag(nodeOptions, sizeMb) {
  const s = String(nodeOptions ?? '').trim();
  const desired = `--max-old-space-size=${sizeMb}`;
  if (!s) return desired;

  // Replace any existing `--max-old-space-size` value (supports `=` or space form).
  const replaced = s.replace(/(^|\s)--max-old-space-size(=|\s)\d+(\s|$)/g, `$1${desired}$3`).trim();
  if (replaced !== s) return replaced;

  // Append if missing.
  return `${s} ${desired}`.trim();
}

function applyExpoNodeHeapEnv(baseEnv) {
  const env = { ...(baseEnv ?? process.env) };
  const { explicit, value } = parseExpoMaxOldSpaceSizeMb(env);
  const desired =
    explicit && typeof value === 'number'
      ? value
      : DEFAULT_EXPO_MAX_OLD_SPACE_SIZE_MB;

  // Explicit disable: allow opting out entirely (useful for debugging / reproducing).
  if (explicit && value === 0) return env;

  const existing = env.NODE_OPTIONS ?? '';
  env.NODE_OPTIONS = setOrReplaceMaxOldSpaceSizeFlag(existing, desired);
  return env;
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
  const expoBin = join(runnerDir, 'node_modules', '.bin', 'expo');
  const effectiveEnv = applyExpoNodeHeapEnv(env);
  await run(expoBin, args, { cwd, env: effectiveEnv, stdio: quiet ? 'ignore' : 'inherit' });
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
  const expoBin = join(runnerDir, 'node_modules', '.bin', 'expo');
  const effectiveEnv = applyExpoNodeHeapEnv(env);
  return spawnProc(label, expoBin, args, effectiveEnv, { cwd, ...(options ?? {}) });
}
