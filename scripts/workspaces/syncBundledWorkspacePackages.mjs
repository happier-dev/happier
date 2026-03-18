import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

let syncSequence = 0;

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

export function sanitizeBundledWorkspacePackageJson(raw) {
  const {
    name,
    version,
    type,
    main,
    module,
    types,
    exports,
    dependencies,
    peerDependencies,
    optionalDependencies,
    engines,
  } = raw ?? {};

  return {
    name,
    version,
    private: true,
    type,
    main,
    module,
    types,
    exports,
    dependencies,
    peerDependencies,
    optionalDependencies,
    engines,
  };
}

function resolveSyncSwapSuffix(syncId) {
  const explicit = String(syncId ?? '').trim();
  if (explicit) return explicit;

  syncSequence += 1;
  return `${process.pid}.${syncSequence}`;
}

function isRetryableRmError(err) {
  const code = err && typeof err === 'object' ? err.code : null;
  return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EINTR';
}

function isStaleSwapDirName(name, targetBaseName) {
  return name.startsWith(`${targetBaseName}.__sync_tmp__.`) || name.startsWith(`${targetBaseName}.__sync_backup__.`);
}

function removeStaleBundledWorkspaceSwapDirs(parentDir, targetBaseName, fsOps) {
  const dir = String(parentDir ?? '').trim();
  const baseName = String(targetBaseName ?? '').trim();
  if (!dir || !baseName || !fsOps.existsSync(dir)) return;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isStaleSwapDirName(entry.name, baseName)) continue;
    rmDirSafeSync(resolve(dir, entry.name), fsOps);
  }
}

export function rmDirSafeSync(targetDir, fsOps = {}, { retries = 5, delayMs = 25 } = {}) {
  const rm = fsOps.rmSync ?? rmSync;
  const path = String(targetDir ?? '').trim();
  if (!path) return;

  const maxAttempts = Math.max(1, Number.isFinite(retries) ? retries + 1 : 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableRmError(error) || attempt === maxAttempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
}

function replaceDirFromSourceSync(targetDir, srcDir, fsOps, { syncSuffix } = {}) {
  const outDir = String(targetDir ?? '').trim();
  const sourceDir = String(srcDir ?? '').trim();
  if (!outDir || !sourceDir) return;

  const parentDir = dirname(outDir);
  removeStaleBundledWorkspaceSwapDirs(parentDir, basename(outDir), fsOps);
  const suffix = resolveSyncSwapSuffix(syncSuffix);
  const stagingDir = `${outDir}.__sync_tmp__.${suffix}`;
  const backupDir = `${outDir}.__sync_backup__.${suffix}`;

  fsOps.mkdirSync(parentDir, { recursive: true });
  rmDirSafeSync(stagingDir, fsOps);
  rmDirSafeSync(backupDir, fsOps);
  fsOps.cpSync(sourceDir, stagingDir, { recursive: true, force: true });

  let movedExistingDir = false;
  try {
    if (fsOps.existsSync(outDir)) {
      fsOps.renameSync(outDir, backupDir);
      movedExistingDir = true;
    }

    fsOps.renameSync(stagingDir, outDir);

    if (movedExistingDir) {
      rmDirSafeSync(backupDir, fsOps);
    }
  } catch (error) {
    rmDirSafeSync(stagingDir, fsOps);
    if (movedExistingDir && fsOps.existsSync(backupDir) && !fsOps.existsSync(outDir)) {
      fsOps.renameSync(backupDir, outDir);
    }
    throw error;
  }
}

export function syncBundledWorkspacePackages(opts = {}) {
  const repoRoot = String(opts.repoRoot ?? '').trim();
  if (!repoRoot) return;

  const exists = opts.existsSync ?? existsSync;
  const cp = opts.cpSync ?? cpSync;
  const mkdir = opts.mkdirSync ?? mkdirSync;
  const rename = opts.renameSync ?? renameSync;
  const rm = opts.rmSync ?? rmSync;
  const readFile = opts.readFileSync ?? readFileSync;
  const writeFile = opts.writeFileSync ?? writeFileSync;
  const syncId = opts.syncId;
  const packages = Array.isArray(opts.packages) && opts.packages.length > 0
    ? opts.packages
    : ['agents', 'cli-common', 'connection-supervisor', 'protocol', 'transfers', 'release-runtime'];
  const hostApps = Array.isArray(opts.hostApps) && opts.hostApps.length > 0
    ? opts.hostApps
    : ['cli', 'stack'];

  for (const pkg of packages) {
    const srcDist = resolve(repoRoot, 'packages', pkg, 'dist');
    const srcPackageJsonPath = resolve(repoRoot, 'packages', pkg, 'package.json');
    if (!exists(srcPackageJsonPath)) continue;

    for (const hostApp of hostApps) {
      const destPackageDir = resolve(repoRoot, 'apps', hostApp, 'node_modules', '@happier-dev', pkg);
      const destDist = resolve(destPackageDir, 'dist');
      if (exists(srcDist)) {
        try {
          replaceDirFromSourceSync(destDist, srcDist, {
            existsSync: exists,
            cpSync: cp,
            mkdirSync: mkdir,
            renameSync: rename,
            rmSync: rm,
          }, { syncSuffix: syncId });
        } catch {
          // Best-effort: bundled deps may be missing or readonly.
        }
      }

      const destPackageJsonPath = resolve(destPackageDir, 'package.json');
      try {
        mkdir(destPackageDir, { recursive: true });
        const raw = JSON.parse(readFile(srcPackageJsonPath, 'utf8'));
        const sanitized = sanitizeBundledWorkspacePackageJson(raw);
        writeFile(destPackageJsonPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
      } catch {
        // Best-effort: keep local bundled deps usable even if package.json sync fails.
      }
    }
  }
}
