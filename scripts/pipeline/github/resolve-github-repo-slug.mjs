// @ts-check

import { execFileSync } from 'node:child_process';

/**
 * @param {string} raw
 * @returns {string}
 */
function stripGitSuffix(raw) {
  return raw.endsWith('.git') ? raw.slice(0, -'.git'.length) : raw;
}

/**
 * @param {string} remoteUrl
 * @returns {string}
 */
function parseGitHubRepoSlugFromRemoteUrl(remoteUrl) {
  const raw = String(remoteUrl ?? '').trim();
  if (!raw) return '';

  // git@github.com:owner/repo(.git)
  if (raw.startsWith('git@github.com:')) {
    const rest = stripGitSuffix(raw.slice('git@github.com:'.length));
    const parts = rest.split('/').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return '';
  }

  // ssh://git@github.com/owner/repo(.git)
  // https://github.com/owner/repo(.git)
  // https://<token>@github.com/owner/repo(.git)
  try {
    const url = new URL(raw);
    if (url.hostname !== 'github.com') return '';
    const pathname = stripGitSuffix(url.pathname.replace(/^\/+/, ''));
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    return '';
  } catch {
    return '';
  }
}

/**
 * Best-effort resolution of the `owner/repo` slug for the current repo.
 * Used to build stable GitHub release asset URLs when running pipeline scripts locally.
 *
 * Order:
 * 1) `GH_REPO` (preferred)
 * 2) `GITHUB_REPOSITORY` (Actions)
 * 3) `git config --get remote.origin.url` (local)
 *
 * @param {{ repoRoot: string; env?: Record<string, string | undefined> }} opts
 * @returns {string}
 */
export function resolveGitHubRepoSlug(opts) {
  const env = opts.env ?? /** @type {any} */ (process.env);
  const fromEnv = String(env.GH_REPO ?? env.GITHUB_REPOSITORY ?? '').trim();
  if (fromEnv) return fromEnv;

  try {
    const remote = String(
      execFileSync('git', ['config', '--get', 'remote.origin.url'], {
        cwd: opts.repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
      }) ?? '',
    ).trim();
    return parseGitHubRepoSlugFromRemoteUrl(remote);
  } catch {
    return '';
  }
}

