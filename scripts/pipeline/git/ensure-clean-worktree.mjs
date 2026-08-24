// @ts-check

import { execFileSync } from 'node:child_process';

const RELEASE_CONTROL_PATHS = [
  'scripts/pipeline/',
  '.github/workflows/release-npm.yml',
];

/**
 * @param {string} cwd
 * @returns {boolean}
 */
function isGitRepo(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    })
      .trim()
      .toLowerCase();
    return out === 'true';
  } catch {
    return false;
  }
}

/**
 * @param {string} cwd
 * @returns {string[]}
 */
function gitStatusPorcelain(cwd) {
  const out = execFileSync('git', ['status', '--porcelain=v1'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  return String(out || '')
    .replaceAll('\r', '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean);
}

/**
 * @param {string} statusLine
 * @returns {boolean}
 */
function isReleaseControlStatusLine(statusLine) {
  const paths = statusLine.slice(3).split(' -> ');
  return paths.some((path) =>
    RELEASE_CONTROL_PATHS.some((controlPath) =>
      controlPath.endsWith('/')
        ? path === controlPath.slice(0, -1) || path.startsWith(controlPath)
        : path === controlPath,
    ),
  );
}

/**
 * `--allow-dirty` permits product edits while preserving the local release-control
 * scripts that determine the release plan as a fixed, auditable corridor.
 *
 * @param {{ cwd: string; maxLines?: number }} opts
 */
export function assertReleaseControlWorktreeClean(opts) {
  if (!isGitRepo(opts.cwd)) return;

  const controlLines = gitStatusPorcelain(opts.cwd).filter(isReleaseControlStatusLine);
  if (controlLines.length === 0) return;

  const maxLines = typeof opts.maxLines === 'number' && Number.isFinite(opts.maxLines) ? opts.maxLines : 20;
  const snippet = controlLines.slice(0, Math.max(0, maxLines));
  const extra = controlLines.length > snippet.length ? `\n… and ${controlLines.length - snippet.length} more` : '';
  throw new Error(
    [
      'RELEASE_CONTROL_WORKTREE_DIRTY: release-control paths are dirty; --allow-dirty permits unrelated product edits only.',
      'Commit or revert release-control edits before release planning.',
      '',
      ...snippet,
      extra,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/**
 * Require a clean git worktree unless explicitly overridden.
 * This is intended to prevent accidental publishes from a dirty local checkout.
 *
 * @param {{
 *   cwd: string;
 *   allowDirty: boolean;
 *   maxLines?: number;
 * }} opts
 */
export function assertCleanWorktree(opts) {
  if (opts.allowDirty) return;
  if (!isGitRepo(opts.cwd)) return;

  const lines = gitStatusPorcelain(opts.cwd);
  if (lines.length === 0) return;

  const maxLines = typeof opts.maxLines === 'number' && Number.isFinite(opts.maxLines) ? opts.maxLines : 20;
  const snippet = lines.slice(0, Math.max(0, maxLines));
  const extra = lines.length > snippet.length ? `\n… and ${lines.length - snippet.length} more` : '';
  throw new Error(
    [
      'git worktree is dirty; refusing to publish from a non-reproducible state.',
      'Commit/stash changes, or re-run with --allow-dirty to override.',
      '',
      ...snippet,
      extra,
    ]
      .filter(Boolean)
      .join('\n'),
  );
}
