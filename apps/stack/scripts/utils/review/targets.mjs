import { getRepoDir } from '../paths/paths.mjs';

export function isStackMode(env = process.env) {
  const stack = String(env.HAPPIER_STACK_STACK ?? '').trim();
  const envFile = String(env.HAPPIER_STACK_ENV_FILE ?? '').trim();
  return Boolean(stack && envFile);
}

export function defaultRepoCheckoutDir(rootDir, env = process.env) {
  const clean = { ...env, HAPPIER_STACK_REPO_DIR: '' };
  return getRepoDir(rootDir, clean);
}

export function resolveDefaultStackReviewComponents({ rootDir, components }) {
  const list = Array.isArray(components) ? components : [];
  if (!list.length) return [];

  const effectiveRepo = getRepoDir(rootDir, process.env);
  const defaultRepo = defaultRepoCheckoutDir(rootDir, process.env);
  // Repo-only model: if the stack is pinned to a non-default worktree/checkout, all
  // logical services share that same repo pin.
  return effectiveRepo !== defaultRepo ? list : [];
}
