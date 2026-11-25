import { isAbsolute, join, relative, resolve } from 'node:path';
import { resolveConfiguredNativeHomePath, resolveHomeDirFromEnvironment } from '@happier-dev/plugin-sdk/fs';

import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';

/** Default-home auth declarations follow the Agent's final native-home selection. */
export function resolveNativeAgentCliAuthPaths(
  paths: readonly string[],
  nativeHome: Parameters<typeof resolveConfiguredNativeHomePath>[0] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
  if (paths.length === 0) return [];
  const configuredHome = nativeHome ? resolveConfiguredNativeHomePath(nativeHome, env) : null;
  const defaultHome = nativeHome ? resolve(resolveHomeDirFromEnvironment(env), nativeHome.defaultRelativePath) : null;
  return paths.map(path => {
    const expanded = resolve(expandHomeDirPath(path, env));
    if (!configuredHome || !defaultHome || configuredHome === defaultHome) return expanded;
    const inside = relative(defaultHome, expanded);
    return inside && !inside.startsWith('..') && !isAbsolute(inside) ? join(configuredHome, inside) : expanded;
  });
}
