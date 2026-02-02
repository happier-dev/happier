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

async function getRemoteUrl({ repoDir, remoteName }) {
  const r = String(remoteName ?? '').trim();
  if (!r) return '';
  try {
    return (await runCapture('git', ['remote', 'get-url', r], { cwd: repoDir })).trim();
  } catch {
    return '';
  }
}

// Remote used to *read* the canonical dev branch from (sync/reset defaults).
export async function resolveDevSyncRemote({ repoDir, env = process.env, preferred = '' } = {}) {
  const want = String(preferred ?? '').trim();
  if (want) return want;

  // Default preference: upstream (if configured), else origin.
  if (await gitHasRemote({ repoDir, remote: 'upstream' })) return 'upstream';
  if (await gitHasRemote({ repoDir, remote: 'origin' })) return 'origin';
  return '';
}

// Remote used to *push* feature branches to (extract defaults).
// Conventional git behavior: push to origin (fork), PR against upstream.
export async function resolveDevPushRemote({ repoDir, env = process.env, preferred = '' } = {}) {
  const want = String(preferred ?? '').trim();
  if (want) return want;

  if (await gitHasRemote({ repoDir, remote: 'origin' })) return 'origin';
  if (await gitHasRemote({ repoDir, remote: 'upstream' })) return 'upstream';
  return '';
}

export async function ensureDevCheckout({ rootDir, env = process.env, remote = '' } = {}) {
  const mainDir = getRepoDir(rootDir, { ...env, HAPPIER_STACK_REPO_DIR: '' });
  const devDir = getDevRepoDir(rootDir, env);
  const devBranch = resolveDevBranchName(env);

  if (!existsSync(mainDir) || !existsSync(join(mainDir, '.git'))) {
    throw new Error(`[dev] missing main checkout at ${mainDir}\nFix: run \`hstack bootstrap --clone\` (or \`hstack setup\`).`);
  }

  const syncRemote = await resolveDevSyncRemote({ repoDir: mainDir, env, preferred: remote });
  if (!syncRemote) {
    throw new Error(`[dev] missing git remotes in ${mainDir}\nFix: ensure at least one of {upstream, origin} exists.`);
  }

  const preferred = String(remote ?? '').trim();
  const hasUpstream = await gitHasRemote({ repoDir: mainDir, remote: 'upstream' });
  const hasOrigin = await gitHasRemote({ repoDir: mainDir, remote: 'origin' });
  let trackingRemote = preferred;
  if (!trackingRemote) {
    // Maintainership UX:
    // Contributor UX:
    // - if origin differs from upstream, assume origin is a fork and track origin/dev (pushable).
    // - otherwise, track upstream/dev (canonical).
    if (hasUpstream && hasOrigin) {
      const upstreamUrl = await getRemoteUrl({ repoDir: mainDir, remoteName: 'upstream' });
      const originUrl = await getRemoteUrl({ repoDir: mainDir, remoteName: 'origin' });
      trackingRemote = upstreamUrl && originUrl && upstreamUrl !== originUrl ? 'origin' : 'upstream';
    } else if (hasOrigin) {
      trackingRemote = 'origin';
    } else if (hasUpstream) {
      trackingRemote = 'upstream';
    } else {
      trackingRemote = syncRemote;
    }
  }

  // Already exists: treat as ok, but report the actual tracking remote best-effort.
  if (existsSync(devDir) && existsSync(join(devDir, '.git'))) {
    let inferred = '';
    try {
      const upstreamRef = (await runCapture('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: devDir })).trim();
      inferred = upstreamRef.split('/')[0] ?? '';
    } catch {
      inferred = '';
    }
    return { ok: true, created: false, mainDir, devDir, devBranch, syncRemote, trackingRemote: inferred || trackingRemote };
  }

  await mkdir(devDir, { recursive: true }).catch(() => {});

  // Create/overwrite a local branch "dev" from <remote>/<devBranch>, then add the worktree.
  // NOTE: `-B` resets the local branch name to the requested start-point (safe for a fresh workspace).
  const startPoint = `${trackingRemote}/${devBranch}`;
  try {
    await runCapture('git', ['fetch', trackingRemote, devBranch], { cwd: mainDir });
  } catch (e) {
    // Common contributor case: origin points to a fresh fork that doesn't have dev yet.
    // Best-effort: seed origin/dev from upstream/dev (or the chosen sync remote).
    if (trackingRemote === 'origin' && syncRemote && syncRemote !== 'origin') {
      await runCapture('git', ['fetch', syncRemote, devBranch], { cwd: mainDir });
      await runCapture('git', ['push', 'origin', `refs/remotes/${syncRemote}/${devBranch}:refs/heads/${devBranch}`], { cwd: mainDir });
      await runCapture('git', ['fetch', 'origin', devBranch], { cwd: mainDir });
    } else {
      throw e;
    }
  }

  await runCapture('git', ['worktree', 'add', '-B', devBranch, devDir, startPoint], { cwd: mainDir });
  // Ensure the branch explicitly tracks the chosen remote for clarity (git status shows upstream correctly).
  await runCapture('git', ['-C', devDir, 'branch', '--set-upstream-to', startPoint, devBranch], { cwd: mainDir }).catch(() => {});

  return { ok: true, created: true, mainDir, devDir, devBranch, syncRemote, trackingRemote };
}
