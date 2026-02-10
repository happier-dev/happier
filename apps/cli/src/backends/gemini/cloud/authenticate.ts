/**
 * Gemini/Google authentication helper
 * 
 * Provides OAuth authentication flow for Google Gemini
 * Uses local callback server to handle OAuth redirect
 */

import { randomBytes } from 'crypto';
import { generatePkceCodes } from '@/cloud/pkce';
import { startLoopbackOauthPkceFlow } from '@/cloud/loopbackOauthPkce';
import { openBrowser } from '@/ui/openBrowser';

export interface GeminiAuthTokens {
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number;
    scope: string;
    id_token?: string;
}

// Google OAuth Configuration for Gemini
const CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const CLIENT_SECRET = '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';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_PORT = 54545;
const SCOPES = [
    'https://www.googleapis.com/auth/cloud-platform',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

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
): Promise<GeminiAuthTokens> {
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            code: code,
            code_verifier: verifier,
            redirect_uri: `http://localhost:${port}/oauth2callback`,
        }),
    });
    
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Token exchange failed: ${error}`);
    }
    
    const data = await response.json() as GeminiAuthTokens;
    return data;
}

/**
 * Authenticate with Google Gemini and return tokens
 * 
 * This function handles the complete OAuth flow:
 * 1. Generates PKCE codes and state
 * 2. Starts local callback server
 * 3. Opens browser for authentication
 * 4. Handles callback and token exchange
 * 5. Returns complete token object
 * 
 * @returns Promise resolving to GeminiAuthTokens with all token information
 */
export async function authenticateGemini(): Promise<GeminiAuthTokens> {
    console.log('🚀 Starting Google Gemini authentication...');

    try {
        const tokens = await startLoopbackOauthPkceFlow({
            defaultPort: DEFAULT_PORT,
            callbackPath: '/oauth2callback',
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
                    client_id: CLIENT_ID,
                    response_type: 'code',
                    redirect_uri: redirectUri,
                    scope: SCOPES,
                    access_type: 'offline', // To get refresh token
                    code_challenge: challenge,
                    code_challenge_method: 'S256',
                    state,
                    prompt: 'consent', // Force consent to get refresh token
                });
                return `${AUTHORIZE_URL}?${params}`;
            },
            openAuthorizationUrl: async ({ authorizationUrl }) => {
                console.log('\n📋 Opening browser for authentication...');
                console.log('If browser doesn\'t open, visit this URL:');
                console.log(`\n${authorizationUrl}\n`);
                await openBrowser(authorizationUrl);
            },
            exchangeCodeForTokens: ({ code, verifier, port }) =>
                exchangeCodeForTokens(code, verifier, port),
            onCallbackErrorParam: ({ error, res }) => {
                res.writeHead(302, {
                    Location: 'https://developers.google.com/gemini-code-assist/auth_failure_gemini',
                });
                res.end();
                throw new Error(`Authentication error: ${error}`);
            },
            onSuccessResponse: ({ res }) => {
                res.writeHead(302, {
                    Location: 'https://developers.google.com/gemini-code-assist/auth_success_gemini',
                });
                res.end();
            },
        });
        
        console.log('\n🎉 Authentication successful!');
        console.log('✅ OAuth tokens received');
        
        return tokens;
    } catch (error) {
        console.error('\n❌ Failed to authenticate with Google');
        throw error;
    }
}
