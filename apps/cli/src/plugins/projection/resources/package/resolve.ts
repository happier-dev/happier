import { realpath } from 'node:fs/promises';
import { normalize, relative, resolve, sep } from 'node:path';

export type ResolvedPluginResourcePath = Readonly<{
  absolutePath: string;
  relativePath: string;
}>;

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function isInside(parent: string, child: string): boolean {
  const normalizedParent = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child === parent || child.startsWith(normalizedParent);
}

export function resolvePluginResourcePath(params: Readonly<{
  pluginRootPath: string;
  resourcePath: string;
}>): ResolvedPluginResourcePath | null {
  const pluginRootPath = params.pluginRootPath.trim();
  const resourcePath = params.resourcePath.trim();
  if (!pluginRootPath || !resourcePath || resourcePath.includes('\0')) {
    return null;
  }

  const normalizedRoot = resolve(pluginRootPath);
  const absolutePath = resolve(normalizedRoot, resourcePath);
  const relativePath = normalizeRelativePath(normalize(relative(normalizedRoot, absolutePath)));
  if (
    relativePath.length === 0
    || relativePath === '.'
    || relativePath === '..'
    || relativePath.startsWith('../')
  ) {
    return null;
  }

  return {
    absolutePath,
    relativePath,
  };
}

export async function resolveContainedPluginResourcePath(params: Readonly<{
  pluginRootPath: string;
  resourcePath: string;
}>): Promise<ResolvedPluginResourcePath | null> {
  const resolvedPath = resolvePluginResourcePath(params);
  if (!resolvedPath) {
    return null;
  }

  const pluginRootPath = params.pluginRootPath.trim();
  const normalizedRoot = resolve(pluginRootPath);
  const [pluginRootRealPath, resourceRealPath] = await Promise.all([
    realpath(normalizedRoot).catch(() => null),
    realpath(resolvedPath.absolutePath).catch(() => null),
  ]);
  if (!pluginRootRealPath || !resourceRealPath || !isInside(pluginRootRealPath, resourceRealPath)) {
    return null;
  }

  return {
    absolutePath: resourceRealPath,
    relativePath: resolvedPath.relativePath,
  };
}
