import { requireConnectedAccountDescriptor } from '@happier-dev/protocol';

import { buildConnectedAccountAuthorizationUrl } from './connectedServiceOauthAdapters';

const OPENAI_CODEX_DESCRIPTOR = requireConnectedAccountDescriptor('openai-codex');
if (!OPENAI_CODEX_DESCRIPTOR.oauth) {
  throw new Error('OpenAI Codex descriptor is missing OAuth metadata');
}

export const OPENAI_CODEX_OAUTH = Object.freeze({
  clientId: OPENAI_CODEX_DESCRIPTOR.oauth.publicClientId.defaultValue,
  authBaseUrl: new URL(OPENAI_CODEX_DESCRIPTOR.oauth.authorization.endpointUrl).origin,
  defaultRedirectUri: OPENAI_CODEX_DESCRIPTOR.oauth.authorization.defaultRedirectUri,
  scope: OPENAI_CODEX_DESCRIPTOR.oauth.authorization.scopes.join(' '),
});

export function buildOpenAiCodexAuthorizationUrl(params: Readonly<{
  redirectUri: string;
  state: string;
  challenge: string;
}>): string {
  return buildConnectedAccountAuthorizationUrl({
    descriptor: OPENAI_CODEX_DESCRIPTOR,
    redirectUri: params.redirectUri,
    state: params.state,
    challenge: params.challenge,
  });
}
