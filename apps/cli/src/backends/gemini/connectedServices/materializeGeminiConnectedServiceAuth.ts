import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { join } from 'node:path';

import { requireConnectedServiceOauthCredentialRecord } from '@/backends/connectedServices/connectedServiceCredentialRecord';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

export async function materializeGeminiConnectedServiceAuth(params: Readonly<{
  rootDir: string;
  record: ConnectedServiceCredentialRecordV1;
}>): Promise<Readonly<{ env: Record<string, string> }>> {
  const record = requireConnectedServiceOauthCredentialRecord(params.record);

  // Gemini CLI uses oauth-personal when it can find local OAuth credentials at ~/.gemini/oauth_creds.json.
  // We materialize an isolated HOME so the spawned Gemini process can authenticate without requiring
  // user-interactive `gemini auth` on the remote machine.
  const homeDir = join(params.rootDir, 'home');
  const oauthCredsPath = join(homeDir, '.gemini', 'oauth_creds.json');

  await writeJsonAtomic(oauthCredsPath, {
    access_token: record.oauth.accessToken,
    token_type: record.oauth.tokenType ?? 'Bearer',
    scope: record.oauth.scope ?? 'https://www.googleapis.com/auth/cloud-platform',
    ...(record.oauth.refreshToken ? { refresh_token: record.oauth.refreshToken } : {}),
    ...(record.oauth.idToken ? { id_token: record.oauth.idToken } : {}),
    ...(typeof record.expiresAt === 'number' ? { expires_at: record.expiresAt } : {}),
  });

  return {
    env: {
      HOME: homeDir,
      ...(process.platform === 'win32' ? { USERPROFILE: homeDir } : {}),
    },
  };
}
