import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  coerceHappyMonorepoRootFromPath,
  getComponentRepoDir,
  getWorkspaceDir,
  happyMonorepoSubdirForComponent,
} from '../paths/paths.mjs';
import { pathExists } from '../fs/fs.mjs';
import { run, runCapture } from '../proc/proc.mjs';

export function parseGithubOwner(remoteUrl) {
  const raw = (remoteUrl ?? '').trim();
  if (!raw) {
    return null;
  }
  // https://github.com/<owner>/<repo>.git
  // git@github.com:<owner>/<repo>.git
  const m = raw.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/);
  return m?.groups?.owner ?? null;
}

export function getWorktreesRoot(rootDir, env = process.env) {
  return join(getWorkspaceDir(rootDir, env), '.worktrees');
}

export function componentRepoDir(rootDir, component, env = process.env) {
  return getComponentRepoDir(rootDir, component, env);
}

function worktreeRepoKeyForComponent({ rootDir, component, env = process.env }) {
  // Deprecated: worktrees are repo-scoped and no longer nested by component key.
  void rootDir;
  void component;
  void env;
  return null;
}

export function isComponentWorktreePath({ rootDir, component, dir, env = process.env }) {
  const raw = String(dir ?? '').trim();
  if (!raw) return false;
  const abs = resolve(raw);
  void component;
  const root = resolve(getWorktreesRoot(rootDir, env)) + '/';
  return abs.startsWith(root);
}

export function worktreeSpecFromDir({ rootDir, component, dir, env = process.env }) {
  const raw = String(dir ?? '').trim();
  if (!raw) return null;
  if (!isComponentWorktreePath({ rootDir, component, dir: raw, env })) return null;
  const abs = resolve(raw);
  void component;
  const base = resolve(getWorktreesRoot(rootDir, env));

  // Normalize to the actual worktree root directory (the one containing `.git`) so
  // package subdirectories like `.../cli` don't corrupt the computed spec.
  let cur = abs;
  while (cur && cur !== base && cur !== dirname(cur)) {
    if (existsSync(join(cur, '.git'))) {
      break;
    }
    cur = dirname(cur);
  }
  if (!cur || cur === base || cur === dirname(cur)) return null;

  const root = base + '/';
  if (!cur.startsWith(root)) return null;
  const rel = cur.slice(root.length).split('/').filter(Boolean);
  if (rel.length < 2) return null;
  return rel.join('/');
}

export async function inferRemoteNameForOwner({ repoDir, owner }) {
  const want = String(owner ?? '').trim();
  if (!want) return 'upstream';

  const candidates = ['upstream', 'origin', 'fork'];
  for (const remoteName of candidates) {
    try {
      const url = (await runCapture('git', ['remote', 'get-url', remoteName], { cwd: repoDir })).trim();
      const o = parseGithubOwner(url);
      if (o && o === want) {
        return remoteName;
      }
    } catch {
      // ignore missing remote
    }
  }
  return 'upstream';
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
  await run(process.execPath, [join(rootDir, 'bin', 'hstack.mjs'), ...args], { cwd: rootDir, env });

  const repoDir = componentRepoDir(rootDir, component, env);
  const owner = await getRemoteOwner({ repoDir, remoteName });
  const wtRoot = join(getWorktreesRoot(rootDir, env), owner, ...slug.split('/'));
  const monoRoot = coerceHappyMonorepoRootFromPath(wtRoot);
  const sub = monoRoot ? happyMonorepoSubdirForComponent(component, { monorepoRoot: monoRoot }) : null;
  return sub && monoRoot ? join(monoRoot, sub) : wtRoot;
}

export function resolveComponentSpecToDir({ rootDir, component, spec, env = process.env }) {
  const raw = (spec ?? '').trim();
  if (!raw || raw === 'default') {
    return null;
  }
  if (isAbsolute(raw)) {
    const monoRoot = coerceHappyMonorepoRootFromPath(raw);
    const sub = monoRoot ? happyMonorepoSubdirForComponent(component, { monorepoRoot: monoRoot }) : null;
    if (monoRoot && sub) {
      return join(monoRoot, sub);
    }
    return raw;
  }
  // Treat as <owner>/<branch...> under <workspace>/.worktrees/...
  const wtRoot = join(getWorktreesRoot(rootDir, env), ...raw.split('/'));
  const monoRoot = coerceHappyMonorepoRootFromPath(wtRoot);
  const sub = monoRoot ? happyMonorepoSubdirForComponent(component, { monorepoRoot: monoRoot }) : null;
  return sub && monoRoot ? join(monoRoot, sub) : wtRoot;
}

export async function listWorktreeSpecs({ rootDir, component, env = process.env }) {
  void component;
  const dir = getWorktreesRoot(rootDir, env);
  const specs = [];
  try {
    const walk = async (d, prefixParts) => {
      const entries = await readdir(d, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = join(d, e.name);
        const nextPrefix = [...prefixParts, e.name];
        if (await pathExists(join(p, '.git'))) {
          specs.push(nextPrefix.join('/'));
          // IMPORTANT: do not recurse into worktree roots (they contain full repos and can be huge).
          // Worktrees are leaf nodes for our purposes.
          continue;
        }
        await walk(p, nextPrefix);
      }
    };
    if (await pathExists(dir)) {
      await walk(dir, []);
    }
  } catch {
    // ignore
  }
  return specs.sort();
}

export async function getRemoteOwner({ repoDir, remoteName = 'upstream' }) {
  const url = (await runCapture('git', ['remote', 'get-url', remoteName], { cwd: repoDir })).trim();
  const owner = parseGithubOwner(url);
  if (!owner) {
    throw new Error(`[worktrees] unable to parse owner for ${repoDir} remote ${remoteName} (${url})`);
  }
  return owner;
}

export async function createWorktree({ rootDir, component, slug, remoteName = 'upstream', env = process.env }) {
  // Create without modifying env.local (unless caller passes --use elsewhere).
  await run(process.execPath, [join(rootDir, 'bin', 'hstack.mjs'), 'wt', 'new', component, slug, `--remote=${remoteName}`], {
    cwd: rootDir,
    env,
  });
  const repoDir = componentRepoDir(rootDir, component, env);
  const owner = await getRemoteOwner({ repoDir, remoteName });
  const wtRoot = join(getWorktreesRoot(rootDir, env), owner, ...slug.split('/'));
  const sub = happyMonorepoSubdirForComponent(component);
  const monoRoot = sub ? coerceHappyMonorepoRootFromPath(wtRoot) : null;
  return sub && monoRoot ? join(monoRoot, sub) : wtRoot;
}
