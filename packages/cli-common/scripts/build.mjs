import { spawnSync } from 'node:child_process';
import { existsSync, closeSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

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

function workspacePackageLockSlug(packageDir, packageJson) {
  const raw = String(packageJson?.name ?? '').trim() || resolve(packageDir);
  const slug = raw.replace(/^@/, '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'cli-common';
}

export function resolveCliCommonDistBuildLockPath(packageDir) {
  const resolvedPackageDir = resolve(packageDir);
  const repoRoot = resolve(resolvedPackageDir, '..', '..');
  const packageJson = readJson(join(resolvedPackageDir, 'package.json'));
  return join(repoRoot, '.project', 'tmp', 'workspace-dist-builds', `${workspacePackageLockSlug(resolvedPackageDir, packageJson)}.lock`);
}

function parseLockOwner(lockPath) {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function shouldReclaimLock(lockPath, staleAfterMs, nowMs) {
  const owner = parseLockOwner(lockPath);
  if (!owner) return true;
  if (owner.pid && !isPidAlive(owner.pid)) return true;
  const updatedAtMs = Number(owner.updatedAtMs ?? owner.createdAtMs ?? 0);
  return Boolean(updatedAtMs && nowMs - updatedAtMs > staleAfterMs);
}

function serializeLockOwner(nowMs) {
  return JSON.stringify({ pid: process.pid, createdAtMs: nowMs, updatedAtMs: nowMs });
}

export async function withWorkspaceDistBuildLock(fn, options) {
  const lockPath = options?.lockPath;
  if (!lockPath) throw new Error('withWorkspaceDistBuildLock requires lockPath');

  const env = options?.env ?? process.env;
  if (String(env.HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD ?? '').trim() === lockPath) {
    return await fn({ waited: false });
  }

  mkdirSync(dirname(lockPath), { recursive: true });

  const timeoutMs = options?.timeoutMs ?? 240_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 250;
  const staleAfterMs = options?.staleAfterMs ?? timeoutMs;
  const startedAt = Date.now();
  let fd = null;
  let heartbeat = null;
  let waited = false;

  while (true) {
    try {
      fd = openSync(lockPath, 'wx');
      writeFileSync(fd, serializeLockOwner(Date.now()), 'utf8');
      closeSync(fd);
      break;
    } catch (error) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // best-effort cleanup
        }
        fd = null;
      }
      if (error?.code !== 'EEXIST') throw error;
      if (shouldReclaimLock(lockPath, staleAfterMs, Date.now())) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for workspace dist build lock: ${lockPath}`);
      }
      waited = true;
      await delay(pollIntervalMs);
    }
  }

  try {
    heartbeat = setInterval(() => {
      try {
        writeFileSync(lockPath, serializeLockOwner(Date.now()), 'utf8');
      } catch {
        // best-effort heartbeat
      }
    }, Math.max(500, Math.min(5_000, Math.floor(staleAfterMs / 4))));
    return await fn({ waited });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (fd !== null) {
      try {
        unlinkSync(lockPath);
      } catch {
        // best-effort cleanup
      }
    }
  }
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
  const lockPath = options.lockPath ?? buildPlan.lockPath;
  const lockTimeoutMs = options.lockTimeoutMs
    ?? parsePositiveInteger(commandEnv.HAPPIER_PACKAGE_DIST_BUILD_LOCK_TIMEOUT_MS, 240_000);
  const lockPollMs = options.lockPollMs
    ?? parsePositiveInteger(commandEnv.HAPPIER_PACKAGE_DIST_BUILD_LOCK_POLL_MS, 250);

  return await withWorkspaceDistBuildLock(async () => {
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
          HAPPIER_WORKSPACE_DIST_BUILD_LOCK_HELD: lockPath,
        },
      });
      stageRoot = stagedBuild.stageRoot;

      verifyStagedPackageDistExports({
        stageRoot: stagedBuild.stageRoot,
        packageJson,
      });

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
    } finally {
      if (stageRoot) {
        await cleanupPackageDistBuildArtifacts({
          buildPlan,
          stageRoot,
        }).catch(() => {});
      }
    }

    const indexPath = join(buildPlan.distDir, 'index.js');
    const marker = readFileSync(indexPath, 'utf8');
    if (!marker.trim()) {
      throw new Error(`cli-common build produced an empty dist entrypoint: ${relative(packageDir, indexPath)}`);
    }
  }, {
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
