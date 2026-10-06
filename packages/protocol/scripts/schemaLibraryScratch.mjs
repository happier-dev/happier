import { mkdtempSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

/** Experiment copies/dependencies must never enter a watched checkout. */
export function requireExternalScratch(repo, value) {
  if (!value || !isAbsolute(value)) throw new Error('An explicit absolute scratch directory outside the checkout is required');
  const scratch = realpathSync(value);
  const inside = relative(realpathSync(repo), scratch);
  if (!inside || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))) {
    throw new Error('Scratch directories must be outside the checkout (including through symlinks)');
  }
  return scratch;
}

export function createExternalScratch(repo, prefix) {
  // Validate TMPDIR before creating anything, including custom environment paths.
  const parent = requireExternalScratch(repo, tmpdir());
  return mkdtempSync(resolve(parent, prefix));
}
