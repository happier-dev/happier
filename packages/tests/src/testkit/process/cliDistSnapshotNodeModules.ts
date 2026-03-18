import { Dirent, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

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

function copyMissingEntry(destPath: string, sourcePath: string): void {
  if (isTransientSyncDirName(basename(sourcePath))) return;

  if (existsSync(destPath)) {
    if (!isDirectoryEntry(sourcePath) || !isDirectoryEntry(destPath)) return;

    for (const entry of listNodeModulesEntries(sourcePath)) {
      if (entry.name.startsWith('.')) continue;
      copyMissingEntry(resolve(destPath, entry.name), resolve(sourcePath, entry.name));
    }
    return;
  }

  mkdirSync(dirname(destPath), { recursive: true });
  if (isDirectoryEntry(sourcePath)) {
    mkdirSync(destPath, { recursive: true });
    for (const entry of listNodeModulesEntries(sourcePath)) {
      if (entry.name.startsWith('.')) continue;
      copyMissingEntry(resolve(destPath, entry.name), resolve(sourcePath, entry.name));
    }
    return;
  }

  try {
    cpSync(sourcePath, destPath, { recursive: true, dereference: false, preserveTimestamps: true });
  } catch {
    // Best-effort only. Callers must tolerate missing links in constrained environments.
  }
}

function ensureCopiedDirectory(destPath: string, sourcePath: string): void {
  copyMissingEntry(destPath, sourcePath);
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

function ensureCopiedTextFile(destPath: string, sourcePath: string): void {
  if (existsSync(destPath)) return;
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
  const packagesDir = resolve(rootDir, 'packages');
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const packageJsonPath = resolve(packagesDir, entry.name, 'package.json');
    let packageName = '';
    try {
      const raw = readFileSync(packageJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as { name?: unknown };
      packageName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    } catch {
      continue;
    }

    if (!packageName.startsWith('@happier-dev/')) continue;

    const scopePackageName = packageName.slice('@happier-dev/'.length).trim();
    if (!scopePackageName) continue;

    const snapshotPackageJsonPath = resolve(snapshotNodeModulesDir, '@happier-dev', scopePackageName, 'package.json');
    ensureCopiedTextFile(snapshotPackageJsonPath, packageJsonPath);
  }
}

function ensureWorkspacePackageDistTrees(snapshotNodeModulesDir: string, rootDir: string): void {
  const packagesDir = resolve(rootDir, 'packages');
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const packageJsonPath = resolve(packagesDir, entry.name, 'package.json');
    let packageName = '';
    try {
      const raw = readFileSync(packageJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as { name?: unknown };
      packageName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    } catch {
      continue;
    }

    if (!packageName.startsWith('@happier-dev/')) continue;

    const scopePackageName = packageName.slice('@happier-dev/'.length).trim();
    if (!scopePackageName) continue;

    const sourceDistDir = resolve(packagesDir, entry.name, 'dist');
    const snapshotPackageDir = resolve(snapshotNodeModulesDir, '@happier-dev', scopePackageName);
    const snapshotPackageDistDir = resolve(snapshotPackageDir, 'dist');
    if (!existsSync(sourceDistDir)) continue;

    mkdirSync(snapshotPackageDir, { recursive: true });
    try {
      cpSync(sourceDistDir, snapshotPackageDistDir, {
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
  const packagesDir = resolve(rootDir, 'packages');
  let entries: Dirent[] = [];
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    const packageJsonPath = resolve(packagesDir, entry.name, 'package.json');
    let packageName = '';
    try {
      const raw = readFileSync(packageJsonPath, 'utf8');
      const parsed = JSON.parse(raw) as { name?: unknown };
      packageName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
    } catch {
      continue;
    }

    if (!packageName.startsWith('@happier-dev/')) continue;

    const scopePackageName = packageName.slice('@happier-dev/'.length).trim();
    if (!scopePackageName) continue;

    const sourceNodeModulesDir = resolve(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', scopePackageName, 'node_modules');
    const snapshotPackageNodeModulesDir = resolve(snapshotNodeModulesDir, '@happier-dev', scopePackageName, 'node_modules');
    if (!existsSync(sourceNodeModulesDir)) continue;

    ensureCopiedDirectory(snapshotPackageNodeModulesDir, sourceNodeModulesDir);
  }
}

export function ensureCliDistSnapshotNodeModules(params: {
  snapshotDir: string;
  snapshotDistDir: string;
  rootDir: string;
}): void {
  const cliNodeModulesDir = resolve(params.rootDir, 'apps', 'cli', 'node_modules');
  const rootNodeModulesDir = resolve(params.rootDir, 'node_modules');
  const snapshotNodeModulesDir = resolve(params.snapshotDir, 'node_modules');

  if (existsSync(cliNodeModulesDir)) {
    mkdirSync(snapshotNodeModulesDir, { recursive: true });
    ensureCopiedDirectory(
      resolve(snapshotNodeModulesDir, '@happier-dev'),
      resolve(cliNodeModulesDir, '@happier-dev'),
    );
    ensureWorkspacePackageManifests(snapshotNodeModulesDir, params.rootDir);
    ensureWorkspacePackageDistTrees(snapshotNodeModulesDir, params.rootDir);
    ensureWorkspacePackageRuntimeDependencyTrees(snapshotNodeModulesDir, params.rootDir);
    ensureCopiedNodeModulesEntries(cliNodeModulesDir, snapshotNodeModulesDir, new Set(['@happier-dev']));
  } else if (existsSync(rootNodeModulesDir)) {
    ensureSymlink(snapshotNodeModulesDir, rootNodeModulesDir);
  }

  if (existsSync(cliNodeModulesDir) && existsSync(rootNodeModulesDir) && cliNodeModulesDir !== rootNodeModulesDir) {
    ensureRootNodeModulesFallback(params.snapshotDistDir, params.rootDir);
  }
}
