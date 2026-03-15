/**
 * Claude-related settings helpers.
 *
 * IMPORTANT:
 * Happier does NOT read Claude Code's `settings.json` (or any of its setting-source files).
 * Claude reads and merges those settings internally.
 *
 * For Happier-owned behavior (like whether we append co-authored-by credits),
 * we rely solely on Happier settings propagated into env vars.
 */

/**
 * Check if Co-Authored-By lines should be included in commit messages
 * based on Happier settings (propagated via env).
 * 
 * @returns true if Co-Authored-By should be included, false otherwise
 */
export function shouldIncludeCoAuthoredBy(): boolean {
  const envRaw = typeof process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY === 'string'
    ? process.env.HAPPIER_SCM_INCLUDE_CO_AUTHORED_BY.trim()
    : '';
  if (envRaw === '1') return true;
  if (envRaw === '0') return false;
  return false;
}
