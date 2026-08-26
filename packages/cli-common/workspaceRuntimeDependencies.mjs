import {
  constants,
  cpSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';

const PACKAGE_NAME_SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;

export function parsePackageNameSegments(packageName) {
  const normalizedPackageName = String(packageName ?? '').trim();
  const segments = normalizedPackageName.split('/');
  const valid = (
    (
      segments.length === 1
      && PACKAGE_NAME_SEGMENT_PATTERN.test(segments[0])
    )
    || (
      segments.length === 2
      && segments[0].startsWith('@')
      && PACKAGE_NAME_SEGMENT_PATTERN.test(segments[0].slice(1))
      && PACKAGE_NAME_SEGMENT_PATTERN.test(segments[1])
    )
  )
    && segments.every((segment) => segment !== '.' && segment !== '..')
    && !normalizedPackageName.includes('\\')
    && !normalizedPackageName.includes('%');
  if (!valid) {
    throw new Error(
      `Invalid package dependency name: ${normalizedPackageName || '<empty>'}`,
    );
  }
  return segments;
}

function sleepSync(ms) {
  if (!ms || ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function isMissingPathError(error) {
  return error?.code === 'ENOENT';
}

function isRetryableRenameError(error) {
  return (
    error?.code === 'ENOTEMPTY'
    || error?.code === 'EBUSY'
    || error?.code === 'EPERM'
    || error?.code === 'EACCES'
  );
}

function removePathSync(path, remove) {
  remove(path, { recursive: true, force: true });
}

function renameLivePathWithRetry({
  sourcePath,
  targetPath,
  rename,
  retries = 5,
  delayMs = 25,
}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      rename(sourcePath, targetPath);
      return;
    } catch (error) {
      if (!isRetryableRenameError(error) || attempt === retries) throw error;
      sleepSync(delayMs);
    }
  }
}

function fileContentsMatch(leftPath, rightPath) {
  try {
    const leftStats = statSync(leftPath);
    const rightStats = statSync(rightPath);
    return (
      leftStats.isFile()
      && rightStats.isFile()
      && leftStats.size === rightStats.size
      && readFileSync(leftPath).equals(readFileSync(rightPath))
    );
  } catch {
    return false;
  }
}

function recordLivePathForRollbackSync({
  livePath,
  liveStats,
  rollbackDir,
  rollbackEntries,
  mkdir,
}) {
  const backupPath = liveStats
    ? resolve(rollbackDir, `entry-${rollbackEntries.length}`)
    : null;
  if (backupPath) {
    mkdir(dirname(backupPath), { recursive: true });
    if (liveStats.isFile()) {
      try {
        linkSync(livePath, backupPath);
      } catch {
        copyFileSync(livePath, backupPath);
      }
    } else {
      cpSync(livePath, backupPath, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
    }
  }

  const entry = { livePath, backupPath, mutated: false };
  rollbackEntries.push(entry);
  return entry;
}

function rollbackLiveDirectoryReconciliationSync({
  rollbackEntries,
  exists,
  mkdir,
  rename,
  remove,
}) {
  for (let index = rollbackEntries.length - 1; index >= 0; index -= 1) {
    const entry = rollbackEntries[index];
    if (!entry.mutated) continue;
    removePathSync(entry.livePath, remove);
    if (!entry.backupPath || !exists(entry.backupPath)) continue;
    mkdir(dirname(entry.livePath), { recursive: true });
    renameLivePathWithRetry({
      sourcePath: entry.backupPath,
      targetPath: entry.livePath,
      rename,
    });
  }
}

function reconcileStagedDirectoryIntoLiveDirectorySync({
  stagedDir,
  liveDir,
  rollbackDir,
  rollbackEntries,
  exists,
  lstat,
  mkdir,
  readDir,
  rename,
  remove,
  pruneStale,
  deferredRemovals,
}) {
  const pendingRemovals = deferredRemovals ?? [];
  const ownsDeferredRemovals = deferredRemovals === undefined;
  mkdir(liveDir, { recursive: true });

  const stagedEntries = readDir(stagedDir).sort((left, right) => {
    if (left.name === 'package.json') return 1;
    if (right.name === 'package.json') return -1;
    return left.name.localeCompare(right.name);
  });
  const stagedNames = new Set(stagedEntries.map((entry) => entry.name));

  for (const entry of stagedEntries) {
    const stagedPath = resolve(stagedDir, entry.name);
    const livePath = resolve(liveDir, entry.name);
    let liveStats = null;
    if (exists(livePath)) {
      try {
        liveStats = lstat(livePath);
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
      }
    }

    if (entry.isDirectory()) {
      if (liveStats?.isDirectory()) {
        reconcileStagedDirectoryIntoLiveDirectorySync({
          stagedDir: stagedPath,
          liveDir: livePath,
          rollbackDir,
          rollbackEntries,
          exists,
          lstat,
          mkdir,
          readDir,
          rename,
          remove,
          pruneStale,
          deferredRemovals: pendingRemovals,
        });
        continue;
      }

      const rollbackEntry = recordLivePathForRollbackSync({
        livePath,
        liveStats,
        rollbackDir,
        rollbackEntries,
        mkdir,
      });
      if (liveStats) {
        rollbackEntry.mutated = true;
        removePathSync(livePath, remove);
      }
      renameLivePathWithRetry({
        sourcePath: stagedPath,
        targetPath: livePath,
        rename,
      });
      rollbackEntry.mutated = true;
      continue;
    }

    if (entry.isFile() && liveStats?.isFile() && fileContentsMatch(stagedPath, livePath)) {
      removePathSync(stagedPath, remove);
      continue;
    }

    const rollbackEntry = recordLivePathForRollbackSync({
      livePath,
      liveStats,
      rollbackDir,
      rollbackEntries,
      mkdir,
    });
    if (liveStats?.isDirectory()) {
      rollbackEntry.mutated = true;
      removePathSync(livePath, remove);
    }
    renameLivePathWithRetry({
      sourcePath: stagedPath,
      targetPath: livePath,
      rename,
    });
    rollbackEntry.mutated = true;
  }

  if (pruneStale) {
    for (const liveEntry of readDir(liveDir)) {
      if (!stagedNames.has(liveEntry.name)) {
        pendingRemovals.push(resolve(liveDir, liveEntry.name));
      }
    }
  }

  if (ownsDeferredRemovals) {
    for (const stalePath of pendingRemovals) {
      let staleStats = null;
      if (exists(stalePath)) {
        try {
          staleStats = lstat(stalePath);
        } catch (error) {
          if (!isMissingPathError(error)) throw error;
        }
      }
      const rollbackEntry = recordLivePathForRollbackSync({
        livePath: stalePath,
        liveStats: staleStats,
        rollbackDir,
        rollbackEntries,
        mkdir,
      });
      rollbackEntry.mutated = true;
      removePathSync(stalePath, remove);
    }
  }
}

export function publishStagedDirectoryMountedSync({
  stagedDir,
  liveDir,
  rollbackDir,
  pruneStale = false,
  fsOps = {},
}) {
  const exists = fsOps.existsSync ?? existsSync;
  const lstat = fsOps.lstatSync ?? lstatSync;
  const mkdir = fsOps.mkdirSync ?? mkdirSync;
  const readDir =
    fsOps.readdirSync ?? ((path) => readdirSync(path, { withFileTypes: true }));
  const rename = fsOps.renameSync ?? renameSync;
  const remove = fsOps.rmSync ?? rmSync;
  const rollbackEntries = [];
  let rollbackFailed = false;

  try {
    reconcileStagedDirectoryIntoLiveDirectorySync({
      stagedDir,
      liveDir,
      rollbackDir,
      rollbackEntries,
      exists,
      lstat,
      mkdir,
      readDir,
      rename,
      remove,
      pruneStale,
    });
  } catch (error) {
    try {
      rollbackLiveDirectoryReconciliationSync({
        rollbackEntries,
        exists,
        mkdir,
        rename,
        remove,
      });
    } catch (rollbackError) {
      rollbackFailed = true;
      throw new AggregateError(
        [error, rollbackError],
        `Failed to publish and roll back live directory: ${liveDir}`,
      );
    }
    throw error;
  } finally {
    if (!rollbackFailed) {
      removePathSync(rollbackDir, remove);
    }
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function collectExternalRuntimeDependencies(packageJson) {
  const dependencies = packageJson?.dependencies && typeof packageJson.dependencies === 'object'
    ? packageJson.dependencies
    : {};
  const optionalDependencies =
    packageJson?.optionalDependencies && typeof packageJson.optionalDependencies === 'object'
      ? packageJson.optionalDependencies
      : {};

  const required = Object.keys(dependencies).flatMap((name) => {
    parsePackageNameSegments(name);
    return name.startsWith('@happier-dev/')
      ? []
      : [{
          name,
          optional: false,
          declaredSpec: typeof dependencies[name] === 'string' ? dependencies[name].trim() : '',
        }];
  });
  const optional = Object.keys(optionalDependencies).flatMap((name) => {
    parsePackageNameSegments(name);
    return name.startsWith('@happier-dev/')
      ? []
      : [{
          name,
          optional: true,
          declaredSpec:
            typeof optionalDependencies[name] === 'string'
              ? optionalDependencies[name].trim()
              : '',
        }];
  });

  return [...required, ...optional];
}

function parseNpmAliasSpec(spec) {
  if (!spec.startsWith('npm:')) return null;

  const target = spec.slice('npm:'.length);
  const versionSeparatorIndex = target.startsWith('@')
    ? target.indexOf('@', target.indexOf('/') + 1)
    : target.lastIndexOf('@');
  if (versionSeparatorIndex <= 0) return null;

  const packageName = target.slice(0, versionSeparatorIndex);
  const versionSpec = target.slice(versionSeparatorIndex + 1);
  return packageName && versionSpec ? { packageName, versionSpec } : null;
}

export function assertResolvedRuntimeDependencyMatchesDeclaration({
  dependency,
  resolvedPackageJsonPath,
  resolvedPackageJson,
}) {
  const alias = parseNpmAliasSpec(dependency.declaredSpec);
  const expectedPackageName = alias?.packageName ?? dependency.name;
  const actualPackageName =
    typeof resolvedPackageJson?.name === 'string' ? resolvedPackageJson.name : '';
  if (actualPackageName !== expectedPackageName) {
    throw new Error(
      `Resolved runtime dependency ${dependency.name} has package identity `
        + `${actualPackageName || '<missing>'}; expected ${expectedPackageName} `
        + `(${resolvedPackageJsonPath})`,
    );
  }

  const versionSpec = alias?.versionSpec ?? dependency.declaredSpec;
  const validRange = semver.validRange(versionSpec);
  if (!validRange) return;

  const actualVersion =
    typeof resolvedPackageJson?.version === 'string' ? resolvedPackageJson.version : '';
  if (!semver.satisfies(actualVersion, validRange)) {
    throw new Error(
      `Resolved runtime dependency ${dependency.name}@${actualVersion || '<missing>'} `
        + `does not satisfy declared range ${versionSpec} (${resolvedPackageJsonPath})`,
    );
  }
}

export function assertPhysicalPathWithinApprovedRoot({
  approvedRootDir,
  sourcePath,
  dependencyName,
  errorPrefix,
  realpathSyncImpl = realpathSync,
}) {
  const physicalApprovedRoot = realpathSyncImpl(approvedRootDir);
  const physicalSourcePath = realpathSyncImpl(sourcePath);
  const relativeSourcePath = relative(physicalApprovedRoot, physicalSourcePath);
  if (
    relativeSourcePath === '..'
    || relativeSourcePath.startsWith(`..${sep}`)
    || isAbsolute(relativeSourcePath)
  ) {
    throw new Error(
      `${errorPrefix ?? `Resolved runtime dependency ${dependencyName} is outside the caller-approved root`}: `
        + `${physicalSourcePath} (root: ${physicalApprovedRoot})`,
    );
  }
  return physicalSourcePath;
}

export function resolveInstalledRuntimePackage({
  packageName,
  resolveFromPackageJsonPath,
  dereferenceRootDir,
}) {
  const packageNameSegments = parsePackageNameSegments(packageName);
  const require = createRequire(pathToFileURL(resolveFromPackageJsonPath).href);
  const searchPaths = require.resolve.paths(packageName) ?? [];
  let aliasInstalledPackage = null;

  for (const searchPath of searchPaths) {
    const packageJsonPath = resolve(searchPath, ...packageNameSegments, 'package.json');
    if (!existsSync(packageJsonPath)) continue;
    const packageJson = readJson(packageJsonPath);
    const installedPackage = {
      packageDir: dirname(packageJsonPath),
      packageJsonPath,
      packageJson,
    };
    if (packageJson?.name === packageName) {
      if (dereferenceRootDir) {
        assertPhysicalPathWithinApprovedRoot({
          approvedRootDir: dereferenceRootDir,
          sourcePath: installedPackage.packageDir,
          dependencyName: packageName,
        });
      }
      return installedPackage;
    }
    aliasInstalledPackage ??= installedPackage;
  }

  if (aliasInstalledPackage) {
    if (dereferenceRootDir) {
      assertPhysicalPathWithinApprovedRoot({
        approvedRootDir: dereferenceRootDir,
        sourcePath: aliasInstalledPackage.packageDir,
        dependencyName: packageName,
      });
    }
    return aliasInstalledPackage;
  }

  let resolvedEntry = '';
  try {
    resolvedEntry = require.resolve(`${packageName}/package.json`);
  } catch {
    resolvedEntry = require.resolve(packageName);
  }

  let dir = dirname(resolvedEntry);
  for (let i = 0; i < 50; i += 1) {
    const packageJsonPath = resolve(dir, 'package.json');
    if (existsSync(packageJsonPath)) {
      const packageJson = readJson(packageJsonPath);
      if (packageJson?.name === packageName) {
        const installedPackage = { packageDir: dir, packageJsonPath, packageJson };
        if (dereferenceRootDir) {
          assertPhysicalPathWithinApprovedRoot({
            approvedRootDir: dereferenceRootDir,
            sourcePath: installedPackage.packageDir,
            dependencyName: packageName,
          });
        }
        return installedPackage;
      }
    }

    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  throw new Error(
    `Failed to locate installed package.json for ${packageName} (resolved: ${resolvedEntry})`,
  );
}

export function copyDirDereferenceContainedSync({
  sourceDir,
  destDir,
  dereferenceRootDir = sourceDir,
  shouldCopyPath = () => true,
}) {
  const physicalDereferenceRoot = realpathSync(dereferenceRootDir);

  const copyPath = (sourcePath, targetPath, activePhysicalDirectories) => {
    if (!shouldCopyPath(sourcePath)) return;
    const sourceLstat = lstatSync(sourcePath);
    if (sourceLstat.isSymbolicLink()) {
      assertPhysicalPathWithinApprovedRoot({
        approvedRootDir: physicalDereferenceRoot,
        sourcePath,
        dependencyName: sourcePath,
        errorPrefix: 'Dereferenced symlink target escapes copy source root',
      });
    }
    const sourceStats = statSync(sourcePath);
    if (sourceStats.isDirectory()) {
      const physicalSourceDirectory = realpathSync(sourcePath);
      if (activePhysicalDirectories.has(physicalSourceDirectory)) {
        throw new Error(
          `Dereferenced directory symlink cycle detected while copying: `
            + `${sourcePath} (${physicalSourceDirectory})`,
        );
      }
      const nextActivePhysicalDirectories = new Set(activePhysicalDirectories);
      nextActivePhysicalDirectories.add(physicalSourceDirectory);
      mkdirSync(targetPath, { recursive: true });
      for (const entry of readdirSync(sourcePath, { withFileTypes: true })) {
        copyPath(
          resolve(sourcePath, entry.name),
          resolve(targetPath, entry.name),
          nextActivePhysicalDirectories,
        );
      }
      return;
    }

    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath, constants.COPYFILE_FICLONE);
  };

  assertPhysicalPathWithinApprovedRoot({
    approvedRootDir: physicalDereferenceRoot,
    sourcePath: sourceDir,
    dependencyName: sourceDir,
  });
  copyPath(sourceDir, destDir, new Set());
}

export function vendorRuntimeDependencyTree({
  packageJsonPath,
  resolveFromPackageJsonPath = packageJsonPath,
  destNodeModulesDir,
  copyResolvedPackage,
  visited = new Set(),
  activeSourcePackageDirs = new Set(),
  validateResolvedPackage,
  dereferenceRootDir,
}) {
  const packageJson = readJson(packageJsonPath);
  const dependencies = collectExternalRuntimeDependencies(packageJson);
  mkdirSync(destNodeModulesDir, { recursive: true });

  for (const dependency of dependencies) {
    let resolvedPackage;
    try {
      resolvedPackage = resolveInstalledRuntimePackage({
        packageName: dependency.name,
        resolveFromPackageJsonPath,
        dereferenceRootDir,
      });
    } catch (error) {
      if (dependency.optional && error?.code === 'MODULE_NOT_FOUND') continue;
      throw error;
    }
    validateResolvedPackage?.({
      packageName: dependency.name,
      packageDir: resolvedPackage.packageDir,
      packageJsonPath: resolvedPackage.packageJsonPath,
    });
    assertResolvedRuntimeDependencyMatchesDeclaration({
      dependency,
      resolvedPackageJsonPath: resolvedPackage.packageJsonPath,
      resolvedPackageJson: resolvedPackage.packageJson,
    });

    const physicalSourcePackageDir = realpathSync(resolvedPackage.packageDir);
    if (activeSourcePackageDirs.has(physicalSourcePackageDir)) continue;
    const nextActiveSourcePackageDirs = new Set(activeSourcePackageDirs);
    nextActiveSourcePackageDirs.add(physicalSourcePackageDir);
    const physicalSourcePackageJsonPath = realpathSync(
      resolvedPackage.packageJsonPath,
    );

    const depDestDir = resolve(
      destNodeModulesDir,
      ...parsePackageNameSegments(dependency.name),
    );
    if (visited.has(depDestDir)) continue;
    visited.add(depDestDir);

    copyResolvedPackage({
      sourcePackageDir: resolvedPackage.packageDir,
      destPackageDir: depDestDir,
      dereferenceRootDir: dereferenceRootDir ?? resolvedPackage.packageDir,
    });

    vendorRuntimeDependencyTree({
      packageJsonPath: resolvedPackage.packageJsonPath,
      resolveFromPackageJsonPath: physicalSourcePackageJsonPath,
      destNodeModulesDir: resolve(depDestDir, 'node_modules'),
      copyResolvedPackage,
      visited,
      activeSourcePackageDirs: nextActiveSourcePackageDirs,
      validateResolvedPackage,
      dereferenceRootDir,
    });
  }
}
