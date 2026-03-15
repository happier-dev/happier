import type { ConnectedServiceCredentialRecordV1 } from '@happier-dev/protocol';

export function materializeClaudeConnectedServiceAuth(params: Readonly<{
  record: ConnectedServiceCredentialRecordV1;
}>): Readonly<{ env: Record<string, string> }> {
  const env: Record<string, string> = {};
  if (params.record.kind === 'oauth') {
    throw new Error('Anthropic OAuth credentials are not supported. Reconnect using an Anthropic API key.');
  }
  env.ANTHROPIC_API_KEY = params.record.token.token;
  return {
    env,
  };
}
