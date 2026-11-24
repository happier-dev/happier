import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRootDir } from '../paths';

function workspaceSourceRuntimeImportSpecifier(rootDir: string): string {
  return pathToFileURL(resolve(rootDir, 'packages/cli-common/registerSourceRuntime.mjs')).href;
}

export function withWorkspaceSourceRuntime(
  env: NodeJS.ProcessEnv,
  rootDir = repoRootDir(),
): NodeJS.ProcessEnv & { NODE_OPTIONS: string } {
  return {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, '--import', workspaceSourceRuntimeImportSpecifier(rootDir)]
      .filter(Boolean).join(' '),
  };
}

export function withoutWorkspaceSourceRuntime(
  env: NodeJS.ProcessEnv,
  rootDir = repoRootDir(),
): NodeJS.ProcessEnv {
  if (!env.NODE_OPTIONS) return env;
  const specifier = workspaceSourceRuntimeImportSpecifier(rootDir);
  const nodeOptions = env.NODE_OPTIONS.replace(
    /(^|\s)--import(?:=|\s+)(?:"([^"]*)"|([^\s"]+))(?=\s|$)/g,
    (option, prefix, quoted, bare) => (quoted ?? bare) === specifier ? prefix : option,
  );
  return { ...env, NODE_OPTIONS: nodeOptions.trim() };
}

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
