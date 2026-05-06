import { requireConnectedAccountDescriptor } from '@happier-dev/protocol';

import { buildConnectedAccountAuthorizationUrl } from './connectedServiceOauthAdapters';

const CLAUDE_SUBSCRIPTION_DESCRIPTOR = requireConnectedAccountDescriptor('claude-subscription');
if (!CLAUDE_SUBSCRIPTION_DESCRIPTOR.oauth) {
  throw new Error('Claude subscription descriptor is missing OAuth metadata');
}

export const CLAUDE_SUBSCRIPTION_OAUTH = Object.freeze({
  clientId: CLAUDE_SUBSCRIPTION_DESCRIPTOR.oauth.publicClientId.defaultValue,
  authBaseUrl: new URL(CLAUDE_SUBSCRIPTION_DESCRIPTOR.oauth.authorization.endpointUrl).origin,
  defaultRedirectUri: CLAUDE_SUBSCRIPTION_DESCRIPTOR.oauth.authorization.defaultRedirectUri,
  scope: CLAUDE_SUBSCRIPTION_DESCRIPTOR.oauth.authorization.scopes.join(' '),
});

export function buildClaudeSubscriptionAuthorizationUrl(params: Readonly<{
  redirectUri: string;
  state: string;
  challenge: string;
}>): string {
  return buildConnectedAccountAuthorizationUrl({
    descriptor: CLAUDE_SUBSCRIPTION_DESCRIPTOR,
    redirectUri: params.redirectUri,
    state: params.state,
    challenge: params.challenge,
  });
}
