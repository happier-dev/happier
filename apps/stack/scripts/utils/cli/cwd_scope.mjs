import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { WORKTREE_CATEGORIES, getWorktreeCategoryRoot } from '../git/worktrees.mjs';
import { getDevRepoDir, getRepoDir, getWorkspaceDir, happyMonorepoSubdirForComponent, isHappyMonorepoRoot } from '../paths/paths.mjs';

export function getInvokedCwd(env = process.env) {
  return String(env.HAPPIER_STACK_INVOKED_CWD ?? env.PWD ?? '').trim();
}

function hasGitMarker(dir) {
  try {
    // In a worktree, `.git` is typically a file; in the primary checkout it may be a directory.
    return existsSync(join(dir, '.git'));
  } catch {
    return false;
  }
}

function isPathInside(path, parentDir) {
  const p = resolve(path);
  const d = resolve(parentDir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

function findGitRoot(startDir, stopAtDir) {
  let cur = resolve(startDir);
  const stop = stopAtDir ? resolve(stopAtDir) : '';

  while (true) {
    if (hasGitMarker(cur)) {
      return cur;
    }
    if (stop && cur === stop) {
      return null;
    }
    const parent = dirname(cur);
    if (parent === cur) {
      return null;
    }
    if (stop && !isPathInside(parent, stop)) {
      return null;
    }
    cur = parent;
  }
}

function resolveHappyMonorepoComponentFromPath({ monorepoRoot, absPath }) {
  const root = resolve(monorepoRoot);
  const abs = resolve(absPath);
  const components = ['happy', 'happy-cli', 'happy-server'];
  for (const component of components) {
    const subdir = happyMonorepoSubdirForComponent(component, { monorepoRoot: root });
    if (!subdir) continue;
    const dir = join(root, subdir);
    if (isPathInside(abs, dir)) {
      // We return the shared git root so callers can safely use it as an env override
      // for any of the monorepo components.
      return { component, repoDir: root };
    }
  }
  return null;
}

export function inferComponentFromCwd({ rootDir, invokedCwd, components }) {
  const cwd = String(invokedCwd ?? '').trim();
  const list = Array.isArray(components) ? components : [];
  if (!rootDir || !cwd || !list.length) {
    return null;
  }

  const abs = resolve(cwd);
  const workspaceDir = getWorkspaceDir(rootDir);

  // Monorepo-aware inference:
  // If we're inside a happy monorepo checkout/worktree, infer which "logical component"
  // (packages/happy-*/ or legacy expo-app/cli/server) the user is working in and return that repo root.
  //
  // This enables workflows like:
  // - running `hstack dev` from inside <repo>/apps/cli (should infer happy-cli)
  // - running from inside <workspace>/pr/.../apps/cli (should infer happy-cli)
  // - running from inside <workspace>/local/.../apps/cli (should infer happy-cli)
  // - running from inside <workspace>/tmp/.../apps/cli (should infer happy-cli)
  {
    const categoryRoots = WORKTREE_CATEGORIES.map((c) => resolve(getWorktreeCategoryRoot(rootDir, c, process.env)));
    const monorepoScopes = Array.from(
      new Set([
        resolve(getRepoDir(rootDir)),
        resolve(getDevRepoDir(rootDir)),
        resolve(workspaceDir),
        ...categoryRoots,
      ])
    );
    for (const scope of monorepoScopes) {
      if (!isPathInside(abs, scope)) continue;
      const repoRoot = findGitRoot(abs, scope);
      if (!repoRoot) continue;
      if (!isHappyMonorepoRoot(repoRoot)) continue;

      const inferred = resolveHappyMonorepoComponentFromPath({ monorepoRoot: repoRoot, absPath: abs });
      if (inferred) {
        // Only return components the caller asked us to consider.
        if (list.includes(inferred.component)) {
          return inferred;
        }
        return null;
      }

      // If we are inside the monorepo root but not inside a known package dir, default to `happy`
      // (the UI) when the caller allows it. This keeps legacy behavior where running from the
      // repo root still "belongs" to the UI component.
      if (list.includes('happy')) {
        return { component: 'happy', repoDir: repoRoot };
      }
      return null;
    }
  }

  // Fallback: allow inference from any Happier monorepo checkout, even if it lives outside the
  // configured workspace/repo dir (useful for custom clones).
  const repoRoot = findGitRoot(abs, '');
  if (repoRoot && isHappyMonorepoRoot(repoRoot)) {
    const inferred = resolveHappyMonorepoComponentFromPath({ monorepoRoot: repoRoot, absPath: abs });
    if (inferred && list.includes(inferred.component)) return inferred;
    if (list.includes('happy')) return { component: 'happy', repoDir: repoRoot };
  }

  return null;
}
