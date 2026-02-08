export type OAuthProviderStatus = Readonly<{
    enabled: boolean;
    configured: boolean;
}>;

export type GitHubOAuthConfig = Readonly<{
    status: OAuthProviderStatus;
    clientId: string | null;
    clientSecret: string | null;
    redirectUrl: string | null;
}>;

export function resolveGitHubOAuthConfigFromEnv(env: NodeJS.ProcessEnv): GitHubOAuthConfig {
    const clientId = env.GITHUB_CLIENT_ID?.toString().trim() || null;
    const clientSecret = env.GITHUB_CLIENT_SECRET?.toString().trim() || null;
    const redirectUrl = (env.GITHUB_REDIRECT_URL ?? env.GITHUB_REDIRECT_URI)?.toString().trim() || null;
    const configured = Boolean(clientId) && Boolean(clientSecret) && Boolean(redirectUrl);

    return Object.freeze({
        status: Object.freeze({ enabled: true, configured }),
        clientId,
        clientSecret,
        redirectUrl,
    });
}

