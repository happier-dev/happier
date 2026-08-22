import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { ensureDepsInstalled, ensureWorkspacePackagesBuiltForComponent } from '../proc/pm.mjs';
import { resolveWorkspaceToolBinDirs } from '../proc/workspace_tool_bins.mjs';
import { run } from '../proc/proc.mjs';
import { spawnProc } from '../proc/proc.mjs';
import { ensureExpoIsolationEnv, getExpoStatePaths, resolveExpoTmpDir, wantsExpoClearCache } from './expo.mjs';
import { coerceHappyMonorepoRootFromPath } from '../paths/paths.mjs';
import { pathExists } from '../fs/fs.mjs';
import { applyExpoNodeHeapEnv } from './expoNodeHeapEnv.mjs';
import { repairExpoYarnPackageBinShims } from './expoPackageBinShims.mjs';
import { ensureReactNativeLibsodiumNativeBuild } from './libsodiumNativeBuild.mjs';
import {
  ensureReactNativeSkiaAndroidBinaries,
  ensureReactNativeSkiaIosBinaries,
  resolveReactNativeSkiaAndroidArchitecturesFromEnv,
} from './skiaPrebuiltBinaries.mjs';

const DEFAULT_EXPO_EXPORT_MAX_WORKERS_NONINTERACTIVE = 1;
const CANONICAL_UI_PREFLIGHT_ERROR_CODE = 'HAPPIER_EXPO_CANONICAL_UI_PREFLIGHT_FAILED';

export async function withExpoPreparationEnv(envIn, action) {
  if (typeof action !== 'function') {
    throw new TypeError('withExpoPreparationEnv requires an action function');
  }
  const env = { ...(envIn ?? process.env) };
  const scratchBase = String(env.TMPDIR ?? env.TMP ?? env.TEMP ?? tmpdir()).trim() || tmpdir();
  await mkdir(scratchBase, { recursive: true });
  const scratchDir = await mkdtemp(join(scratchBase, 'happier-expo-preparation-'));
  env.TMPDIR = scratchDir;
  env.TMP = scratchDir;
  env.TEMP = scratchDir;
  try {
    return await action(env);
  } finally {
    await rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function isCanonicalExpoUiPreflightError(error) {
  return error?.code === CANONICAL_UI_PREFLIGHT_ERROR_CODE;
}

async function loadCanonicalUiPreflight(projectDir) {
  const canonicalUiPreflightPath = join(
    projectDir,
    'scripts',
    'ensureWorkspacePackagesBuilt.mjs',
  );
  if (!(await pathExists(canonicalUiPreflightPath))) return null;
  return {
    module: await import(pathToFileURL(canonicalUiPreflightPath).href),
    path: canonicalUiPreflightPath,
  };
}

export async function hasUsableExpoWorkspaceLastGreen({ projectDir }) {
  const canonical = await loadCanonicalUiPreflight(projectDir);
  if (!canonical) return false;
  return await canonical.module.hasUsableUiWorkspaceLastGreen?.({ uiPackageDir: projectDir }) === true;
}

export async function resolveExpoBin(runnerDir) {
  const workspaceToolBinDirs = await resolveWorkspaceToolBinDirs(runnerDir);
  for (const binDir of workspaceToolBinDirs) {
    const isolatedBin = join(binDir, 'expo');
    const isolatedCmdBin = `${isolatedBin}.cmd`;
    if (process.platform === 'win32' && (await pathExists(isolatedCmdBin))) return isolatedCmdBin;
    if (await pathExists(isolatedBin)) return isolatedBin;
  }

  // Yarn owns installed package bins. They remain a read-only fallback when an installed
  // dependency cannot be represented by Stack's deterministic shim publisher.
  const workspaceBin = join(runnerDir, 'node_modules', '.bin', 'expo');
  const workspaceCmdBin = `${workspaceBin}.cmd`;
  if (process.platform === 'win32' && (await pathExists(workspaceCmdBin))) return workspaceCmdBin;
  if (await pathExists(workspaceBin)) return workspaceBin;

  const monorepoRoot = coerceHappyMonorepoRootFromPath(runnerDir);
  if (monorepoRoot) {
    const rootBin = join(monorepoRoot, 'node_modules', '.bin', 'expo');
    const rootCmdBin = `${rootBin}.cmd`;
    if (process.platform === 'win32' && (await pathExists(rootCmdBin))) return rootCmdBin;
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

function isIosRunCommand(args) {
  return Array.isArray(args) && args[0] === 'run:ios';
}

function isAndroidRunCommand(args) {
  return Array.isArray(args) && args[0] === 'run:android';
}

export async function ensureExpoWorkspacePrepared({ projectDir, env, quiet = false }) {
  const canonical = await loadCanonicalUiPreflight(projectDir);
  if (canonical) {
    try {
      const preflightModule = canonical.module;
      if (typeof preflightModule.ensureUiWorkspacePackagesBuilt !== 'function') {
        throw new Error(
          `[expo] canonical UI workspace preflight is unavailable: ${canonical.path}`,
        );
      }
      return await preflightModule.ensureUiWorkspacePackagesBuilt({
        env,
        uiPackageDir: projectDir,
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      const error = new Error(`[expo] canonical UI workspace preflight failed: ${detail}`, { cause });
      error.code = CANONICAL_UI_PREFLIGHT_ERROR_CODE;
      throw error;
    }
  }
  return await ensureWorkspacePackagesBuiltForComponent(projectDir, { quiet, env });
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
  const workspaceDepsDir = projectDir ?? runnerDir;
  await withExpoPreparationEnv(env, async (preparationEnv) => {
    await ensureDepsInstalled(runnerDir, ensureDepsLabel, { quiet, env: preparationEnv });
    await ensureExpoWorkspacePrepared({ projectDir: workspaceDepsDir, quiet, env: preparationEnv });
    await repairExpoYarnPackageBinShims({ runnerDir, projectDir: workspaceDepsDir });
    if (isIosRunCommand(args)) {
      await ensureReactNativeSkiaIosBinaries({ runnerDir, projectDir: workspaceDepsDir, env: preparationEnv, quiet });
      await ensureReactNativeLibsodiumNativeBuild({ runnerDir, projectDir: workspaceDepsDir, env: preparationEnv, quiet });
    }
    if (isAndroidRunCommand(args)) {
      await ensureReactNativeSkiaAndroidBinaries({
        runnerDir,
        projectDir: workspaceDepsDir,
        architectures: resolveReactNativeSkiaAndroidArchitecturesFromEnv(preparationEnv),
        env: preparationEnv,
        quiet,
      });
    }
  });
  const expoBin = await resolveExpoBin(runnerDir);
  const effectiveEnv = applyExpoNodeHeapEnv(env, {
    envKey: 'HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB',
  });
  effectiveEnv.EXPO_UNSTABLE_WEB_MODAL = '1';
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
  workspacePrepared = false,
  options,
}) {
  const runnerDir = dir;
  const cwd = projectDir ?? runnerDir;
  const workspaceDepsDir = projectDir ?? runnerDir;
  await withExpoPreparationEnv(env, async (preparationEnv) => {
    await ensureDepsInstalled(runnerDir, ensureDepsLabel, {
      quiet,
      env: preparationEnv,
      refreshExisting: !workspacePrepared,
      // `workspacePrepared` means the caller already owns the potentially
      // expensive dependency/workspace refresh. Cheap component readiness is
      // still required before every spawn: postinstall-owned files may be
      // absent from a newly synchronized dev-target dependency tree even when
      // the last-green workspace build is reusable.
      prepareComponentOutputs: true,
    });
    if (!workspacePrepared) {
      try {
        await ensureExpoWorkspacePrepared({ projectDir: workspaceDepsDir, quiet, env: preparationEnv });
      } catch (error) {
        if (isCanonicalExpoUiPreflightError(error)) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          '[local] Expo workspace package build failed; starting the development server with the current workspace source and last-green outputs.\n'
          + detail,
        );
      }
    }
    await repairExpoYarnPackageBinShims({ runnerDir, projectDir: workspaceDepsDir });
    if (isIosRunCommand(args)) {
      await ensureReactNativeSkiaIosBinaries({ runnerDir, projectDir: workspaceDepsDir, env: preparationEnv, quiet });
      await ensureReactNativeLibsodiumNativeBuild({ runnerDir, projectDir: workspaceDepsDir, env: preparationEnv, quiet });
    }
    if (isAndroidRunCommand(args)) {
      await ensureReactNativeSkiaAndroidBinaries({
        runnerDir,
        projectDir: workspaceDepsDir,
        architectures: resolveReactNativeSkiaAndroidArchitecturesFromEnv(preparationEnv),
        env: preparationEnv,
        quiet,
      });
    }
  });
  const expoBin = await resolveExpoBin(runnerDir);
  const effectiveEnv = applyExpoNodeHeapEnv(env, {
    envKey: 'HAPPIER_STACK_EXPO_MAX_OLD_SPACE_SIZE_MB',
  });
  effectiveEnv.EXPO_UNSTABLE_WEB_MODAL = '1';
  const effectiveArgs = applyExpoExportMaxWorkersArgs(args, effectiveEnv);
  return spawnProc(label, expoBin, effectiveArgs, effectiveEnv, { cwd, ...(options ?? {}) });
}
