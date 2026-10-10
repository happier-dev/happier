import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AGY_OAUTH_CLIENT_ID, AGY_OAUTH_CLIENT_SECRET, AGY_OAUTH_TOKEN_URL, resolveAgyOauthAccount } from '@happier-dev/agents';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { CONNECTED_SERVICE_IMPORT_TIMEOUT_MS } from '@happier-dev/protocol';
import { buildSafeOauthProviderFailureMessage } from '@/cloud/safeOauthProviderError';

/** Narrows untrusted native-login and Google response objects before reading credential fields. */
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/**
 * Reads the selected native login without modifying it, refreshes its existing grant,
 * and verifies the account/project within the bounded import operation.
 * Granted scopes come from Google’s refresh response, never from the saved file.
 */
export async function importAgyCredentials(input: Readonly<{ source: 'acp' | 'cli'; projectId?: string; signal?: AbortSignal }>) {
  const deadline = AbortSignal.timeout(CONNECTED_SERVICE_IMPORT_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  signal.throwIfAborted();
  const geminiHome = process.env.GEMINI_HOME?.trim() ? expandHomeDirPath(process.env.GEMINI_HOME) : join(homedir(), '.gemini');
  const sourcePath = input.source === 'acp' ? join(geminiHome, 'antigravity-acp', 'acp_token.json') : join(geminiHome, 'antigravity-cli', 'antigravity-oauth-token');
  let data: Record<string, unknown>;
  try { data = record(JSON.parse(await readFile(sourcePath, { encoding: 'utf8', signal }))); }
  catch (error) { signal.throwIfAborted(); throw new Error(`No readable Antigravity ${input.source} OAuth login found on this machine`); }
  const token = typeof data.token === 'object' ? record(data.token) : data;
  if (token.client_id && token.client_id !== AGY_OAUTH_CLIENT_ID) throw new Error('Antigravity import uses an unsupported OAuth issuer; authorize in the browser');
  if (input.source === 'acp' && token.type && token.type !== 'authorized_user') throw new Error('Only personal Antigravity OAuth logins can be imported');
  const refreshToken = typeof token.refresh_token === 'string' ? token.refresh_token.trim() : typeof token.refreshToken === 'string' ? token.refreshToken.trim() : '';
  if (!refreshToken) throw new Error('Antigravity login has no refresh token; authorize in the browser');
  const response = await fetch(AGY_OAUTH_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: AGY_OAUTH_CLIENT_ID, client_secret: AGY_OAUTH_CLIENT_SECRET, refresh_token: refreshToken }), signal });
  if (!response.ok) throw new Error(buildSafeOauthProviderFailureMessage({ operation: 'Antigravity import', status: response.status, statusText: response.statusText, body: await response.text() }));
  const refreshed = record(await response.json());
  if (typeof refreshed.access_token !== 'string' || !refreshed.access_token.trim()) throw new Error('Antigravity refresh returned no access token');
  // The refresh response proves granted scopes; stored scope declarations are not authority.
  if (typeof refreshed.scope !== 'string') throw new Error('Antigravity import could not verify granted scopes; authorize in the browser');
  const verified = await resolveAgyOauthAccount({ accessToken: refreshed.access_token, projectId: input.projectId ?? (typeof token.project_id === 'string' ? token.project_id.trim() : typeof token.projectId === 'string' ? token.projectId.trim() : undefined), allowOnboarding: false, signal });
  return { ...refreshed, scope: refreshed.scope, refresh_token: typeof refreshed.refresh_token === 'string' ? refreshed.refresh_token : refreshToken, ...verified };
}
