import { createHash } from "node:crypto";

import * as oidcClient from "openid-client";

import { createOutboundIdentityFetch, type OutboundIdentityFetch } from "@/app/net/outboundIdentityFetch";
import {
    evaluateOutboundUrl,
    IDENTITY_ENDPOINT_MAX_HEADER_BYTES,
    IDENTITY_ENDPOINT_MAX_RESPONSE_BYTES,
    OutboundIdentityEndpointError,
    redactEndpoint,
    type OutboundIdentityNetworkPolicy,
} from "@/app/net/outboundIdentityNetworkPolicy";
import type { OidcAuthProviderInstanceConfig } from "@/app/auth/providers/oidc/oidcProviderConfig";
import { isLoopbackHostname } from '@happier-dev/protocol/server/urls/loopbackHostname';

type CachedDiscovery = Readonly<{
    instanceId: string;
    runtimeFingerprint: string;
    issuer: string;
    clientId: string;
    /** Digest of the exact credentials this configuration authenticates with; never the secret. */
    credentialDigest: string;
    config: oidcClient.Configuration;
    outbound: OutboundIdentityFetch;
    expiresAtMs: number;
}>;

const DISCOVERY_TTL_MS = 10 * 60 * 1000;

/**
 * Keyed by provider instance **and** runtime fingerprint, because one provider instance is
 * reachable as a Home method and through each Team connection at the same time. Keying by
 * instance alone made each resolution evict the other and destroy its in-flight transport.
 */
const discoveryCache = new Map<string, CachedDiscovery>();

function discoveryCacheKey(instanceId: string, runtimeFingerprint: string): string {
    return `${instanceId}\u0000${runtimeFingerprint}`;
}

function credentialDigest(instance: OidcAuthProviderInstanceConfig): string {
    return createHash("sha256")
        .update(`${instance.issuer}\u0000${instance.clientId}\u0000${instance.clientSecret}`)
        .digest("hex");
}

/**
 * Outbound policy for a deployment-configured (env/file) OIDC provider.
 *
 * The deployment operator already chose the issuer, so addresses stay unfiltered
 * and every released private-network issuer keeps working. Scheme, peer pinning,
 * redirect rejection, response bounds, and the timeout still apply, and plaintext
 * HTTP remains restricted to loopback exactly as `oidcProviderConfig` validates it.
 */
export function deploymentConfiguredOidcNetworkPolicy(
    instance: OidcAuthProviderInstanceConfig,
): OutboundIdentityNetworkPolicy {
    return Object.freeze({
        address: Object.freeze({ kind: "deploymentConfigured" as const }),
        allowedPorts: "any" as const,
        allowLoopbackHttp: true,
        maxResponseBytes: IDENTITY_ENDPOINT_MAX_RESPONSE_BYTES,
        maxHeaderBytes: IDENTITY_ENDPOINT_MAX_HEADER_BYTES,
        timeoutMs: instance.httpTimeoutSeconds * 1000,
    });
}

function evictDiscovery(key: string): void {
    const cached = discoveryCache.get(key);
    if (!cached) return;
    discoveryCache.delete(key);
    void cached.outbound.close();
}

/**
 * Reclaims the runtimes of one instance that no lookup will ever return again, because the
 * compound key means a superseded runtime is never touched: rotating the client secret, issuer
 * or client id makes every other credential identity unable to authenticate, and a connection
 * revision, security revision or network-policy change mints a new fingerprint and abandons the
 * old one. Both leave an open undici dispatcher, so they are closed here rather than retained
 * for the process lifetime. Expiry is the same TTL the hit path already treats as unusable.
 */
function reclaimUnreachableDiscovery(instanceId: string, currentCredentialDigest: string, now: number): void {
    for (const [key, cached] of [...discoveryCache]) {
        if (cached.instanceId !== instanceId) continue;
        if (cached.credentialDigest === currentCredentialDigest && cached.expiresAtMs > now) continue;
        evictDiscovery(key);
    }
}

export async function discoverOidcConfiguration(
    instance: OidcAuthProviderInstanceConfig,
    runtimeFingerprint: string,
    networkPolicy: OutboundIdentityNetworkPolicy = deploymentConfiguredOidcNetworkPolicy(instance),
): Promise<oidcClient.Configuration> {
    const key = discoveryCacheKey(instance.id, runtimeFingerprint);
    const currentCredentialDigest = credentialDigest(instance);
    const cached = discoveryCache.get(key);
    const now = Date.now();
    if (cached) {
        if (cached.issuer !== instance.issuer || cached.clientId !== instance.clientId) {
            evictDiscovery(key);
            throw new Error("oidc_runtime_fingerprint_mismatch");
        }
        if (cached.credentialDigest === currentCredentialDigest && cached.expiresAtMs > now) return cached.config;
        evictDiscovery(key);
    }
    reclaimUnreachableDiscovery(instance.id, currentCredentialDigest, now);

    let issuer: URL;
    try {
        issuer = new URL(instance.issuer);
    } catch {
        throw new OutboundIdentityEndpointError(
            "outbound_scheme_forbidden",
            "<unparseable-issuer>",
            "issuer is not a valid absolute URL",
        );
    }

    // The connector owns the loopback-development decision. No discovery, token, or
    // UserInfo call may independently opt out of TLS or address validation.
    const allowsInsecureIssuer =
        issuer.protocol === "http:" && networkPolicy.allowLoopbackHttp && isLoopbackHostname(issuer.hostname);

    const outbound = createOutboundIdentityFetch({ policy: networkPolicy });
    const execute: Array<(config: oidcClient.Configuration) => void> = [oidcClient.enableNonRepudiationChecks];
    if (allowsInsecureIssuer) execute.push(oidcClient.allowInsecureRequests);

    const options: oidcClient.DiscoveryRequestOptions = {
        timeout: instance.httpTimeoutSeconds,
        // Retained by `openid-client` for JWKS, token, refresh, and UserInfo requests.
        [oidcClient.customFetch]: outbound.fetch as oidcClient.CustomFetch,
        execute,
    };

    let config: oidcClient.Configuration;
    try {
        config = await oidcClient.discovery(
            issuer,
            instance.clientId,
            instance.clientSecret,
            instance.clientAuthenticationMethod === "client_secret_basic"
                ? oidcClient.ClientSecretBasic(instance.clientSecret)
                : oidcClient.ClientSecretPost(instance.clientSecret),
            options,
        );
        assertDiscoveredOidcMetadata(config, instance.issuer, networkPolicy);
    } catch (error) {
        await outbound.close();
        throw error;
    }

    discoveryCache.set(key, {
        instanceId: instance.id, runtimeFingerprint,
        issuer: instance.issuer, clientId: instance.clientId,
        credentialDigest: currentCredentialDigest,
        config, outbound, expiresAtMs: now + DISCOVERY_TTL_MS,
    });
    return config;
}

/**
 * Microsoft Entra ID's global authority, the origin `openid-client` itself treats as Entra
 * (`handleEntraId`). Its `/common`, `/organizations`, `/consumers` and tenant-domain issuers
 * discover a different issuer: the `{tenantid}` template or the tenant's GUID issuer.
 * `openid-client` then validates every ID token's `iss` against that discovered issuer with
 * the template filled from the token's own `tid` claim, so a token can only name its tenant.
 */
const ENTRA_AUTHORITY_ORIGIN = "https://login.microsoftonline.com";

function isEntraAuthority(issuer: unknown): boolean {
    if (typeof issuer !== "string") return false;
    try {
        return new URL(issuer).origin === ENTRA_AUTHORITY_ORIGIN;
    } catch {
        return false;
    }
}

function assertDiscoveredOidcMetadata(
    config: oidcClient.Configuration,
    expectedIssuer: string,
    networkPolicy: OutboundIdentityNetworkPolicy,
): void {
    const metadata = config.serverMetadata();
    const entra = isEntraAuthority(expectedIssuer);
    if (metadata.issuer !== expectedIssuer && !(entra && isEntraAuthority(metadata.issuer))) {
        throw new Error("oidc_issuer_mismatch");
    }
    if (
        !Array.isArray(metadata.response_types_supported)
        || !metadata.response_types_supported.includes("code")
    ) {
        throw new Error("oidc_authorization_code_unsupported");
    }
    // Entra supports S256 but omits `code_challenge_methods_supported` from discovery; an
    // advertised list is still checked, for Entra and every other issuer.
    const pkceMethods = metadata.code_challenge_methods_supported;
    const supportsS256 = Array.isArray(pkceMethods) ? pkceMethods.includes("S256") : pkceMethods === undefined && entra;
    if (!supportsS256) {
        throw new Error("oidc_pkce_s256_unsupported");
    }

    if (typeof metadata.authorization_endpoint !== "string") {
        throw new OutboundIdentityEndpointError(
            "outbound_host_forbidden",
            "<missing-authorization-endpoint>",
            "discovery did not return an authorization endpoint",
        );
    }

    let authorizationEndpoint: URL;
    try {
        authorizationEndpoint = new URL(metadata.authorization_endpoint);
    } catch {
        throw new OutboundIdentityEndpointError(
            "outbound_scheme_forbidden",
            "<unparseable-authorization-endpoint>",
            "authorization endpoint is not a valid absolute URL",
        );
    }
    const decision = evaluateOutboundUrl(networkPolicy, authorizationEndpoint);
    if (!decision.allowed) {
        throw new OutboundIdentityEndpointError(
            decision.code,
            redactEndpoint(authorizationEndpoint),
            decision.reason,
        );
    }

    // Discovery metadata can introduce additional server-fetch targets after
    // the well-known request. Validate every one up front so enabling a
    // provider cannot succeed with a token/JWKS/UserInfo endpoint that would
    // only fail (or disclose policy details) on a later OAuth operation. The
    // custom fetch remains the final enforcement boundary for redirects,
    // rebinding, and every actual request.
    for (const [name, rawEndpoint] of [
        ["token_endpoint", metadata.token_endpoint],
        ["jwks_uri", metadata.jwks_uri],
        ["userinfo_endpoint", metadata.userinfo_endpoint],
    ] as const) {
        if (rawEndpoint === undefined) continue;
        if (typeof rawEndpoint !== "string") {
            throw new OutboundIdentityEndpointError(
                "outbound_scheme_forbidden",
                `<invalid-${name}>`,
                `${name} is not a valid URL`,
            );
        }
        let endpoint: URL;
        try {
            endpoint = new URL(rawEndpoint);
        } catch {
            throw new OutboundIdentityEndpointError(
                "outbound_scheme_forbidden",
                `<unparseable-${name}>`,
                `${name} is not a valid absolute URL`,
            );
        }
        const endpointDecision = evaluateOutboundUrl(networkPolicy, endpoint);
        if (!endpointDecision.allowed) {
            throw new OutboundIdentityEndpointError(
                endpointDecision.code,
                redactEndpoint(endpoint),
                endpointDecision.reason,
            );
        }
    }
}
