import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Resolves the symlink-free path of the nearest ancestor that exists.
 *
 * Authoring containment checks run against paths the toolchain is about to
 * create, so the target itself is usually absent. Walking up to the first
 * existing ancestor and canonicalizing THAT is what makes the subsequent
 * `isCanonicalAbsolutePathInsideRoot` comparison a physical one: a symlinked
 * parent cannot smuggle a write outside the project root. Any failure other
 * than `ENOENT` — a permission or loop error — propagates, because it means the
 * containment question could not be answered rather than that nothing is there.
 */
export async function realpathNearestExistingAncestor(targetPath: string): Promise<string> {
  let candidatePath = targetPath;
  while (true) {
    try {
      return await realpath(candidatePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
      const parentPath = dirname(candidatePath);
      if (parentPath === candidatePath) throw error;
      candidatePath = parentPath;
    }
  }
}
