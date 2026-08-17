/**
 * Which authentication route a given PostHog origin may use.
 *
 * OAuth authorization-code is documented only for PostHog Cloud, and its metadata
 * document is region-stamped: the US and EU deployments publish different issuers, so a
 * Cloud issuer is never a fallback for another deployment. An arbitrary self-hosted
 * origin therefore has no characterized protected-resource, authorization-server,
 * client-registration, or Error Tracking scope behavior, and its supported route in V1
 * is the explicit administrator-configured Personal API key pilot.
 *
 * This module validates metadata; it never fetches it, stores it, or holds a credential.
 * Custody, refresh, and revocation stay entirely inside the canonical Connected
 * Accounts lifecycle.
 */

import { normalizePosthogApiOrigin, type PosthogApiOrigin } from './origin.js';

export type PosthogCloudRegion = 'us' | 'eu';

const CLOUD_API_ORIGINS: Readonly<Record<PosthogCloudRegion, string>> = {
    us: 'https://us.posthog.com',
    eu: 'https://eu.posthog.com',
};

/** The exact read scopes the source requests. `error_tracking:write` is not requested. */
export const POSTHOG_REQUESTED_SCOPES: readonly string[] = [
    'error_tracking:read',
    'organization:read',
    'project:read',
    'activity_log:read',
];

export function resolvePosthogCloudRegion(origin: PosthogApiOrigin): PosthogCloudRegion | null {
    for (const [region, cloudOrigin] of Object.entries(CLOUD_API_ORIGINS)) {
        if ((origin as string) === cloudOrigin) {
            return region as PosthogCloudRegion;
        }
    }
    return null;
}

export type PosthogAuthenticationRoute =
    /** Cloud: the canonical Connected Accounts OAuth owner may run authorization code + PKCE. */
    | Readonly<{ kind: 'cloudOauthAuthorizationCode'; region: PosthogCloudRegion }>
    /** Self-hosted: explicit administrator-configured Personal API key pilot only. */
    | Readonly<{ kind: 'personalApiKeyPilot'; reason: 'selfHostedOauthUncharacterized' }>;

export function resolvePosthogAuthenticationRoute(
    origin: PosthogApiOrigin,
): PosthogAuthenticationRoute {
    const region = resolvePosthogCloudRegion(origin);
    if (region === null) {
        return { kind: 'personalApiKeyPilot', reason: 'selfHostedOauthUncharacterized' };
    }
    return { kind: 'cloudOauthAuthorizationCode', region };
}

export type PosthogAuthorizationServerMetadata = Readonly<{
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    region: PosthogCloudRegion;
}>;

export type PosthogOauthMetadataRejection =
    | 'notCloudOrigin'
    | 'malformedMetadata'
    | 'insecureEndpoint'
    | 'endpointOffIssuer'
    | 'missingAuthorizationCodeGrant'
    | 'missingCodeResponseType'
    | 'missingPkceS256'
    | 'missingErrorTrackingScope'
    | 'regionMismatch';

export type PosthogOauthMetadataResult =
    | Readonly<{ ok: true; metadata: PosthogAuthorizationServerMetadata }>
    | Readonly<{ ok: false; reason: PosthogOauthMetadataRejection }>;

function readStringArray(value: unknown): readonly string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    return value.every((item): item is string => typeof item === 'string')
        ? value
        : null;
}

function endpointOrigin(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.origin : null;
    } catch {
        return null;
    }
}

/**
 * Accepts an authorization-server metadata document for one exact Cloud API origin.
 *
 * PKCE `S256` is required rather than preferred: the document advertises the methods it
 * supports, and a document without `S256` does not describe a deployment this source can
 * authenticate against safely. The region stamp must match the API origin, which is what
 * stops a US issuer from being reused for an EU tenant.
 */
export function acceptPosthogAuthorizationServerMetadata(
    origin: PosthogApiOrigin,
    document: unknown,
): PosthogOauthMetadataResult {
    const region = resolvePosthogCloudRegion(origin);
    if (region === null) {
        return { ok: false, reason: 'notCloudOrigin' };
    }
    if (typeof document !== 'object' || document === null || Array.isArray(document)) {
        return { ok: false, reason: 'malformedMetadata' };
    }
    const raw = document as Readonly<Record<string, unknown>>;

    const issuerOrigin = endpointOrigin(raw['issuer']);
    const authorizationOrigin = endpointOrigin(raw['authorization_endpoint']);
    const tokenOrigin = endpointOrigin(raw['token_endpoint']);
    const issuer = raw['issuer'];
    const authorizationEndpoint = raw['authorization_endpoint'];
    const tokenEndpoint = raw['token_endpoint'];
    if (
        typeof issuer !== 'string'
        || typeof authorizationEndpoint !== 'string'
        || typeof tokenEndpoint !== 'string'
    ) {
        return { ok: false, reason: 'malformedMetadata' };
    }
    if (issuerOrigin === null || authorizationOrigin === null || tokenOrigin === null) {
        return { ok: false, reason: 'insecureEndpoint' };
    }
    if (authorizationOrigin !== issuerOrigin || tokenOrigin !== issuerOrigin) {
        return { ok: false, reason: 'endpointOffIssuer' };
    }

    const grantTypes = readStringArray(raw['grant_types_supported']);
    if (grantTypes === null || !grantTypes.includes('authorization_code')) {
        return { ok: false, reason: 'missingAuthorizationCodeGrant' };
    }
    const responseTypes = readStringArray(raw['response_types_supported']);
    if (responseTypes === null || !responseTypes.includes('code')) {
        return { ok: false, reason: 'missingCodeResponseType' };
    }
    const challengeMethods = readStringArray(raw['code_challenge_methods_supported']);
    if (challengeMethods === null || !challengeMethods.includes('S256')) {
        return { ok: false, reason: 'missingPkceS256' };
    }
    const scopes = readStringArray(raw['scopes_supported']);
    if (scopes === null || !scopes.includes('error_tracking:read')) {
        return { ok: false, reason: 'missingErrorTrackingScope' };
    }
    const stampedRegion = raw['posthog_region'];
    if (typeof stampedRegion !== 'string' || stampedRegion !== region) {
        return { ok: false, reason: 'regionMismatch' };
    }

    return {
        ok: true,
        metadata: { issuer, authorizationEndpoint, tokenEndpoint, region },
    };
}

/** Convenience for callers holding a raw origin string rather than a validated one. */
export function resolvePosthogAuthenticationRouteForRawOrigin(
    rawOrigin: string,
): PosthogAuthenticationRoute | null {
    const resolved = normalizePosthogApiOrigin(rawOrigin);
    return resolved.ok ? resolvePosthogAuthenticationRoute(resolved.origin) : null;
}
