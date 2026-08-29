import {
  copyFileSync,
  type Dirent,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  assertResolvedRuntimeDependencyMatchesDeclaration,
  collectExternalRuntimeDependencies,
  copyDirDereferenceContainedSync,
  parsePackageNameSegments,
  publishStagedDirectoryMountedSync,
  resolveInstalledRuntimePackage,
  vendorRuntimeDependencyTree as vendorRuntimeDependencyTreeCanonical,
} from '../../workspaceRuntimeDependencies.mjs';
import {
  findUnservableBundledPluginPackageResources,
  readBundledPluginPackageResourceRelativePaths,
} from '../../bundledPluginResources.mjs';

const PLUGINS_PACKAGE_PREFIX = '@happier-dev/plugins-';
const INTERNAL_PACKAGE_PREFIX = '@happier-dev/';

type ReaddirWithFileTypesSync = (path: string) => Dirent[];
type ResolvedPackageValidator = (resolved: Readonly<{
  packageName: string;
  packageDir: string;
  packageJsonPath: string;
}>) => void;

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

function isPrepublicationAuthorPackage(rawPackageJson: any): boolean {
  const happier = rawPackageJson?.happier;
  const publicSdkRelease = happier?.publicSdkRelease;
  return (
    !!happier
    && typeof happier === 'object'
    && !Array.isArray(happier)
    && Object.keys(happier).length === 1
    && Object.prototype.hasOwnProperty.call(happier, 'publicSdkRelease')
    && !!publicSdkRelease
    && typeof publicSdkRelease === 'object'
    && !Array.isArray(publicSdkRelease)
    && publicSdkRelease.posture === 'developer_preview'
  );
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
    bin,
    dependencies,
    peerDependencies,
    optionalDependencies,
    engines,
  } = raw ?? {};
  const preservesPrepublicationAuthoringMetadata = isPrepublicationAuthorPackage(raw);
  const prepublicationAuthoringFiles = preservesPrepublicationAuthoringMetadata
    ? collectPrepublicationAuthoringFileEntries(raw)
    : undefined;

  // `bin` is runtime input, not source-only package metadata: a bundled
  // workspace package whose executable entrypoint ships inside `dist` is
  // undiscoverable without it, and the Plugin SDK's `happier-plugin-build-ui`
  // builder is exactly that. Package scripts and dev dependencies stay removed.
  // Public-SDK prepublication roots are the narrow exception for internal runtime
  // edges: their manifest is the canonical declaration used later to materialize
  // a temporary independently-installable author tree. The published host itself
  // remains flat; this metadata does not place any closure bytes below the root.
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
    dependencies: preservesPrepublicationAuthoringMetadata
      ? dependencies
      : stripInternalBundledWorkspaceDependencies(dependencies),
    peerDependencies,
    optionalDependencies: preservesPrepublicationAuthoringMetadata
      ? optionalDependencies
      : stripInternalBundledWorkspaceDependencies(optionalDependencies),
    engines,
    ...(preservesPrepublicationAuthoringMetadata
      ? {
          happier: { publicSdkRelease: raw.happier.publicSdkRelease },
          bundledDependencies: readBundledDependencyNames(raw),
          ...(prepublicationAuthoringFiles === undefined ? {} : { files: prepublicationAuthoringFiles }),
        }
      : {}),
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

function removeEmptyDirSync(path: string): void {
  if (existsSync(path) && readdirSync(path).length === 0) {
    rmSync(path, { recursive: true });
  }
}

export function atomicReplaceDirSync(params: Readonly<{
  destDir: string;
  buildInto: (tempDir: string) => void;
  /**
   * Keep an existing destination directory mounted while its staged contents are reconciled.
   * Runtime dependency trees use this mode because daemons and test workers may resolve files
   * from the tree while a source-dev refresh is running.
   */
  preserveDestinationPath?: boolean;
  pruneStale?: boolean;
  fsOps?: Readonly<{
    existsSync?: typeof existsSync;
    lstatSync?: typeof lstatSync;
    mkdirSync?: typeof mkdirSync;
    readdirSync?: ReaddirWithFileTypesSync;
    renameSync?: typeof renameSync;
    rmSync?: typeof rmSync;
  }>;
}>): void {
  const fsOps = params.fsOps ?? {};
  const exists = fsOps.existsSync ?? existsSync;
  const lstat = fsOps.lstatSync ?? lstatSync;
  const mkdir = fsOps.mkdirSync ?? mkdirSync;
  const readDir = fsOps.readdirSync ?? ((path: string) => readdirSync(path, { withFileTypes: true }));
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

    if (params.preserveDestinationPath === true && exists(params.destDir)) {
      try {
        publishStagedDirectoryMountedSync({
          stagedDir: tempDir,
          liveDir: params.destDir,
          rollbackDir: backupDir,
          pruneStale: params.pruneStale !== false,
          fsOps: {
            existsSync: exists,
            lstatSync: lstat,
            mkdirSync: mkdir,
            readdirSync: readDir,
            renameSync: rename,
            rmSync: rm,
          },
        });
      } finally {
        rmDirSafeSync(tempDir, { rmSyncImpl: rm });
      }
      return;
    }

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
    dereferenceRootDir?: string;
    retries?: number;
    delayMs?: number;
    copyFileSyncImpl?: typeof copyFileSync;
    existsSyncImpl?: typeof existsSync;
    lstatSyncImpl?: typeof lstatSync;
    mkdirSyncImpl?: typeof mkdirSync;
    readlinkSyncImpl?: typeof readlinkSync;
    realpathSyncImpl?: typeof realpathSync;
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
    realpathSyncImpl = realpathSync,
    statSyncImpl = statSync,
    symlinkSyncImpl = symlinkSync,
    unlinkSyncImpl = unlinkSync,
  } = opts;
  const readDirWithFileTypes = opts.readdirSyncImpl ?? ((path: string) => readdirSync(path, { withFileTypes: true }));
  const maxAttempts = Math.max(1, Number.isFinite(retries) ? retries + 1 : 1);
  const usesInjectedFileSystem = [
    opts.copyFileSyncImpl,
    opts.existsSyncImpl,
    opts.lstatSyncImpl,
    opts.mkdirSyncImpl,
    opts.readlinkSyncImpl,
    opts.realpathSyncImpl,
    opts.readdirSyncImpl,
    opts.statSyncImpl,
    opts.symlinkSyncImpl,
    opts.unlinkSyncImpl,
  ].some((implementation) => implementation !== undefined);
  if (dereference && recursive && force && !usesInjectedFileSystem) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        copyDirDereferenceContainedSync({
          sourceDir: srcDir,
          destDir,
          dereferenceRootDir: opts.dereferenceRootDir ?? srcDir,
        });
        return;
      } catch (error) {
        if (!isRetryableCopyError(error) || attempt === maxAttempts - 1) throw error;
        sleepSync(delayMs);
      }
    }
  }
  const physicalDereferenceRoot = dereference
    ? realpathSyncImpl(opts.dereferenceRootDir ?? srcDir)
    : '';

  const copyPath = (
    sourcePath: string,
    targetPath: string,
    activePhysicalDirectories: ReadonlySet<string>,
  ): void => {
    const sourceLstat = lstatSyncImpl(sourcePath);
    if (dereference && sourceLstat.isSymbolicLink()) {
      const resolvedTargetPath = realpathSyncImpl(sourcePath);
      const relativeTargetPath = relative(physicalDereferenceRoot, resolvedTargetPath);
      if (
        relativeTargetPath === '..'
        || relativeTargetPath.startsWith(`..${sep}`)
        || isAbsolute(relativeTargetPath)
      ) {
        throw new Error(
          `Dereferenced symlink target escapes copy source root: `
          + `${sourcePath} -> ${resolvedTargetPath} (root: ${physicalDereferenceRoot})`,
        );
      }
    }
    const sourceStats = dereference ? statSyncImpl(sourcePath) : sourceLstat;
    if (sourceStats.isDirectory()) {
      if (!recursive && sourcePath !== srcDir) return;
      let nextActivePhysicalDirectories = activePhysicalDirectories;
      if (dereference) {
        const physicalSourceDirectory = realpathSyncImpl(sourcePath);
        if (activePhysicalDirectories.has(physicalSourceDirectory)) {
          throw new Error(
            `Dereferenced directory symlink cycle detected while copying: ${sourcePath} (${physicalSourceDirectory})`,
          );
        }
        nextActivePhysicalDirectories = new Set([
          ...activePhysicalDirectories,
          physicalSourceDirectory,
        ]);
      }
      mkdirSyncImpl(targetPath, { recursive: true });
      for (const entry of readDirWithFileTypes(sourcePath)) {
        copyPath(
          resolve(sourcePath, entry.name),
          resolve(targetPath, entry.name),
          nextActivePhysicalDirectories,
        );
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

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      copyPath(srcDir, destDir, new Set());
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
  preserveDestinationPath?: boolean;
  pruneStale?: boolean;
}>): void {
  const packageDetails = readWorkspacePackageDetails(params);
  const referencedFiles = collectWorkspacePackageReferencedFiles(packageDetails.rawPackageJson);

  atomicReplaceDirSync({
    destDir: params.destDir,
    preserveDestinationPath: params.preserveDestinationPath,
    pruneStale: params.pruneStale,
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

function collectWorkspacePackageDeclaredFileEntries(rawPackageJson: any): string[] {
  if (rawPackageJson?.files === undefined) return [];
  if (!Array.isArray(rawPackageJson.files) || rawPackageJson.files.some((entry: unknown) => typeof entry !== 'string')) {
    throw new Error('Bundled workspace package files must be an array of exact relative paths');
  }
  return [...new Set(rawPackageJson.files as string[])].filter((entry) => {
    if (
      !entry
      || entry.includes('\\')
      || entry.startsWith('/')
      || entry.split('/').some((segment) => !segment || segment === '.' || segment === '..')
      || /[*?{}[\]]/u.test(entry)
    ) {
      throw new Error(`Bundled workspace package file must be an exact relative path: '${entry}'`);
    }
    return entry !== 'package.json' && entry !== 'dist' && !entry.startsWith('dist/');
  });
}

function collectPrepublicationAuthoringFileEntries(rawPackageJson: any): string[] | undefined {
  if (rawPackageJson?.files === undefined) return undefined;

  // The workspace copier already owns the exact relative-path validation for
  // declared package files. Keep the complete canonical inventory here (rather
  // than its copy-only subset) because npm still needs dist/package.json entries
  // when this flattened package is later materialized for external authors.
  collectWorkspacePackageDeclaredFileEntries(rawPackageJson);
  return [...new Set(rawPackageJson.files as string[])];
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
  const bundledDistDir = resolve(params.tempDir, 'dist');
  copyDirSafeSync(params.distDir, bundledDistDir);
  removeTypeScriptIncrementalMetadata(bundledDistDir);
  writeJson(resolve(params.tempDir, 'package.json'), sanitizeBundledPackageJson(params.rawPackageJson));

  // A bundled plugin's manifest is runtime input, not source-only package metadata. Preserve the
  // reserved manifest directory even when this package is being copied from an already-sanitized
  // workspace runtime whose package.json no longer carries the original `files` declaration.
  const bundledPluginManifestCopied = copyIfExists(
    resolve(params.srcDir, '.happier-plugin'),
    resolve(params.tempDir, '.happier-plugin'),
  );

  const files = params.includeFiles ?? ['README.md'];
  for (const f of files) {
    copyIfExists(resolve(params.srcDir, f), resolve(params.tempDir, f));
  }

  for (const relativePath of [...params.referencedFiles].sort((left, right) => left.localeCompare(right))) {
    const targetPath = resolve(params.tempDir, relativePath);
    const relativeTargetPath = relative(params.tempDir, targetPath);
    if (
      relativeTargetPath === '..'
      || relativeTargetPath.startsWith(`..${sep}`)
      || isAbsolute(relativeTargetPath)
    ) {
      throw new Error(`Bundled workspace package referenced file escapes the package root: '${relativePath}'`);
    }
    // package.json is generated from the sanitized manifest above. An explicit package.json export
    // must remain available, but copying its source target would restore scripts, dev dependencies,
    // and internal workspace edges that the artifact boundary intentionally removed.
    if (targetPath === resolve(params.tempDir, 'package.json')) continue;
    copyIfExists(resolve(params.srcDir, relativePath), targetPath);
  }

  for (const relativePath of collectWorkspacePackageDeclaredFileEntries(params.rawPackageJson)) {
    if (!copyIfExists(resolve(params.srcDir, relativePath), resolve(params.tempDir, relativePath))) {
      throw new Error(`Bundled workspace package declared file is missing: '${relativePath}'`);
    }
  }

  if (bundledPluginManifestCopied) {
    copyBundledPluginManifestResources(params.srcDir, params.tempDir);
  }
}

/**
 * The resources a plugin manifest declares are runtime input for the same reason the manifest
 * itself is, and the `files` selection above cannot carry them across a second generation:
 * `sanitizeBundledPackageJson` strips `files` from every package tree this bundler writes, so
 * re-bundling an already-published tree — which is exactly how the daemon artifact payload is
 * produced — selects nothing. Shipping the manifest without its declared bytes produces an
 * artifact the runtime correctly refuses to start from.
 */
function copyBundledPluginManifestResources(srcDir: string, destDir: string): void {
  for (const relativePath of readBundledPluginPackageResourceRelativePaths(srcDir)) {
    copyIfExists(resolve(srcDir, relativePath), resolve(destDir, relativePath));
  }

  // Fail here rather than at first daemon start: this is the only point that knows both the
  // manifest's declarations and the bytes the package will actually ship.
  const unservableResources = findUnservableBundledPluginPackageResources(destDir);
  if (unservableResources.length > 0) {
    throw new Error([
      'Bundled plugin package cannot serve resources its own manifest declares:',
      ...unservableResources.map((problem) => `- ${problem}`),
    ].join('\n'));
  }
}

export function bundleWorkspacePackageWithRuntimeDependencies(params: Readonly<{
  packageName: string;
  srcDir: string;
  destDir: string;
  includeFiles?: string[];
  resolveFromPackageJsonPath?: string;
  dereferenceRootDir?: string;
  preserveDestinationPath?: boolean;
  pruneStale?: boolean;
  validatePreparedPackage?: (context: Readonly<{
    packageName: string;
    packageDir: string;
  }>) => void;
}>): void {
  const packageDetails = readWorkspacePackageDetails(params);
  const referencedFiles = collectWorkspacePackageReferencedFiles(packageDetails.rawPackageJson);

  atomicReplaceDirSync({
    destDir: params.destDir,
    preserveDestinationPath: params.preserveDestinationPath,
    pruneStale: params.pruneStale,
    buildInto: (tempDir) => {
      copyBundledWorkspacePackageContents({
        srcDir: params.srcDir,
        tempDir,
        rawPackageJson: packageDetails.rawPackageJson,
        distDir: packageDetails.distDir,
        referencedFiles,
        includeFiles: params.includeFiles,
      });
      const destNodeModulesDir = resolve(tempDir, 'node_modules');
      vendorRuntimeDependencyTree({
        packageJsonPath: packageDetails.srcPackageJsonPath,
        resolveFromPackageJsonPath: params.resolveFromPackageJsonPath,
        destNodeModulesDir,
        dereferenceRootDir: params.dereferenceRootDir,
      });
      if (existsSync(destNodeModulesDir) && readdirSync(destNodeModulesDir).length === 0) {
        rmSync(destNodeModulesDir, { recursive: true });
      }
      params.validatePreparedPackage?.({
        packageName: params.packageName,
        packageDir: tempDir,
      });
    },
  });

  removeEmptyDirSync(resolve(params.destDir, 'node_modules'));
}

export function bundleWorkspacePackagesWithRuntimeDependencies(params: Readonly<{
  publicationMode?: 'live' | 'artifact';
  pruneStale?: boolean;
  bundles: ReadonlyArray<{
    packageName: string;
    srcDir: string;
    destDir: string;
    includeFiles?: string[];
    resolveFromPackageJsonPath?: string;
    dereferenceRootDir?: string;
  }>;
}>): void {
  const publicationMode = params.publicationMode ?? 'live';
  if (publicationMode !== 'live' && publicationMode !== 'artifact') {
    throw new Error(`Unknown workspace bundle publication mode: ${String(publicationMode)}`);
  }

  for (const bundle of params.bundles) {
    bundleWorkspacePackageWithRuntimeDependencies({
      ...bundle,
      // Source-dev hosts can refresh these packages while daemons, CLIs, or test workers are
      // resolving them. Keep the package path mounted and publish the complete package plus its
      // runtime dependency tree as one reconciled view.
      preserveDestinationPath: true,
      // A resolver can read the previous manifest immediately before publication and open one of
      // its targets afterward. Retain prior targets in ordinary live package trees so that in-flight reads remain valid.
      // Exact artifact publication and explicit exact prepared readers prune compatibility targets
      // so obsolete generations cannot enter their consumed declaration or artifact graph.
      pruneStale: params.pruneStale ?? publicationMode === 'artifact',
    });
  }
}

type WorkspacePackageBundle = Readonly<{
  packageName: string;
  srcDir: string;
  destDir: string;
  includeFiles?: string[];
  resolveFromPackageJsonPath?: string;
  dereferenceRootDir?: string;
}>;

function readWorkspacePackageVersion(bundle: WorkspacePackageBundle): string {
  const rawPackageJson = readJson(resolve(bundle.srcDir, 'package.json'));
  if (rawPackageJson?.name !== bundle.packageName) {
    throw new Error(`Bundled workspace package manifest does not match '${bundle.packageName}'`);
  }
  if (typeof rawPackageJson?.version !== 'string' || rawPackageJson.version.trim().length === 0) {
    throw new Error(`Bundled workspace package '${bundle.packageName}' has no non-empty version`);
  }
  return rawPackageJson.version.trim();
}

function readPreparedPackageDependencies(rawPackageJson: any, packageName: string): Record<string, string> {
  if (rawPackageJson?.dependencies === undefined) return {};
  if (
    !rawPackageJson.dependencies
    || typeof rawPackageJson.dependencies !== 'object'
    || Array.isArray(rawPackageJson.dependencies)
  ) {
    throw new Error(`Materialized '${packageName}' manifest has an invalid dependencies field`);
  }

  const dependencies: Record<string, string> = {};
  for (const [dependencyName, specifier] of Object.entries(rawPackageJson.dependencies)) {
    if (typeof specifier !== 'string' || specifier.trim().length === 0) {
      throw new Error(`Materialized '${packageName}' manifest has an invalid dependency '${dependencyName}'`);
    }
    dependencies[dependencyName] = specifier.trim();
  }
  return dependencies;
}

function readPrepublicationWorkspacePackageManifest(bundle: WorkspacePackageBundle): any {
  const rawPackageJson = readJson(resolve(bundle.srcDir, 'package.json'));
  if (rawPackageJson?.name !== bundle.packageName) {
    throw new Error(`Bundled workspace package manifest does not match '${bundle.packageName}'`);
  }
  return rawPackageJson;
}

function readDeclaredPrepublicationWorkspaceClosureNames(
  rawPackageJson: any,
  packageName: string,
): string[] {
  const names = readBundledWorkspacePackageNames(rawPackageJson);
  if (new Set(names).size !== names.length) {
    throw new Error(`Prepublication workspace package '${packageName}' declares duplicate bundled dependencies`);
  }
  return names;
}

function assertMaterializedPrepublicationWorkspaceClosure(params: Readonly<{
  packageName: string;
  packageDir: string;
  nestedBundles: ReadonlyArray<WorkspacePackageBundle>;
}>): void {
  const packageJson = readJson(resolve(params.packageDir, 'package.json'));
  if (packageJson?.name !== params.packageName) {
    throw new Error(`Materialized prepublication package does not match '${params.packageName}'`);
  }

  const expectedNames = params.nestedBundles.map((bundle) => bundle.packageName);
  const declaredNames = readDeclaredPrepublicationWorkspaceClosureNames(packageJson, params.packageName);
  if (
    declaredNames.length !== expectedNames.length
    || declaredNames.some((packageName, index) => packageName !== expectedNames[index])
  ) {
    throw new Error(`Materialized prepublication package '${params.packageName}' has a mismatched bundled dependency declaration`);
  }

  const physicalPackageDir = realpathSync(params.packageDir);
  for (const nestedBundle of params.nestedBundles) {
    const nestedPackageDir = resolve(physicalPackageDir, 'node_modules', ...nestedBundle.packageName.split('/'));
    let nestedPackageManifest: any;
    try {
      const nestedStats = lstatSync(nestedPackageDir);
      if (!nestedStats.isDirectory() || nestedStats.isSymbolicLink()) {
        throw new Error('not a physical directory');
      }
      const physicalNestedPackageDir = realpathSync(nestedPackageDir);
      const relativeNestedPackageDir = relative(physicalPackageDir, physicalNestedPackageDir);
      if (
        relativeNestedPackageDir === '..'
        || relativeNestedPackageDir.startsWith(`..${sep}`)
        || isAbsolute(relativeNestedPackageDir)
      ) {
        throw new Error('escapes the materialized root');
      }
      nestedPackageManifest = readJson(resolve(physicalNestedPackageDir, 'package.json'));
    } catch {
      throw new Error(
        `Materialized prepublication package '${params.packageName}' is missing physical bundled dependency '${nestedBundle.packageName}'`,
      );
    }
    if (nestedPackageManifest?.name !== nestedBundle.packageName) {
      throw new Error(
        `Materialized prepublication package '${params.packageName}' has an invalid bundled dependency '${nestedBundle.packageName}'`,
      );
    }
  }
}

/**
 * Materialize marked, flattened prepublication packages into caller-selected
 * transient author roots. Their preserved package manifests declare the internal
 * closure; the host publisher never performs this nesting in its own tree.
 */
export function materializePrepublicationWorkspacePackageRoots(params: Readonly<{
  bundles: ReadonlyArray<WorkspacePackageBundle>;
  rootPackageNames?: readonly string[];
}>): void {
  const bundlesByPackageName = new Map(params.bundles.map((bundle) => [bundle.packageName, bundle] as const));
  if (bundlesByPackageName.size !== params.bundles.length) {
    throw new Error('Prepublication materialization received duplicate workspace package bundles');
  }
  const selectedRootNames = params.rootPackageNames === undefined
    ? null
    : new Set(params.rootPackageNames);
  if (selectedRootNames && selectedRootNames.size !== params.rootPackageNames?.length) {
    throw new Error('Prepublication materialization received duplicate root package names');
  }
  const prepublicationRoots = params.bundles
    .map((bundle) => ({ bundle, rawPackageJson: readPrepublicationWorkspacePackageManifest(bundle) }))
    .filter(({ rawPackageJson }) => isPrepublicationAuthorPackage(rawPackageJson))
    .filter(({ bundle }) => selectedRootNames === null || selectedRootNames.has(bundle.packageName))
    .sort((left, right) => left.bundle.packageName.localeCompare(right.bundle.packageName));
  if (selectedRootNames) {
    const resolvedRootNames = new Set(prepublicationRoots.map(({ bundle }) => bundle.packageName));
    const unsupportedRootName = params.rootPackageNames?.find((packageName) => !resolvedRootNames.has(packageName));
    if (unsupportedRootName) {
      throw new Error(`Bundled host package '${unsupportedRootName}' is not classified for public author use`);
    }
  }
  if (prepublicationRoots.length === 0) return;

  const rootNames = new Set(prepublicationRoots.map(({ bundle }) => bundle.packageName));
  const assignedPackageNames = new Set(rootNames);
  for (const { bundle: rootBundle, rawPackageJson } of prepublicationRoots) {
    const declaredClosureNames = readDeclaredPrepublicationWorkspaceClosureNames(
      rawPackageJson,
      rootBundle.packageName,
    );
    for (const packageName of declaredClosureNames) {
      if (!bundlesByPackageName.has(packageName)) {
        throw new Error(
          `Bundled host is missing prepublication runtime dependency '${packageName}' for '${rootBundle.packageName}'`,
        );
      }
    }
    const nestedBundles = declaredClosureNames
      .filter((packageName) => !assignedPackageNames.has(packageName))
      .map((packageName) => {
        const bundle = bundlesByPackageName.get(packageName);
        if (!bundle) {
          throw new Error(
            `Bundled host is missing prepublication runtime dependency '${packageName}' for '${rootBundle.packageName}'`,
          );
        }
        return bundle;
      });
    for (const nestedBundle of nestedBundles) assignedPackageNames.add(nestedBundle.packageName);
    const siblingRootNames = collectInternalRuntimeWorkspaceDepNames(rawPackageJson).filter((packageName) => (
      packageName !== rootBundle.packageName && rootNames.has(packageName)
    ));

    bundleWorkspacePackageWithRuntimeDependencies({
      ...rootBundle,
      preserveDestinationPath: true,
      pruneStale: true,
      validatePreparedPackage: ({ packageDir }) => {
        for (const nestedBundle of nestedBundles) {
          bundleWorkspacePackageWithRuntimeDependencies({
            ...nestedBundle,
            destDir: resolve(packageDir, 'node_modules', ...nestedBundle.packageName.split('/')),
            pruneStale: true,
          });
        }

        const packageJsonPath = resolve(packageDir, 'package.json');
        const packageJson = readJson(packageJsonPath);
        if (packageJson?.name !== rootBundle.packageName) {
          throw new Error(`Materialized prepublication package does not match '${rootBundle.packageName}'`);
        }
        const dependencies = readPreparedPackageDependencies(packageJson, rootBundle.packageName);
        for (const nestedBundle of nestedBundles) {
          dependencies[nestedBundle.packageName] = readWorkspacePackageVersion(nestedBundle);
        }
        for (const siblingRootName of siblingRootNames) {
          const siblingBundle = bundlesByPackageName.get(siblingRootName);
          if (!siblingBundle) {
            throw new Error(
              `Bundled host is missing sibling prepublication package '${siblingRootName}' for '${rootBundle.packageName}'`,
            );
          }
          dependencies[siblingRootName] = readWorkspacePackageVersion(siblingBundle);
        }
        writeJson(packageJsonPath, {
          ...packageJson,
          dependencies,
          bundledDependencies: nestedBundles.map((bundle) => bundle.packageName),
        });
        assertMaterializedPrepublicationWorkspaceClosure({
          packageName: rootBundle.packageName,
          packageDir,
          nestedBundles,
        });
      },
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
  dereferenceRootDir: string;
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
      dereferenceRootDir: params.repoRoot,
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
  const emitted = new Set<string>();
  const visiting = new Set<string>();
  const orderedPackageNames: string[] = [];

  const visit = (packageName: string): void => {
    const normalizedName = String(packageName ?? '').trim();
    if (!isInternalWorkspacePackageName(normalizedName) || emitted.has(normalizedName)) {
      return;
    }
    // Internal workspace cycles are invalid for publication ordering, but keep closure resolution
    // finite and deterministic so the existing missing-closure diagnostic remains actionable.
    if (visiting.has(normalizedName)) return;
    visiting.add(normalizedName);

    const sourcePackageJsonPath = resolve(
      resolveWorkspaceSourceDir({
        repoRoot: params.repoRoot,
        packageName: normalizedName,
      }),
      'package.json',
    );
    if (existsSync(sourcePackageJsonPath)) {
      const sourcePackageJson = readJson(sourcePackageJsonPath);
      for (const dependencyName of collectInternalRuntimeWorkspaceDepNames(sourcePackageJson)) {
        visit(dependencyName);
      }
    }

    visiting.delete(normalizedName);
    emitted.add(normalizedName);
    orderedPackageNames.push(normalizedName);
  };

  for (const packageName of [...params.packageNames].sort((left, right) => left.localeCompare(right))) {
    visit(packageName);
  }

  return orderedPackageNames;
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

function isTypeScriptIncrementalMetadataPath(relativePath: string): boolean {
  return relativePath.replace(/\\/g, '/').endsWith('.tsbuildinfo');
}

function removeTypeScriptIncrementalMetadata(rootDir: string): void {
  for (const relativePath of collectRelativeRegularFilePaths(rootDir)) {
    if (isTypeScriptIncrementalMetadataPath(relativePath)) {
      rmSync(resolve(rootDir, relativePath), { force: true });
    }
  }
}

function isRuntimePackageContentPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/');
  return !(
    isTypeScriptIncrementalMetadataPath(normalized)
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

  for (const relPath of sourceDistFiles) {
    if (!fileContentsMatch(resolve(workspacePackageDir, relPath), resolve(bundledPackageDir, relPath))) {
      return false;
    }
  }

  const expectedOutputPaths = [...collectWorkspacePackageReferencedFiles(workspacePackageJson)]
    .filter((relativePath) =>
      relativePath.replace(/\\/g, '/') !== 'package.json'
      && isRuntimePackageContentPath(relativePath),
    );
  for (const declaredEntry of collectWorkspacePackageDeclaredFileEntries(workspacePackageJson)) {
    const sourcePath = resolve(workspacePackageDir, declaredEntry);
    if (!existsSync(sourcePath)) return false;
    if (statSync(sourcePath).isDirectory()) {
      expectedOutputPaths.push(
        ...collectRelativeRegularFilePaths(sourcePath, declaredEntry).filter(isRuntimePackageContentPath),
      );
    } else if (isRuntimePackageContentPath(declaredEntry)) {
      expectedOutputPaths.push(declaredEntry);
    }
  }
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
  const deps = collectExternalRuntimeDependencies(pkg);

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

    try {
      assertResolvedRuntimeDependencyMatchesDeclaration({
        dependency: dep,
        resolvedPackageJsonPath: depPackageJsonPath,
        resolvedPackageJson: readJson(depPackageJsonPath),
      });
    } catch {
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

function vendorRuntimeDependencyTree(params: Readonly<{
  packageJsonPath: string;
  resolveFromPackageJsonPath?: string;
  destNodeModulesDir: string;
  visited?: Set<string>;
  activeSourcePackageDirs?: ReadonlySet<string>;
  validateResolvedPackage?: ResolvedPackageValidator;
  dereferenceRootDir?: string;
}>): void {
  vendorRuntimeDependencyTreeCanonical({
    ...params,
    copyResolvedPackage: ({
      sourcePackageDir,
      destPackageDir,
      dereferenceRootDir,
    }) => {
      resetDir(destPackageDir);
      copyDirDereferenceContainedSync({
        sourceDir: sourcePackageDir,
        destDir: destPackageDir,
        dereferenceRootDir,
      });
    },
  });
}

export function vendorBundledPackageRuntimeDependencies(params: Readonly<{
  srcPackageJsonPath: string;
  resolveFromPackageJsonPath?: string;
  destPackageDir: string;
  dereferenceRootDir?: string;
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
  // Build into a sibling temp directory, then reconcile complete files into the live tree while
  // keeping its directory path mounted for concurrent module resolvers.
  atomicReplaceDirSync({
    destDir: destNodeModulesDir,
    preserveDestinationPath: true,
    pruneStale: false,
    buildInto: (tempNodeModulesDir) => {
      vendorRuntimeDependencyTree({
        packageJsonPath: params.srcPackageJsonPath,
        resolveFromPackageJsonPath: params.resolveFromPackageJsonPath,
        destNodeModulesDir: tempNodeModulesDir,
        dereferenceRootDir: params.dereferenceRootDir,
      });
    },
  });
  removeEmptyDirSync(destNodeModulesDir);
}

export function bundleInstalledPackageWithRuntimeDependencies(params: Readonly<{
  packageName: string;
  declaredSpec?: string;
  resolveFromPackageJsonPath: string;
  destNodeModulesDir: string;
  validateResolvedPackage?: ResolvedPackageValidator;
  dereferenceRootDir?: string;
}>): void {
  const resolved = resolveInstalledRuntimePackage({
    packageName: params.packageName,
    resolveFromPackageJsonPath: params.resolveFromPackageJsonPath,
    dereferenceRootDir: params.dereferenceRootDir,
  });
  const destPackageDir = resolve(
    params.destNodeModulesDir,
    ...parsePackageNameSegments(params.packageName),
  );
  params.validateResolvedPackage?.({
    packageName: params.packageName,
    packageDir: resolved.packageDir,
    packageJsonPath: resolved.packageJsonPath,
  });
  assertResolvedRuntimeDependencyMatchesDeclaration({
    dependency: {
      name: params.packageName,
      optional: false,
      declaredSpec: params.declaredSpec ?? '',
    },
    resolvedPackageJsonPath: resolved.packageJsonPath,
    resolvedPackageJson: resolved.packageJson,
  });
  const activeSourcePackageDirs = new Set([realpathSync(resolved.packageDir)]);

  atomicReplaceDirSync({
    destDir: destPackageDir,
    preserveDestinationPath: true,
    pruneStale: false,
    buildInto: (tempDir) => {
      resetDir(tempDir);
      copyDirDereferenceContainedSync({
        sourceDir: resolved.packageDir,
        destDir: tempDir,
        dereferenceRootDir: params.dereferenceRootDir ?? resolved.packageDir,
      });

      vendorRuntimeDependencyTree({
        packageJsonPath: resolved.packageJsonPath,
        resolveFromPackageJsonPath: resolved.packageJsonPath,
        destNodeModulesDir: resolve(tempDir, 'node_modules'),
        activeSourcePackageDirs,
        validateResolvedPackage: params.validateResolvedPackage,
        dereferenceRootDir: params.dereferenceRootDir,
      });
    },
  });
}
