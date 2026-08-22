import type {
    OauthCredentialRecord,
    TokenCredentialRecord,
} from '@happier-dev/plugin-sdk/connected-accounts';

export function materializeClaudeApiKeyAuth(params: Readonly<{
    record: OauthCredentialRecord | TokenCredentialRecord;
}>): Readonly<{ env: Record<string, string> }> {
    const env: Record<string, string> = {};
    if (params.record.kind === 'oauth') {
        throw new Error('Anthropic OAuth credentials are not supported. Reconnect using an Anthropic API key.');
    }
    env.ANTHROPIC_API_KEY = params.record.token.token;
    return { env };
}
