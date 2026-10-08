import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeConnectedServiceOauthCredentialRawMetadata, type ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';
import { AGY_OAUTH_CLIENT_ID, AGY_OAUTH_CLIENT_SECRET, AGY_OAUTH_SCOPES, AGY_CLOUDCODE_API_BASE_URLS } from '@happier-dev/agents';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

/** Rejects grants lacking verified account/project metadata or the official ACP coding permissions. */
export function requireAgySessionCredential(record: ConnectedServiceCredentialRecordV1) {
  if (record.serviceId !== 'antigravity' || record.kind !== 'oauth') throw new Error('Antigravity sessions require personal OAuth credentials');
  const meta = normalizeConnectedServiceOauthCredentialRawMetadata(record.oauth.raw)?.antigravity;
  if (meta?.clientId !== AGY_OAUTH_CLIENT_ID || meta.authMethod !== 'oauth-personal') throw new Error('Antigravity OAuth issuer is unsupported; reconnect in the browser');
  const scopes = new Set(record.oauth.scope?.split(/\s+/));
  if (!AGY_OAUTH_SCOPES.every((scope) => scopes.has(scope))) throw new Error('This imported Antigravity login can read quota but requires browser reauthorization before official ACP sessions');
  if (!record.oauth.refreshToken || !record.oauth.providerAccountId || !meta.projectId) throw new Error('Antigravity credentials are missing verified account/project information; reconnect');
  return record;
}

/**
 * Writes official ACP credentials and settings only beneath the connected profile root.
 * Redirects provider home/temp paths and clears ambient Google credentials so the
 * selected account cannot fall back to, or overwrite, the machine’s native login.
 */
export async function materializeAgyConnectedServiceAuth(input: Readonly<{ rootDir: string; record: ConnectedServiceCredentialRecordV1 }>) {
  const record = requireAgySessionCredential(input.record);
  const geminiHome = join(input.rootDir, 'gemini');
  const homeDir = join(input.rootDir, 'home');
  const tempDir = join(input.rootDir, 'tmp');
  await Promise.all([mkdir(homeDir, { recursive: true, mode: 0o700 }), mkdir(tempDir, { recursive: true, mode: 0o700 })]);
  await writeJsonAtomic(join(geminiHome, 'antigravity-acp/acp_token.json'), {
    type: 'authorized_user', client_id: AGY_OAUTH_CLIENT_ID, client_secret: AGY_OAUTH_CLIENT_SECRET,
    refresh_token: record.oauth.refreshToken, project_id: normalizeConnectedServiceOauthCredentialRawMetadata(record.oauth.raw)!.antigravity!.projectId,
    token: record.oauth.accessToken,
    ...(record.expiresAt ? { expiry: new Date(record.expiresAt).toISOString() } : {}),
  });
  await writeJsonAtomic(join(geminiHome, 'antigravity-acp/settings.json'), { auth: { type: 'oauth-personal' } });
  await writeJsonAtomic(join(geminiHome, 'antigravity-acp/happier-profile.json'), { providerAccountId: record.oauth.providerAccountId, profileId: record.profileId });
  return { env: {
    HOME: homeDir, ...(process.platform === 'win32' ? { USERPROFILE: homeDir } : {}),
    XDG_CONFIG_HOME: join(homeDir, '.config'), XDG_CACHE_HOME: join(homeDir, '.cache'), XDG_DATA_HOME: join(homeDir, '.local', 'share'),
    TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir,
    GEMINI_HOME: geminiHome, AGY_ACP_FORCE_FILE_STORAGE: '1',
    AGY_ACP_CCPA_PROJECT: normalizeConnectedServiceOauthCredentialRawMetadata(record.oauth.raw)!.antigravity!.projectId!,
    AGY_ACP_CCPA_BASE_URL: AGY_CLOUDCODE_API_BASE_URLS[0],
    GOOGLE_API_KEY: '', GEMINI_API_KEY: '', GOOGLE_APPLICATION_CREDENTIALS: '', GOOGLE_GENAI_USE_VERTEXAI: '',
    GOOGLE_CLOUD_PROJECT: '', GOOGLE_CLOUD_LOCATION: '', GOOGLE_CLOUD_QUOTA_PROJECT: '',
  } };
}
