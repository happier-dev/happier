import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withOptionalCliDistBuildLockSync } from './optionalWorkspaceBundleLock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WRITE_FS_OPTION_NAMES = ['cpSync', 'mkdirSync', 'renameSync', 'rmSync'];
const WINDOWS_TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

function renameForPublicationSync(from, to, {
  platform,
  rename,
  wait,
  maxRetries,
}) {
  let retry = 0;
  while (true) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      if (
        platform !== 'win32'
        || !WINDOWS_TRANSIENT_RENAME_CODES.has(error?.code)
        || retry >= maxRetries
      ) {
        throw error;
      }
      wait(Math.min(25 * (2 ** retry), 400));
      retry += 1;
    }
  }
}

export function resolveCliPackageRoot(scriptDir = __dirname) {
  return resolve(scriptDir, '..');
}

export function syncPackageDist(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? resolveCliPackageRoot()));
  const distDir = resolve(String(options.distDir ?? resolve(packageRoot, 'dist')));
  const packageDistDir = resolve(String(options.packageDistDir ?? resolve(packageRoot, 'package-dist')));
  if (shouldSkipPackageDistSync(options.env ?? process.env)) {
    return {
      packageRoot,
      distDir,
      packageDistDir,
      skipped: true,
    };
  }
  return withOptionalCliDistBuildLockSync(() => syncPackageDistUnlocked({ ...options, packageRoot }), {
    startDir: packageRoot,
    repoRoot: options.repoRoot,
    lockPath: options.lockPath,
    lockModulePath: options.lockModulePath,
    lockTimeoutMs: options.lockTimeoutMs,
    lockPollIntervalMs: options.lockPollIntervalMs,
    lockStaleAfterMs: options.lockStaleAfterMs,
    skipLock: options.skipLock,
    env: options.env,
    heldLockValue: options.heldLockValue,
  });
}

function shouldSkipPackageDistSync(env) {
  const raw = String(env?.HAPPIER_CLI_SKIP_PACKAGE_DIST_SYNC ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

function syncPackageDistUnlocked(options = {}) {
  const packageRoot = resolve(String(options.packageRoot ?? resolveCliPackageRoot()));
  const distDir = resolve(String(options.distDir ?? resolve(packageRoot, 'dist')));
  const packageDistDir = resolve(String(options.packageDistDir ?? resolve(packageRoot, 'package-dist')));
  const exists = options.existsSync ?? existsSync;
  const { copy, makeDir, rename, remove } = resolveWriteFs(options);

  if (!exists(distDir)) {
    throw new Error(`[sync-package-dist] missing dist directory: ${distDir}`);
  }

  const suffix = `${process.pid}.${Date.now()}`;
  const stagingDir = `${packageDistDir}.__sync_tmp__.${suffix}`;
  const backupDir = `${packageDistDir}.__sync_backup__.${suffix}`;

  remove(stagingDir, { recursive: true, force: true });
  remove(backupDir, { recursive: true, force: true });
  makeDir(dirname(packageDistDir), { recursive: true });
  copy(distDir, stagingDir, { recursive: true });

  atomicPromoteDirectorySync({
    sourceDir: stagingDir,
    targetDir: packageDistDir,
    backupDir,
    existsSync: exists,
    mkdirSync: makeDir,
    renameSync: rename,
    rmSync: remove,
    removeSourceOnFailure: true,
  });

  return {
    packageRoot,
    distDir,
    packageDistDir,
  };
}

export function atomicPromoteDirectorySync(options = {}) {
  const sourceDir = resolve(String(options.sourceDir ?? ''));
  const targetDir = resolve(String(options.targetDir ?? ''));
  const backupDir = resolve(String(options.backupDir ?? `${targetDir}.__backup__.${process.pid}.${Date.now()}`));
  const exists = options.existsSync ?? existsSync;
  const makeDir = options.mkdirSync ?? mkdirSync;
  const rename = options.renameSync ?? renameSync;
  const remove = options.rmSync ?? rmSync;
  const removeSourceOnFailure = options.removeSourceOnFailure !== false;
  const platform = options.platform ?? process.platform;
  const wait = options.waitSync ?? waitSync;
  const maxRenameRetries = options.maxRenameRetries ?? 8;
  const promote = (from, to) => renameForPublicationSync(from, to, {
    platform,
    rename,
    wait,
    maxRetries: maxRenameRetries,
  });

  if (!sourceDir || !targetDir || sourceDir === targetDir) {
    throw new Error('[atomic-promote] source and target directories must be distinct');
  }
  if (!exists(sourceDir)) {
    throw new Error(`[atomic-promote] missing source directory: ${sourceDir}`);
  }

  remove(backupDir, { recursive: true, force: true });
  makeDir(dirname(targetDir), { recursive: true });

  let movedExistingDir = false;
  try {
    if (exists(targetDir)) {
      promote(targetDir, backupDir);
      movedExistingDir = true;
    }
    promote(sourceDir, targetDir);
    if (movedExistingDir) {
      remove(backupDir, { recursive: true, force: true });
    }
  } catch (error) {
    if (removeSourceOnFailure) {
      remove(sourceDir, { recursive: true, force: true });
    }
    if (movedExistingDir && exists(backupDir) && !exists(targetDir)) {
      promote(backupDir, targetDir);
    }
    throw error;
  }
}

function hasOwnOption(options, name) {
  return Object.prototype.hasOwnProperty.call(options, name);
}

function resolveWriteFs(options) {
  const injectedWriteNames = WRITE_FS_OPTION_NAMES.filter((name) => hasOwnOption(options, name));
  if (injectedWriteNames.length > 0 && injectedWriteNames.length < WRITE_FS_OPTION_NAMES.length) {
    const missingNames = WRITE_FS_OPTION_NAMES.filter((name) => !hasOwnOption(options, name)).join(', ');
    throw new Error(`[sync-package-dist] incomplete filesystem adapter; missing ${missingNames}`);
  }

  return {
    copy: options.cpSync ?? cpSync,
    makeDir: options.mkdirSync ?? mkdirSync,
    rename: options.renameSync ?? renameSync,
    remove: options.rmSync ?? rmSync,
  };
}

const invokedAsMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  return resolve(argv1) === resolve(fileURLToPath(import.meta.url));
})();

if (invokedAsMain) {
  try {
    syncPackageDist();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
