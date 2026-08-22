import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import { vendorBundledPackageRuntimeDependenciesFallback } from './vendorBundledWorkspaceRuntimeDependenciesFallback.mjs';

const EXTENSIONS_WORKSPACE_PREFIX = 'plugins-';

function stripInternalBundledWorkspaceDependencies(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  const out = {};
  for (const [name, version] of Object.entries(value)) {
    if (name.startsWith('@happier-dev/')) continue;
    out[name] = version;
  }

  return out;
}

function hasExternalRuntimeDependencies(rawPackageJson) {
  for (const dependencies of [rawPackageJson?.dependencies, rawPackageJson?.optionalDependencies]) {
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue;
    if (Object.keys(dependencies).some((name) => !name.startsWith('@happier-dev/'))) return true;
  }
  return false;
}

function collectPackageJsonRelativeFileTargets(value, result) {
  if (typeof value === 'string') {
    if (value.startsWith('./') && !value.includes('*')) {
      result.add(value.slice(2));
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectPackageJsonRelativeFileTargets(item, result);
    return;
  }
  for (const nested of Object.values(value)) collectPackageJsonRelativeFileTargets(nested, result);
}

function syncBundledWorkspaceReferencedFiles({ srcPackageDir, destPackageDir, packageJsonRaw, fsOps = {} }) {
  const exists = fsOps.existsSync ?? existsSync;
  const mkdir = fsOps.mkdirSync ?? mkdirSync;
  const stat = fsOps.statSync ?? statSync;

  const relativeTargets = new Set();
  collectPackageJsonRelativeFileTargets(packageJsonRaw?.main, relativeTargets);
  collectPackageJsonRelativeFileTargets(packageJsonRaw?.module, relativeTargets);
  collectPackageJsonRelativeFileTargets(packageJsonRaw?.types, relativeTargets);
  collectPackageJsonRelativeFileTargets(packageJsonRaw?.exports, relativeTargets);

  for (const relPath of relativeTargets) {
    // `dist/**` is synced separately with extra staging/atomicity; skip it here.
    if (relPath.startsWith('dist/')) continue;

    const srcPath = resolve(srcPackageDir, relPath);
    if (!exists(srcPath)) continue;
    const destPath = resolve(destPackageDir, relPath);

    try {
      mkdir(dirname(destPath), { recursive: true });
      stat(srcPath);
      copyDirSafeSync(srcPath, destPath, fsOps);
    } catch (error) {
      if (fsOps.strict === true) throw error;
      // Best-effort: keep local bundled deps usable even if extra file sync fails.
    }
  }
}

function sanitizeBundledPackageJsonFallback(raw) {
  const {
    name,
    version,
    type,
    main,
    module,
    types,
    exports,
    bin,
    dependencies,
    peerDependencies,
    optionalDependencies,
    engines,
  } = raw ?? {};

  // Keep this aligned with `packages/cli-common/src/workspaces/index.ts#sanitizeBundledPackageJson`.
  return {
    name,
    version,
    private: true,
    type,
    main,
    module,
    types,
    exports,
    ...(bin === undefined ? {} : { bin }),
    dependencies: stripInternalBundledWorkspaceDependencies(dependencies),
    peerDependencies,
    optionalDependencies: stripInternalBundledWorkspaceDependencies(optionalDependencies),
    engines,
  };
}

let sanitizeBundledPackageJsonImpl = sanitizeBundledPackageJsonFallback;
let readBundledWorkspacePackageNamesImpl = null;
let vendorBundledPackageRuntimeDependenciesImpl = null;
let bundleWorkspacePackageWithRuntimeDependenciesImpl = null;
let resolveInternalWorkspacePackageNameClosureImpl = null;
let atomicReplaceDirSyncImpl = null;
let copyDirSafeSyncImpl = null;
let rmDirSafeSyncImpl = null;

try {
  const mod = await import('../../packages/cli-common/dist/workspaces/index.js');
  if (mod && typeof mod.sanitizeBundledPackageJson === 'function') {
    sanitizeBundledPackageJsonImpl = mod.sanitizeBundledPackageJson;
  }
  if (mod && typeof mod.readBundledWorkspacePackageNames === 'function') {
    readBundledWorkspacePackageNamesImpl = mod.readBundledWorkspacePackageNames;
  }
  if (mod && typeof mod.vendorBundledPackageRuntimeDependencies === 'function') {
    vendorBundledPackageRuntimeDependenciesImpl = mod.vendorBundledPackageRuntimeDependencies;
  }
  if (mod && typeof mod.bundleWorkspacePackageWithRuntimeDependencies === 'function') {
    bundleWorkspacePackageWithRuntimeDependenciesImpl = mod.bundleWorkspacePackageWithRuntimeDependencies;
  }
  if (mod && typeof mod.resolveInternalWorkspacePackageNameClosure === 'function') {
    resolveInternalWorkspacePackageNameClosureImpl = mod.resolveInternalWorkspacePackageNameClosure;
  }
  if (mod && typeof mod.atomicReplaceDirSync === 'function') {
    atomicReplaceDirSyncImpl = mod.atomicReplaceDirSync;
  }
  if (mod && typeof mod.copyDirSafeSync === 'function') {
    copyDirSafeSyncImpl = mod.copyDirSafeSync;
  }
  if (mod && typeof mod.rmDirSafeSync === 'function') {
    rmDirSafeSyncImpl = mod.rmDirSafeSync;
  }
} catch {
  // Best-effort: local preflight sandboxes may not have `packages/cli-common/dist/**` available.
}

export function sanitizeBundledWorkspacePackageJson(raw) {
  return sanitizeBundledPackageJsonImpl(raw);
}

export { vendorBundledPackageRuntimeDependenciesFallback };

let syncSequence = 0;
const DEFAULT_STALE_SWAP_DIR_AGE_MS = 60_000;

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
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

function isRetryableCopyError(err) {
  const code = err && typeof err === 'object' ? err.code : null;
  return code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EINTR';
}

function isStaleSwapDirName(name, targetBaseName) {
  return name.startsWith(`${targetBaseName}.__sync_tmp__.`) || name.startsWith(`${targetBaseName}.__sync_backup__.`);
}

function parseSwapDirOwnerPid(name, targetBaseName) {
  const prefix = `${targetBaseName}.__sync_`;
  if (!name.startsWith(prefix)) return null;

  const suffix = name.slice(prefix.length);
  const firstDot = suffix.indexOf('.');
  if (firstDot < 0) return null;

  const ownerPid = Number(suffix.slice(firstDot + 1).split('.')[0]);
  return Number.isFinite(ownerPid) && ownerPid > 1 ? ownerPid : null;
}

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function shouldRemoveSwapDir(entryPath, entryName, targetBaseName, fsOps, options = {}) {
  const stat = fsOps.statSync ?? statSync;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const staleSwapDirAgeMs =
    Number.isFinite(options.staleSwapDirAgeMs) && options.staleSwapDirAgeMs >= 0
      ? options.staleSwapDirAgeMs
      : DEFAULT_STALE_SWAP_DIR_AGE_MS;

  let stats;
  try {
    stats = stat(entryPath);
  } catch {
    return false;
  }

  const ageMs = Math.max(0, nowMs - Number(stats?.mtimeMs ?? 0));
  const ownerPid = parseSwapDirOwnerPid(entryName, targetBaseName);
  if (ownerPid) {
    if (!isPidAlive(ownerPid)) return true;
    return ageMs > staleSwapDirAgeMs;
  }

  return ageMs > staleSwapDirAgeMs;
}

function removeStaleBundledWorkspaceSwapDirs(parentDir, targetBaseName, fsOps, options = {}) {
  const dir = String(parentDir ?? '').trim();
  const baseName = String(targetBaseName ?? '').trim();
  if (!dir || !baseName || !fsOps.existsSync(dir)) return;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isStaleSwapDirName(entry.name, baseName)) continue;
    const entryPath = resolve(dir, entry.name);
    if (!shouldRemoveSwapDir(entryPath, entry.name, baseName, fsOps, options)) continue;
    rmDirSafeSync(entryPath, fsOps);
  }
}

function readBundledWorkspacePackageNamesFromHostPackageJson(raw, readPackageNames) {
  if (readPackageNames) {
    try {
      return readPackageNames(raw);
    } catch {
      // Fall through to the local implementation.
    }
  }

  const bundledDependencies = Array.isArray(raw?.bundledDependencies)
    ? raw.bundledDependencies
    : Array.isArray(raw?.bundleDependencies)
      ? raw.bundleDependencies
      : [];

  return bundledDependencies
    .filter((value) => typeof value === 'string' && value.startsWith('@happier-dev/'));
}

function resolveDefaultBundledWorkspacePackageNames(
  repoRoot,
  hostPackageDirs,
  readFileImpl = readFileSync,
  cliCommonWorkspacesModule = null,
) {
  const repo = String(repoRoot ?? '').trim();
  if (!repo) return [];
  const readPackageNames =
    typeof cliCommonWorkspacesModule?.readBundledWorkspacePackageNames === 'function'
      ? cliCommonWorkspacesModule.readBundledWorkspacePackageNames
      : readBundledWorkspacePackageNamesImpl;
  const resolvePackageClosure =
    typeof cliCommonWorkspacesModule?.resolveInternalWorkspacePackageNameClosure === 'function'
      ? cliCommonWorkspacesModule.resolveInternalWorkspacePackageNameClosure
      : resolveInternalWorkspacePackageNameClosureImpl;

  const out = new Set();
  for (const hostPackageDir of hostPackageDirs) {
    try {
      const hostPackageJsonPath = resolve(String(hostPackageDir ?? '').trim(), 'package.json');
      const raw = JSON.parse(readFileImpl(hostPackageJsonPath, 'utf8'));
      for (const packageName of readBundledWorkspacePackageNamesFromHostPackageJson(
        raw,
        readPackageNames,
      )) {
        const leaf = String(packageName).split('/').pop();
        if (leaf) out.add(leaf);
      }
    } catch {
      // Best-effort: some host apps may not exist in certain sandboxes.
    }
  }
  const packageNames = [...out].map((leaf) => `@happier-dev/${leaf}`);
  if (!resolvePackageClosure) {
    return [...out];
  }

  const declaredPackageNames = new Set(packageNames);
  return resolvePackageClosure({
    repoRoot: repo,
    packageNames,
  })
    .filter((packageName) => declaredPackageNames.has(packageName))
    .map((packageName) => packageName.split('/').pop())
    .filter(Boolean);
}

function resolveBundledWorkspaceSourceDir({ repoRoot, workspaceLeaf }) {
  const leaf = String(workspaceLeaf ?? '').trim();
  if (!leaf) return '';
  if (leaf.startsWith(EXTENSIONS_WORKSPACE_PREFIX)) {
    const extensionId = leaf.slice(EXTENSIONS_WORKSPACE_PREFIX.length);
    if (extensionId) {
      return resolve(repoRoot, 'packages', 'plugins', extensionId);
    }
  }
  return resolve(repoRoot, 'packages', leaf);
}

function hasInjectedFileSystemOps(fsOps) {
  return Boolean(
    (fsOps.existsSync && fsOps.existsSync !== existsSync)
      || (fsOps.lstatSync && fsOps.lstatSync !== lstatSync)
      || (fsOps.mkdirSync && fsOps.mkdirSync !== mkdirSync)
      || (fsOps.readlinkSync && fsOps.readlinkSync !== readlinkSync)
      || (fsOps.readdirSync && fsOps.readdirSync !== readdirSync)
      || (fsOps.renameSync && fsOps.renameSync !== renameSync)
      || (fsOps.rmSync && fsOps.rmSync !== rmSync)
      || (fsOps.statSync && fsOps.statSync !== statSync)
      || (fsOps.symlinkSync && fsOps.symlinkSync !== symlinkSync)
      || (fsOps.unlinkSync && fsOps.unlinkSync !== unlinkSync)
      || (fsOps.copyFileSync && fsOps.copyFileSync !== copyFileSync)
  );
}

function hasInjectedPackageSyncOps(opts) {
  return Boolean(
    (opts.existsSync && opts.existsSync !== existsSync)
      || (opts.mkdirSync && opts.mkdirSync !== mkdirSync)
      || (opts.readFileSync && opts.readFileSync !== readFileSync)
      || (opts.renameSync && opts.renameSync !== renameSync)
      || (opts.rmSync && opts.rmSync !== rmSync)
      || (opts.writeFileSync && opts.writeFileSync !== writeFileSync)
      || opts.nowMs !== undefined
      || opts.staleSwapDirAgeMs !== undefined
      || typeof opts.isPidAlive === 'function'
      || typeof opts.vendorBundledPackageRuntimeDependencies === 'function'
  );
}

export function rmDirSafeSync(targetDir, fsOps = {}, { retries = 5, delayMs = 25 } = {}) {
  if (rmDirSafeSyncImpl) {
    rmDirSafeSyncImpl(targetDir, {
      recursive: true,
      force: true,
      retries,
      delayMs,
      rmSyncImpl: fsOps.rmSync ?? rmSync,
    });
    return;
  }

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

function copyDirSafeSync(srcDir, destDir, fsOps = {}, { retries = 5, delayMs = 25, dereference = false } = {}) {
  if (copyDirSafeSyncImpl && !hasInjectedFileSystemOps(fsOps)) {
    copyDirSafeSyncImpl(srcDir, destDir, {
      recursive: true,
      force: true,
      dereference,
      retries,
      delayMs,
      copyFileSyncImpl: copyFileSync,
      existsSyncImpl: existsSync,
      lstatSyncImpl: lstatSync,
      mkdirSyncImpl: mkdirSync,
      readlinkSyncImpl: readlinkSync,
      readdirSyncImpl: (path) => readdirSync(path, { withFileTypes: true }),
      statSyncImpl: statSync,
      symlinkSyncImpl: symlinkSync,
      unlinkSyncImpl: unlinkSync,
    });
    return;
  }

  // Bootstrap fallback for sandboxes where cli-common/dist is unavailable, and for
  // tests that run against a virtual filesystem instead of real paths.
  const explicitCp = fsOps.cpSync;
  const copyFile = fsOps.copyFileSync ?? copyFileSync;
  const exists = fsOps.existsSync ?? existsSync;
  const lstat = fsOps.lstatSync ?? lstatSync;
  const mkdir = fsOps.mkdirSync ?? mkdirSync;
  const readDir = fsOps.readdirSync ?? readdirSync;
  const readLink = fsOps.readlinkSync ?? readlinkSync;
  const stat = fsOps.statSync ?? statSync;
  const symlink = fsOps.symlinkSync ?? symlinkSync;
  const unlink = fsOps.unlinkSync ?? unlinkSync;

  const copyWithJsWalker = (sourcePath, targetPath) => {
    const sourceStats = dereference ? stat(sourcePath) : lstat(sourcePath);
    if (sourceStats.isDirectory()) {
      mkdir(targetPath, { recursive: true });
      for (const entry of readDir(sourcePath, { withFileTypes: true })) {
        copyWithJsWalker(resolve(sourcePath, entry.name), resolve(targetPath, entry.name));
      }
      return;
    }

    mkdir(dirname(targetPath), { recursive: true });
    if (!dereference && sourceStats.isSymbolicLink()) {
      if (exists(targetPath)) unlink(targetPath);
      symlink(readLink(sourcePath), targetPath);
      return;
    }

    copyFile(sourcePath, targetPath);
  };

  const maxAttempts = Math.max(1, Number.isFinite(retries) ? retries + 1 : 1);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      if (typeof explicitCp === 'function') {
        explicitCp(srcDir, destDir, { recursive: true, force: true });
      } else {
        copyWithJsWalker(srcDir, destDir);
      }
      return;
    } catch (error) {
      if (!isRetryableCopyError(error) || attempt === maxAttempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
}

function replaceDirFromSourceSync(targetDir, srcDir, fsOps, options = {}) {
  const outDir = String(targetDir ?? '').trim();
  const sourceDir = String(srcDir ?? '').trim();
  if (!outDir || !sourceDir) return;

  const parentDir = dirname(outDir);
  removeStaleBundledWorkspaceSwapDirs(parentDir, basename(outDir), fsOps, options);
  if (atomicReplaceDirSyncImpl && !hasInjectedFileSystemOps(fsOps)) {
    atomicReplaceDirSyncImpl({
      destDir: outDir,
      buildInto(tempDir) {
        copyDirSafeSync(sourceDir, tempDir, fsOps, { retries: 5, delayMs: 25 });
      },
      fsOps: {
        existsSync,
        mkdirSync,
        renameSync,
        rmSync,
      },
    });
    return;
  }

  // Bootstrap fallback for sandboxes where cli-common/dist is unavailable, and for
  // tests that run against a virtual filesystem instead of real paths.
  const suffix = resolveSyncSwapSuffix(options.syncSuffix);
  const stagingDir = `${outDir}.__sync_tmp__.${suffix}`;
  const backupDir = `${outDir}.__sync_backup__.${suffix}`;

  fsOps.mkdirSync(parentDir, { recursive: true });
  rmDirSafeSync(stagingDir, fsOps);
  rmDirSafeSync(backupDir, fsOps);
  copyDirSafeSync(sourceDir, stagingDir, fsOps, { retries: 5, delayMs: 25 });

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

export function bundleWorkspacePackageFallbackTransactionally({
  srcPackageDir,
  destPackageDir,
  packageName,
  syncId,
  dereferenceRootDir = srcPackageDir,
  validatePreparedPackage,
  vendorBundledPackageRuntimeDependencies =
    vendorBundledPackageRuntimeDependenciesImpl ?? vendorBundledPackageRuntimeDependenciesFallback,
}) {
  const srcPackageJsonPath = resolve(srcPackageDir, 'package.json');
  const srcDistDir = resolve(srcPackageDir, 'dist');
  if (!existsSync(srcPackageJsonPath)) {
    throw new Error(`Missing bundled workspace package manifest: ${srcPackageJsonPath}`);
  }
  if (!existsSync(srcDistDir)) {
    throw new Error(`Missing bundled workspace package dist: ${srcDistDir}`);
  }

  const suffix = resolveSyncSwapSuffix(syncId);
  const preparedDir = resolve(
    dirname(destPackageDir),
    `.${basename(destPackageDir)}.__sync_package__.${suffix}`,
  );
  rmDirSafeSync(preparedDir);

  try {
    mkdirSync(preparedDir, { recursive: true });
    copyDirSafeSync(srcDistDir, resolve(preparedDir, 'dist'));

    const raw = JSON.parse(readFileSync(srcPackageJsonPath, 'utf8'));
    syncBundledWorkspaceReferencedFiles({
      srcPackageDir,
      destPackageDir: preparedDir,
      packageJsonRaw: raw,
      fsOps: { strict: true },
    });
    if (hasExternalRuntimeDependencies(raw)) {
      vendorBundledPackageRuntimeDependencies({
        srcPackageJsonPath,
        destPackageDir: preparedDir,
        dereferenceRootDir,
      });
    }
    writeFileSync(
      resolve(preparedDir, 'package.json'),
      `${JSON.stringify(sanitizeBundledWorkspacePackageJson(raw), null, 2)}\n`,
      'utf8',
    );
    validatePreparedPackage?.({ packageName, packageDir: preparedDir });

    replaceDirFromSourceSync(
      destPackageDir,
      preparedDir,
      {
        existsSync,
        mkdirSync,
        renameSync,
        rmSync,
      },
      { syncSuffix: `${suffix}.publish` },
    );
  } finally {
    rmDirSafeSync(preparedDir);
  }
}

export function syncBundledWorkspacePackages(opts = {}) {
  const repoRoot = String(opts.repoRoot ?? '').trim();
  if (!repoRoot) return;

  const cliCommonWorkspacesModule =
    opts.cliCommonWorkspacesModule && typeof opts.cliCommonWorkspacesModule === 'object'
      ? opts.cliCommonWorkspacesModule
      : null;
  const exists = opts.existsSync ?? existsSync;
  const cp = opts.cpSync;
  const mkdir = opts.mkdirSync ?? mkdirSync;
  const rename = opts.renameSync ?? renameSync;
  const rm = opts.rmSync ?? rmSync;
  const readFile = opts.readFileSync ?? readFileSync;
  const writeFile = opts.writeFileSync ?? writeFileSync;
  const syncId = opts.syncId;
  const replaceExisting = opts.replaceExisting !== false;
  const bundleWorkspacePackageWithRuntimeDependencies =
    typeof cliCommonWorkspacesModule?.bundleWorkspacePackageWithRuntimeDependencies === 'function'
      ? cliCommonWorkspacesModule.bundleWorkspacePackageWithRuntimeDependencies
      : bundleWorkspacePackageWithRuntimeDependenciesImpl;
  const useCanonicalPackageBundle =
    bundleWorkspacePackageWithRuntimeDependencies
    && !hasInjectedPackageSyncOps(opts);
  const vendorBundledPackageRuntimeDependencies =
    typeof opts.vendorBundledPackageRuntimeDependencies === 'function'
      ? opts.vendorBundledPackageRuntimeDependencies
      : typeof cliCommonWorkspacesModule?.vendorBundledPackageRuntimeDependencies === 'function'
        ? cliCommonWorkspacesModule.vendorBundledPackageRuntimeDependencies
      : vendorBundledPackageRuntimeDependenciesImpl ?? vendorBundledPackageRuntimeDependenciesFallback;
  const hostApps = Array.isArray(opts.hostApps) && opts.hostApps.length > 0
    ? opts.hostApps
    : ['cli', 'stack'];
  const hostPackageDirs = Array.isArray(opts.hostPackageDirs) && opts.hostPackageDirs.length > 0
    ? opts.hostPackageDirs.map((dir) => resolve(String(dir)))
    : hostApps.map((hostApp) => resolve(repoRoot, 'apps', hostApp));
  const packages = Array.isArray(opts.packages) && opts.packages.length > 0
    ? opts.packages
    : resolveDefaultBundledWorkspacePackageNames(
      repoRoot,
      hostPackageDirs,
      readFile,
      cliCommonWorkspacesModule,
    );

  for (const pkg of packages) {
    const srcPackageDir = resolveBundledWorkspaceSourceDir({ repoRoot, workspaceLeaf: pkg });
    if (!srcPackageDir) continue;
    const srcDist = resolve(srcPackageDir, 'dist');
    const srcPackageJsonPath = resolve(srcPackageDir, 'package.json');
    if (!exists(srcPackageJsonPath)) continue;

    for (const hostPackageDir of hostPackageDirs) {
      const destPackageDir = resolve(hostPackageDir, 'node_modules', '@happier-dev', pkg);
      if (useCanonicalPackageBundle) {
        bundleWorkspacePackageWithRuntimeDependencies({
          packageName: `@happier-dev/${pkg}`,
          srcDir: srcPackageDir,
          destDir: destPackageDir,
          dereferenceRootDir: repoRoot,
          preserveDestinationPath: true,
          // Currentness-bearing callers opt into exact reconciliation. Presence-only preflight
          // refreshes intentionally retain prior targets for in-flight module resolution.
          pruneStale: opts.pruneStale === true,
          validatePreparedPackage: opts.validatePreparedPackage,
        });
        continue;
      }

      if (!hasInjectedPackageSyncOps(opts)) {
        // Bootstrap-only production fallback for a checkout where cli-common/dist is unavailable.
        // Build and vendor the entire package off-path, then publish it as one rollback-safe unit.
        bundleWorkspacePackageFallbackTransactionally({
          srcPackageDir,
          destPackageDir,
          packageName: `@happier-dev/${pkg}`,
          syncId,
          dereferenceRootDir: repoRoot,
          vendorBundledPackageRuntimeDependencies,
          validatePreparedPackage: opts.validatePreparedPackage,
        });
        continue;
      }

      // Virtual filesystem adapters are retained for the script-level test harness. Production
      // callers take either the canonical publisher above or the complete transactional fallback.
      const destDist = resolve(destPackageDir, 'dist');
      if (exists(srcDist)) {
        try {
          if (!replaceExisting && exists(destDist)) {
            // Preflight mode: keep the `dist/**` directory stable once it exists.
            // Copy into place instead of swapping the directory out from under other processes.
            //
            // Note: this does *not* delete removed files; it is "presence-only" to make sure the
            // bundled tree is usable (and to avoid transient ENOENT during directory swaps).
            mkdir(destDist, { recursive: true });
            try {
              copyDirSafeSync(srcDist, destDist, {
                copyFileSync,
                cpSync: cp,
                existsSync: exists,
                lstatSync,
                mkdirSync: mkdir,
                readlinkSync,
                readdirSync,
                statSync,
                symlinkSync,
                unlinkSync,
              });
            } catch {
              replaceDirFromSourceSync(destDist, srcDist, {
                existsSync: exists,
                cpSync: cp,
                mkdirSync: mkdir,
                renameSync: rename,
                rmSync: rm,
              }, {
                syncSuffix: syncId,
                staleSwapDirAgeMs: opts.staleSwapDirAgeMs,
                nowMs: opts.nowMs,
                isPidAlive: opts.isPidAlive,
              });
            }
          } else {
            replaceDirFromSourceSync(destDist, srcDist, {
              existsSync: exists,
              cpSync: cp,
              mkdirSync: mkdir,
              renameSync: rename,
              rmSync: rm,
            }, {
              syncSuffix: syncId,
              staleSwapDirAgeMs: opts.staleSwapDirAgeMs,
              nowMs: opts.nowMs,
              isPidAlive: opts.isPidAlive,
            });
          }
        } catch {
          // Best-effort: bundled deps may be missing or readonly.
        }
      }

      const destPackageJsonPath = resolve(destPackageDir, 'package.json');
      try {
        mkdir(destPackageDir, { recursive: true });
        const raw = JSON.parse(readFile(srcPackageJsonPath, 'utf8'));
        const sanitized = sanitizeBundledWorkspacePackageJson(raw);
        syncBundledWorkspaceReferencedFiles({
          srcPackageDir: dirname(srcPackageJsonPath),
          destPackageDir,
          packageJsonRaw: raw,
          fsOps: { existsSync: exists, cpSync: cp, mkdirSync: mkdir, statSync },
        });
        if (hasExternalRuntimeDependencies(raw)) {
          vendorBundledPackageRuntimeDependencies({
            srcPackageJsonPath,
            destPackageDir,
            dereferenceRootDir: repoRoot,
          });
        }
        // Publish the manifest only after every target it can expose has been installed.
        writeFile(destPackageJsonPath, `${JSON.stringify(sanitized, null, 2)}\n`, 'utf8');
      } catch {
        // Best-effort: keep local bundled deps usable even if package.json sync fails.
      }
    }
  }
}
