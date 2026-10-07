import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { withWorkspaceBundleLock } from '../../../scripts/workspaces/workspaceBundleLock.mjs';
import { copyDirectoryContents } from '../../../scripts/workspaces/copyDirectoryContents.mjs';
import { resolveWorkspacePackageBuildLockPath } from '../../../scripts/workspaces/workspacePackageBuildLock.mjs';
import { createPackageDistBuildPlan } from './packageDistBuildPlan.mjs';
import {
  cleanupPackageDistBuildArtifacts,
  resolveTypeScriptBuildInvocation,
  restorePackageDistFromBackup,
  stagePackageDistBuild,
  swapStagedPackageDistIntoPlace,
  verifyStagedPackageDistExports,
} from './packageDistBuildPhases.mjs';
import { verifyPackageExportTargets } from './verifyExports.mjs';

export {
  cleanupPackageDistBuildArtifacts,
  createPackageDistBuildPlan,
  resolveTypeScriptBuildInvocation,
  restorePackageDistFromBackup,
  stagePackageDistBuild,
  swapStagedPackageDistIntoPlace,
  verifyStagedPackageDistExports,
};

const TRANSIENT_REMOVE_ERROR_CODES = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES']);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function resolveCliCommonDistBuildLockPath(packageDir) {
  const resolvedPackageDir = resolve(packageDir);
  const packageJson = readJson(join(resolvedPackageDir, 'package.json'));
  return resolveWorkspacePackageBuildLockPath(resolvedPackageDir, packageJson);
}

export async function withWorkspaceDistBuildLock(fn, options) {
  const lockPath = options?.lockPath;
  if (!lockPath) throw new Error('withWorkspaceDistBuildLock requires lockPath');

  const env = options?.env ?? process.env;
  const timeoutMs = options?.timeoutMs ?? 240_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 250;
  const staleAfterMs = options?.staleAfterMs ?? timeoutMs;
  return await withWorkspaceBundleLock(
    ({ waited, heldLockValue, inherited }) => fn({ waited, heldLockValue, inherited }),
    {
      lockPath,
      heldLockValue: env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
      timeoutMs,
      pollIntervalMs,
      staleAfterMs,
    },
  );
}

function runChecked(command, args, options, runCommandImpl) {
  const result = runCommandImpl(command, args, options);
  if (result?.error) {
    throw result.error;
  }
  if ((result?.status ?? 0) !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with code ${result?.status ?? 'unknown'}`);
  }
}

function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransientRemoveError(error) {
  return TRANSIENT_REMOVE_ERROR_CODES.has(String(error?.code ?? ''));
}

export function cleanPackageDistSync({
  targetDir = 'dist',
  rmSyncImpl = rmSync,
  retries = 3,
  delayMs = 50,
} = {}) {
  let attempt = 0;
  while (true) {
    try {
      rmSyncImpl(targetDir, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= retries || !isTransientRemoveError(error)) {
        throw error;
      }
      attempt += 1;
      sleepSync(delayMs);
    }
  }
}

export function resolveBuildScriptMode(argv = process.argv.slice(2)) {
  return argv.includes('--clean') ? 'clean' : 'build';
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function runTscBuild({
  packageDir,
  stagingDistDir,
  env,
  stdio = 'inherit',
  runCommandImpl = spawnSync,
}) {
  const invocation = resolveTypeScriptBuildInvocation({
    packageDir,
    outDir: stagingDistDir,
  });
  runChecked(invocation.command, invocation.args, { cwd: packageDir, env, stdio }, runCommandImpl);
}

function resolveDefaultPackageDir() {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  return dirname(scriptsDir);
}

export async function buildPackageDistAtomically(options = {}) {
  const packageDir = resolve(options.packageDir ?? resolveDefaultPackageDir());
  const packageJson = options.packageJson ?? readJson(join(packageDir, 'package.json'));
  const commandEnv = {
    ...process.env,
    ...(options.env ?? {}),
  };
  const buildPlan = options.buildPlan ?? createPackageDistBuildPlan({
    packageDir,
    packageName: packageJson.name,
    pid: options.pid ?? process.pid,
    now: options.now ?? Date.now(),
  });
  const workspaceOutputDir = String(commandEnv.HAPPIER_WORKSPACE_DIST_OUTPUT_DIR ?? '').trim();
  const outputDir = workspaceOutputDir ? resolve(workspaceOutputDir) : buildPlan.distDir;
  const lockPath = options.lockPath ?? buildPlan.lockPath;
  const lockTimeoutMs = options.lockTimeoutMs
    ?? parsePositiveInteger(commandEnv.HAPPIER_PACKAGE_DIST_BUILD_LOCK_TIMEOUT_MS, 240_000);
  const lockPollMs = options.lockPollMs
    ?? parsePositiveInteger(commandEnv.HAPPIER_PACKAGE_DIST_BUILD_LOCK_POLL_MS, 250);

  const runStagedBuild = async ({ heldLockValue }) => {
    let stageRoot = null;
    let distMovedToBackup = false;

    try {
      const stagedBuild = await stagePackageDistBuild({
        buildPlan,
        packageJson,
        buildIntoDistDir: options.buildIntoDistDir ?? ((params) => runTscBuild({
          ...params,
          stdio: options.stdio ?? 'inherit',
          runCommandImpl: options.runCommandImpl ?? spawnSync,
        })),
        env: {
          ...commandEnv,
          HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: heldLockValue,
        },
      });
      stageRoot = stagedBuild.stageRoot;

      verifyStagedPackageDistExports({
        stageRoot: stagedBuild.stageRoot,
        packageJson,
      });

      if (workspaceOutputDir) {
        await copyDirectoryContents(stagedBuild.stageDistDir, outputDir);
      } else {
        try {
          const swapResult = await swapStagedPackageDistIntoPlace({
            buildPlan,
            stageDistDir: stagedBuild.stageDistDir,
          });
          distMovedToBackup = Boolean(swapResult?.distMovedToBackup);
          verifyPackageExportTargets({ packageDir, packageJson });
        } catch (error) {
          distMovedToBackup = distMovedToBackup || existsSync(buildPlan.backupDir);
          await restorePackageDistFromBackup({
            buildPlan,
            distMovedToBackup,
          });
          throw error;
        }
      }
    } finally {
      if (stageRoot) {
        if (workspaceOutputDir) {
          await rm(stageRoot, { recursive: true, force: true }).catch(() => {});
        } else {
          await cleanupPackageDistBuildArtifacts({ buildPlan, stageRoot }).catch(() => {});
        }
      }
    }

    const indexPath = join(outputDir, 'index.js');
    const marker = readFileSync(indexPath, 'utf8');
    if (!marker.trim()) {
      throw new Error(`cli-common build produced an empty dist entrypoint: ${relative(packageDir, indexPath)}`);
    }
  };

  // An outer workspace publisher that supplies HAPPIER_WORKSPACE_DIST_OUTPUT_DIR already owns
  // this package's workspace build lock and passes only the global bundle lease through
  // HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD; reacquiring the same package lock here would
  // self-deadlock the nested build. Mirror scripts/workspaces/buildTypeScriptPackageDist.mjs:
  // copy verified compiler output into the supplied stage without swapping it, and keep the
  // ordinary workspace package lock for standalone builds.
  if (workspaceOutputDir) {
    return await runStagedBuild({
      heldLockValue: commandEnv.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD,
    });
  }

  return await withWorkspaceDistBuildLock(runStagedBuild, {
    lockPath,
    env: commandEnv,
    timeoutMs: lockTimeoutMs,
    pollIntervalMs: lockPollMs,
    staleAfterMs: lockTimeoutMs,
  });
}

export async function buildCliCommonDist(options = {}) {
  return await buildPackageDistAtomically(options);
}

async function main() {
  if (resolveBuildScriptMode(process.argv.slice(2)) === 'clean') {
    cleanPackageDistSync();
    return;
  }
  await buildCliCommonDist();
}

const isEntrypoint = (() => {
  const arg = typeof process.argv?.[1] === 'string' ? process.argv[1] : '';
  if (!arg) return false;
  return arg.endsWith('/scripts/build.mjs') || arg.endsWith('\\scripts\\build.mjs');
})();

if (isEntrypoint) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
