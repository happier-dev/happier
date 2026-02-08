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
}>;
