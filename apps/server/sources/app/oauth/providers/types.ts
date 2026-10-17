export type OAuthProviderStatus = Readonly<{
    enabled: boolean;
    configured: boolean;
}>;

export type OAuthTokenExchangeResult = Readonly<{
    accessToken: string;
    idToken?: string;
    idTokenClaims?: unknown;
    refreshToken?: string;
}>;

/**
 * Outcome of checking an access token the caller obtained from the identity provider
 * itself, outside this server's sign-in flow. `profile` is the provider's own answer
 * about the token's user, so it feeds `getProviderUserId` like a sign-in profile does.
 */
export type ExternalAccessTokenVerification =
    | Readonly<{ ok: true; profile: unknown }>
    | Readonly<{ ok: false; error: "invalid-token" | "client-not-allowed" | "upstream_error" }>;

export type OAuthFlowProvider = Readonly<{
    id: string;
    resolveStatus: (env: NodeJS.ProcessEnv) => OAuthProviderStatus;
    isConfigured: (env: NodeJS.ProcessEnv) => boolean;
    resolveRedirectUrl: (env: NodeJS.ProcessEnv) => string | null;
    resolveScope: (params: { env: NodeJS.ProcessEnv; flow: "auth" | "connect" }) => string;
    resolveAuthorizeUrl: (params: {
        env: NodeJS.ProcessEnv;
        state: string;
        scope: string;
        codeChallenge?: string;
        codeChallengeMethod?: "S256";
        nonce?: string;
    }) => Promise<string>;
    exchangeCodeForAccessToken: (params: {
        env: NodeJS.ProcessEnv;
        code: string;
        state?: string;
        iss?: string;
        pkceCodeVerifier?: string;
        expectedNonce?: string;
    }) => Promise<OAuthTokenExchangeResult>;
    fetchProfile: (params: {
        env: NodeJS.ProcessEnv;
        accessToken: string;
        idToken?: string;
        idTokenClaims?: unknown;
    }) => Promise<unknown>;
    getLogin: (profile: unknown) => string | null;
    getProviderUserId: (profile: unknown) => string | null;
    /** Present only when the operator enabled access-token exchange for this provider. */
    verifyExternalAccessToken?: (params: { accessToken: string }) => Promise<ExternalAccessTokenVerification>;
}>;
