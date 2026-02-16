import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

export function materializeClaudeConnectedServiceAuth(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
}>): Readonly<{ env: Record<string, string> }> {
  const env: Record<string, string> = {};
  if (params.record.kind === 'oauth') {
    env.CLAUDE_CODE_OAUTH_TOKEN = params.record.oauth.accessToken;
  } else {
    env.CLAUDE_CODE_SETUP_TOKEN = params.record.token.token;
  }
  return {
    env,
  };
}
