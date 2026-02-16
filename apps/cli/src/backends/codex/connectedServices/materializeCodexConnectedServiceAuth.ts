import { join } from 'node:path';

import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { requireConnectedServiceOauthCredentialRecord } from '@/backends/connectedServices/connectedServiceCredentialRecord';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

export async function materializeCodexConnectedServiceAuth(params: Readonly<{
  rootDir: string;
  record: ConnectedServiceCredentialRecordV1;
}>): Promise<Readonly<{ env: Record<string, string> }>> {
  const record = requireConnectedServiceOauthCredentialRecord(params.record);
  const codexHome = join(params.rootDir, 'codex-home');
  await writeJsonAtomic(join(codexHome, 'auth.json'), {
    access_token: record.oauth.accessToken,
    refresh_token: record.oauth.refreshToken,
    id_token: record.oauth.idToken,
    account_id: record.oauth.providerAccountId,
  });
  return { env: { CODEX_HOME: codexHome } };
}
