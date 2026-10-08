/**
 * Antigravity personal OAuth authentication
 *
 * Provides OAuth authentication flow for Antigravity
 * Uses local callback server to handle OAuth redirect
 */

import { randomBytes } from 'crypto';
import {
    AGY_OAUTH_AUTHORIZE_URL,
    AGY_OAUTH_SCOPES,
    AGY_OAUTH_CLIENT_ID,
    AGY_OAUTH_CLIENT_SECRET,
    AGY_OAUTH_TOKEN_URL,
    resolveAgyOauthAccount,
} from '@happier-dev/agents';
import { generatePkceCodes } from '@/cloud/pkce';
import { buildSafeOauthProviderFailureMessage } from '@/cloud/safeOauthProviderError';
import { openBrowser } from '@/ui/openBrowser';
import type { CloudConnectAuthenticateOptions } from '@/cloud/connectTypes';
import { startOauthPkceWithPasteFallback } from '@/cloud/oauthPkceWithPasteFallback';
import { promptInput } from '@/terminal/prompts/promptInput';
import { CONNECTED_SERVICE_OAUTH_REFRESH_FETCH_TIMEOUT_MS } from '@/daemon/connectedServices/refresh/serviceRefreshers';
import { dim, fail, info, ok } from '@happier-dev/cli-common/output';

export interface AgyAuthTokens {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number;
    scope: string;
    id_token?: string;
}

// Native Antigravity OAuth configuration
const DEFAULT_PORT = 51121;
const SCOPES = AGY_OAUTH_SCOPES.join(' ');

/** Exchanges a one-use native OAuth code with PKCE and preserves cancellation through response parsing. */
export async function exchangeAgyAuthorizationCodeForTokens(params: Readonly<{
    code: string;
    verifier: string;
    redirectUri: string;
}>): Promise<AgyAuthTokens> {
    const clientId = AGY_OAUTH_CLIENT_ID;
    const clientSecret = AGY_OAUTH_CLIENT_SECRET;
    const tokenUrl = AGY_OAUTH_TOKEN_URL;
    const response = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        signal: AbortSignal.timeout(CONNECTED_SERVICE_OAUTH_REFRESH_FETCH_TIMEOUT_MS),
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            code: params.code,
            code_verifier: params.verifier,
            redirect_uri: params.redirectUri,
        }),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(buildSafeOauthProviderFailureMessage({
            operation: 'Token exchange',
            status: response.status,
            statusText: response.statusText,
            body,
        }));
    }

    const data = (await response.json()) as AgyAuthTokens;
    return data;
}

/**
 * Generate random state for OAuth security
 */
function generateState(): string {
    return randomBytes(32).toString('hex');
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(
    code: string,
    verifier: string,
    port: number
): Promise<AgyAuthTokens> {
    return exchangeAgyAuthorizationCodeForTokens({
        code,
        verifier,
        redirectUri: `http://localhost:${port}/oauth2callback`,
    });
}

/**
 * Authenticate with Antigravity and return tokens
 *
 * This function handles the complete OAuth flow:
 * 1. Generates PKCE codes and state
 * 2. Starts local callback server
 * 3. Opens browser for authentication
 * 4. Handles callback and token exchange
 * 5. Returns complete token object
 *
 * @returns Promise resolving to AgyAuthTokens with all token information
 */
/** Connects a Google account through a local callback or pasted return URL, then verifies its ACP access. */
export async function authenticateAgy(opts?: CloudConnectAuthenticateOptions): Promise<AgyAuthTokens & Awaited<ReturnType<typeof resolveAgyOauthAccount>>> {
    console.log(info('Signing in to Antigravity'));

    try {
        const mode = opts?.paste ? 'paste' : 'loopback';
        const timeoutMs = typeof opts?.timeoutSeconds === 'number' && Number.isFinite(opts.timeoutSeconds)
            ? Math.max(1, Math.trunc(opts.timeoutSeconds)) * 1000
            : undefined;

        const tokens = await startOauthPkceWithPasteFallback({
            mode,
            defaultPort: DEFAULT_PORT,
            callbackPath: '/oauth2callback',
            generateState,
            generatePkce: generatePkceCodes,
            timeoutMs,
            onPortResolved: ({ defaultPort, port, usedFallback }) => {
                if (usedFallback) {
                    console.log(`Port ${defaultPort} is in use, finding an available port...`);
                }
                console.log(dim(`  Using callback port ${port}`));
            },
            buildAuthorizationUrl: ({ redirectUri, state, challenge }) => {
                const clientId = AGY_OAUTH_CLIENT_ID;
                const params = new URLSearchParams({
                    client_id: clientId,
                    response_type: 'code',
                    redirect_uri: redirectUri,
                    scope: SCOPES,
                    access_type: 'offline', // To get refresh token
                    code_challenge: challenge,
                    code_challenge_method: 'S256',
                    state,
                    prompt: 'consent', // Force consent to get refresh token
                });
                return `${AGY_OAUTH_AUTHORIZE_URL}?${params}`;
            },
            onAuthorizationUrl: ({ authorizationUrl }) => {
                console.log('\nOpen this URL in a browser to authenticate:\n');
                console.log(authorizationUrl);
                console.log('\nAfter login, paste the final redirected URL here.\n');
            },
            promptForPastedRedirectUrl: () => promptInput('Paste redirect URL: '),
            openAuthorizationUrl: async ({ authorizationUrl }) => {
                if (opts?.noOpen) return;
                console.log(info('Opening your browser to sign in'));
                console.log('If browser doesn\'t open, visit this URL:');
                console.log(`\n${authorizationUrl}\n`);
                await openBrowser(authorizationUrl);
            },
            exchangeCodeForTokens: ({ code, verifier, port }) =>
                exchangeCodeForTokens(code, verifier, port),
            onCallbackErrorParam: ({ res }) => {
                res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Antigravity authorization failed. Return to Happier and try again.');
                throw new Error('Antigravity browser authorization was declined or failed');
            },
            onSuccessResponse: ({ res }) => {
                res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Antigravity connected. Return to Happier.');
            },
        });

        if (!tokens.refresh_token || !tokens.scope?.split(/\s+/).includes('https://www.googleapis.com/auth/aicode')) throw new Error('Antigravity authorization requires the official ACP scopes; reconnect in your browser');
        const verified = await resolveAgyOauthAccount({ accessToken: tokens.access_token, projectId: opts?.projectId, signal: AbortSignal.timeout(CONNECTED_SERVICE_OAUTH_REFRESH_FETCH_TIMEOUT_MS) });
        console.log(ok('Signed in to Antigravity'));
        return { ...tokens, ...verified };
    } catch (error) {
        console.error(fail('Could not sign in to Google'));
        throw error;
    }
}
