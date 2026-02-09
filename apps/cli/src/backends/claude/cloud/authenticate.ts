/**
 * Anthropic authentication helper
 * 
 * Provides OAuth authentication flow for Anthropic Claude
 * Uses local callback server to handle OAuth redirect
 */

import { randomBytes } from 'crypto';
import { openBrowser } from '@/ui/openBrowser';
import { generatePkceCodes } from '@/cloud/pkce';
import { startLoopbackOauthPkceFlow } from '@/cloud/loopbackOauthPkce';

export interface ClaudeAuthTokens {
    raw: any;
    token: string;
    expires: number;
}

// Anthropic OAuth Configuration for Claude.ai
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_AI_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const DEFAULT_PORT = 54545;
const SCOPE = 'user:inference';

/**
 * Generate random state for OAuth security
 */
function generateState(): string {
    return randomBytes(32).toString('base64url');
}

/**
 * Exchange authorization code for tokens
 * The Anthropic SDK actually creates an API key, not standard OAuth tokens
 */
async function exchangeCodeForTokens(
    code: string,
    verifier: string,
    port: number,
    state: string
): Promise<ClaudeAuthTokens> {

    // Exchange code for tokens
    const tokenResponse = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            code: code,
            redirect_uri: `http://localhost:${port}/callback`,
            client_id: CLIENT_ID,
            code_verifier: verifier,
            state: state,
        }),
    });
    if (!tokenResponse.ok) {
        throw new Error(`Token exchange failed: ${tokenResponse.statusText}`);
    }

    // {
    //     token_type: 'Bearer',
    //     access_token: string,
    //     expires_in: number,
    //     refresh_token: string,
    //     scope: 'user:inference',
    //     organization: {
    //       uuid: string,
    //       name: string
    //     },
    //     account: {
    //       uuid: string,
    //       email_address: string
    //     }
    //   }
    const tokenData = await tokenResponse.json() as any;

    return {
        raw: tokenData,
        token: tokenData.access_token,
        expires: Date.now() + tokenData.expires_in * 1000,
    };
}

/**
 * Authenticate with Anthropic Claude and return tokens
 * 
 * This function handles the complete OAuth flow:
 * 1. Generates PKCE codes and state
 * 2. Starts local callback server
 * 3. Opens browser for authentication
 * 4. Handles callback and token exchange
 * 5. Returns complete token object
 * 
 * @returns Promise resolving to AnthropicAuthTokens with all token information
 */
export async function authenticateClaude(): Promise<ClaudeAuthTokens> {
    console.log('🚀 Starting Anthropic Claude authentication...');

    try {
        const tokens = await startLoopbackOauthPkceFlow({
            defaultPort: DEFAULT_PORT,
            callbackPath: '/callback',
            generateState,
            generatePkce: generatePkceCodes,
            onPortResolved: ({ defaultPort, port, usedFallback }) => {
                if (usedFallback) {
                    console.log(`Port ${defaultPort} is in use, finding an available port...`);
                }
                console.log(`📡 Using callback port: ${port}`);
            },
            buildAuthorizationUrl: ({ redirectUri, state, challenge }) => {
                const params = new URLSearchParams({
                    code: 'true', // This tells Claude.ai to show the code AND redirect
                    client_id: CLIENT_ID,
                    response_type: 'code',
                    redirect_uri: redirectUri,
                    scope: SCOPE,
                    code_challenge: challenge,
                    code_challenge_method: 'S256',
                    state,
                });
                return `${CLAUDE_AI_AUTHORIZE_URL}?${params}`;
            },
            openAuthorizationUrl: async ({ authorizationUrl }) => {
                console.log('📋 Opening browser for authentication...');
                console.log('If browser doesn\'t open, visit this URL:');
                console.log();
                console.log(`${authorizationUrl}`);
                console.log();
                await openBrowser(authorizationUrl);
            },
            exchangeCodeForTokens: ({ code, verifier, port, state }) =>
                exchangeCodeForTokens(code, verifier, port, state),
            onSuccessResponse: ({ res }) => {
                res.writeHead(302, {
                    Location: 'https://console.anthropic.com/oauth/code/success?app=claude-code',
                });
                res.end();
            },
        });

        console.log('🎉 Authentication successful!');
        console.log('✅ OAuth tokens received');
        return tokens;
    } catch (error) {
        console.error('\n❌ Failed to authenticate with Anthropic');
        throw error;
    }
}
