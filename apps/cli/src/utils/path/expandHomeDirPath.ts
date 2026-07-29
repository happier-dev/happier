import { posix, win32 } from 'node:path';
import {
  expandHomeDirPath,
  resolveHomeDirFromEnvironment,
} from '@happier-dev/cli-common/agents';

export {
  expandHomeDirPath,
  resolveHomeDirFromEnvironment,
} from '@happier-dev/cli-common/agents';

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

export type CanonicalAbsolutePath = Readonly<{
  path: string;
  comparisonKey: string;
}>;

/**
 * Resolves persisted or environment-provided CLI input to the native absolute
 * path that filesystem and child-process consumers must use. The comparison
 * identity is derived from that execution value and is case-folded only on
 * Windows, where path identity is case-insensitive.
 */
export function resolveCanonicalAbsolutePath(
  value: string,
  options: Readonly<{
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  }> = {},
): CanonicalAbsolutePath | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const expanded = expandHomeDirPath(value.trim(), env, platform);
  const nativeSeparators = platform === 'win32'
    ? expanded.replaceAll('/', '\\')
    : expanded.replaceAll('\\', '/');
  const normalizedPath = api.normalize(nativeSeparators);
  if (!api.isAbsolute(normalizedPath)) return null;
  const root = api.parse(normalizedPath).root;
  const path = normalizedPath.length > root.length
    ? normalizedPath.replace(/[\\/]+$/, '')
    : normalizedPath;
  return {
    path,
    comparisonKey: platform === 'win32' ? path.toLowerCase() : path,
  };
}

function inferAbsolutePathPlatform(value: string): NodeJS.Platform | null {
  // Recognize Windows drive and UNC syntax before POSIX. A forward-slash UNC
  // path is also POSIX-absolute, but it must retain Windows case/separator
  // semantics when compared with the equivalent backslash spelling.
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/u.test(value)) {
    return 'win32';
  }
  if (posix.isAbsolute(value)) return 'linux';
  if (win32.isAbsolute(value)) return 'win32';
  return null;
}

export function canonicalAbsolutePathsEqual(left: string, right: string): boolean {
  const leftPlatform = inferAbsolutePathPlatform(left);
  const rightPlatform = inferAbsolutePathPlatform(right);
  if (!leftPlatform || leftPlatform !== rightPlatform) return false;

  const leftCanonical = resolveCanonicalAbsolutePath(left, { platform: leftPlatform });
  const rightCanonical = resolveCanonicalAbsolutePath(right, { platform: rightPlatform });
  return leftCanonical !== null
    && rightCanonical !== null
    && leftCanonical.comparisonKey === rightCanonical.comparisonKey;
}
