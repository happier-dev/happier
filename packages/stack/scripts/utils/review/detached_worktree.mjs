import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { ensureDir } from '../fs/ops.mjs';
import { runCapture } from '../proc/proc.mjs';

function sanitizeLabel(raw) {
  return String(raw ?? 'worktree')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function defaultNonce() {
  const rand = Math.random().toString(16).slice(2, 10);
  return `${process.pid}-${Date.now()}-${rand}`;
}

export function computeDetachedWorktreeDir({ repoRootDir, label, headCommit, nonce } = {}) {
  const root = String(repoRootDir ?? '').trim();
  if (!root) throw new Error('[review] computeDetachedWorktreeDir: missing repoRootDir');

  const safeLabel = sanitizeLabel(label);
  const short = String(headCommit ?? '').slice(0, 12);
  const n = String(nonce ?? defaultNonce()).trim();
  return join(root, '.project', 'review-worktrees', `${safeLabel}-${short}-${n}`);
}

/**
 * Create a detached git worktree for `headCommit`, run `fn(worktreeDir)`, then clean up.
 *
 * Notes:
 * - The worktree directory name includes a nonce to avoid collisions when a prior run crashed
 *   and left behind a directory, or when multiple review runs happen in parallel.
 * - We do best-effort cleanup even if `fn` throws.
 */
export async function withDetachedWorktree({ repoDir, headCommit, label, env, nonce }, fn) {
  const root = (await runCapture('git', ['rev-parse', '--show-toplevel'], { cwd: repoDir, env })).toString().trim();
  if (!root) throw new Error('[review] failed to resolve git toplevel');

  const worktreesRoot = join(root, '.project', 'review-worktrees');
  await ensureDir(worktreesRoot);
  const dir = computeDetachedWorktreeDir({ repoRootDir: root, label, headCommit, nonce });

  // Extremely defensive: should not happen with nonced dirs, but avoid surprising errors.
  if (existsSync(dir)) {
    throw new Error(`[review] detached worktree dir already exists: ${dir}`);
  }

  try {
    await runCapture('git', ['worktree', 'add', '--detach', dir, headCommit], { cwd: repoDir, env });
    return await fn(dir);
  } finally {
    try {
      await runCapture('git', ['worktree', 'remove', '--force', dir], { cwd: repoDir, env });
      await runCapture('git', ['worktree', 'prune'], { cwd: repoDir, env });
    } catch {
      // best-effort cleanup; leave an orphaned worktree if needed
    }
  }
}

