import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve as resolvePath } from 'node:path';

import { repoRootDir } from '../paths';

function shouldIgnoreUiWebSourceDir(name: string): boolean {
  return name === '__tests__'
    || name === '__mocks__'
    || name === 'dist'
    || name === 'node_modules'
    || name === '.git'
    || name === '.project';
}

function shouldIgnoreUiWebWorkspaceDir(name: string): boolean {
  return name === '__tests__'
    || name === '__mocks__'
    || name === 'node_modules'
    || name === '.git'
    || name === '.project';
}

function shouldIgnoreUiWebSourceFile(name: string): boolean {
  return /\.(test|spec|stories)\.[cm]?[jt]sx?$/u.test(name);
}

function updateUiWebSourceHashForPath(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  filePath: string,
): void {
  const stats = statSync(filePath);
  if (!stats.isFile()) return;
  hash.update(relative(rootDir, filePath));
  hash.update('\0');
  hash.update(String(stats.size));
  hash.update('\0');
  hash.update(readFileSync(filePath));
  hash.update('\n');
}

function walkUiWebSourceTree(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  currentPath: string,
  options?: Readonly<{ ignoreDir?: (name: string) => boolean }>,
): void {
  const stats = statSync(currentPath);
  if (stats.isFile()) {
    updateUiWebSourceHashForPath(hash, rootDir, currentPath);
    return;
  }
  if (!stats.isDirectory()) return;

  const entries = readdirSync(currentPath, { withFileTypes: true })
    .filter((entry) => entry?.name)
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (options?.ignoreDir?.(entry.name) ?? shouldIgnoreUiWebSourceDir(entry.name)) continue;
      walkUiWebSourceTree(hash, rootDir, resolvePath(currentPath, entry.name), options);
      continue;
    }
    if (!entry.isFile()) continue;
    if (shouldIgnoreUiWebSourceFile(entry.name)) continue;
    updateUiWebSourceHashForPath(hash, rootDir, resolvePath(currentPath, entry.name));
  }
}

function readInternalWorkspaceNamesFromPackageJson(packageJsonPath: string): string[] {
  if (!existsSync(packageJsonPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const internalWorkspaceNames = new Set<string>();
    for (const source of [parsed.dependencies, parsed.optionalDependencies, parsed.devDependencies]) {
      if (!source || typeof source !== 'object') continue;
      for (const name of Object.keys(source)) {
        if (name.startsWith('@happier-dev/')) {
          internalWorkspaceNames.add(name);
        }
      }
    }
    return [...internalWorkspaceNames].sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function resolveInternalWorkspacePackageDir(monorepoRoot: string, workspaceName: string): string | null {
  const packageId = workspaceName.split('/')[1] ?? '';
  if (!packageId) return null;
  const packageDir = resolvePath(monorepoRoot, 'packages', packageId);
  return existsSync(packageDir) ? packageDir : null;
}

function readInternalUiWorkspacePackageDirs(uiDir: string): string[] {
  const uiPackageJsonPath = resolvePath(uiDir, 'package.json');
  if (!existsSync(uiPackageJsonPath)) return [];

  const monorepoRoot = resolvePath(uiDir, '..', '..');
  const discoveredPackageDirs = new Set<string>();
  const visitedWorkspaceNames = new Set<string>();
  const pendingWorkspaceNames = readInternalWorkspaceNamesFromPackageJson(uiPackageJsonPath);

  while (pendingWorkspaceNames.length > 0) {
    const workspaceName = pendingWorkspaceNames.shift();
    if (!workspaceName || visitedWorkspaceNames.has(workspaceName)) {
      continue;
    }
    visitedWorkspaceNames.add(workspaceName);

    const packageDir = resolveInternalWorkspacePackageDir(monorepoRoot, workspaceName);
    if (!packageDir) {
      continue;
    }
    discoveredPackageDirs.add(packageDir);

    const transitiveWorkspaceNames = readInternalWorkspaceNamesFromPackageJson(resolvePath(packageDir, 'package.json'));
    for (const transitiveWorkspaceName of transitiveWorkspaceNames) {
      if (!visitedWorkspaceNames.has(transitiveWorkspaceName)) {
        pendingWorkspaceNames.push(transitiveWorkspaceName);
      }
    }
  }

  return [...discoveredPackageDirs].sort((left, right) => left.localeCompare(right));
}

function resolveUiWebConfigRoots(uiDir: string): string[] {
  return [
    resolvePath(uiDir, 'index.ts'),
    resolvePath(uiDir, 'metro.config.js'),
    resolvePath(uiDir, 'babel.config.js'),
    resolvePath(uiDir, 'app.config.js'),
    resolvePath(uiDir, 'appVariantConfig.cjs'),
    resolvePath(uiDir, 'package.json'),
    resolvePath(uiDir, 'tsconfig.json'),
    resolvePath(uiDir, 'tsconfig.activity-surfaces-rollout.json'),
    resolvePath(uiDir, 'sources'),
  ];
}

export function resolveUiWebSourceFingerprint(): string {
  const hash = createHash('sha256');
  const uiDir = resolvePath(repoRootDir(), 'apps', 'ui');
  const roots = [
    ...resolveUiWebConfigRoots(uiDir),
    ...readInternalUiWorkspacePackageDirs(uiDir),
  ];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const rootRoot = root.startsWith(resolvePath(uiDir, '..', '..', 'packages'))
      ? root
      : uiDir;
    walkUiWebSourceTree(
      hash,
      rootRoot,
      root,
      root.startsWith(resolvePath(uiDir, '..', '..', 'packages'))
        ? { ignoreDir: shouldIgnoreUiWebWorkspaceDir }
        : undefined,
    );
  }

  return hash.digest('hex');
}
