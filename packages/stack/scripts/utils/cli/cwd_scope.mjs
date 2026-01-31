import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { getWorktreesRoot } from '../git/worktrees.mjs';
import { getComponentsDir, happyMonorepoSubdirForComponent, isHappyMonorepoRoot } from '../paths/paths.mjs';

export function getInvokedCwd(env = process.env) {
  return String(env.HAPPY_STACKS_INVOKED_CWD ?? env.HAPPY_LOCAL_INVOKED_CWD ?? env.PWD ?? '').trim();
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
  const componentsDir = getComponentsDir(rootDir);
  const worktreesRoot = getWorktreesRoot(rootDir);

  // Monorepo-aware inference:
  // If we're inside a happy monorepo checkout/worktree, infer which "logical component"
  // (packages/happy-*/ or legacy expo-app/cli/server) the user is working in and return that repo root.
  //
  // This enables workflows like:
  // - running `happys dev` from inside components/happy/cli (should infer happy-cli)
  // - running from inside components/.worktrees/happy/<owner>/<branch>/server (should infer happy-server)
  {
    const monorepoScopes = [
      resolve(join(componentsDir, 'happy')),
      resolve(join(worktreesRoot, 'happy')),
    ];
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

  for (const component of list) {
    const c = String(component ?? '').trim();
    if (!c) continue;

    const wtBase = resolve(join(worktreesRoot, c));
    if (isPathInside(abs, wtBase)) {
      const repoDir = findGitRoot(abs, wtBase);
      if (repoDir) {
        return { component: c, repoDir };
      }
    }

    const primaryBase = resolve(join(componentsDir, c));
    if (isPathInside(abs, primaryBase)) {
      const repoDir = findGitRoot(abs, primaryBase);
      if (repoDir) {
        return { component: c, repoDir };
      }
    }
  }

  return null;
}
