import { z } from 'zod';
import { AGY_OAUTH_SCOPES, AgyOauthAccountError, resolveAgyOauthAccount } from '@happier-dev/agents';
import { CONNECTED_SERVICE_ERROR_CODES } from '@happier-dev/protocol';

import type { OauthExchangePayload } from '../exchangeConnectedServiceOauthTokens';
import { ConnectedServiceOauthExchangeError, ConnectedServiceOauthStateMismatchError } from '../connectedServiceOauthErrors';
import { resolveAntigravityOauthConfig } from '../oauthConfig';

const TokenResponseSchema = z.object({
    access_token: z.string().trim().min(1),
    refresh_token: z.string().trim().min(1).optional(),
    id_token: z.string().trim().min(1).optional(),
    expires_in: z.number().finite().positive().optional(),
    scope: z.string().trim().min(1).optional(),
    token_type: z.string().trim().min(1).optional(),
});
const ProviderErrorSchema = z.object({ error: z.string().optional() });

/**
 * Exchanges the native PKCE grant and verifies its scopes, Google identity, and
 * provider-issued project before returning the payload for account-scoped sealing.
 * A consumed authorization code is never retried; all verification shares one signal.
 */
export async function exchangeAntigravityOauthTokens(params: Readonly<{
    code: string;
    verifier: string;
    redirectUri: string;
    state?: string | null;
    projectId?: string;
    now: number;
    fetcher: typeof fetch;
    signal: AbortSignal;
}>): Promise<OauthExchangePayload> {
    if (!params.state?.trim()) throw new ConnectedServiceOauthStateMismatchError();
    if (!params.verifier.trim()) throw new Error('Antigravity OAuth requires a PKCE verifier');
    const redirect = new URL(params.redirectUri);
    if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname)
        || redirect.username || redirect.password) {
        throw new Error('Antigravity OAuth requires a native loopback callback');
    }
    const config = resolveAntigravityOauthConfig();
    const response = await params.fetcher(config.tokenUrl, {
        method: 'POST',
        signal: params.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code', client_id: config.clientId, client_secret: config.clientSecret,
            code: params.code, code_verifier: params.verifier, redirect_uri: params.redirectUri,
        }),
    });
    if (!response.ok) {
        const error = ProviderErrorSchema.safeParse(await response.json().catch(() => null));
        const providerCode = error.success ? error.data.error : undefined;
        const errorCode = providerCode === 'invalid_grant' ? CONNECTED_SERVICE_ERROR_CODES.oauthInvalidGrant
            : providerCode === 'invalid_client' ? CONNECTED_SERVICE_ERROR_CODES.oauthInvalidClient
                : CONNECTED_SERVICE_ERROR_CODES.oauthExchangeFailed;
        throw new ConnectedServiceOauthExchangeError(errorCode, 'Antigravity OAuth token exchange failed');
    }
    const tokens = TokenResponseSchema.parse(await response.json());
    if (!tokens.refresh_token) {
        throw new ConnectedServiceOauthExchangeError(
            CONNECTED_SERVICE_ERROR_CODES.oauthMissingRefreshToken, 'Antigravity OAuth did not return a refresh token',
        );
    }
    const grantedScopes = new Set(tokens.scope?.split(/\s+/) ?? []);
    if (AGY_OAUTH_SCOPES.some((scope) => !grantedScopes.has(scope))) {
        throw new Error('Antigravity OAuth is missing required native ACP permissions; reconnect in the browser');
    }
    const verified = await resolveAgyOauthAccount({ accessToken: tokens.access_token, projectId: params.projectId,
        fetcher: params.fetcher, signal: params.signal, allowOnboarding: true }).catch((error: unknown) => {
        if (error instanceof AgyOauthAccountError) {
            throw new ConnectedServiceOauthExchangeError(
                error.kind === 'project_required' ? CONNECTED_SERVICE_ERROR_CODES.oauthProjectRequired
                    : CONNECTED_SERVICE_ERROR_CODES.oauthAccountIneligible,
                error.kind === 'project_required' ? 'Antigravity requires a verified Google Cloud project'
                    : 'Antigravity account eligibility must be verified',
            );
        }
        throw error;
    });
    return {
        serviceId: 'antigravity', accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
        idToken: tokens.id_token ?? null, scope: tokens.scope ?? null, tokenType: tokens.token_type ?? null,
        providerAccountId: verified.account.id, providerEmail: verified.account.email,
        expiresAt: tokens.expires_in ? params.now + Math.trunc(tokens.expires_in * 1000) : null,
        raw: { antigravity: verified.antigravity },
    };
}
