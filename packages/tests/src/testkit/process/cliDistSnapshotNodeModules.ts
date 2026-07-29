import {
  Dirent,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve, sep } from 'node:path';

import { sanitizeBundledPackageJson } from '@happier-dev/cli-common/workspaces';

type CopyMissingEntryOptions = {
  mergeExistingDirectoryContents?: boolean;
  pruneNestedNodeModules?: boolean;
};

function isTransientSyncDirName(name: string): boolean {
  return name.startsWith('dist.__sync_tmp__.') || name.startsWith('dist.__sync_backup__.');
}

function resolveSymlinkType(sourcePath: string): 'dir' | 'file' | 'junction' | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    return lstatSync(sourcePath).isDirectory() ? 'junction' : 'file';
  } catch {
    return undefined;
  }
}

function ensureSymlink(destPath: string, sourcePath: string): void {
  if (existsSync(destPath)) return;
  mkdirSync(dirname(destPath), { recursive: true });
  try {
    symlinkSync(sourcePath, destPath, resolveSymlinkType(sourcePath));
  } catch {
    // Best-effort only. Some environments disallow symlinks; callers must tolerate missing links.
  }
}

function isDirectoryEntry(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSymbolicLinkEntry(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * True when writing to destPath would traverse a symlinked component INSIDE a node_modules
 * subtree (overlay symlinks pointing at the live source tree). Per-entry lstat guards only see
 * the final component; when an ANCESTOR (e.g. a scoped @scope directory, or any deeper entry)
 * is the symlink, the textual destination resolves through it and the write lands in the LIVE
 * tree (observed live 2026-06-12: real workspace node_modules gained vendored nested copies
 * through scope-level overlay symlinks with the entry-level guard already in place).
 * Components ABOVE the first node_modules segment (snapshot tmp dirs, /var on macOS, ...) are
 * legitimately symlinked and deliberately not policed.
 */
function writesThroughSymlinkedNodeModulesPath(destPath: string): boolean {
  const segments = destPath.split(sep);
  const firstNodeModulesIndex = segments.indexOf('node_modules');
  if (firstNodeModulesIndex === -1) return false;
  let current = segments.slice(0, firstNodeModulesIndex + 1).join(sep) || sep;
  try {
    if (lstatSync(current).isSymbolicLink()) return true;
  } catch {
    return false;
  }
  for (let i = firstNodeModulesIndex + 1; i < segments.length - 1; i += 1) {
    current = `${current}${sep}${segments[i]}`;
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      // Ancestor does not exist yet: everything below will be created as real directories.
      return false;
    }
  }
  return false;
}

function copyMissingEntry(destPath: string, sourcePath: string, options: CopyMissingEntryOptions = {}): void {
  const mergeExistingDirectoryContents = options.mergeExistingDirectoryContents ?? true;
  const pruneNestedNodeModules = options.pruneNestedNodeModules ?? false;
  if (isTransientSyncDirName(basename(sourcePath))) return;
  if (writesThroughSymlinkedNodeModulesPath(destPath)) return;

  if (existsSync(destPath)) {
    if (!isDirectoryEntry(sourcePath) || !isDirectoryEntry(destPath)) return;
    if (!mergeExistingDirectoryContents) return;

    for (const entry of listNodeModulesEntries(sourcePath)) {
      if (entry.name.startsWith('.')) continue;
      if (pruneNestedNodeModules && entry.name === 'node_modules') continue;
      copyMissingEntry(resolve(destPath, entry.name), resolve(sourcePath, entry.name), options);
    }
    return;
  }

  mkdirSync(dirname(destPath), { recursive: true });
  if (isDirectoryEntry(sourcePath)) {
    mkdirSync(destPath, { recursive: true });
    for (const entry of listNodeModulesEntries(sourcePath)) {
      if (entry.name.startsWith('.')) continue;
      if (pruneNestedNodeModules && entry.name === 'node_modules') continue;
      copyMissingEntry(resolve(destPath, entry.name), resolve(sourcePath, entry.name), options);
    }
    return;
  }

  try {
    cpSync(sourcePath, destPath, { recursive: true, dereference: true, preserveTimestamps: true });
  } catch {
    // Best-effort only. Callers must tolerate missing links in constrained environments.
  }
}

function ensureCopiedDirectory(destPath: string, sourcePath: string, options: CopyMissingEntryOptions = {}): void {
  copyMissingEntry(destPath, sourcePath, options);
}

function ensureCopiedDirectoryFromCandidates(
  destPath: string,
  sourceCandidates: ReadonlyArray<string>,
  options: CopyMissingEntryOptions = {},
): void {
  for (const sourcePath of sourceCandidates) {
    if (!existsSync(sourcePath)) continue;
    ensureCopiedDirectory(destPath, sourcePath, options);
  }
}

function ensureCopiedNodeModulesEntries(sourceNodeModulesDir: string, destNodeModulesDir: string, skipNames: ReadonlySet<string> = new Set()): void {
  for (const entry of listNodeModulesEntries(sourceNodeModulesDir)) {
    if (entry.name.startsWith('.')) continue;
    if (skipNames.has(entry.name)) continue;

    const sourcePath = resolve(sourceNodeModulesDir, entry.name);
    const destPath = resolve(destNodeModulesDir, entry.name);
    ensureCopiedDirectory(destPath, sourcePath);
  }
}

function ensureCopiedTextFile(destPath: string, sourcePath: string, options: { overwriteExisting?: boolean } = {}): void {
  if (existsSync(destPath) && !options.overwriteExisting) return;
  if (writesThroughSymlinkedNodeModulesPath(destPath)) return;
  mkdirSync(dirname(destPath), { recursive: true });
  try {
    writeFileSync(destPath, readFileSync(sourcePath));
  } catch {
    // Best-effort only. Callers tolerate missing optional files.
  }
}

function listNodeModulesEntries(nodeModulesDir: string): Dirent[] {
  try {
    return readdirSync(nodeModulesDir, { withFileTypes: true }).filter((entry) => !isTransientSyncDirName(entry.name));
  } catch {
    return [];
  }
}

function listScopedPackageEntries(scopeDir: string): Dirent[] {
  return listNodeModulesEntries(scopeDir).filter((entry) => !entry.name.startsWith('.'));
}

type RuntimeDependencyCollectionOptions = {
  includeOptionalDependencies?: boolean;
  includePeerDependencies?: boolean;
};

function collectExternalRuntimeDepNamesFromPackageJson(
  packageJsonPath: string,
  options: RuntimeDependencyCollectionOptions = {},
): ReadonlyArray<{ name: string; optional: boolean }> {
  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return [];
  }

  const includeOptionalDependencies = options.includeOptionalDependencies ?? true;
  const includePeerDependencies = options.includePeerDependencies ?? true;
  const deps = pkg?.dependencies ?? {};
  const optionalDeps = pkg?.optionalDependencies ?? {};
  const peerDeps = pkg?.peerDependencies ?? {};

  const required = Object.keys(deps)
    .filter((name) => typeof name === 'string' && !name.startsWith('@happier-dev/'))
    .map((name) => ({ name, optional: false }));
  const optional = includeOptionalDependencies
    ? Object.keys(optionalDeps)
        .filter((name) => typeof name === 'string' && !name.startsWith('@happier-dev/'))
        .map((name) => ({ name, optional: true }))
    : [];
  const peer = includePeerDependencies
    ? Object.keys(peerDeps)
        .filter((name) => typeof name === 'string' && !name.startsWith('@happier-dev/'))
        .map((name) => ({ name, optional: true }))
    : [];

  return [...required, ...optional, ...peer];
}

function readPackageNameFromPackageJson(packageJsonPath: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { name?: unknown };
    return typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name.trim() : null;
  } catch {
    return null;
  }
}

type WorkspacePackageInfo = {
  packageDir: string;
  packageJsonPath: string;
  scopePackageName: string;
};

function collectWorkspacePackageInfos(rootDir: string): WorkspacePackageInfo[] {
  const candidateParentDirs = [
    resolve(rootDir, 'packages'),
    resolve(rootDir, 'packages', 'plugins'),
    resolve(rootDir, 'packages', 'extensions'),
  ];
  const seenPackageJsonPaths = new Set<string>();
  const packages: WorkspacePackageInfo[] = [];

  for (const parentDir of candidateParentDirs) {
    for (const entry of listNodeModulesEntries(parentDir)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      const packageDir = resolve(parentDir, entry.name);
      const packageJsonPath = resolve(packageDir, 'package.json');
      if (seenPackageJsonPaths.has(packageJsonPath)) continue;
      seenPackageJsonPaths.add(packageJsonPath);

      const packageName = readPackageNameFromPackageJson(packageJsonPath);
      if (!packageName?.startsWith('@happier-dev/')) continue;

      const scopePackageName = packageName.slice('@happier-dev/'.length).trim();
      if (!scopePackageName) continue;

      packages.push({ packageDir, packageJsonPath, scopePackageName });
    }
  }

  return packages;
}

function ensureWorkspacePackageRuntimeDependencyFallbacks(
  snapshotPackageNodeModulesDir: string,
  rootDir: string,
  packageJsonPath: string,
): void {
  const rootNodeModulesDir = resolve(rootDir, 'node_modules');
  const cliNodeModulesDir = resolve(rootDir, 'apps', 'cli', 'node_modules');

  for (const dep of collectExternalRuntimeDepNamesFromPackageJson(packageJsonPath)) {
    const snapshotDepPath = resolve(snapshotPackageNodeModulesDir, ...dep.name.split('/'));
    const sourceCandidates = [
      resolve(cliNodeModulesDir, ...dep.name.split('/')),
      resolve(rootNodeModulesDir, ...dep.name.split('/')),
    ];
    ensureCopiedDirectoryFromCandidates(snapshotDepPath, sourceCandidates);
  }
}

function ensureHoistedScopeFallback(scopeName: string, params: {
  rootNodeModulesDir: string;
  cliNodeModulesDir: string | null;
  fallbackNodeModulesDir: string;
}): void {
  const rootScopeDir = resolve(params.rootNodeModulesDir, scopeName);
  const cliScopeDir = params.cliNodeModulesDir ? resolve(params.cliNodeModulesDir, scopeName) : null;
  const fallbackScopeDir = resolve(params.fallbackNodeModulesDir, scopeName);

  for (const pkgEntry of listScopedPackageEntries(rootScopeDir)) {
    const rootPackagePath = resolve(rootScopeDir, pkgEntry.name);
    const cliPackagePath = cliScopeDir ? resolve(cliScopeDir, pkgEntry.name) : null;
    if (cliPackagePath && existsSync(cliPackagePath)) continue;
    ensureSymlink(resolve(fallbackScopeDir, pkgEntry.name), rootPackagePath);
  }

  const scopedFallbackEntries = listScopedPackageEntries(fallbackScopeDir);
  if (scopedFallbackEntries.length === 0 && existsSync(fallbackScopeDir)) {
    rmSync(fallbackScopeDir, { recursive: true, force: true });
  }
}

function ensureRootNodeModulesFallback(snapshotDistDir: string, rootDir: string): void {
  const rootNodeModulesDir = resolve(rootDir, 'node_modules');
  if (!existsSync(rootNodeModulesDir)) return;

  const cliNodeModulesDir = existsSync(resolve(rootDir, 'apps', 'cli', 'node_modules'))
    ? resolve(rootDir, 'apps', 'cli', 'node_modules')
    : null;
  const fallbackNodeModulesDir = resolve(snapshotDistDir, 'node_modules');

  for (const entry of listNodeModulesEntries(rootNodeModulesDir)) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name.startsWith('@')) {
      ensureHoistedScopeFallback(entry.name, {
        rootNodeModulesDir,
        cliNodeModulesDir,
        fallbackNodeModulesDir,
      });
      continue;
    }

    if (cliNodeModulesDir && existsSync(resolve(cliNodeModulesDir, entry.name))) continue;
    ensureSymlink(resolve(fallbackNodeModulesDir, entry.name), resolve(rootNodeModulesDir, entry.name));
  }
}

function ensureWorkspacePackageManifests(snapshotNodeModulesDir: string, rootDir: string): void {
  for (const { packageJsonPath, scopePackageName } of collectWorkspacePackageInfos(rootDir)) {
    const snapshotPackageJsonPath = resolve(snapshotNodeModulesDir, '@happier-dev', scopePackageName, 'package.json');
    if (writesThroughSymlinkedNodeModulesPath(snapshotPackageJsonPath)) continue;
    try {
      const sourceManifest = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
      mkdirSync(dirname(snapshotPackageJsonPath), { recursive: true });
      writeFileSync(
        snapshotPackageJsonPath,
        `${JSON.stringify(sanitizeBundledPackageJson(sourceManifest), null, 2)}\n`,
        'utf8',
      );
    } catch {
      // Best-effort only. Tests can still use the bundled manifest copied before this repair.
    }
  }
}

function ensureWorkspacePackageDistTrees(snapshotNodeModulesDir: string, rootDir: string): void {
  for (const { packageDir, scopePackageName } of collectWorkspacePackageInfos(rootDir)) {
    const sourceDistDir = resolve(packageDir, 'dist');
    const snapshotPackageDir = resolve(snapshotNodeModulesDir, '@happier-dev', scopePackageName);
    const snapshotDistDir = resolve(snapshotPackageDir, 'dist');
    if (!existsSync(sourceDistDir)) continue;

    mkdirSync(snapshotPackageDir, { recursive: true });
    try {
      cpSync(sourceDistDir, snapshotDistDir, {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
        force: true,
      });
    } catch {
      // Best-effort only. Callers tolerate missing optional files.
    }
  }
}

function ensureWorkspacePackageRuntimeDependencyTrees(snapshotNodeModulesDir: string, rootDir: string): void {
  for (const { packageJsonPath, scopePackageName } of collectWorkspacePackageInfos(rootDir)) {
    const sourceNodeModulesDir = resolve(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', scopePackageName, 'node_modules');
    const snapshotPackageNodeModulesDir = resolve(snapshotNodeModulesDir, '@happier-dev', scopePackageName, 'node_modules');
    if (existsSync(sourceNodeModulesDir)) {
      ensureCopiedDirectory(snapshotPackageNodeModulesDir, sourceNodeModulesDir);
    }
    ensureWorkspacePackageRuntimeDependencyFallbacks(snapshotPackageNodeModulesDir, rootDir, packageJsonPath);
  }
}

function ensureExternalPackageRuntimeDependencyTree(
  packageDir: string,
  rootDir: string,
  visited: Set<string>,
  options: CopyMissingEntryOptions & RuntimeDependencyCollectionOptions = {},
  dependencyPathNames: readonly string[] = [],
): void {
  // Symlinked entries (source-entrypoint overlay snapshots) resolve their dependencies at their
  // REAL location; vendoring "into the snapshot" through such an entry would write into the live
  // source tree instead (observed live 2026-06-12: workspace node_modules gained nested vendor
  // copies through overlay symlinks during the daemon launch-spec phase). The chain check also
  // refuses paths whose ANCESTOR (e.g. a symlinked @scope directory) is the overlay symlink —
  // the write chokepoints are guarded too, but skipping here avoids traversing live trees.
  if (isSymbolicLinkEntry(packageDir)) return;
  if (writesThroughSymlinkedNodeModulesPath(resolve(packageDir, 'node_modules', 'x'))) return;
  const packageJsonPath = resolve(packageDir, 'package.json');
  if (!existsSync(packageJsonPath) || visited.has(packageJsonPath)) return;
  visited.add(packageJsonPath);

  const rootNodeModulesDir = resolve(rootDir, 'node_modules');
  const cliNodeModulesDir = resolve(rootDir, 'apps', 'cli', 'node_modules');
  const packageName = readPackageNameFromPackageJson(packageJsonPath);
  const traversalPathNames = packageName ? [...dependencyPathNames, packageName] : dependencyPathNames;

  for (const dep of collectExternalRuntimeDepNamesFromPackageJson(packageJsonPath, options)) {
    // Dependency cycles (e.g. browserslist <-> update-browserslist-db peer deps) must terminate:
    // every name on the traversal path is physically present at an ancestor node_modules level of
    // this materializer's nesting, so node resolution already satisfies the dependency. Without
    // this guard the cycle materializes fresh nested copies (each with a new package.json path
    // that defeats the visited set) until the filesystem path-length limit.
    if (traversalPathNames.includes(dep.name)) continue;
    const destDepPath = resolve(packageDir, 'node_modules', ...dep.name.split('/'));
    const sourceCandidates = [
      resolve(cliNodeModulesDir, ...dep.name.split('/')),
      resolve(rootNodeModulesDir, ...dep.name.split('/')),
    ];

    if (!existsSync(destDepPath)) {
      ensureCopiedDirectoryFromCandidates(destDepPath, sourceCandidates, options);
    }

    if (isDirectoryEntry(destDepPath)) {
      ensureExternalPackageRuntimeDependencyTree(destDepPath, rootDir, visited, options, traversalPathNames);
    }
  }
}

function ensureExternalPackageRuntimeDependencyTrees(
  snapshotNodeModulesDir: string,
  rootDir: string,
  options: CopyMissingEntryOptions & RuntimeDependencyCollectionOptions = {},
): void {
  const visited = new Set<string>();

  for (const entry of listNodeModulesEntries(snapshotNodeModulesDir)) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === '@happier-dev') continue;

    const packagePath = resolve(snapshotNodeModulesDir, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scopedEntry of listScopedPackageEntries(packagePath)) {
        if (scopedEntry.name.startsWith('.')) continue;
        ensureExternalPackageRuntimeDependencyTree(resolve(packagePath, scopedEntry.name), rootDir, visited, options);
      }
      continue;
    }

    ensureExternalPackageRuntimeDependencyTree(packagePath, rootDir, visited, options);
  }
}

function ensurePackageRuntimeDependenciesFromPackageJson(params: {
  packageJsonPath: string;
  destNodeModulesDir: string;
  rootDir: string;
  visited: Set<string>;
  mergeExistingDirectoryContents?: boolean;
  traverseExistingDependencyTrees?: boolean;
  includeOptionalDependencies?: boolean;
  includePeerDependencies?: boolean;
  remainingTraversalDepth?: number;
  dependencyPathNames?: readonly string[];
}): void {
  const packageName = readPackageNameFromPackageJson(params.packageJsonPath);
  const mergeExistingDirectoryContents = params.mergeExistingDirectoryContents ?? true;
  const traverseExistingDependencyTrees = params.traverseExistingDependencyTrees ?? true;
  const includeOptionalDependencies = params.includeOptionalDependencies ?? true;
  const includePeerDependencies = params.includePeerDependencies ?? true;
  const remainingTraversalDepth = params.remainingTraversalDepth;
  if (params.visited.has(params.packageJsonPath)) {
    return;
  }
  params.visited.add(params.packageJsonPath);
  const dependencyPathNames = params.dependencyPathNames ?? [];
  const traversalPathNames = packageName ? [...dependencyPathNames, packageName] : dependencyPathNames;

  for (const dep of collectExternalRuntimeDepNamesFromPackageJson(params.packageJsonPath, {
    includeOptionalDependencies,
    includePeerDependencies,
  })) {
    // Cycle guard — see ensureExternalPackageRuntimeDependencyTree.
    if (traversalPathNames.includes(dep.name)) continue;
    const destDepPath = resolve(params.destNodeModulesDir, ...dep.name.split('/'));
    const existedBefore = existsSync(destDepPath);
    const packageLocalSourceCandidate = packageName
      ? resolve(params.rootDir, 'apps', 'cli', 'node_modules', ...packageName.split('/'), 'node_modules', ...dep.name.split('/'))
      : null;
    const sourceCandidates = (
      mergeExistingDirectoryContents
        ? [packageLocalSourceCandidate, resolve(params.rootDir, 'apps', 'cli', 'node_modules', ...dep.name.split('/')), resolve(params.rootDir, 'node_modules', ...dep.name.split('/'))]
        : [resolve(params.rootDir, 'apps', 'cli', 'node_modules', ...dep.name.split('/')), resolve(params.rootDir, 'node_modules', ...dep.name.split('/')), packageLocalSourceCandidate]
    ).filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);

    ensureCopiedDirectoryFromCandidates(destDepPath, sourceCandidates, {
      mergeExistingDirectoryContents,
      pruneNestedNodeModules: !mergeExistingDirectoryContents,
    });

    if (isDirectoryEntry(destDepPath)) {
      if (traverseExistingDependencyTrees) {
        ensureExternalPackageRuntimeDependencyTree(
          destDepPath,
          params.rootDir,
          params.visited,
          { mergeExistingDirectoryContents },
          traversalPathNames,
        );
        continue;
      }

      if (typeof remainingTraversalDepth === 'number' && remainingTraversalDepth <= 0) {
        continue;
      }

      const nestedNodeModulesDir = resolve(destDepPath, 'node_modules');
      if (existsSync(nestedNodeModulesDir)) {
        continue;
      }
      ensurePackageRuntimeDependenciesFromPackageJson({
        packageJsonPath: resolve(destDepPath, 'package.json'),
        destNodeModulesDir: nestedNodeModulesDir,
        rootDir: params.rootDir,
        visited: params.visited,
        mergeExistingDirectoryContents,
        traverseExistingDependencyTrees: false,
        includeOptionalDependencies,
        includePeerDependencies,
        remainingTraversalDepth:
          typeof remainingTraversalDepth === 'number' ? remainingTraversalDepth - 1 : remainingTraversalDepth,
        dependencyPathNames: traversalPathNames,
      });
    }
  }
}

export function ensureCliPackSnapshotRuntimeDependencies(params: {
  snapshotDir: string;
  rootDir: string;
  mergeExistingDirectories?: boolean;
  hydrationScope?: 'full' | 'bundled-workspaces-only';
}): void {
  const snapshotNodeModulesDir = resolve(params.snapshotDir, 'node_modules');
  mkdirSync(snapshotNodeModulesDir, { recursive: true });
  const mergeExistingDirectoryContents = params.mergeExistingDirectories ?? true;
  const hydrationScope = params.hydrationScope ?? 'full';
  const hydrateRootRuntimeGraph = hydrationScope === 'full';
  const fastModeTraversalDepth = mergeExistingDirectoryContents ? undefined : 1;

  const visited = new Set<string>();
  if (hydrateRootRuntimeGraph) {
    ensurePackageRuntimeDependenciesFromPackageJson({
      packageJsonPath: resolve(params.snapshotDir, 'package.json'),
      destNodeModulesDir: snapshotNodeModulesDir,
      rootDir: params.rootDir,
      visited,
      mergeExistingDirectoryContents,
      traverseExistingDependencyTrees: mergeExistingDirectoryContents,
      includeOptionalDependencies: mergeExistingDirectoryContents,
      includePeerDependencies: true,
      remainingTraversalDepth: fastModeTraversalDepth,
    });
  }

  const bundledScopeDir = resolve(snapshotNodeModulesDir, '@happier-dev');
  for (const entry of listScopedPackageEntries(bundledScopeDir)) {
    const packageDir = resolve(bundledScopeDir, entry.name);
    ensurePackageRuntimeDependenciesFromPackageJson({
      packageJsonPath: resolve(packageDir, 'package.json'),
      destNodeModulesDir: resolve(packageDir, 'node_modules'),
      rootDir: params.rootDir,
      visited,
      mergeExistingDirectoryContents,
      traverseExistingDependencyTrees: mergeExistingDirectoryContents,
      includeOptionalDependencies: mergeExistingDirectoryContents,
      includePeerDependencies: true,
      remainingTraversalDepth: fastModeTraversalDepth,
    });
  }

  if (mergeExistingDirectoryContents && hydrateRootRuntimeGraph) {
    ensureExternalPackageRuntimeDependencyTrees(snapshotNodeModulesDir, params.rootDir, { mergeExistingDirectoryContents });
  }
}

export function ensureCliDistSnapshotNodeModules(params: {
  snapshotDir: string;
  snapshotDistDir: string;
  rootDir: string;
  firstPartyClosureMode?: 'bundled-only' | 'workspace-overlay';
}): void {
  const cliNodeModulesDir = resolve(params.rootDir, 'apps', 'cli', 'node_modules');
  const rootNodeModulesDir = resolve(params.rootDir, 'node_modules');
  const snapshotNodeModulesDir = resolve(params.snapshotDir, 'node_modules');

  // Symlink-mode snapshots intentionally resolve the live CLI dependency tree directly. A later
  // copy-mode hydration must treat that alias as read-only instead of repairing through it.
  if (isSymbolicLinkEntry(snapshotNodeModulesDir)) return;

  if (existsSync(cliNodeModulesDir)) {
    mkdirSync(snapshotNodeModulesDir, { recursive: true });
    ensureCopiedDirectory(
      resolve(snapshotNodeModulesDir, '@happier-dev'),
      resolve(cliNodeModulesDir, '@happier-dev'),
    );
    if ((params.firstPartyClosureMode ?? 'workspace-overlay') === 'workspace-overlay') {
      ensureWorkspacePackageManifests(snapshotNodeModulesDir, params.rootDir);
      ensureWorkspacePackageDistTrees(snapshotNodeModulesDir, params.rootDir);
      ensureWorkspacePackageRuntimeDependencyTrees(snapshotNodeModulesDir, params.rootDir);
    }
    ensureCopiedNodeModulesEntries(cliNodeModulesDir, snapshotNodeModulesDir, new Set(['@happier-dev']));
    if (params.firstPartyClosureMode === 'bundled-only') {
      ensureCliPackSnapshotRuntimeDependencies({
        snapshotDir: params.snapshotDir,
        rootDir: params.rootDir,
        hydrationScope: 'bundled-workspaces-only',
      });
    }
    ensureExternalPackageRuntimeDependencyTrees(snapshotNodeModulesDir, params.rootDir);
  } else if (existsSync(rootNodeModulesDir)) {
    ensureSymlink(snapshotNodeModulesDir, rootNodeModulesDir);
  }

  if (existsSync(cliNodeModulesDir) && existsSync(rootNodeModulesDir) && cliNodeModulesDir !== rootNodeModulesDir) {
    ensureRootNodeModulesFallback(params.snapshotDistDir, params.rootDir);
  }
}

function isCopiedTreeSubset(sourcePath: string, destPath: string): boolean {
  let sourceStats;
  let destStats;
  try {
    sourceStats = statSync(sourcePath);
    destStats = statSync(destPath);
  } catch {
    return false;
  }

  if (sourceStats.isDirectory() !== destStats.isDirectory()) return false;
  if (!sourceStats.isDirectory()) return sourceStats.size === destStats.size;

  for (const entry of listNodeModulesEntries(sourcePath)) {
    if (entry.name.startsWith('.')) continue;
    if (!isCopiedTreeSubset(resolve(sourcePath, entry.name), resolve(destPath, entry.name))) {
      return false;
    }
  }
  return true;
}

export function hasCliDistSnapshotFirstPartyCopyClosure(params: {
  snapshotDir: string;
  rootDir: string;
}): boolean {
  const sourceScopeDir = resolve(params.rootDir, 'apps', 'cli', 'node_modules', '@happier-dev');
  const snapshotScopeDir = resolve(params.snapshotDir, 'node_modules', '@happier-dev');
  if (!isDirectoryEntry(sourceScopeDir) || !isDirectoryEntry(snapshotScopeDir)) return false;
  if (isSymbolicLinkEntry(snapshotScopeDir)) return false;

  for (const entry of listScopedPackageEntries(sourceScopeDir)) {
    const sourcePackageDir = resolve(sourceScopeDir, entry.name);
    const snapshotPackageDir = resolve(snapshotScopeDir, entry.name);
    if (isSymbolicLinkEntry(snapshotPackageDir)) return false;
    if (!isCopiedTreeSubset(sourcePackageDir, snapshotPackageDir)) return false;
  }
  return true;
}
