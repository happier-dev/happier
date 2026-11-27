import { isLoopbackHostname } from "@happier-dev/protocol/server/urls/loopbackHostname";

import { createOutboundFetch, createOutboundIdentityFetch } from "@/app/net/outboundIdentityFetch";
import { vendorIdentityEndpointNetworkPolicy, type OutboundIdentityNetworkPolicy } from "@/app/net/outboundIdentityNetworkPolicy";
import { resolveGitHubHttpTimeoutMs } from "@/app/auth/providers/github/httpTimeout";

/**
 * Endpoints of the env-configured GitHub OAuth provider and their outbound transport.
 *
 * `operatorConfigured` records whether the deployment operator replaced the github.com
 * default (GitHub Enterprise Server, local fakes). That choice selects the policy, so every
 * request uses the shared vendor identity endpoint policy: github.com defaults are public
 * unicast on 443, operator overrides keep addresses unfiltered because the operator chose the
 * host. Peer pinning, redirect rejection, loopback-only plaintext and the timeout apply to both.
 */
export type GitHubEndpoint = Readonly<{ url: string; operatorConfigured: boolean }>;

function resolveGitHubEndpoint(env: NodeJS.ProcessEnv, key: string, fallback: string): GitHubEndpoint {
    const raw = env[key]?.toString?.().trim?.() ?? "";
    if (!raw) return { url: fallback, operatorConfigured: false };
    try {
        const url = new URL(raw);
        if (url.protocol === "https:") return { url: url.toString(), operatorConfigured: true };
        if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return { url: url.toString(), operatorConfigured: true };
    } catch {
        // An unparseable override keeps the github.com default, exactly like an unsupported scheme.
    }
    return { url: fallback, operatorConfigured: false };
}

export function resolveGitHubOAuthAuthorizeEndpoint(env: NodeJS.ProcessEnv): GitHubEndpoint {
    return resolveGitHubEndpoint(env, "GITHUB_OAUTH_AUTHORIZE_URL", "https://github.com/login/oauth/authorize");
}

export function resolveGitHubOAuthTokenEndpoint(env: NodeJS.ProcessEnv): GitHubEndpoint {
    return resolveGitHubEndpoint(env, "GITHUB_OAUTH_TOKEN_URL", "https://github.com/login/oauth/access_token");
}

export function resolveGitHubApiUserEndpoint(env: NodeJS.ProcessEnv): GitHubEndpoint {
    return resolveGitHubEndpoint(env, "GITHUB_API_USER_URL", "https://api.github.com/user");
}

/** GitHub Sponsors is hosted on github.com, independently of a Home's profile endpoint. */
export function resolveGitHubApiGraphQLEndpoint(): GitHubEndpoint {
    return { url: "https://api.github.com/graphql", operatorConfigured: false };
}

function resolveGitHubOutboundPolicy(env: NodeJS.ProcessEnv, operatorConfigured: boolean): OutboundIdentityNetworkPolicy {
    return Object.freeze({ ...vendorIdentityEndpointNetworkPolicy(operatorConfigured), timeoutMs: resolveGitHubHttpTimeoutMs(env) });
}

/** One identity request through the pinned owner; the returned body is already buffered. */
export async function fetchGitHubEndpoint(env: NodeJS.ProcessEnv, endpoint: GitHubEndpoint, init: RequestInit): Promise<Response> {
    const outbound = createOutboundIdentityFetch({ policy: resolveGitHubOutboundPolicy(env, endpoint.operatorConfigured) });
    try {
        return await outbound.fetch(endpoint.url, init);
    } finally {
        await outbound.close();
    }
}

/**
 * The avatar URL is named by the profile endpoint, so it inherits that endpoint's trust.
 * An image is not an identity document: no response bound is imposed here, the media
 * owner (`processImage`) bounds decoded pixels.
 */
export async function fetchGitHubAvatar(env: NodeJS.ProcessEnv, avatarUrl: string): Promise<Response> {
    const { maxResponseBytes: _identityDocumentBound, ...policy } = resolveGitHubOutboundPolicy(
        env,
        resolveGitHubApiUserEndpoint(env).operatorConfigured,
    );
    const outbound = createOutboundFetch({ policy });
    try {
        return await outbound.fetch(avatarUrl);
    } finally {
        await outbound.close();
    }
}
