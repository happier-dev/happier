import { isAbsolute, resolve } from 'node:path';
import { createWorktree, resolveComponentSpecToDir } from '../utils/git/worktrees.mjs';
import { coerceHappyMonorepoRootFromPath, getRepoDir, getWorkspaceDir } from '../utils/paths/paths.mjs';

export async function resolveRequestedRepoCheckoutDir({ rootDir, repoSelection, remoteName, defaultRepoDir = '' }) {
  if (!repoSelection) return '';

  let resolved = '';
  if (typeof repoSelection === 'object' && repoSelection.create) {
    const uiPkgDir = await createWorktree({
      rootDir,
      component: 'happier-ui',
      slug: repoSelection.slug,
      remoteName,
    });
    resolved = uiPkgDir ? coerceHappyMonorepoRootFromPath(uiPkgDir) || uiPkgDir : '';
  } else {
    const spec = String(repoSelection ?? '').trim();
    if (spec === 'default' || spec === 'main') {
      resolved = defaultRepoDir || getRepoDir(rootDir, { ...process.env, HAPPIER_STACK_REPO_DIR: '' });
    } else if (spec === 'active') {
      resolved = getRepoDir(rootDir, process.env);
    } else {
      const dir = resolveComponentSpecToDir({ rootDir, component: 'happier-ui', spec });
      const abs = dir ? resolve(rootDir, dir) : isAbsolute(spec) ? spec : resolve(getWorkspaceDir(rootDir), spec);
      resolved = coerceHappyMonorepoRootFromPath(abs) || abs;
    }
  }

  return resolved;
}
