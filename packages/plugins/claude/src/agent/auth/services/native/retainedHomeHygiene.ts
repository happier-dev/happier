import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Relative location, within a Happier-managed materialized home root, of the Claude subscription
 * credential file that the daemon retains across sessions. Owned by the Claude plugin so that the
 * generic connected-service cleanup scheduler never encodes provider-specific credential paths.
 */
const CLAUDE_RETAINED_CREDENTIAL_RELATIVE_PATH = ['claude', '.credentials.json'] as const;

/**
 * Removes long-lived refresh-token fields from a parsed Claude credential envelope. Returns the
 * sanitized envelope when a refresh-token field was present, or `null` when there is nothing to
 * strip (so callers can skip a rewrite).
 */
export function stripClaudeRefreshTokenFields(value: unknown): unknown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const credential = root.claudeAiOauth;
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)) return null;
  const credentialRecord = credential as Record<string, unknown>;
  if (
    !('refreshToken' in credentialRecord)
    && !('refresh_token' in credentialRecord)
    && !('RT' in credentialRecord)
  ) {
    return null;
  }
  const {
    refreshToken: _refreshToken,
    refresh_token: _refresh_token,
    RT: _rt,
    ...withoutRefreshTokens
  } = credentialRecord;
  return {
    ...root,
    claudeAiOauth: withoutRefreshTokens,
  };
}

/**
 * Retained-materialized-home hygiene hook contributed to the connected-service cleanup scheduler.
 * Strips legacy refresh tokens from the Claude credential file inside the given home root. Missing
 * files and unreadable JSON are ignored — retained homes are best-effort sanitized.
 */
export async function sanitizeRetainedClaudeMaterializedHome(homeRootDir: string): Promise<void> {
  const credentialPath = join(homeRootDir, ...CLAUDE_RETAINED_CREDENTIAL_RELATIVE_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(credentialPath, 'utf8')) as unknown;
  } catch {
    return;
  }
  const stripped = stripClaudeRefreshTokenFields(parsed);
  if (!stripped) return;
  await writeFile(credentialPath, `${JSON.stringify(stripped)}\n`);
}
