import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import {
  copyDirDereferenceContainedSync,
  publishStagedDirectoryMountedSync,
  vendorRuntimeDependencyTree,
} from '../../packages/cli-common/workspaceRuntimeDependencies.mjs';

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

function isRetryableFsError(err) {
  const code = err && typeof err === 'object' ? err.code : null;
  return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EINTR';
}

function rmDirSafeSync(targetDir, { retries = 5, delayMs = 25 } = {}) {
  const path = String(targetDir ?? '').trim();
  if (!path) return;

  const maxAttempts = Math.max(1, Number.isFinite(retries) ? retries + 1 : 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableFsError(error) || attempt === maxAttempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
}

function isVendoredSwapDirName(name, targetBaseName) {
  return name.startsWith(`${targetBaseName}.__sync_tmp__.`) || name.startsWith(`${targetBaseName}.__sync_backup__.`);
}

function removeStaleVendoredSwapDirs(parentDir, targetBaseName) {
  if (!existsSync(parentDir)) return;

  for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isVendoredSwapDirName(entry.name, targetBaseName)) continue;
    rmDirSafeSync(resolve(parentDir, entry.name));
  }
}

function atomicReplaceBuiltDirSync(targetDir, buildInto) {
  const outDir = String(targetDir ?? '').trim();
  if (!outDir) return;

  const parentDir = dirname(outDir);
  const baseName = basename(outDir);
  removeStaleVendoredSwapDirs(parentDir, baseName);

  const syncSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const stagingDir = `${outDir}.__sync_tmp__.${syncSuffix}`;
  const rollbackDir = `${outDir}.__sync_backup__.${syncSuffix}`;

  mkdirSync(parentDir, { recursive: true });
  rmDirSafeSync(stagingDir);
  rmDirSafeSync(rollbackDir);

  try {
    buildInto(stagingDir);
    if (existsSync(outDir)) {
      publishStagedDirectoryMountedSync({
        stagedDir: stagingDir,
        liveDir: outDir,
        rollbackDir,
        pruneStale: false,
      });
      rmDirSafeSync(stagingDir);
      return;
    }

    renameSync(stagingDir, outDir);
  } catch (error) {
    rmDirSafeSync(stagingDir);
    throw error;
  }
}

export function vendorBundledPackageRuntimeDependenciesFallback({
  srcPackageJsonPath,
  resolveFromPackageJsonPath = srcPackageJsonPath,
  destPackageDir,
  dereferenceRootDir,
}) {
  if (!existsSync(srcPackageJsonPath)) {
    throw new Error(`Missing package.json: ${srcPackageJsonPath}`);
  }

  const destNodeModulesDir = resolve(destPackageDir, 'node_modules');
  atomicReplaceBuiltDirSync(destNodeModulesDir, (tempNodeModulesDir) => {
    vendorRuntimeDependencyTree({
      packageJsonPath: srcPackageJsonPath,
      resolveFromPackageJsonPath,
      destNodeModulesDir: tempNodeModulesDir,
      dereferenceRootDir,
      copyResolvedPackage: ({
        sourcePackageDir,
        destPackageDir: dependencyDestDir,
        dereferenceRootDir: dependencyDereferenceRootDir,
      }) => {
        rmDirSafeSync(dependencyDestDir);
        copyDirDereferenceContainedSync({
          sourceDir: sourcePackageDir,
          destDir: dependencyDestDir,
          dereferenceRootDir: dependencyDereferenceRootDir,
        });
      },
    });
  });
  if (existsSync(destNodeModulesDir) && readdirSync(destNodeModulesDir).length === 0) {
    rmDirSafeSync(destNodeModulesDir);
  }
}
