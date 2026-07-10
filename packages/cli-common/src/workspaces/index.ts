import {
  copyFileSync,
  type Dirent,
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
import { createRequire } from 'node:module';
import { basename, dirname, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const PLUGINS_PACKAGE_PREFIX = '@happier-dev/plugins-';
const INTERNAL_PACKAGE_PREFIX = '@happier-dev/';

type ReaddirWithFileTypesSync = (path: string) => Dirent[];

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
  return readBundledDependencyNames(rawPackageJson).filter(isInternalWorkspacePackageName);
}

function isInternalWorkspacePackageName(packageName: string): boolean {
  return packageName.startsWith(INTERNAL_PACKAGE_PREFIX);
}

function collectInternalRuntimeWorkspaceDepNames(packageJson: any): string[] {
  const result = new Set<string>();
  for (const deps of [packageJson?.dependencies, packageJson?.optionalDependencies]) {
    if (!deps || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) {
      if (isInternalWorkspacePackageName(name)) {
        result.add(name);
      }
    }
  }
  return [...result].sort((left, right) => left.localeCompare(right));
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
  mkdirSync(dirname(dest), { recursive: true });
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
    copyFileSyncImpl?: typeof copyFileSync;
    existsSyncImpl?: typeof existsSync;
    lstatSyncImpl?: typeof lstatSync;
    mkdirSyncImpl?: typeof mkdirSync;
    readlinkSyncImpl?: typeof readlinkSync;
    readdirSyncImpl?: ReaddirWithFileTypesSync;
    statSyncImpl?: typeof statSync;
    symlinkSyncImpl?: typeof symlinkSync;
    unlinkSyncImpl?: typeof unlinkSync;
  }> = {},
): void {
  const {
    recursive = true,
    force = true,
    dereference = false,
    retries = 5,
    delayMs = 25,
    copyFileSyncImpl = copyFileSync,
    existsSyncImpl = existsSync,
    lstatSyncImpl = lstatSync,
    mkdirSyncImpl = mkdirSync,
    readlinkSyncImpl = readlinkSync,
    statSyncImpl = statSync,
    symlinkSyncImpl = symlinkSync,
    unlinkSyncImpl = unlinkSync,
  } = opts;
  const readDirWithFileTypes = opts.readdirSyncImpl ?? ((path: string) => readdirSync(path, { withFileTypes: true }));

  const copyPath = (sourcePath: string, targetPath: string): void => {
    const sourceStats = dereference ? statSyncImpl(sourcePath) : lstatSyncImpl(sourcePath);
    if (sourceStats.isDirectory()) {
      if (!recursive && sourcePath !== srcDir) return;
      mkdirSyncImpl(targetPath, { recursive: true });
      for (const entry of readDirWithFileTypes(sourcePath)) {
        copyPath(resolve(sourcePath, entry.name), resolve(targetPath, entry.name));
      }
      return;
    }

    mkdirSyncImpl(dirname(targetPath), { recursive: true });
    if (!dereference && sourceStats.isSymbolicLink()) {
      if (force && existsSyncImpl(targetPath)) {
        unlinkSyncImpl(targetPath);
      }
      symlinkSyncImpl(readlinkSyncImpl(sourcePath), targetPath);
      return;
    }

    if (!force && existsSyncImpl(targetPath)) return;
    copyFileSyncImpl(sourcePath, targetPath);
  };

  const maxAttempts = Math.max(1, Number.isFinite(retries) ? retries + 1 : 1);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      copyPath(srcDir, destDir);
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
  const referencedFiles = collectWorkspacePackageReferencedFiles(packageDetails.rawPackageJson);

  atomicReplaceDirSync({
    destDir: params.destDir,
    buildInto: (tempDir) => {
      copyBundledWorkspacePackageContents({
        srcDir: params.srcDir,
        tempDir,
        rawPackageJson: packageDetails.rawPackageJson,
        distDir: packageDetails.distDir,
        referencedFiles,
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

function collectWorkspacePackageReferencedFiles(rawPackageJson: any): Set<string> {
  const referencedFiles = new Set<string>();
  collectPackageJsonRelativeFileTargets(rawPackageJson.main, referencedFiles);
  collectPackageJsonRelativeFileTargets(rawPackageJson.module, referencedFiles);
  collectPackageJsonRelativeFileTargets(rawPackageJson.types, referencedFiles);
  collectPackageJsonRelativeFileTargets(rawPackageJson.exports, referencedFiles);
  return referencedFiles;
}

function copyBundledWorkspacePackageContents(params: Readonly<{
  srcDir: string;
  tempDir: string;
  rawPackageJson: any;
  distDir: string;
  referencedFiles: ReadonlySet<string>;
  includeFiles?: string[];
}>): void {
  resetDir(params.tempDir);
  copyDirSafeSync(params.distDir, resolve(params.tempDir, 'dist'));
  writeJson(resolve(params.tempDir, 'package.json'), sanitizeBundledPackageJson(params.rawPackageJson));

  const files = params.includeFiles ?? ['README.md'];
  for (const f of files) {
    copyIfExists(resolve(params.srcDir, f), resolve(params.tempDir, f));
  }

  for (const relativePath of [...params.referencedFiles].sort((left, right) => left.localeCompare(right))) {
    copyIfExists(resolve(params.srcDir, relativePath), resolve(params.tempDir, relativePath));
  }
}

export function bundleWorkspacePackageWithRuntimeDependencies(params: Readonly<{
  packageName: string;
  srcDir: string;
  destDir: string;
  includeFiles?: string[];
  resolveFromPackageJsonPath?: string;
}>): void {
  const packageDetails = readWorkspacePackageDetails(params);
  const referencedFiles = collectWorkspacePackageReferencedFiles(packageDetails.rawPackageJson);

  atomicReplaceDirSync({
    destDir: params.destDir,
    buildInto: (tempDir) => {
      copyBundledWorkspacePackageContents({
        srcDir: params.srcDir,
        tempDir,
        rawPackageJson: packageDetails.rawPackageJson,
        distDir: packageDetails.distDir,
        referencedFiles,
        includeFiles: params.includeFiles,
      });
      vendorRuntimeDependencyTree({
        packageJsonPath: packageDetails.srcPackageJsonPath,
        resolveFromPackageJsonPath: params.resolveFromPackageJsonPath,
        destNodeModulesDir: resolve(tempDir, 'node_modules'),
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
  const bundledWorkspaceNameSet = new Set(bundledWorkspaceNames);
  const bundledWorkspaceClosureNames = resolveInternalWorkspacePackageNameClosure({
    repoRoot: params.repoRoot,
    packageNames: bundledWorkspaceNames,
  });
  const missingClosureNames = bundledWorkspaceClosureNames.filter((packageName) => !bundledWorkspaceNameSet.has(packageName));
  if (missingClosureNames.length > 0) {
    throw new Error(
      [
        `Missing bundled internal workspace dependencies in ${hostPackageJsonPath}:`,
        ...missingClosureNames.map((packageName) => `- ${packageName}`),
      ].join('\n'),
    );
  }

  return bundledWorkspaceClosureNames.map((packageName) => {
    return {
      packageName,
      srcDir: resolveWorkspaceSourceDir({ repoRoot: params.repoRoot, packageName }),
      destDir: resolve(params.hostPackageDir, 'node_modules', ...packageName.split('/')),
    };
  });
}

export function resolveWorkspaceSourceDir(params: Readonly<{
  repoRoot: string;
  packageName: string;
}>): string {
  const packageName = String(params.packageName ?? '').trim();
  const workspaceName = packageName.split('/').at(-1);
  if (!workspaceName) {
    throw new Error(`Unable to resolve workspace name from bundled dependency: ${packageName}`);
  }

  if (packageName.startsWith(PLUGINS_PACKAGE_PREFIX)) {
    return resolve(params.repoRoot, 'packages', 'plugins', packageName.slice(PLUGINS_PACKAGE_PREFIX.length));
  }
  return resolve(params.repoRoot, 'packages', workspaceName);
}

export function resolveInternalWorkspacePackageNameClosure(params: Readonly<{
  repoRoot: string;
  packageNames: ReadonlyArray<string>;
}>): string[] {
  const visited = new Set<string>();

  const visit = (packageName: string): void => {
    const normalizedName = String(packageName ?? '').trim();
    if (!isInternalWorkspacePackageName(normalizedName) || visited.has(normalizedName)) {
      return;
    }
    visited.add(normalizedName);

    const sourcePackageJsonPath = resolve(
      resolveWorkspaceSourceDir({
        repoRoot: params.repoRoot,
        packageName: normalizedName,
      }),
      'package.json',
    );
    if (!existsSync(sourcePackageJsonPath)) {
      return;
    }

    const sourcePackageJson = readJson(sourcePackageJsonPath);
    for (const dependencyName of collectInternalRuntimeWorkspaceDepNames(sourcePackageJson)) {
      visit(dependencyName);
    }
  };

  for (const packageName of params.packageNames) {
    visit(packageName);
  }

  return [...visited].sort((left, right) => left.localeCompare(right));
}

function resolveBundledWorkspaceRepoRoot(params: Readonly<{
  repoRoot: string;
  hostPackageDir: string;
}>): string {
  const candidateRoots = [params.repoRoot, params.hostPackageDir];

  for (const candidateRoot of candidateRoots) {
    if (existsSync(resolve(candidateRoot, 'packages'))) {
      return candidateRoot;
    }
  }

  for (const candidateRoot of candidateRoots) {
    try {
      const resolvedRepoRoot = findRepoRoot(candidateRoot);
      if (existsSync(resolve(resolvedRepoRoot, 'packages'))) {
        return resolvedRepoRoot;
      }
    } catch {
      // Fall back to the original input when the host is not inside a source checkout.
    }
  }

  return params.repoRoot;
}

function collectPackageJsonRelativeFileTargets(value: unknown, result: Set<string>): void {
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

function stableJsonStringify(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(',')}]`;
  }
  if (type !== 'object') return JSON.stringify(String(value));

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`).join(',')}}`;
}

function readPackageJsonField(packageJsonPath: string, field: string): unknown {
  try {
    const parsed = readJson(packageJsonPath) as Record<string, unknown>;
    return parsed[field];
  } catch {
    return undefined;
  }
}

function hasBundledWorkspacePackageReferencedFiles(packageJsonPath: string): boolean {
  if (!existsSync(packageJsonPath)) return false;

  let pkg: any;
  try {
    pkg = readJson(packageJsonPath);
  } catch {
    return false;
  }

  const packageDir = dirname(packageJsonPath);
  const relativeFileTargets = new Set<string>();
  collectPackageJsonRelativeFileTargets(pkg.main, relativeFileTargets);
  collectPackageJsonRelativeFileTargets(pkg.module, relativeFileTargets);
  collectPackageJsonRelativeFileTargets(pkg.types, relativeFileTargets);
  collectPackageJsonRelativeFileTargets(pkg.exports, relativeFileTargets);

  for (const relPath of relativeFileTargets) {
    if (!packageFileTargetExists(packageDir, relPath)) {
      return false;
    }
  }

  return true;
}

function packageFileTargetExists(packageDir: string, relativePath: string): boolean {
  const exactPath = resolve(packageDir, relativePath);
  if (existsSync(exactPath)) return true;
  if (extname(relativePath)) return false;

  return ['.js', '.mjs', '.cjs', '.json'].some((extension) =>
    existsSync(resolve(packageDir, `${relativePath}${extension}`)),
  );
}

function collectRelativeRegularFilePaths(rootDir: string, relativePrefix = ''): string[] {
  if (!existsSync(rootDir)) return [];

  const result: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }
      if (entry.isFile()) {
        result.push(relativePath);
      }
    }
  };

  walk(rootDir, relativePrefix);
  return result;
}

function haveSameRelativeFileSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function fileContentsMatch(leftPath: string, rightPath: string): boolean {
  try {
    const leftStats = statSync(leftPath);
    const rightStats = statSync(rightPath);
    if (!leftStats.isFile() || !rightStats.isFile() || leftStats.size !== rightStats.size) {
      return false;
    }
    return readFileSync(leftPath).equals(readFileSync(rightPath));
  } catch {
    return false;
  }
}

function isRuntimePackageContentPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return !(
    normalized.endsWith('.tsbuildinfo')
    || normalized.endsWith('.d.ts')
    || normalized.endsWith('.d.ts.map')
    || normalized.endsWith('.map')
  );
}

function hasBundledWorkspaceSourceContentParity(
  workspacePackageDir: string,
  bundledPackageDir: string,
  workspacePackageJson: any,
): boolean {
  const sourceDistFiles = collectRelativeRegularFilePaths(resolve(workspacePackageDir, 'dist'), 'dist')
    .filter(isRuntimePackageContentPath);
  const bundledDistFiles = collectRelativeRegularFilePaths(resolve(bundledPackageDir, 'dist'), 'dist')
    .filter(isRuntimePackageContentPath);
  if (!haveSameRelativeFileSet(sourceDistFiles, bundledDistFiles)) {
    return false;
  }

  for (const relPath of sourceDistFiles) {
    if (!fileContentsMatch(resolve(workspacePackageDir, relPath), resolve(bundledPackageDir, relPath))) {
      return false;
    }
  }

  const expectedOutputPaths = [...collectWorkspacePackageReferencedFiles(workspacePackageJson)]
    .filter(isRuntimePackageContentPath);
  if (expectedOutputPaths.length === 0) expectedOutputPaths.push('dist/index.js');

  for (const relPath of expectedOutputPaths) {
    if (!fileContentsMatch(resolve(workspacePackageDir, relPath), resolve(bundledPackageDir, relPath))) {
      return false;
    }
  }

  return true;
}

function hasBundledWorkspacePackageManifestParity(
  rootDir: string,
  hostPackageDir: string,
  packageName: string,
): boolean {
  const workspacePackageJsonPath = resolve(resolveWorkspaceSourceDir({ repoRoot: rootDir, packageName }), 'package.json');
  const bundledPackageJsonPath = resolve(hostPackageDir, 'node_modules', ...packageName.split('/'), 'package.json');
  if (!existsSync(bundledPackageJsonPath)) return false;
  if (!existsSync(workspacePackageJsonPath)) return true;

  const workspaceExports = readPackageJsonField(workspacePackageJsonPath, 'exports');
  const bundledExports = readPackageJsonField(bundledPackageJsonPath, 'exports');
  return stableJsonStringify(workspaceExports) === stableJsonStringify(bundledExports);
}

function hasBundledWorkspaceRuntimeDependencyTreeHealthy(
  packageJsonPath: string,
  opts?: { visited?: Set<string> },
): boolean {
  if (!existsSync(packageJsonPath)) return false;

  const visited = opts?.visited ?? new Set<string>();
  if (visited.has(packageJsonPath)) return true;
  visited.add(packageJsonPath);

  let pkg: any;
  try {
    pkg = readJson(packageJsonPath);
  } catch {
    return false;
  }

  if (!hasBundledWorkspacePackageReferencedFiles(packageJsonPath)) {
    return false;
  }

  const packageDir = dirname(packageJsonPath);
  const deps = collectExternalRuntimeDepNamesFromPackageJson(pkg);

  for (const dep of deps) {
    const depPackageDir = resolve(packageDir, 'node_modules', ...dep.name.split('/'));
    if (!existsSync(depPackageDir)) {
      if (dep.optional) continue;
      return false;
    }

    const depPackageJsonPath = resolve(depPackageDir, 'package.json');
    if (!existsSync(depPackageJsonPath)) {
      if (dep.optional) continue;
      return false;
    }

    if (!hasBundledWorkspaceRuntimeDependencyTreeHealthy(depPackageJsonPath, { visited })) {
      return false;
    }
  }

  return true;
}

function hasBundledWorkspacePackageHealthy(rootDir: string, hostPackageDir: string, packageName: string): boolean {
  const packageDir = resolve(hostPackageDir, 'node_modules', ...packageName.split('/'));
  const bundledPackageJsonPath = resolve(packageDir, 'package.json');
  const workspacePackageJsonPath = resolve(resolveWorkspaceSourceDir({ repoRoot: rootDir, packageName }), 'package.json');

  if (!hasBundledWorkspacePackageManifestParity(rootDir, hostPackageDir, packageName)) {
    return false;
  }

  if (!existsSync(workspacePackageJsonPath)) {
    return hasBundledWorkspaceRuntimeDependencyTreeHealthy(bundledPackageJsonPath);
  }

  const workspacePackageDir = dirname(workspacePackageJsonPath);
  const workspacePackageJson = readJson(workspacePackageJsonPath);
  return (
    hasBundledWorkspaceSourceContentParity(workspacePackageDir, packageDir, workspacePackageJson)
    && hasBundledWorkspaceRuntimeDependencyTreeHealthy(bundledPackageJsonPath)
  );
}

export function hasBundledWorkspacePackagesHealthy(params: Readonly<{
  repoRoot: string;
  hostPackageDir: string;
}>): boolean {
  const workspaceRepoRoot = resolveBundledWorkspaceRepoRoot(params);
  const bundles = resolveWorkspaceBundlesFromPackageJson({
    repoRoot: workspaceRepoRoot,
    hostPackageDir: params.hostPackageDir,
  });

  return bundles.every((bundle) =>
    hasBundledWorkspacePackageHealthy(workspaceRepoRoot, params.hostPackageDir, bundle.packageName),
  );
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

function vendorRuntimeDependencyTree(params: Readonly<{
  packageJsonPath: string;
  resolveFromPackageJsonPath?: string;
  destNodeModulesDir: string;
  visited?: Set<string>;
}>): void {
  const pkgJson = readJson(params.packageJsonPath);
  const roots = collectExternalRuntimeDepNamesFromPackageJson(pkgJson);
  const require = createRequire(pathToFileURL(params.resolveFromPackageJsonPath ?? params.packageJsonPath).href);

  const visited = params.visited ?? new Set<string>();
  mkdirSync(params.destNodeModulesDir, { recursive: true });

  for (const dep of roots) {
    let resolved: Readonly<{ packageDir: string; packageJsonPath: string }>;
    try {
      resolved = resolveInstalledPackage({ require, packageName: dep.name });
    } catch (error) {
      if (dep.optional) continue;
      throw error;
    }

    const depDestDir = resolve(params.destNodeModulesDir, ...dep.name.split('/'));
    if (visited.has(depDestDir)) continue;
    visited.add(depDestDir);

    resetDir(depDestDir);
    copyDirSafeSync(resolved.packageDir, depDestDir, { dereference: true });

    vendorRuntimeDependencyTree({
      packageJsonPath: resolved.packageJsonPath,
      destNodeModulesDir: resolve(depDestDir, 'node_modules'),
      visited,
    });
  }
}

export function vendorBundledPackageRuntimeDependencies(params: Readonly<{
  srcPackageJsonPath: string;
  resolveFromPackageJsonPath?: string;
  destPackageDir: string;
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
