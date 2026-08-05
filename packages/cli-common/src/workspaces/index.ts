import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(resolve(dir, 'package.json')) && existsSync(resolve(dir, 'yarn.lock'))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Repository root not found starting from ${startDir}`);
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path: string, value: any): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function stripInternalBundledWorkspaceDependencies(value: any): any {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [name, version] of Object.entries(value)) {
    if (name.startsWith('@happier-dev/')) continue;
    out[name] = version;
  }

  return out;
}

function sleepSync(ms: number): void {
  if (!ms || ms <= 0) return;
  const buf = new SharedArrayBuffer(4);
  const arr = new Int32Array(buf);
  Atomics.wait(arr, 0, 0, ms);
}

function isRetryableRmError(err: unknown): boolean {
  const code = err && typeof err === 'object' ? Reflect.get(err, 'code') : null;
  return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

function isRetryableRenameError(err: unknown): boolean {
  const code = err && typeof err === 'object' ? Reflect.get(err, 'code') : null;
  return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

function isMissingPathError(err: unknown): boolean {
  const code = err && typeof err === 'object' ? Reflect.get(err, 'code') : null;
  return code === 'ENOENT';
}

function isRetryableCopyError(err: unknown): boolean {
  const code = err && typeof err === 'object' ? Reflect.get(err, 'code') : null;
  return (
    code === 'ENOENT'
    || code === 'ENOTEMPTY'
    || code === 'EBUSY'
    || code === 'EPERM'
    || code === 'EACCES'
  );
}

export function sanitizeBundledPackageJson(raw: any): any {
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
    dependencies: stripInternalBundledWorkspaceDependencies(dependencies),
    peerDependencies,
    optionalDependencies: stripInternalBundledWorkspaceDependencies(optionalDependencies),
    engines,
  };
}

export function readBundledDependencyNames(rawPackageJson: any): string[] {
  const bundledDependencies = Array.isArray(rawPackageJson?.bundledDependencies)
    ? rawPackageJson.bundledDependencies
    : Array.isArray(rawPackageJson?.bundleDependencies)
      ? rawPackageJson.bundleDependencies
      : [];

  return bundledDependencies
    .map((value: unknown) => (typeof value === 'string' ? value.trim() : ''))
    .filter((value: string) => value.length > 0);
}

export function readBundledWorkspacePackageNames(rawPackageJson: any): string[] {
  return readBundledDependencyNames(rawPackageJson).filter((packageName) => packageName.startsWith('@happier-dev/'));
}

export function rmDirSafeSync(
  path: string,
  opts: Readonly<{
    recursive?: boolean;
    force?: boolean;
    retries?: number;
    delayMs?: number;
    rmSyncImpl?: typeof rmSync;
  }> = {},
): void {
  const {
    recursive = true,
    force = true,
    retries = 5,
    delayMs = 25,
    rmSyncImpl = rmSync,
  } = opts;

  const maxAttempts = Math.max(1, Number.isFinite(retries) ? retries + 1 : 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      rmSyncImpl(path, { recursive, force });
      return;
    } catch (error) {
      if (!isRetryableRmError(error) || attempt === maxAttempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
}

function resetDir(path: string): void {
  removeStaleBundledWorkspaceTempDirs(path);
  rmDirSafeSync(path);
  mkdirSync(path, { recursive: true });
}

export function atomicReplaceDirSync(params: Readonly<{
  destDir: string;
  buildInto: (tempDir: string) => void;
  fsOps?: Readonly<{
    existsSync?: typeof existsSync;
    mkdirSync?: typeof mkdirSync;
    renameSync?: typeof renameSync;
    rmSync?: typeof rmSync;
  }>;
}>): void {
  const fsOps = params.fsOps ?? {};
  const exists = fsOps.existsSync ?? existsSync;
  const mkdir = fsOps.mkdirSync ?? mkdirSync;
  const rename = fsOps.renameSync ?? renameSync;
  const rm = fsOps.rmSync ?? rmSync;
  const parentDir = dirname(params.destDir);
  const baseName = basename(params.destDir);
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tempDir = resolve(parentDir, `.${baseName}.__sync_tmp__.${suffix}`);
  const backupDir = resolve(parentDir, `.${baseName}.__sync_backup__.${suffix}`);

  // Ensure temp/backup paths are clear before building.
  rmDirSafeSync(tempDir);
  rmDirSafeSync(backupDir);

  let didRenameDestToBackup = false;
  try {
    params.buildInto(tempDir);

    if (exists(params.destDir)) {
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          rename(params.destDir, backupDir);
          didRenameDestToBackup = true;
          break;
        } catch (error) {
          if (isMissingPathError(error)) {
            // Another process already removed/replaced the destination after our existence check.
            break;
          }
          if (!isRetryableRenameError(error) || attempt === 3) throw error;
          sleepSync(25);
        }
      }
    }

    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        rename(tempDir, params.destDir);
        if (didRenameDestToBackup) {
          rmDirSafeSync(backupDir, { rmSyncImpl: rm });
        }
        return;
      } catch (error) {
        if (!isRetryableRenameError(error) || attempt === 3) throw error;
        try {
          if (exists(params.destDir)) {
            rmDirSafeSync(params.destDir, { rmSyncImpl: rm });
          }
        } catch {
          // ignore
        }
        sleepSync(25);
      }
    }
  } catch (error) {
    // Best-effort cleanup and rollback. Never leave a half-populated destination.
    try {
      if (exists(tempDir)) rmDirSafeSync(tempDir, { rmSyncImpl: rm });
    } catch {
      // ignore
    }

    if (didRenameDestToBackup) {
      try {
        if (!exists(params.destDir) && exists(backupDir)) {
          rename(backupDir, params.destDir);
        }
      } catch {
        // ignore rollback errors; we'll still rethrow original
      }
      try {
        if (exists(backupDir)) rmDirSafeSync(backupDir, { rmSyncImpl: rm });
      } catch {
        // ignore
      }
    }

    throw error;
  }
}

function copyIfExists(src: string, dest: string): boolean {
  if (!existsSync(src)) return false;
  copyDirSafeSync(src, dest);
  return true;
}

export function copyDirSafeSync(
  srcDir: string,
  destDir: string,
  opts: Readonly<{
    recursive?: boolean;
    force?: boolean;
    dereference?: boolean;
    retries?: number;
    delayMs?: number;
    cpSyncImpl?: typeof cpSync;
  }> = {},
): void {
  const {
    recursive = true,
    force = true,
    dereference = false,
    retries = 5,
    delayMs = 25,
    cpSyncImpl = cpSync,
  } = opts;

  const maxAttempts = Math.max(1, Number.isFinite(retries) ? retries + 1 : 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      cpSyncImpl(srcDir, destDir, { recursive, force, dereference });
      return;
    } catch (error) {
      if (!isRetryableCopyError(error) || attempt === maxAttempts - 1) throw error;
      sleepSync(delayMs);
    }
  }
}

function isBundledWorkspaceTempDirName(name: string): boolean {
  return name.startsWith('dist.__sync_tmp__.') || name.startsWith('dist.__sync_backup__.');
}

function removeStaleBundledWorkspaceTempDirs(targetDir: string): void {
  if (!existsSync(targetDir)) return;

  for (const entry of readdirSync(targetDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!isBundledWorkspaceTempDirName(entry.name)) continue;
    rmDirSafeSync(resolve(targetDir, entry.name));
  }
}

export function bundleWorkspacePackage(params: Readonly<{
  packageName: string;
  srcDir: string;
  destDir: string;
  includeFiles?: string[];
}>): void {
  const packageDetails = readWorkspacePackageDetails(params);

  atomicReplaceDirSync({
    destDir: params.destDir,
    buildInto: (tempDir) => {
      copyBundledWorkspacePackageContents({
        srcDir: params.srcDir,
        tempDir,
        rawPackageJson: packageDetails.rawPackageJson,
        distDir: packageDetails.distDir,
        includeFiles: params.includeFiles,
      });
    },
  });
}

function readWorkspacePackageDetails(params: Readonly<{
  packageName: string;
  srcDir: string;
}>): Readonly<{
  srcPackageJsonPath: string;
  rawPackageJson: any;
  distDir: string;
}> {
  const srcPackageJsonPath = resolve(params.srcDir, 'package.json');
  if (!existsSync(srcPackageJsonPath)) {
    throw new Error(`Missing workspace package.json for ${params.packageName}: ${srcPackageJsonPath}`);
  }

  const rawPackageJson = readJson(srcPackageJsonPath);
  if (rawPackageJson.name !== params.packageName) {
    throw new Error(
      `Unexpected package name at ${srcPackageJsonPath}: expected ${params.packageName}, got ${rawPackageJson.name}`,
    );
  }

  const distDir = resolve(params.srcDir, 'dist');
  if (!existsSync(distDir)) {
    throw new Error(`Missing dist/ for ${params.packageName}. Run its build first.`);
  }

  return { srcPackageJsonPath, rawPackageJson, distDir };
}

function copyBundledWorkspacePackageContents(params: Readonly<{
  srcDir: string;
  tempDir: string;
  rawPackageJson: any;
  distDir: string;
  includeFiles?: string[];
}>): void {
  resetDir(params.tempDir);
  copyDirSafeSync(params.distDir, resolve(params.tempDir, 'dist'));
  writeJson(resolve(params.tempDir, 'package.json'), sanitizeBundledPackageJson(params.rawPackageJson));

  const files = new Set(params.includeFiles ?? ['README.md']);
  collectNonDistPackageEntryTargets(params.rawPackageJson?.main, files);
  collectNonDistPackageEntryTargets(params.rawPackageJson?.module, files);
  collectNonDistPackageEntryTargets(params.rawPackageJson?.types, files);
  collectNonDistPackageEntryTargets(params.rawPackageJson?.exports, files);
  for (const f of files) {
    copyIfExists(resolve(params.srcDir, f), resolve(params.tempDir, f));
  }
}

function collectNonDistPackageEntryTargets(value: unknown, result: Set<string>): void {
  if (typeof value === 'string') {
    const target = value.trim();
    if (
      target.startsWith('./')
      && !target.includes('*')
      && !target.startsWith('./dist/')
      && target !== './dist'
      && !target.split('/').includes('..')
    ) {
      result.add(target.slice(2));
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const nestedValue of Object.values(value)) {
    collectNonDistPackageEntryTargets(nestedValue, result);
  }
}

export function bundleWorkspacePackageWithRuntimeDependencies(params: Readonly<{
  packageName: string;
  srcDir: string;
  destDir: string;
  includeFiles?: string[];
  resolveFromPackageJsonPath?: string;
  excludePackageNames?: ReadonlySet<string>;
}>): void {
  const packageDetails = readWorkspacePackageDetails(params);

  atomicReplaceDirSync({
    destDir: params.destDir,
    buildInto: (tempDir) => {
      copyBundledWorkspacePackageContents({
        srcDir: params.srcDir,
        tempDir,
        rawPackageJson: packageDetails.rawPackageJson,
        distDir: packageDetails.distDir,
        includeFiles: params.includeFiles,
      });
      vendorRuntimeDependencyTree({
        packageJsonPath: packageDetails.srcPackageJsonPath,
        resolveFromPackageJsonPath: params.resolveFromPackageJsonPath,
        destNodeModulesDir: resolve(tempDir, 'node_modules'),
        excludePackageNames: params.excludePackageNames,
      });
    },
  });
}

export function bundleWorkspacePackages(params: Readonly<{
  bundles: ReadonlyArray<{ packageName: string; srcDir: string; destDir: string; includeFiles?: string[] }>;
}>): void {
  for (const b of params.bundles) {
    bundleWorkspacePackage({
      packageName: b.packageName,
      srcDir: b.srcDir,
      destDir: b.destDir,
      includeFiles: b.includeFiles,
    });
  }
}

export function resolveWorkspaceBundlesFromPackageJson(params: Readonly<{
  repoRoot: string;
  hostPackageDir: string;
}>): ReadonlyArray<{
  packageName: string;
  srcDir: string;
  destDir: string;
}> {
  const hostPackageJsonPath = resolve(params.hostPackageDir, 'package.json');
  if (!existsSync(hostPackageJsonPath)) {
    throw new Error(`Missing host package.json: ${hostPackageJsonPath}`);
  }

  const hostPackageJson = readJson(hostPackageJsonPath);
  const bundledWorkspaceNames = readBundledWorkspacePackageNames(hostPackageJson);

  return bundledWorkspaceNames.map((packageName) => {
    const workspaceName = packageName.split('/').at(-1);
    if (!workspaceName) {
      throw new Error(`Unable to resolve workspace name from bundled dependency: ${packageName}`);
    }

    return {
      packageName,
      srcDir: resolve(params.repoRoot, 'packages', workspaceName),
      destDir: resolve(params.hostPackageDir, 'node_modules', ...packageName.split('/')),
    };
  });
}

function collectExternalRuntimeDepNamesFromPackageJson(packageJson: any): ReadonlyArray<{ name: string; optional: boolean }> {
  const deps = packageJson?.dependencies ?? {};
  const optionalDeps = packageJson?.optionalDependencies ?? {};

  const required = Object.keys(deps)
    .filter((name) => typeof name === 'string' && !name.startsWith('@happier-dev/'))
    .map((name) => ({ name, optional: false }));
  const optional = Object.keys(optionalDeps)
    .filter((name) => typeof name === 'string' && !name.startsWith('@happier-dev/'))
    .map((name) => ({ name, optional: true }));

  return [...required, ...optional];
}

function resolveInstalledPackage(params: Readonly<{ require: NodeRequire; packageName: string }>): Readonly<{
  packageDir: string;
  packageJsonPath: string;
  packageJson: any;
}> {
  const searchPaths = params.require.resolve.paths(params.packageName) ?? [];
  let aliasInstalledPackage:
    | Readonly<{
        packageDir: string;
        packageJsonPath: string;
        packageJson: any;
      }>
    | undefined;
  for (const searchPath of searchPaths) {
    const packageJsonPath = resolve(searchPath, ...params.packageName.split('/'), 'package.json');
    if (!existsSync(packageJsonPath)) continue;
    const packageJson = readJson(packageJsonPath);
    if (packageJson?.name === params.packageName) {
      return {
        packageDir: dirname(packageJsonPath),
        packageJsonPath,
        packageJson,
      };
    }

    // npm alias installs keep the alias folder name on disk while package.json preserves
    // the canonical upstream package name. Vendoring needs the on-disk folder, not an exact
    // name match, so keep the first directly-installed alias candidate as a fallback.
    if (!aliasInstalledPackage) {
      aliasInstalledPackage = {
        packageDir: dirname(packageJsonPath),
        packageJsonPath,
        packageJson,
      };
    }
  }

  if (aliasInstalledPackage) {
    return aliasInstalledPackage;
  }

  let resolvedEntry = '';
  try {
    resolvedEntry = params.require.resolve(`${params.packageName}/package.json`);
  } catch {
    resolvedEntry = params.require.resolve(params.packageName);
  }

  let dir = dirname(resolvedEntry);

  for (let i = 0; i < 50; i++) {
    const pkgJsonPath = resolve(dir, 'package.json');
    if (existsSync(pkgJsonPath)) {
      const pkgJson = readJson(pkgJsonPath);
      if (pkgJson?.name === params.packageName) {
        return { packageDir: dir, packageJsonPath: pkgJsonPath, packageJson: pkgJson };
      }
    }

    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(`Failed to locate installed package.json for ${params.packageName} (resolved: ${resolvedEntry})`);
}

// name@version alone doesn't prove two resolved package directories are actually identical --
// different resolution paths could in principle land on different builds/patches published under
// the same version string. Before symlinking one onto the other, verify the two trees have the
// same relative file paths and byte sizes. This is not a full content hash (that would defeat much
// of the point of skipping a redundant copy for large trees), but it catches the realistic failure
// mode of the two directories actually differing while remaining cheap.
function collectRelativeFileSizes(rootDir: string): Map<string, number> {
  const result = new Map<string, number>();
  const stack: string[] = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const size = statSync(entryPath).size;
      result.set(relative(rootDir, entryPath), size);
    }
  }
  return result;
}

function areDirectoryTreesEquivalent(dirA: string, dirB: string): boolean {
  const filesA = collectRelativeFileSizes(dirA);
  const filesB = collectRelativeFileSizes(dirB);
  if (filesA.size !== filesB.size) return false;
  for (const [relPath, size] of filesA) {
    if (filesB.get(relPath) !== size) return false;
  }
  return true;
}

function vendorRuntimeDependencyTree(params: Readonly<{
  packageJsonPath: string;
  resolveFromPackageJsonPath?: string;
  destNodeModulesDir: string;
  visited?: Set<string>;
  dedupeByNameVersion?: Map<string, string>;
  excludePackageNames?: ReadonlySet<string>;
}>): void {
  const pkgJson = readJson(params.packageJsonPath);
  const roots = collectExternalRuntimeDepNamesFromPackageJson(pkgJson)
    .filter((dep) => !params.excludePackageNames?.has(dep.name));
  const require = createRequire(pathToFileURL(params.resolveFromPackageJsonPath ?? params.packageJsonPath).href);

  const visited = params.visited ?? new Set<string>();
  const dedupeByNameVersion = params.dedupeByNameVersion ?? new Map<string, string>();
  mkdirSync(params.destNodeModulesDir, { recursive: true });

  for (const dep of roots) {
    let resolved: Readonly<{ packageDir: string; packageJsonPath: string; packageJson: any }>;
    try {
      resolved = resolveInstalledPackage({ require, packageName: dep.name });
    } catch (error) {
      if (dep.optional) continue;
      throw error;
    }

    const depDestDir = resolve(params.destNodeModulesDir, ...dep.name.split('/'));
    if (visited.has(depDestDir)) continue;
    visited.add(depDestDir);

    const version = typeof resolved.packageJson?.version === 'string' ? resolved.packageJson.version : undefined;
    const dedupeKey = version ? `${dep.name}@${version}` : undefined;
    const existingDedupePath = dedupeKey ? dedupeByNameVersion.get(dedupeKey) : undefined;

    // name@version alone doesn't prove the two resolved package directories are actually
    // identical (see areDirectoryTreesEquivalent above) -- verify before deduping. If they differ,
    // fall through to a normal copy rather than symlinking to the wrong content.
    if (existingDedupePath && areDirectoryTreesEquivalent(resolved.packageDir, existingDedupePath)) {
      // Already vendored elsewhere in this same tree at the identical name+version, with verified
      // matching content. Symlink to the surviving copy instead of copying again -- behaviorally
      // identical for any consumer (including one that reads from disk directly). Skip recursing
      // into its subtree: those deps were already vendored under the first copy.
      //
      // Use a relative link target: both paths currently live inside the same not-yet-renamed
      // atomic-build staging tree, and the whole tree (staging dir and all its contents, symlink
      // included) gets renamed as one unit into its final place. An absolute target captured now
      // would point at the staging path and dangle once that rename happens; a relative target
      // survives the rename because the relationship between the two paths doesn't change.
      rmDirSafeSync(depDestDir);
      mkdirSync(dirname(depDestDir), { recursive: true });
      try {
        symlinkSync(relative(dirname(depDestDir), existingDedupePath), depDestDir, 'dir');
      } catch (error) {
        // Directory symlinks require elevated privileges or Developer Mode on Windows and can
        // throw EPERM on an ordinary build host. Fall back to a real copy -- larger on disk than
        // a symlink, but still avoids re-vendoring this dependency's own transitive tree (we still
        // skip the recursive vendorRuntimeDependencyTree call below), and behaves identically for
        // any consumer.
        const code = error && typeof error === 'object' && 'code' in error ? String(Reflect.get(error, 'code')) : '';
        if (code !== 'EPERM' && code !== 'ENOSYS' && code !== 'EACCES') throw error;
        copyDirSafeSync(existingDedupePath, depDestDir, { dereference: true });
      }
      continue;
    }

    resetDir(depDestDir);
    copyDirSafeSync(resolved.packageDir, depDestDir, { dereference: true });
    if (dedupeKey && !existingDedupePath) dedupeByNameVersion.set(dedupeKey, depDestDir);

    vendorRuntimeDependencyTree({
      packageJsonPath: resolved.packageJsonPath,
      destNodeModulesDir: resolve(depDestDir, 'node_modules'),
      visited,
      dedupeByNameVersion,
      excludePackageNames: params.excludePackageNames,
    });
  }
}

export function vendorBundledPackageRuntimeDependencies(params: Readonly<{
  srcPackageJsonPath: string;
  resolveFromPackageJsonPath?: string;
  destPackageDir: string;
  excludePackageNames?: ReadonlySet<string>;
}>): void {
  if (!existsSync(params.srcPackageJsonPath)) {
    throw new Error(`Missing package.json: ${params.srcPackageJsonPath}`);
  }

  const destNodeModulesDir = resolve(params.destPackageDir, 'node_modules');

  // Vendoring is used while local dev daemons/sessions may already be importing from the
  // bundled workspace copies under apps/*/node_modules/@happier-dev/*.
  //
  // Copying directly into the destination can produce transiently invalid package.json files
  // (and broken Node ESM resolution) if a reader observes a partially-copied dependency tree.
  //
  // Build into a sibling temp directory and swap atomically to keep the destination always-valid.
  atomicReplaceDirSync({
    destDir: destNodeModulesDir,
    buildInto: (tempNodeModulesDir) => {
      vendorRuntimeDependencyTree({
        packageJsonPath: params.srcPackageJsonPath,
        resolveFromPackageJsonPath: params.resolveFromPackageJsonPath,
        destNodeModulesDir: tempNodeModulesDir,
        excludePackageNames: params.excludePackageNames,
      });
    },
  });
}

export function bundleInstalledPackageWithRuntimeDependencies(params: Readonly<{
  packageName: string;
  resolveFromPackageJsonPath: string;
  destNodeModulesDir: string;
}>): void {
  const require = createRequire(pathToFileURL(params.resolveFromPackageJsonPath).href);
  const resolved = resolveInstalledPackage({ require, packageName: params.packageName });
  const destPackageDir = resolve(params.destNodeModulesDir, ...params.packageName.split('/'));

  atomicReplaceDirSync({
    destDir: destPackageDir,
    buildInto: (tempDir) => {
      resetDir(tempDir);
      copyDirSafeSync(resolved.packageDir, tempDir, { dereference: true });

      vendorRuntimeDependencyTree({
        packageJsonPath: resolved.packageJsonPath,
        resolveFromPackageJsonPath: resolved.packageJsonPath,
        destNodeModulesDir: resolve(tempDir, 'node_modules'),
      });
    },
  });
}
