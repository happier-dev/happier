/** The route every OAuth provider's browser redirect returns to on this Home. */
export const OAUTH_CALLBACK_ROUTE = '/v1/oauth/:provider/callback';

/**
 * The address `OAUTH_CALLBACK_ROUTE` answers at for one provider: what an administrator registers at
 * the provider, and what the flow presents as `redirect_uri`. Derived from the Home's public server
 * URL, never stored.
 */
export function oauthCallbackUrl(
  publicServerUrl: string,
  providerId: string,
): string {
  return `${publicServerUrl.replace(/\/$/u, '')}${OAUTH_CALLBACK_ROUTE.replace(':provider', providerId)}`;
}
