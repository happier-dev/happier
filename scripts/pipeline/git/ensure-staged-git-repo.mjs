// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * @param {string} repoDir
 * @param {Record<string, string>} env
 * @returns {boolean}
 */
function hasGitHeadCommit(repoDir, env) {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoDir, env, stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * EAS expects the project to be inside a git repository, even for local builds.
 * When staging outside the working tree, we create a lightweight repo so EAS can proceed
 * without mutating the real checkout.
 *
 * Important: a repo can have `.git/` but still have no commits. Some tools treat that as
 * "not a real repo" and will fail. Ensure we always have at least one commit.
 *
 * @param {{ repoDir: string; env: Record<string, string>; dryRun: boolean }} opts
 */
export function ensureStagedGitRepo(opts) {
  const gitDir = path.join(opts.repoDir, '.git');

  if (opts.dryRun) {
    if (!fs.existsSync(gitDir)) {
      console.log(`[dry-run] (cwd: ${opts.repoDir}) git init`);
    }
    console.log(`[dry-run] (cwd: ${opts.repoDir}) ensure HEAD commit exists`);
    return;
  }

  if (!fs.existsSync(gitDir)) {
    execFileSync('git', ['init', '-q'], { cwd: opts.repoDir, env: opts.env, stdio: 'ignore', timeout: 60_000 });
  }

  if (hasGitHeadCommit(opts.repoDir, opts.env)) return;

  // Avoid `git add -A` on a staged monorepo (can be extremely slow) — EAS only needs a repo + a commit.
  execFileSync('git', [
    '-c',
    'user.email=pipeline@local',
    '-c',
    'user.name=Happier Pipeline',
    'commit',
    '--allow-empty',
    '-m',
    'eas local build',
    '--no-gpg-sign',
    '--no-verify',
  ], {
    cwd: opts.repoDir,
    env: opts.env,
    stdio: 'ignore',
    timeout: 60_000,
  });
}
