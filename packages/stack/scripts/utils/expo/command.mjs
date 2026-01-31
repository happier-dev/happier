import { join } from 'node:path';

import { ensureDepsInstalled } from '../proc/pm.mjs';
import { run } from '../proc/proc.mjs';
import { spawnProc } from '../proc/proc.mjs';
import { ensureExpoIsolationEnv, getExpoStatePaths, wantsExpoClearCache } from './expo.mjs';

export async function prepareExpoCommandEnv({
  baseDir,
  kind,
  projectDir,
  baseEnv,
  stateFileName,
}) {
  const env = { ...(baseEnv ?? process.env) };
  const paths = getExpoStatePaths({ baseDir, kind, projectDir, stateFileName });
  await ensureExpoIsolationEnv({ env, stateDir: paths.stateDir, expoHomeDir: paths.expoHomeDir, tmpDir: paths.tmpDir });
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
  const expoBin = join(runnerDir, 'node_modules', '.bin', 'expo');
  await run(expoBin, args, { cwd, env, stdio: quiet ? 'ignore' : 'inherit' });
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
  const expoBin = join(runnerDir, 'node_modules', '.bin', 'expo');
  return spawnProc(label, expoBin, args, env, { cwd, ...(options ?? {}) });
}

