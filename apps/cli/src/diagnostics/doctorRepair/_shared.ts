import { compareVersions } from '@happier-dev/cli-common/update';

/**
 * Strict "is a an older version than b" semver check.
 * Returns false on equal, newer, or un-parseable inputs.
 */
export function semverLessThan(a: string | null | undefined, b: string | null | undefined): boolean {
  const aa = String(a ?? '').trim();
  const bb = String(b ?? '').trim();
  if (!aa || !bb) return false;
  try {
    return compareVersions(aa, bb) < 0;
  } catch {
    return false;
  }
}
