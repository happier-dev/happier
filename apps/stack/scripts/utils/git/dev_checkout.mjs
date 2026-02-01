import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getDevRepoDir, getRepoDir } from '../paths/paths.mjs';
import { runCapture } from '../proc/proc.mjs';

async function gitHasRemote({ repoDir, remote }) {
  try {
    const r = String(remote ?? '').trim();
    if (!r) return false;
    await runCapture('git', ['remote', 'get-url', r], { cwd: repoDir });
    return true;
  } catch {
    return false;
  }
}

export function resolveDevBranchName(env = process.env) {
  return String(env.HAPPIER_STACK_DEV_BRANCH ?? '').trim() || 'dev';
}

export async function resolvePreferredDevRemote({ repoDir, env = process.env, preferred = '' } = {}) {
  const want = String(preferred ?? '').trim();
  if (want) return want;

  // Default preference: upstream (if configured), else origin.
  if (await gitHasRemote({ repoDir, remote: 'upstream' })) return 'upstream';
  if (await gitHasRemote({ repoDir, remote: 'origin' })) return 'origin';
  return '';
}

export async function ensureDevCheckout({ rootDir, env = process.env, remote = '' } = {}) {
  const mainDir = getRepoDir(rootDir, { ...env, HAPPIER_STACK_REPO_DIR: '' });
  const devDir = getDevRepoDir(rootDir, env);
  const devBranch = resolveDevBranchName(env);

  if (!existsSync(mainDir) || !existsSync(join(mainDir, '.git'))) {
    throw new Error(`[dev] missing main checkout at ${mainDir}\nFix: run \`hstack bootstrap --clone\` (or \`hstack setup\`).`);
  }

  // Already exists: treat as ok.
  if (existsSync(devDir) && existsSync(join(devDir, '.git'))) {
    return { ok: true, created: false, mainDir, devDir, devBranch, remote: remote || '' };
  }

  await mkdir(devDir, { recursive: true }).catch(() => {});

  const chosenRemote = await resolvePreferredDevRemote({ repoDir: mainDir, env, preferred: remote });
  if (!chosenRemote) {
    throw new Error(`[dev] missing git remotes in ${mainDir}\nFix: ensure at least one of {upstream, origin} exists.`);
  }

  // Create/overwrite a local branch "dev" from <remote>/<devBranch>, then add the worktree.
  // NOTE: `-B` resets the local branch name to the requested start-point (safe for a fresh workspace).
  const startPoint = `${chosenRemote}/${devBranch}`;
  await runCapture('git', ['fetch', chosenRemote, devBranch], { cwd: mainDir });
  await runCapture('git', ['worktree', 'add', '-B', devBranch, devDir, startPoint], { cwd: mainDir });

  return { ok: true, created: true, mainDir, devDir, devBranch, remote: chosenRemote };
}

