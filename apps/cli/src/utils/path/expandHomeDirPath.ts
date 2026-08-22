import { isAbsolute, resolve } from 'node:path';
import {
  expandHomeDirPath,
  resolveHomeDirFromEnvironment,
} from '@happier-dev/cli-common/path';

export {
  canonicalAbsolutePathsEqual,
  expandHomeDirPath,
  isCanonicalAbsolutePathInsideRoot,
  resolveCanonicalAbsoluteChildPathComparisonIdentity,
  resolveCanonicalAbsolutePath,
  resolveCanonicalAbsolutePathComparisonIdentity,
  resolveHomeDirFromEnvironment,
} from '@happier-dev/cli-common/path';
export type { CanonicalAbsolutePath } from '@happier-dev/cli-common/path';

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
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}
