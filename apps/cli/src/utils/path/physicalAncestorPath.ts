import { realpath } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

type PhysicalAncestor = Readonly<{
  /** Symlink-free path of the deepest ancestor that currently exists. */
  physicalAncestor: string;
  /** The still-absent remainder, including its original separators. */
  absentSuffix: string;
}>;

/**
 * Walks up from `targetPath` to the deepest existing ancestor and canonicalizes
 * THAT. Any failure other than `ENOENT` — a permission, loop or `ENOTDIR` error
 * — propagates, because it means the physical identity of the path could not be
 * answered rather than that nothing is there. Returns `null` only when no
 * ancestor exists at all, which happens for a spelling this platform cannot
 * resolve (a Windows drive path observed on POSIX, for example).
 */
function isAncestorSpelling(targetPath: string, parentPath: string): boolean {
  if (!targetPath.startsWith(parentPath)) return false;
  const suffix = targetPath.slice(parentPath.length);
  return suffix === ''
    || parentPath.endsWith('/') || parentPath.endsWith('\\')
    || suffix.startsWith('/') || suffix.startsWith('\\');
}

export async function findPhysicalAncestor(targetPath: string): Promise<PhysicalAncestor | null> {
  let candidatePath = targetPath;
  while (true) {
    try {
      return {
        physicalAncestor: await realpath(candidatePath),
        absentSuffix: targetPath.slice(candidatePath.length),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
      const parentPath = dirname(candidatePath);
      // `dirname` answers in this platform's grammar. A foreign spelling — a
      // Windows drive path observed on POSIX — collapses to `.`, which is not
      // an ancestor of the requested path and must not resolve to the process
      // working directory.
      if (parentPath === candidatePath || !isAncestorSpelling(targetPath, parentPath)) return null;
      candidatePath = parentPath;
    }
  }
}

/**
 * Resolves the symlink-free path of the nearest ancestor that exists.
 *
 * Authoring containment checks run against paths the toolchain is about to
 * create, so the target itself is usually absent. Canonicalizing the first
 * existing ancestor is what makes the subsequent
 * `isCanonicalAbsolutePathInsideRoot` comparison a physical one: a symlinked
 * parent cannot smuggle a write outside the project root.
 */
export async function realpathNearestExistingAncestor(targetPath: string): Promise<string> {
  const found = await findPhysicalAncestor(targetPath);
  if (!found) {
    throw Object.assign(new Error(`ENOENT: no existing ancestor for ${targetPath}`), { code: 'ENOENT' });
  }
  return found.physicalAncestor;
}

/**
 * Physicalizes the deepest existing ancestor and reattaches the absent
 * remainder, so a path whose leaf does not exist yet still compares against the
 * same physical identity as its existing parent. Without this, `/var/x` (which
 * exists and realpaths to `/private/var/x` on macOS) and its missing child
 * `/var/x/child` produce unrelated spellings that string containment cannot
 * relate. A path with no resolvable ancestor is returned unchanged: there is no
 * physical alias to collapse.
 */
export async function realpathWithAbsentSuffix(targetPath: string): Promise<string> {
  const found = await findPhysicalAncestor(targetPath);
  return found ? `${found.physicalAncestor}${found.absentSuffix}` : targetPath;
}

/** Resolve the entire parent chain; removing a symlink/junction leaf removes that leaf, not its target. */
export async function physicalPathWithoutFollowingLeaf(targetPath: string): Promise<string> {
  const parent = dirname(targetPath);
  if (parent === targetPath) return await realpathWithAbsentSuffix(targetPath);
  return join(await realpathWithAbsentSuffix(parent), basename(targetPath));
}
