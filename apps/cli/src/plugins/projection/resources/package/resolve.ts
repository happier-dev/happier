import { realpath } from 'node:fs/promises';
import { normalize, relative, resolve } from 'node:path';

import { isCanonicalAbsolutePathInsideRoot } from '@/utils/path/expandHomeDirPath';

export type ResolvedPluginResourcePath = Readonly<{
  absolutePath: string;
  relativePath: string;
}>;

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/');
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
  if (
    absolutePath === normalizedRoot
    || !isCanonicalAbsolutePathInsideRoot(normalizedRoot, absolutePath)
  ) {
    return null;
  }
  const relativePath = normalizeRelativePath(normalize(relative(normalizedRoot, absolutePath)));

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
  if (
    !pluginRootRealPath
    || !resourceRealPath
    || !isCanonicalAbsolutePathInsideRoot(pluginRootRealPath, resourceRealPath)
  ) {
    return null;
  }

  return {
    absolutePath: resourceRealPath,
    relativePath: resolvedPath.relativePath,
  };
}
