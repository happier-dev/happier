import {
  absolutePathFromWorkingDirectory,
  createCanonicalAbsolutePathComparator,
  expandHomeDirPath as expandHomeDirPathFromEnvironment,
  isCanonicalAbsolutePathInsideRoot as isCanonicalAbsolutePathInsideRootFromEnvironment,
  resolveCanonicalAbsoluteChildPathComparisonIdentity as resolveCanonicalAbsoluteChildPathComparisonIdentityFromEnvironment,
  resolveCanonicalAbsolutePath as resolveCanonicalAbsolutePathFromEnvironment,
  resolveCanonicalAbsolutePathComparisonIdentity as resolveCanonicalAbsolutePathComparisonIdentityFromEnvironment,
  resolveHomeDirFromEnvironment as resolveHomeDir,
} from '@happier-dev/cli-common/path';
import { sessionProcessEnvironment, sessionWorkingDirectory } from '@/agent/runtime/lifecycle/hostedSessionScope';

export { isHomeDirPath } from '@happier-dev/cli-common/path';
export type { CanonicalAbsolutePath } from '@happier-dev/cli-common/path';

export function expandHomeDirPath(
  value: string,
  env: Readonly<Record<string, string | undefined>> = sessionProcessEnvironment(),
  platform: NodeJS.Platform = process.platform,
): string {
  return expandHomeDirPathFromEnvironment(value, env, platform);
}

export function resolveHomeDirFromEnvironment(
  env: Readonly<Record<string, string | undefined>> = sessionProcessEnvironment(),
  platform: NodeJS.Platform = process.platform,
): string {
  return resolveHomeDir(env, platform);
}

export function resolveCanonicalAbsolutePath(
  value: string,
  options: Parameters<typeof resolveCanonicalAbsolutePathFromEnvironment>[1] = {},
): ReturnType<typeof resolveCanonicalAbsolutePathFromEnvironment> {
  return resolveCanonicalAbsolutePathFromEnvironment(value, { ...options, env: options.env ?? sessionProcessEnvironment() });
}

export function resolveCanonicalAbsolutePathComparisonIdentity(
  value: string,
  options: Parameters<typeof resolveCanonicalAbsolutePathComparisonIdentityFromEnvironment>[1] = {},
): string | null {
  return resolveCanonicalAbsolutePathComparisonIdentityFromEnvironment(value, { ...options, env: options.env ?? sessionProcessEnvironment() });
}

export function resolveCanonicalAbsoluteChildPathComparisonIdentity(
  parentPath: string,
  relativeChildPath: string,
  options: Parameters<typeof resolveCanonicalAbsoluteChildPathComparisonIdentityFromEnvironment>[2] = {},
): string | null {
  return resolveCanonicalAbsoluteChildPathComparisonIdentityFromEnvironment(parentPath, relativeChildPath, { ...options, env: options.env ?? sessionProcessEnvironment() });
}

export function canonicalAbsolutePathsEqual(left: string, right: string): boolean {
  return createCanonicalAbsolutePathComparator({ env: sessionProcessEnvironment() }).equal(left, right);
}

export function isCanonicalAbsolutePathInsideRoot(
  rootPath: string,
  candidatePath: string,
  options: Parameters<typeof isCanonicalAbsolutePathInsideRootFromEnvironment>[2] = {},
): boolean {
  return isCanonicalAbsolutePathInsideRootFromEnvironment(rootPath, candidatePath, { ...options, env: options.env ?? sessionProcessEnvironment() });
}

/**
 * Resolves a locator the user typed on the command line to the absolute path
 * that identifies it everywhere else — including inside the daemon, whose
 * working directory is never the one the command was typed in.
 *
 * A relative locator is anchored to the caller's working directory. An
 * already-absolute locator keeps its exact spelling, so the identity a caller
 * persists or sends over the wire is the one the user typed. A blank locator
 * resolves to `null` rather than silently becoming the working directory
 * itself, leaving the caller's own validation to reject it.
 */
export function resolveAbsolutePathFromWorkingDirectory(value: string): string | null {
  const expanded = expandHomeDirPath(String(value ?? '').trim());
  if (!expanded) return null;
  return absolutePathFromWorkingDirectory(expanded, sessionWorkingDirectory());
}
