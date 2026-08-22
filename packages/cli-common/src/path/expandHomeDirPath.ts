import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

function pathApi(platform: NodeJS.Platform) {
  return platform === 'win32' ? win32 : posix;
}

export function resolveHomeDirFromEnvironment(
  processEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const envHome =
    platform === 'win32'
      ? (processEnv.USERPROFILE || processEnv.HOME)
      : processEnv.HOME;
  const trimmed = typeof envHome === 'string' ? envHome.trim() : '';
  return trimmed.length > 0 ? trimmed : homedir();
}

export function expandHomeDirPath(
  value: string,
  processEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const api = pathApi(platform);
  if (value === '~') return resolveHomeDirFromEnvironment(processEnv, platform);
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    const relativePathSegments = value
      .slice(2)
      .split(/[\\/]+/)
      .filter(Boolean);
    return api.join(resolveHomeDirFromEnvironment(processEnv, platform), ...relativePathSegments);
  }
  return value;
}

export type CanonicalAbsolutePath = Readonly<{
  path: string;
  comparisonKey: string;
}>;

/**
 * Resolves persisted or environment-provided input to a native absolute path
 * and a platform-correct comparison key. This is lexical normalization only;
 * callers that require physical identity must resolve symlinks first.
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
    ? normalizedPath.replace(/[\\/]+$/u, '')
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

function resolveAbsolutePathPlatform(
  value: string,
  platform?: NodeJS.Platform,
): NodeJS.Platform | null {
  return platform
    ?? inferAbsolutePathPlatform(value)
    ?? (/^~(?:[\\/]|$)/u.test(value.trim()) ? process.platform : null);
}

function comparisonIdentity(
  canonical: CanonicalAbsolutePath,
  platform: NodeJS.Platform,
): string {
  return JSON.stringify([
    platform === 'win32' ? 'win32' : 'posix',
    canonical.comparisonKey,
  ]);
}

export function resolveCanonicalAbsolutePathComparisonIdentity(
  value: string,
  options: Readonly<{
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  }> = {},
): string | null {
  const platform = resolveAbsolutePathPlatform(value, options.platform);
  if (!platform) return null;

  const canonical = resolveCanonicalAbsolutePath(value, {
    env: options.env,
    platform,
  });
  return canonical === null
    ? null
    : comparisonIdentity(canonical, platform);
}

/**
 * Resolves the parent before joining its already-validated relative child so
 * a POSIX root cannot be reinterpreted as a Windows UNC path.
 */
export function resolveCanonicalAbsoluteChildPathComparisonIdentity(
  parentPath: string,
  relativeChildPath: string,
  options: Readonly<{
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  }> = {},
): string | null {
  const platform = resolveAbsolutePathPlatform(parentPath, options.platform);
  if (!platform || relativeChildPath.includes('\0')) return null;

  const parent = resolveCanonicalAbsolutePath(parentPath, {
    env: options.env,
    platform,
  });
  if (parent === null) return null;

  const api = pathApi(platform);
  const nativeChildPath = platform === 'win32'
    ? relativeChildPath.replaceAll('/', '\\')
    : relativeChildPath.replaceAll('\\', '/');
  const normalizedChildPath = api.normalize(nativeChildPath);
  if (
    normalizedChildPath === '.'
    || api.parse(normalizedChildPath).root.length > 0
    || normalizedChildPath === '..'
    || normalizedChildPath.startsWith(`..${api.sep}`)
  ) {
    return null;
  }

  const child = resolveCanonicalAbsolutePath(
    api.join(parent.path, normalizedChildPath),
    { env: options.env, platform },
  );
  return child === null ? null : comparisonIdentity(child, platform);
}

export function canonicalAbsolutePathsEqual(left: string, right: string): boolean {
  const leftIdentity = resolveCanonicalAbsolutePathComparisonIdentity(left);
  return leftIdentity !== null
    && leftIdentity === resolveCanonicalAbsolutePathComparisonIdentity(right);
}

/**
 * Checks lexical containment after normalizing absolute path syntax for its
 * native platform. Callers that require physical containment must resolve
 * symlinks before invoking this helper.
 */
export function isCanonicalAbsolutePathInsideRoot(
  rootPath: string,
  candidatePath: string,
  options: Readonly<{
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
  }> = {},
): boolean {
  const rootPlatform = resolveAbsolutePathPlatform(rootPath, options.platform);
  const candidatePlatform = resolveAbsolutePathPlatform(candidatePath, options.platform);
  if (!rootPlatform || rootPlatform !== candidatePlatform) return false;

  const root = resolveCanonicalAbsolutePath(rootPath, {
    env: options.env,
    platform: rootPlatform,
  });
  const candidate = resolveCanonicalAbsolutePath(candidatePath, {
    env: options.env,
    platform: rootPlatform,
  });
  if (!root || !candidate) return false;

  const api = pathApi(rootPlatform);
  const relativePath = api.relative(root.path, candidate.path);
  return relativePath === ''
    || (relativePath !== '..'
      && !relativePath.startsWith(`..${api.sep}`)
      && !api.isAbsolute(relativePath));
}
