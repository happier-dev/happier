import { join } from 'node:path';

import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import {
  buildConnectedServiceOauthAuthEntry,
  requireConnectedServiceOauthCredentialRecordWithExpiry,
} from '@/backends/connectedServices/connectedServiceCredentialRecord';

export async function materializePiConnectedServiceAuth(params: Readonly<{
  rootDir: string;
  openaiCodex: ConnectedServiceCredentialRecordV1 | null;
  anthropic: ConnectedServiceCredentialRecordV1 | null;
}>): Promise<Readonly<{ env: Record<string, string> }>> {
  const agentDir = join(params.rootDir, 'pi-agent-dir');
  const auth: Record<string, unknown> = {};
  const env: Record<string, string> = {
    PI_CODING_AGENT_DIR: agentDir,
  };

  if (params.openaiCodex) {
    const record = requireConnectedServiceOauthCredentialRecordWithExpiry(params.openaiCodex);
    auth['openai-codex'] = buildConnectedServiceOauthAuthEntry(record);
  }

  if (params.anthropic) {
    if (params.anthropic.kind !== 'token') {
      throw new Error('Pi requires an Anthropic setup-token (connected-services kind=token), not an oauth credential.');
    }
    env.ANTHROPIC_OAUTH_TOKEN = params.anthropic.token.token;
  }

  await writeJsonAtomic(join(agentDir, 'auth.json'), auth);

  return {
    env,
  };
}
