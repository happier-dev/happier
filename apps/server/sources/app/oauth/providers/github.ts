import type { OAuthFlowProvider, OAuthTokenExchangeResult } from "./types";
import { resolveGitHubOAuthConfigFromEnv } from "./githubOAuthConfig";
import { GitHubProfileSchema, type GitHubProfile } from "@/app/auth/providers/github/types";
import { shouldRequestReadOrgScopeForGitHub } from "@/app/auth/providers/github/restrictions";
import { resolveGitHubHttpTimeoutMs } from "@/app/auth/providers/github/httpTimeout";

function parseGitHubProfile(raw: unknown): GitHubProfile | null {
    const parsed = GitHubProfileSchema.safeParse(raw);
    if (!parsed.success) return null;
    return parsed.data;
}

async function safeReadResponseText(res: Response): Promise<string> {
    try {
        return await res.text();
    } catch {
        return "";
    }
}

async function parseJsonBodyWithFallback<T>(res: Response): Promise<{ data: T | null; bodyText: string; parseError: unknown | null }> {
    const canClone = typeof (res as any).clone === "function";
    if (canClone) {
        const bodyText = await safeReadResponseText((res as any).clone());
        try {
            const data = (await res.json()) as T;
            return { data, bodyText, parseError: null };
        } catch (parseError) {
            return { data: null, bodyText, parseError };
        }
    }

    // Fallback path for environments/mocks where Response.clone() is unavailable.
    // Prefer text-based parsing when possible to avoid double body consumption.
    if (typeof (res as any).text === "function") {
        const bodyText = await safeReadResponseText(res);
        let textParseError: unknown | null = null;

        if (bodyText.trim()) {
            try {
                const data = JSON.parse(bodyText) as T;
                return { data, bodyText, parseError: null };
            } catch (parseError) {
                textParseError = parseError;
            }
        }

        if (typeof (res as any).json === "function") {
            try {
                const data = (await (res as any).json()) as T;
                return { data, bodyText, parseError: null };
            } catch (jsonParseError) {
                return { data: null, bodyText, parseError: textParseError ?? jsonParseError };
            }
        }

        return { data: null, bodyText, parseError: textParseError ?? new Error("invalid json body") };
    }

    // Last-resort compatibility for sparse test doubles that only implement json().
    try {
        const data = (await (res as any).json()) as T;
        return { data, bodyText: "", parseError: null };
    } catch (parseError) {
        return { data: null, bodyText: "", parseError };
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
        const params: Record<string, string> = {
            client_id: cfg.clientId,
            redirect_uri: cfg.redirectUrl,
            scope,
            state,
        };
        if (codeChallenge && codeChallengeMethod) {
            params.code_challenge = codeChallenge;
            params.code_challenge_method = codeChallengeMethod;
        }
        const search = new URLSearchParams(params);
        return `https://github.com/login/oauth/authorize?${search.toString()}`;
    },
    exchangeCodeForAccessToken: async ({ env, code, pkceCodeVerifier }): Promise<OAuthTokenExchangeResult> => {
        const cfg = resolveGitHubOAuthConfigFromEnv(env);
        if (!cfg.clientId || !cfg.clientSecret) {
            throw new Error("oauth_not_configured");
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), resolveGitHubHttpTimeoutMs(env));
        let tokenResponse: Response;
        try {
            tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
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
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeoutId);
        }
        const parsedTokenResponse = await parseJsonBodyWithFallback<{
            access_token?: string;
            error?: string;
            error_description?: string;
        }>(tokenResponse);
        if (parsedTokenResponse.parseError) {
            const body = maybeOmitSensitiveBody(parsedTokenResponse.bodyText);
            const status = typeof (tokenResponse as any).status === "number" ? (tokenResponse as any).status : 0;
            throw new Error(
                `token_response_parse_failed (status=${status})${body ? ` body=${body}` : ""}${
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
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), resolveGitHubHttpTimeoutMs(env));
        let userResponse: Response;
        try {
            userResponse = await fetch("https://api.github.com/user", {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/vnd.github.v3+json",
                },
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timeoutId);
        }
        if (!userResponse.ok) {
            throw new Error("profile_fetch_failed");
        }
        const parsedProfileResponse = await parseJsonBodyWithFallback<unknown>(userResponse);
        if (parsedProfileResponse.parseError) {
            const body = maybeOmitSensitiveBody(parsedProfileResponse.bodyText);
            const status = typeof (userResponse as any).status === "number" ? (userResponse as any).status : 0;
            throw new Error(
                `profile_parse_failed (status=${status})${body ? ` body=${body}` : ""}${
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
