import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
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
  hash.update(String(Math.floor(stats.mtimeMs)));
  hash.update('\n');
}

function walkUiWebSourceTree(
  hash: ReturnType<typeof createHash>,
  rootDir: string,
  currentPath: string,
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
      if (shouldIgnoreUiWebSourceDir(entry.name)) continue;
      walkUiWebSourceTree(hash, rootDir, resolvePath(currentPath, entry.name));
      continue;
    }
    if (!entry.isFile()) continue;
    if (shouldIgnoreUiWebSourceFile(entry.name)) continue;
    updateUiWebSourceHashForPath(hash, rootDir, resolvePath(currentPath, entry.name));
  }
}

let cachedUiWebSourceFingerprint: string | null = null;

export function resolveUiWebSourceFingerprint(): string {
  if (cachedUiWebSourceFingerprint) return cachedUiWebSourceFingerprint;

  const hash = createHash('sha256');
  const uiDir = resolvePath(repoRootDir(), 'apps', 'ui');
  const roots = [
    resolvePath(uiDir, 'index.ts'),
    resolvePath(uiDir, 'metro.config.js'),
    resolvePath(uiDir, 'sources'),
  ];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    walkUiWebSourceTree(hash, uiDir, root);
  }

  cachedUiWebSourceFingerprint = hash.digest('hex');
  return cachedUiWebSourceFingerprint;
}
