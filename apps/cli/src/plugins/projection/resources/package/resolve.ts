import { normalize, relative, resolve } from 'node:path';

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
