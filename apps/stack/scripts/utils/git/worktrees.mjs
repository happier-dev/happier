import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { userInfo } from 'node:os';

import {
  coerceHappyMonorepoRootFromPath,
  getComponentRepoDir,
  getDevRepoDir,
  getRepoDir,
  getWorkspaceDir,
  happyMonorepoSubdirForComponent,
} from '../paths/paths.mjs';
import { pathExists } from '../fs/fs.mjs';
import { runCapture } from '../proc/proc.mjs';

export const WORKTREE_CATEGORIES = Object.freeze(['pr', 'local', 'tmp']);

function getLocalOwner(env = process.env) {
  const explicit = String(env.HAPPIER_STACK_OWNER ?? '').trim();
  if (explicit) return explicit;
  try {
    const u = userInfo();
    if (u?.username) return u.username;
  } catch {
    // ignore
  }
  return 'unknown';
}

export function parseGithubOwner(remoteUrl) {
  const raw = (remoteUrl ?? '').trim();
  if (!raw) return null;
  // https://github.com/<owner>/<repo>.git
  // git@github.com:<owner>/<repo>.git
  const m = raw.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/);
  return m?.groups?.owner ?? null;
}

export function parseGithubOwnerRepo(remoteUrl) {
  const raw = (remoteUrl ?? '').trim();
  if (!raw) return null;
  const m = raw.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/);
  const owner = m?.groups?.owner ?? null;
  const repo = m?.groups?.repo ?? null;
  return owner && repo ? { owner, repo } : null;
}

export function getWorktreeCategoryRoot(rootDir, category, env = process.env) {
  const c = String(category ?? '').trim();
  if (!WORKTREE_CATEGORIES.includes(c)) {
    throw new Error(`[worktrees] invalid category: ${category}. Expected one of: ${WORKTREE_CATEGORIES.join(', ')}`);
  }
  return join(getWorkspaceDir(rootDir, env), c);
}

export function getWorktreeArchiveRoot(rootDir, env = process.env) {
  return join(getWorkspaceDir(rootDir, env), 'archive', 'worktrees');
}

export function componentRepoDir(rootDir, component, env = process.env) {
  return getComponentRepoDir(rootDir, component, env);
}

function resolveWorktreeRootFromPath({ workspaceDir, absPath }) {
  // Normalize to the actual worktree root directory (the one containing `.git`) so
  // package subdirectories like `.../apps/cli` don't corrupt the computed spec.
  let cur = absPath;
  while (cur && cur !== workspaceDir && cur !== dirname(cur)) {
    if (existsSync(join(cur, '.git'))) {
      break;
    }
    cur = dirname(cur);
  }
  if (!cur || cur === workspaceDir || cur === dirname(cur)) return null;
  return cur;
}

export function isWorktreePath({ rootDir, dir, env = process.env }) {
  const raw = String(dir ?? '').trim();
  if (!raw) return false;
  const abs = resolve(raw);
  const workspaceDir = resolve(getWorkspaceDir(rootDir, env));
  const prefix = workspaceDir + '/';
  if (!abs.startsWith(prefix)) return false;

  // Only count category worktrees (not main/ or dev/).
  const rel = abs.slice(prefix.length).split('/').filter(Boolean);
  const cat = rel[0] ?? '';
  return WORKTREE_CATEGORIES.includes(cat);
}

export function worktreeSpecFromDir({ rootDir, component, dir, env = process.env }) {
  const raw = String(dir ?? '').trim();
  if (!raw) return null;
  const abs = resolve(raw);
  void component;

  const workspaceDir = resolve(getWorkspaceDir(rootDir, env));
  const mainDir = resolve(getRepoDir(rootDir, { ...env, HAPPIER_STACK_REPO_DIR: '' }));
  const devDir = resolve(getDevRepoDir(rootDir, env));

  if (abs === mainDir || abs.startsWith(mainDir + '/')) return 'main';
  if (abs === devDir || abs.startsWith(devDir + '/')) return 'dev';

  const prefix = workspaceDir + '/';
  if (!abs.startsWith(prefix)) return null;

  const wtRoot = resolveWorktreeRootFromPath({ workspaceDir, absPath: abs });
  if (!wtRoot) return null;

  const rel = wtRoot.slice(prefix.length).split('/').filter(Boolean);
  if (rel.length < 2) return null;
  const cat = rel[0];
  if (!WORKTREE_CATEGORIES.includes(cat)) return null;
  return rel.join('/');
}

export function resolveComponentSpecToDir({ rootDir, component, spec, env = process.env }) {
  const raw = (spec ?? '').trim();
  if (!raw || raw === 'default') {
    return null;
  }

  // Special tokens:
  if (raw === 'main') {
    return getRepoDir(rootDir, { ...env, HAPPIER_STACK_REPO_DIR: '' });
  }
  if (raw === 'dev') {
    return getDevRepoDir(rootDir, env);
  }

  if (isAbsolute(raw)) {
    const monoRoot = coerceHappyMonorepoRootFromPath(raw);
    const sub = monoRoot ? happyMonorepoSubdirForComponent(component, { monorepoRoot: monoRoot }) : null;
    if (monoRoot && sub) return join(monoRoot, sub);
    return raw;
  }

  // Workspace-relative spec (Option C): pr/... | local/... | tmp/...
  const workspaceDir = getWorkspaceDir(rootDir, env);
  const parts = raw.split('/').filter(Boolean);
  const cat = parts[0] ?? '';
  const rest = parts.slice(1);
  let abs = '';
  if (cat === 'pr') {
    abs = join(workspaceDir, 'pr', ...rest);
  } else if (cat === 'local' || cat === 'tmp') {
    const owner = getLocalOwner(env);
    abs = join(workspaceDir, cat, owner, ...rest);
  } else {
    // Escape hatch: allow workspace-relative paths (e.g. "main/apps/ui").
    abs = join(workspaceDir, ...parts);
  }
  const monoRoot = coerceHappyMonorepoRootFromPath(abs);
  const sub = monoRoot ? happyMonorepoSubdirForComponent(component, { monorepoRoot: monoRoot }) : null;
  return sub && monoRoot ? join(monoRoot, sub) : abs;
}

export async function listWorktreeSpecs({ rootDir, component, env = process.env }) {
  void component;
  const workspaceDir = resolve(getWorkspaceDir(rootDir, env));
  const specs = [];

  const walk = async (d, prefixParts) => {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = join(d, e.name);
      const nextPrefix = [...prefixParts, e.name];
      if (await pathExists(join(p, '.git'))) {
        specs.push(nextPrefix.join('/'));
        // Do not recurse into worktree roots (they contain full repos and can be huge).
        continue;
      }
      await walk(p, nextPrefix);
    }
  };

  try {
    for (const cat of WORKTREE_CATEGORIES) {
      const catRoot = getWorktreeCategoryRoot(rootDir, cat, env);
      if (!(await pathExists(catRoot))) continue;

      if (cat === 'pr') {
        // PR worktrees are stored directly under <workspace>/pr/...
        await walk(catRoot, [cat]);
        continue;
      }

      // Local/tmp worktrees are namespaced by local owner:
      //   <workspace>/{local,tmp}/<owner>/...
      // but the user-facing spec intentionally omits the owner prefix:
      //   local/<...>, tmp/<...>
      const owner = getLocalOwner(env);
      const ownerRoot = join(catRoot, owner);
      if (!(await pathExists(ownerRoot))) continue;
      await walk(ownerRoot, [cat]);
    }
  } catch {
    // ignore
  }

  // Sort lexicographically for stable output.
  return specs
    .filter((s) => {
      // Basic safety: ensure spec resolves under the workspace root.
      try {
        const abs = resolve(workspaceDir, s);
        return abs.startsWith(workspaceDir + '/');
      } catch {
        return false;
      }
    })
    .sort();
}

export async function inferRemoteNameForOwner({ repoDir, owner }) {
  const want = String(owner ?? '').trim();
  if (!want) return 'upstream';

  const candidates = ['upstream', 'origin', 'fork'];
  for (const remoteName of candidates) {
    try {
      const url = (await runCapture('git', ['remote', 'get-url', remoteName], { cwd: repoDir })).trim();
      const o = parseGithubOwner(url);
      if (o && o === want) return remoteName;
    } catch {
      // ignore missing remote
    }
  }
  return 'upstream';
}

export async function getRemoteOwner({ repoDir, remoteName = 'upstream' }) {
  const url = (await runCapture('git', ['remote', 'get-url', remoteName], { cwd: repoDir })).trim();
  const owner = parseGithubOwner(url);
  if (!owner) {
    throw new Error(`[worktrees] unable to parse owner for ${repoDir} remote ${remoteName} (${url})`);
  }
  return owner;
}

function categoryFromSlug(slug) {
  const s = String(slug ?? '').trim();
  if (!s) return { category: 'local', rest: '' };
  const parts = s.split('/').filter(Boolean);
  const first = parts[0] ?? '';
  if (first === 'tmp') return { category: 'tmp', rest: parts.slice(1).join('/') };
  if (first === 'local') return { category: 'local', rest: parts.slice(1).join('/') };
  // `pr/` is handled by `hstack wt pr`, but allow it here as an escape hatch.
  if (first === 'pr') return { category: 'pr', rest: parts.slice(1).join('/') };
  return { category: 'local', rest: s };
}

export async function createWorktreeFromBaseWorktree({
  rootDir,
  component,
  slug,
  baseWorktreeSpec,
  remoteName = 'upstream',
  depsMode = '',
  env = process.env,
}) {
  const args = ['wt', 'new', component, slug, `--remote=${remoteName}`, `--base-worktree=${baseWorktreeSpec}`];
  if (depsMode) args.push(`--deps=${depsMode}`);
  await runCapture(process.execPath, [join(rootDir, 'bin', 'hstack.mjs'), ...args], { cwd: rootDir, env });

  const { category, rest } = categoryFromSlug(slug);
  const owner = getLocalOwner(env);
  const wtRoot =
    category === 'pr'
      ? join(getWorktreeCategoryRoot(rootDir, 'pr', env), rest)
      : join(getWorktreeCategoryRoot(rootDir, category, env), owner, ...rest.split('/').filter(Boolean));

  const monoRoot = coerceHappyMonorepoRootFromPath(wtRoot);
  const sub = monoRoot ? happyMonorepoSubdirForComponent(component, { monorepoRoot: monoRoot }) : null;
  return sub && monoRoot ? join(monoRoot, sub) : wtRoot;
}

export async function createWorktree({ rootDir, component, slug, remoteName = 'upstream', env = process.env }) {
  await runCapture(process.execPath, [join(rootDir, 'bin', 'hstack.mjs'), 'wt', 'new', component, slug, `--remote=${remoteName}`], {
    cwd: rootDir,
    env,
  });
  const { category, rest } = categoryFromSlug(slug);
  const owner = getLocalOwner(env);
  const wtRoot =
    category === 'pr'
      ? join(getWorktreeCategoryRoot(rootDir, 'pr', env), rest)
      : join(getWorktreeCategoryRoot(rootDir, category, env), owner, ...rest.split('/').filter(Boolean));
  const monoRoot = coerceHappyMonorepoRootFromPath(wtRoot);
  const sub = monoRoot ? happyMonorepoSubdirForComponent(component, { monorepoRoot: monoRoot }) : null;
  return sub && monoRoot ? join(monoRoot, sub) : wtRoot;
}
