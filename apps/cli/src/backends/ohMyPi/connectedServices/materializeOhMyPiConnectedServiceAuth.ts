import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

import {
  requireConnectedServiceOauthCredentialRecordWithExpiry,
  requireConnectedServiceTokenCredentialRecord,
} from '@/daemon/connectedServices/shared/connectedServiceCredentialRecord';

export async function materializeOhMyPiConnectedServiceAuth(params: Readonly<{
  openaiCodex: ConnectedServiceCredentialRecordV1 | null;
  openai: ConnectedServiceCredentialRecordV1 | null;
  claudeSubscription: ConnectedServiceCredentialRecordV1 | null;
  anthropic: ConnectedServiceCredentialRecordV1 | null;
  gemini: ConnectedServiceCredentialRecordV1 | null;
}>): Promise<Readonly<{ env: Record<string, string> }>> {
  const env: Record<string, string> = {};

  if (params.openaiCodex) {
    const record = requireConnectedServiceOauthCredentialRecordWithExpiry(params.openaiCodex);
    env.OPENAI_CODEX_OAUTH_TOKEN = record.oauth.accessToken;
  }

  if (params.openai) {
    const record = requireConnectedServiceTokenCredentialRecord(params.openai);
    env.OPENAI_API_KEY = record.token.token;
  }

  if (params.claudeSubscription) {
    if (params.claudeSubscription.kind !== 'token') {
      throw new Error('Claude subscription OAuth credentials are not supported. Reconnect using a Claude setup-token.');
    }
    env.ANTHROPIC_OAUTH_TOKEN = params.claudeSubscription.token.token;
  }

  if (params.anthropic) {
    if (params.anthropic.kind !== 'token') {
      throw new Error('Anthropic OAuth credentials are not supported. Reconnect using an Anthropic API key.');
    }
    env.ANTHROPIC_API_KEY = params.anthropic.token.token;
  }

  if (params.gemini) {
    env.GEMINI_API_KEY = params.gemini.kind === 'oauth'
      ? params.gemini.oauth.accessToken
      : params.gemini.token.token;
  }

  return { env };
}
