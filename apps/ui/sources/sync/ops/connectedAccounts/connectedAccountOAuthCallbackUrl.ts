import { CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1 } from '@happier-dev/protocol/connect/oauthAuthorizationResponse';
import { MCP_OAUTH_CALLBACK_URL_V1 } from '@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1';

type CallbackBrowser = Readonly<{
  location: Pick<Location, 'href'>;
  history: Pick<History, 'state' | 'replaceState'>;
}>;

let captured: Readonly<{ callbackUrl: string; originalUrl: string }> | null = null;

/** Take volatile custody before Expo reads the browser's initial URL. */
export function captureConnectedAccountOAuthCallbackUrl(
  browser: CallbackBrowser | undefined = typeof window === 'undefined' || !window.location || !window.history ? undefined : window,
): void {
  if (!browser) return;
  const url = new URL(browser.location.href);
  const pathname = url.pathname.replace(/\/+$/, '');
  const callbackUrl = [CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1, MCP_OAUTH_CALLBACK_URL_V1]
    .find(callback => new URL(callback).pathname === pathname);
  if (!callbackUrl || !url.search) return;
  captured = { callbackUrl, originalUrl: `${callbackUrl}${url.search}` };
  browser.history.replaceState(browser.history.state, '', new URL(callbackUrl).pathname);
}

/** Reading during render is repeatable, including StrictMode's initial render replay. */
export function readCapturedConnectedAccountOAuthCallbackUrl(callbackUrl: string): string | undefined {
  return captured?.callbackUrl === callbackUrl ? captured.originalUrl : undefined;
}

/** Once the mounted controller has custody, release the entry-point copy. */
export function releaseCapturedConnectedAccountOAuthCallbackUrl(callbackUrl: string): void {
  if (captured?.callbackUrl === callbackUrl) captured = null;
}
