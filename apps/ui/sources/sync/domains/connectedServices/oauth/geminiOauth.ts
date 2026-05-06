import { requireConnectedAccountDescriptor } from '@happier-dev/protocol';

import { buildConnectedAccountAuthorizationUrl } from './connectedServiceOauthAdapters';

const GEMINI_DESCRIPTOR = requireConnectedAccountDescriptor('gemini');
if (!GEMINI_DESCRIPTOR.oauth) {
  throw new Error('Gemini descriptor is missing OAuth metadata');
}

export const GEMINI_OAUTH = Object.freeze({
  clientId: GEMINI_DESCRIPTOR.oauth.publicClientId.defaultValue,
  authorizeUrl: GEMINI_DESCRIPTOR.oauth.authorization.endpointUrl,
  defaultRedirectUri: GEMINI_DESCRIPTOR.oauth.authorization.defaultRedirectUri,
  scopes: GEMINI_DESCRIPTOR.oauth.authorization.scopes.join(' '),
});

export function buildGeminiAuthorizationUrl(params: Readonly<{
  redirectUri: string;
  state: string;
  challenge: string;
}>): string {
  return buildConnectedAccountAuthorizationUrl({
    descriptor: GEMINI_DESCRIPTOR,
    redirectUri: params.redirectUri,
    state: params.state,
    challenge: params.challenge,
  });
}
