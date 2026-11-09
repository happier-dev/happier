import { parseOauthAuthorizationResponse } from '@happier-dev/protocol/connect/oauthAuthorizationResponse';

export function parseOauthCallbackUrl(params: Readonly<{ url: string; redirectUri: string; allowRawAuthorizationCode?: boolean }>): Readonly<{
  code?: string;
  state?: string;
  iss?: string;
  error?: string;
  rawAuthorizationCode?: true;
}> {
  const response = parseOauthAuthorizationResponse({ input: params.url, redirectUri: params.redirectUri, allowRawAuthorizationCode: params.allowRawAuthorizationCode });
  if (response.kind === 'invalid') return {};
  if (response.kind === 'rawAuthorizationCode') return { code: response.code, rawAuthorizationCode: true };
  const { kind: _kind, ...callback } = response;
  return callback;
}
