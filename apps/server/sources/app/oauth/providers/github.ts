import type { OAuthFlowProvider, OAuthTokenExchangeResult } from "./types";
import { resolveGitHubOAuthConfigFromEnv } from "./githubOAuthConfig";
import { GitHubProfileSchema, type GitHubProfile } from "@/app/auth/providers/github/types";
import { shouldRequestReadOrgScopeForGitHub } from "@/app/auth/providers/github/restrictions";
import {
    fetchGitHubEndpoint,
    resolveGitHubApiUserEndpoint,
    resolveGitHubOAuthAuthorizeEndpoint,
    resolveGitHubOAuthTokenEndpoint,
} from "@/app/auth/providers/github/endpoints";

function parseGitHubProfile(raw: unknown): GitHubProfile | null {
    const parsed = GitHubProfileSchema.safeParse(raw);
    if (!parsed.success) return null;
    return parsed.data;
}

/** The outbound owner returns a buffered `Response`, so the body is read once as text. */
async function readJsonBody<T>(res: Response): Promise<{ data: T | null; bodyText: string; parseError: unknown | null }> {
    const bodyText = await res.text();
    try {
        return { data: JSON.parse(bodyText) as T, bodyText, parseError: null };
    } catch (parseError) {
        return { data: null, bodyText, parseError };
    }
}

function maybeOmitSensitiveBody(body: string): string {
    const trimmed = body.trim();
    if (!trimmed) return "";
    if (trimmed.includes("access_token") || trimmed.includes("refresh_token") || trimmed.includes("id_token")) {
        return "[omitted]";
    }
    return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed;
}

export const githubOAuthProvider: OAuthFlowProvider = Object.freeze({
    id: "github",
    resolveStatus: (env) => resolveGitHubOAuthConfigFromEnv(env).status,
    isConfigured: (env) => resolveGitHubOAuthConfigFromEnv(env).status.configured,
    resolveRedirectUrl: (env) => resolveGitHubOAuthConfigFromEnv(env).redirectUrl,
    resolveScope: ({ env }) => {
        return shouldRequestReadOrgScopeForGitHub(env) ? "read:user read:org" : "read:user";
    },
    resolveAuthorizeUrl: async ({ env, state, scope, codeChallenge, codeChallengeMethod }) => {
        const cfg = resolveGitHubOAuthConfigFromEnv(env);
        if (!cfg.clientId || !cfg.redirectUrl) {
            throw new Error("oauth_not_configured");
        }
        const url = new URL(resolveGitHubOAuthAuthorizeEndpoint(env).url);
        url.searchParams.set("client_id", cfg.clientId);
        url.searchParams.set("redirect_uri", cfg.redirectUrl);
        url.searchParams.set("scope", scope);
        url.searchParams.set("state", state);
        if (codeChallenge && codeChallengeMethod) {
            url.searchParams.set("code_challenge", codeChallenge);
            url.searchParams.set("code_challenge_method", codeChallengeMethod);
        }
        return url.toString();
    },
    exchangeCodeForAccessToken: async ({ env, code, pkceCodeVerifier }): Promise<OAuthTokenExchangeResult> => {
        const cfg = resolveGitHubOAuthConfigFromEnv(env);
        if (!cfg.clientId || !cfg.clientSecret) {
            throw new Error("oauth_not_configured");
        }
        const tokenResponse = await fetchGitHubEndpoint(env, resolveGitHubOAuthTokenEndpoint(env), {
            method: "POST",
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                client_id: cfg.clientId,
                client_secret: cfg.clientSecret,
                code,
                ...(cfg.redirectUrl ? { redirect_uri: cfg.redirectUrl } : {}),
                ...(pkceCodeVerifier ? { code_verifier: pkceCodeVerifier } : {}),
            }),
        });
        const parsedTokenResponse = await readJsonBody<{
            access_token?: string;
            error?: string;
            error_description?: string;
        }>(tokenResponse);
        if (parsedTokenResponse.parseError) {
            const body = maybeOmitSensitiveBody(parsedTokenResponse.bodyText);
            throw new Error(
                `token_response_parse_failed (status=${tokenResponse.status})${body ? ` body=${body}` : ""}${
                    parsedTokenResponse.parseError instanceof Error ? ` cause=${parsedTokenResponse.parseError.message}` : ""
                }`,
            );
        }
        const tokenResponseData = parsedTokenResponse.data ?? {};
        if (tokenResponseData.error) {
            throw new Error(tokenResponseData.error);
        }
        const accessToken = tokenResponseData.access_token?.toString?.() ?? "";
        if (!accessToken) {
            throw new Error("missing_access_token");
        }
        return { accessToken };
    },
    fetchProfile: async ({ env, accessToken }): Promise<unknown> => {
        const userResponse = await fetchGitHubEndpoint(env, resolveGitHubApiUserEndpoint(env), {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/vnd.github.v3+json",
            },
        });
        if (!userResponse.ok) {
            throw new Error("profile_fetch_failed");
        }
        const parsedProfileResponse = await readJsonBody<unknown>(userResponse);
        if (parsedProfileResponse.parseError) {
            const body = maybeOmitSensitiveBody(parsedProfileResponse.bodyText);
            throw new Error(
                `profile_parse_failed (status=${userResponse.status})${body ? ` body=${body}` : ""}${
                    parsedProfileResponse.parseError instanceof Error ? ` cause=${parsedProfileResponse.parseError.message}` : ""
                }`,
            );
        }
        const raw = parsedProfileResponse.data;
        const profile = parseGitHubProfile(raw);
        if (!profile) {
            throw new Error("invalid_profile");
        }
        return profile;
    },
    getLogin: (profile) => {
        const login = (profile as any)?.login?.toString?.().trim?.() ?? "";
        return login ? login : null;
    },
    getProviderUserId: (profile) => {
        const id = (profile as any)?.id;
        const num = typeof id === "number" ? id : Number.NaN;
        if (!Number.isFinite(num) || num <= 0) return null;
        return String(num);
    },
});
