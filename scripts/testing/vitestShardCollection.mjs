/**
 * Shard runners ask `vitest list` which files a lane collects before deciding how to
 * split them. Both the CLI and UI runners answer the same two questions here so a
 * vacuous green cannot be defined differently in one lane than in the other.
 */

/** Reads the file list `vitest list --filesOnly --json <path>` writes. */
export function parseVitestListJson(raw) {
  const parsed = JSON.parse(String(raw ?? 'null'));
  if (!Array.isArray(parsed)) {
    throw new Error('[runVitestShards] vitest list --json output must be an array');
  }

  return parsed
    .map((entry) => (entry && typeof entry.file === 'string' ? entry.file : null))
    .filter((file) => typeof file === 'string' && file.trim().length > 0);
}

/**
 * `vitest run` exits non-zero when it collects nothing. Sharding must not be more
 * permissive than the tool it wraps: `--shard N/M` legitimately produces empty
 * shards, but a lane that collected nothing at all is a vacuous green unless the
 * caller explicitly asked for `--passWithNoTests`.
 */
export function shouldVitestShardRunProceedWithoutFiles({ fileCount, passthroughArgs }) {
  if (fileCount > 0) return true;
  return Array.from(passthroughArgs ?? []).some((arg) => (
    arg === '--passWithNoTests' || arg === '--passWithNoTests=true'
  ));
}
