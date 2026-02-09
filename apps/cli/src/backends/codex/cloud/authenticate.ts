/**
 * Codex authentication helper
 * 
 * Provides OAuth authentication flow for OpenAI/ChatGPT
 * Returns full token object without storing or refreshing
 */

import { randomBytes } from 'crypto';
import { openBrowser } from '@/ui/openBrowser';
import { generatePkceCodes } from '@/cloud/pkce';
import { startLoopbackOauthPkceFlow } from '@/cloud/loopbackOauthPkce';

export interface CodexAuthTokens {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
}

// Configuration
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_BASE_URL = 'https://auth.openai.com';
const DEFAULT_PORT = 1455;

/**
 * Generate random state for OAuth security
 */
function generateState(): string {
    return randomBytes(16).toString('hex');
}

/**
 * Parse JWT token to extract payload
 */
function parseJWT(token: string): any {
    const parts = token.split('.');
    if (parts.length !== 3) {
        throw new Error('Invalid JWT format');
    }

    const payload = Buffer.from(parts[1], 'base64url').toString();
    return JSON.parse(payload);
}

/**
 * Exchange authorization code for tokens
 */
async function exchangeCodeForTokens(
    code: string,
    verifier: string,
    port: number
): Promise<CodexAuthTokens> {
    const response = await fetch(`${AUTH_BASE_URL}/oauth/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            code: code,
            code_verifier: verifier,
            redirect_uri: `http://localhost:${port}/auth/callback`,
        }),
    });

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
    }

    const data = (await response.json() as any);

    // Parse ID token to get account ID
    const idTokenPayload = parseJWT(data.id_token);

    // The account ID is stored at chatgpt_account_id in the payload
    let accountId = idTokenPayload.chatgpt_account_id;

    // Check nested location
    if (!accountId) {
        const authClaim = idTokenPayload['https://api.openai.com/auth'];
        if (authClaim && typeof authClaim === 'object') {
            accountId = authClaim.chatgpt_account_id || authClaim.account_id;
        }
    }

    return {
        id_token: data.id_token,
        access_token: data.access_token || data.id_token,
        refresh_token: data.refresh_token,
        account_id: accountId,
    };
}

/**
 * Authenticate with Codex/OpenAI and return tokens
 * 
 * This function handles the complete OAuth flow:
 * 1. Generates PKCE codes and state
 * 2. Starts local callback server
 * 3. Opens browser for authentication
 * 4. Handles callback and token exchange
 * 5. Returns complete token object
 * 
 * @returns Promise resolving to CodexAuthTokens with all token information
 */
export async function authenticateCodex(): Promise<CodexAuthTokens> {
    // console.log('🚀 Starting Codex authentication...');
    const tokens = await startLoopbackOauthPkceFlow({
        defaultPort: DEFAULT_PORT,
        callbackPath: '/auth/callback',
        generateState,
        generatePkce: generatePkceCodes,
        buildAuthorizationUrl: ({ redirectUri, state, challenge }) => {
            const params = [
                ['response_type', 'code'],
                ['client_id', CLIENT_ID],
                ['redirect_uri', redirectUri],
                ['scope', 'openid profile email offline_access'],
                ['code_challenge', challenge],
                ['code_challenge_method', 'S256'],
                ['id_token_add_organizations', 'true'],
                ['codex_cli_simplified_flow', 'true'],
                ['state', state],
            ];
            const queryString = params
                .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
                .join('&');
            return `${AUTH_BASE_URL}/oauth/authorize?${queryString}`;
        },
        openAuthorizationUrl: async ({ authorizationUrl }) => {
            console.log('📋 Opening browser for authentication...');
            console.log(`If browser doesn't open, visit:\n${authorizationUrl}\n`);
            await openBrowser(authorizationUrl);
        },
        exchangeCodeForTokens: ({ code, verifier, port }) => exchangeCodeForTokens(code, verifier, port),
        onSuccessResponse: ({ res }) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
                        <html>
                        <body style="font-family: sans-serif; padding: 20px;">
                            <h2>✅ Authentication Successful!</h2>
                            <p>You can close this window and return to your terminal.</p>
                            <script>setTimeout(() => window.close(), 3000);</script>
                        </body>
                        </html>
                    `);
        },
    });

    console.log('🎉 Authentication successful!');
    // console.log(`Account ID: ${tokens.account_id || 'N/A'}`);

    return tokens;
}
