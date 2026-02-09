import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { coerceHappyMonorepoRootFromPath, getRepoDir, getWorkspaceDir } from '../utils/paths/paths.mjs';
import { resolveComponentSpecToDir } from '../utils/git/worktrees.mjs';

export function resolveTransientRepoOverrides({ rootDir, kv }) {
  const raw = (kv.get('--repo') ?? kv.get('--repo-dir') ?? '').toString().trim();
  if (!raw) return {};

  let resolved = '';
  if (raw === 'default' || raw === 'main') {
    resolved = getRepoDir(rootDir, { ...process.env, HAPPIER_STACK_REPO_DIR: '' });
  } else if (raw === 'active') {
    resolved = getRepoDir(rootDir, process.env);
  } else {
    const dir = resolveComponentSpecToDir({ rootDir, component: 'happier-ui', spec: raw });
    const abs = dir ? resolve(rootDir, dir) : isAbsolute(raw) ? raw : resolve(getWorkspaceDir(rootDir), raw);
    resolved = coerceHappyMonorepoRootFromPath(abs) || abs;
  }

  if (!resolved || !existsSync(resolved)) {
    throw new Error(`[stack] --repo points to a missing checkout: ${resolved || '(empty)'}`);
  }
  const monoRoot = coerceHappyMonorepoRootFromPath(resolved);
  if (!monoRoot) {
    throw new Error(`[stack] --repo is not a Happier monorepo root: ${resolved}`);
  }
  return { HAPPIER_STACK_REPO_DIR: monoRoot };
}
