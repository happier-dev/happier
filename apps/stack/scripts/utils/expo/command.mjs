import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { ensureDepsInstalled, ensureWorkspacePackagesBuiltForComponent, hasUsableWorkspaceLastGreen, prepareWorkspaceComponentStartup, resolveDependencyInstallRoot } from '../proc/pm.mjs';
import { inspectDependencyRefresh, withDependencyConsumption } from '../proc/dependency_refresh.mjs';
import { resolveWorkspaceToolBinDirs } from '../proc/workspace_tool_bins.mjs';
import { run } from '../proc/proc.mjs';
import { killProcessTree, spawnProc } from '../proc/proc.mjs';
import { ensureExpoIsolationEnv, getExpoStatePaths, resolveExpoTmpDir, wantsExpoClearCache } from './expo.mjs';
import { coerceHappyMonorepoRootFromPath } from '../paths/paths.mjs';
import { pathExists } from '../fs/fs.mjs';
import { applyExpoNodeHeapEnv } from './expoNodeHeapEnv.mjs';
import { applyExpoExportMaxWorkersArgs } from './exportWorkers.mjs';
export { applyExpoExportMaxWorkersArgs } from './exportWorkers.mjs';
import { repairExpoYarnPackageBinShims } from './expoPackageBinShims.mjs';
import { ensureReactNativeLibsodiumNativeBuild } from './libsodiumNativeBuild.mjs';
import {
  ensureReactNativeSkiaAndroidBinaries,
  ensureReactNativeSkiaIosBinaries,
  resolveReactNativeSkiaAndroidArchitecturesFromEnv,
} from './skiaPrebuiltBinaries.mjs';

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

export async function hasUsableExpoWorkspaceLastGreen({ projectDir, env = process.env }) {
  const canonical = await loadCanonicalUiPreflight(projectDir);
  if (!canonical) return false;
  const describe = canonical.module.resolveUiWorkspaceStartupOutputs;
  if (!describe) return false;
  const requiredFiles = describe({ uiPackageDir: projectDir, env });
  if (requiredFiles && await hasUsableWorkspaceLastGreen(projectDir, { requiredFiles })) return true;
  if (!env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY) return false;
  // Seed this consumer's existing inventory path, so Metro also observes the
  // normal compiler's later atomic publication without a process restart.
  const { HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: requested, ...producerEnv } = env;
  const producerFiles = describe({ uiPackageDir: projectDir, env: producerEnv });
  if (!producerFiles || !await hasUsableWorkspaceLastGreen(projectDir, { requiredFiles: producerFiles })) return false;
  if (!canonical.module.retainBundledPluginUiArtifactsInventory) return false;
  return await canonical.module.retainBundledPluginUiArtifactsInventory({ inventoryPath: producerFiles[0], outputPath: requested });
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

export async function ensureExpoWorkspacePrepared({ projectDir, env = process.env, quiet = false, startup = false }) {
  if (startup) return await prepareWorkspaceComponentStartup({
    readLastGreen: async () => await hasUsableExpoWorkspaceLastGreen({ projectDir, env }) ? { lastGreen: true } : null,
    prepare: () => ensureExpoWorkspacePrepared({ projectDir, env, quiet }),
  });
  const canonical = await loadCanonicalUiPreflight(projectDir);
  if (canonical) {
    try {
      const preflightModule = canonical.module;
      if (typeof preflightModule.ensureUiWorkspacePackagesBuilt !== 'function') {
        throw new Error(
          `[expo] canonical UI workspace preflight is unavailable: ${canonical.path}`,
        );
      }
      const result = await preflightModule.ensureUiWorkspacePackagesBuilt({
        env,
        uiPackageDir: projectDir,
        source: true,
      });
      if (result?.outputPath) env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY = result.outputPath;
      return result;
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
  env = { ...(env ?? process.env) };
  const developmentStart = args?.[0] === 'start';
  if (developmentStart) env.HAPPIER_STACK_DEV_AUTO_REFRESH_DEPS = '1';
  await withExpoPreparationEnv(env, async (preparationEnv) => {
    await ensureDepsInstalled(runnerDir, ensureDepsLabel, { quiet, env: preparationEnv });
    await ensureExpoWorkspacePrepared({ projectDir: workspaceDepsDir, quiet, env: preparationEnv, startup: developmentStart });
    if (preparationEnv.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY) {
      env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY = preparationEnv.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY;
    }
    if (!developmentStart) await repairExpoYarnPackageBinShims({ runnerDir, projectDir: workspaceDepsDir });
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
  onSpawned = null,
  options,
}) {
  const runnerDir = dir;
  const cwd = projectDir ?? runnerDir;
  const workspaceDepsDir = projectDir ?? runnerDir;
  env = { ...(env ?? process.env) };
  const developmentStart = args?.[0] === 'start';
  if (developmentStart) env.HAPPIER_STACK_DEV_AUTO_REFRESH_DEPS = '1';
  await withExpoPreparationEnv(env, async (preparationEnv) => {
    // Managed development already prepared dependencies before taking read
    // custody. It must not upgrade that custody to a writer while spawning.
    // Other commands still prepare mandatory component outputs here.
    if (!workspacePrepared || !developmentStart) {
      await ensureDepsInstalled(runnerDir, ensureDepsLabel, {
        quiet,
        env: preparationEnv,
        refreshExisting: !workspacePrepared,
        prepareComponentOutputs: true,
      });
    }
    if (!workspacePrepared) {
      try {
        await ensureExpoWorkspacePrepared({ projectDir: workspaceDepsDir, quiet, env: preparationEnv, startup: developmentStart });
        if (preparationEnv.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY) {
          env.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY = preparationEnv.HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY;
        }
      } catch (error) {
        if (isCanonicalExpoUiPreflightError(error)) throw error;
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(
          '[local] Expo workspace package build failed; starting the development server with the current workspace source and last-green outputs.\n'
          + detail,
        );
      }
    }
  });
  const installDir = resolveDependencyInstallRoot(runnerDir);
  return await withDependencyConsumption({ installDir, env }, async () => {
    const readiness = await inspectDependencyRefresh({
      installDir, componentDir: runnerDir,
    });
    // Development serves installed bytes while source/manifest inputs move.
    // Missing imports fail their bundle; they do not withdraw Metro availability.
    if (!developmentStart && coerceHappyMonorepoRootFromPath(runnerDir) && !readiness.admitted) {
      const error = new Error('[expo] dependencies are not ready; complete dependency refresh before starting Metro');
      error.code = 'HAPPIER_EXPO_DEPENDENCIES_NOT_READY';
      throw error;
    }
    await withExpoPreparationEnv(env, async (preparationEnv) => {
      if (!developmentStart) await repairExpoYarnPackageBinShims({ runnerDir, projectDir: workspaceDepsDir });
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
    const proc = spawnProc(label, expoBin, effectiveArgs, effectiveEnv, { cwd, ...(options ?? {}) });
    try {
      // Publish the canonical PID before releasing the same lock installers
      // acquire, so an install can never miss a newly launched managed reader.
      await onSpawned?.(proc, { dependencyReady: readiness.admitted });
      return proc;
    } catch (error) {
      await killProcessTree(proc, 'SIGTERM');
      throw error;
    }
  });
}
