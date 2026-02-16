/**
 * OAuth PKCE helper with a headless fallback
 *
 * Provides a generalized wrapper around `startLoopbackOauthPkceFlow` that supports a "paste the redirect URL"
 * flow for remote/headless machines where loopback callbacks are not practical.
 */

import type { OauthPkceCodes, StartLoopbackOauthPkceFlowOptions } from '@/cloud/loopbackOauthPkce';
import { startLoopbackOauthPkceFlow } from '@/cloud/loopbackOauthPkce';
import { parseOauthRedirectPaste } from '@/cloud/parseOauthRedirectPaste';

export type OauthPkceMode = 'loopback' | 'paste';

export type StartOauthPkceWithPasteFallbackOptions<TTokens> = Readonly<{
  mode: OauthPkceMode;
  defaultPort: number;
  callbackPath: `/${string}`;
  buildAuthorizationUrl: (params: {
    port: number;
    state: string;
    challenge: string;
    redirectUri: string;
  }) => string;
  exchangeCodeForTokens: (params: {
    code: string;
    verifier: string;
    state: string;
    port: number;
  }) => Promise<TTokens>;
  openAuthorizationUrl?: StartLoopbackOauthPkceFlowOptions<TTokens>['openAuthorizationUrl'];
  onSuccessResponse?: StartLoopbackOauthPkceFlowOptions<TTokens>['onSuccessResponse'];
  onCallbackErrorParam?: StartLoopbackOauthPkceFlowOptions<TTokens>['onCallbackErrorParam'];
  onTokenExchangeErrorResponse?: StartLoopbackOauthPkceFlowOptions<TTokens>['onTokenExchangeErrorResponse'];
  onPortResolved?: StartLoopbackOauthPkceFlowOptions<TTokens>['onPortResolved'];
  generateState?: StartLoopbackOauthPkceFlowOptions<TTokens>['generateState'];
  generatePkce?: (() => OauthPkceCodes);
  timeoutMs?: number;
  startupDelayMs?: number;
  promptForPastedRedirectUrl?: () => Promise<string>;
  onAuthorizationUrl?: (params: {
    authorizationUrl: string;
    redirectUri: string;
    state: string;
    port: number;
  }) => void;
  startLoopbackOauthPkceFlowFn?: (opts: StartLoopbackOauthPkceFlowOptions<TTokens>) => Promise<TTokens>;
}>;

export async function startOauthPkceWithPasteFallback<TTokens>(
  opts: StartOauthPkceWithPasteFallbackOptions<TTokens>,
): Promise<TTokens> {
  const startLoopback =
    opts.startLoopbackOauthPkceFlowFn ?? ((o) => startLoopbackOauthPkceFlow<TTokens>(o));

  if (opts.mode === 'loopback') {
    if (!opts.openAuthorizationUrl) {
      throw new Error('Missing openAuthorizationUrl for loopback OAuth mode');
    }
    return await startLoopback({
      defaultPort: opts.defaultPort,
      callbackPath: opts.callbackPath,
      buildAuthorizationUrl: opts.buildAuthorizationUrl,
      openAuthorizationUrl: opts.openAuthorizationUrl,
      exchangeCodeForTokens: opts.exchangeCodeForTokens,
      onSuccessResponse: opts.onSuccessResponse,
      onCallbackErrorParam: opts.onCallbackErrorParam,
      onTokenExchangeErrorResponse: opts.onTokenExchangeErrorResponse,
      onPortResolved: opts.onPortResolved,
      generateState: opts.generateState,
      generatePkce: opts.generatePkce,
      timeoutMs: opts.timeoutMs,
      startupDelayMs: opts.startupDelayMs,
    });
  }

  const generateState = opts.generateState ?? (() => crypto.randomUUID());
  const generatePkce = opts.generatePkce ?? (() => {
    throw new Error('Missing generatePkce for paste OAuth mode');
  });
  const prompt = opts.promptForPastedRedirectUrl ?? (() => {
    throw new Error('Missing promptForPastedRedirectUrl for paste OAuth mode');
  });

  const port = opts.defaultPort;
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const redirectUri = `http://localhost:${port}${opts.callbackPath}`;
  const authorizationUrl = opts.buildAuthorizationUrl({ port, state, challenge, redirectUri });

  // We intentionally do not attempt to open a browser in paste mode; callers should display the URL.
  opts.onAuthorizationUrl?.({ authorizationUrl, redirectUri, state, port });

  const pasted = await prompt();
  const parsed = parseOauthRedirectPaste({ pasted });
  if (!parsed.ok) {
    throw new Error(`Invalid OAuth redirect paste (${parsed.error})`);
  }
  if (parsed.state !== state) {
    throw new Error('OAuth state mismatch');
  }

  return await opts.exchangeCodeForTokens({
    code: parsed.code,
    verifier,
    state,
    port,
  });
}
