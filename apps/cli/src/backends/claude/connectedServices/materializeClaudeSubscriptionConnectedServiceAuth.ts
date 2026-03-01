import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

export function materializeClaudeSubscriptionConnectedServiceAuth(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
}>): Readonly<{ env: Record<string, string> }> {
  const env: Record<string, string> = {};

  if (params.record.kind === 'token') {
    env.CLAUDE_CODE_SETUP_TOKEN = params.record.token.token;
    return { env };
  }

  env.CLAUDE_CODE_OAUTH_TOKEN = params.record.oauth.accessToken;
  return { env };
}
