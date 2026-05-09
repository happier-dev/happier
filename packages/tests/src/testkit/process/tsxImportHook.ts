import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function resolveTsxImportHookPath(): string | null {
  try {
    const req = createRequire(import.meta.url);
    const pkgJsonPath = req.resolve('tsx/package.json');
    const pkgDir = dirname(pkgJsonPath);
    const hookPath = join(pkgDir, 'dist', 'esm', 'index.mjs');
    return existsSync(hookPath) ? hookPath : null;
  } catch {
    return null;
  }
}

export function toNodeImportSpecifier(importPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return pathToFileURL(importPath).href;
  }
  return importPath;
}

export function resolveTsxImportHookSpecifier(platform: NodeJS.Platform = process.platform): string | null {
  const importPath = resolveTsxImportHookPath();
  if (!importPath) {
    return null;
  }
  return toNodeImportSpecifier(importPath, platform);
}
