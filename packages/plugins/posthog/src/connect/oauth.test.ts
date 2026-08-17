import { describe, expect, it } from 'vitest';

import {
    POSTHOG_REQUESTED_SCOPES,
    acceptPosthogAuthorizationServerMetadata,
    resolvePosthogAuthenticationRoute,
} from './oauth.js';
import { normalizePosthogApiOrigin, type PosthogApiOrigin } from './origin.js';

function requireOrigin(raw: string): PosthogApiOrigin {
    const resolved = normalizePosthogApiOrigin(raw);
    if (!resolved.ok) throw new Error(`fixture origin must normalize: ${raw}`);
    return resolved.origin;
}

const US = requireOrigin('https://us.posthog.com');
const EU = requireOrigin('https://eu.posthog.com');
const SELF_HOSTED = requireOrigin('https://analytics.example');

/**
 * Shaped from PostHog's published authorization-server metadata document. Values are
 * inert; only the fields this source validates are present.
 */
function cloudMetadata(overrides: Readonly<Record<string, unknown>> = {}) {
    return {
        issuer: 'https://oauth.posthog.com',
        authorization_endpoint: 'https://oauth.posthog.com/oauth/authorize/',
        token_endpoint: 'https://oauth.posthog.com/oauth/token/',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['openid', 'error_tracking:read', 'error_tracking:write'],
        posthog_region: 'us',
        ...overrides,
    };
}

describe('resolvePosthogAuthenticationRoute', () => {
    it('offers Cloud OAuth for the two documented Cloud API origins', () => {
        expect(resolvePosthogAuthenticationRoute(US))
            .toEqual({ kind: 'cloudOauthAuthorizationCode', region: 'us' });
        expect(resolvePosthogAuthenticationRoute(EU))
            .toEqual({ kind: 'cloudOauthAuthorizationCode', region: 'eu' });
    });

    it('routes a self-hosted origin to the explicit key pilot, never to a Cloud issuer', () => {
        expect(resolvePosthogAuthenticationRoute(SELF_HOSTED)).toEqual({
            kind: 'personalApiKeyPilot',
            reason: 'selfHostedOauthUncharacterized',
        });
    });

    it('requests only read scopes', () => {
        expect(POSTHOG_REQUESTED_SCOPES).not.toContain('error_tracking:write');
        expect(POSTHOG_REQUESTED_SCOPES).not.toContain('query:read');
        expect(POSTHOG_REQUESTED_SCOPES).toContain('error_tracking:read');
    });
});

describe('acceptPosthogAuthorizationServerMetadata', () => {
    it('accepts a well-formed region-matched Cloud document', () => {
        expect(acceptPosthogAuthorizationServerMetadata(US, cloudMetadata())).toEqual({
            ok: true,
            metadata: {
                issuer: 'https://oauth.posthog.com',
                authorizationEndpoint: 'https://oauth.posthog.com/oauth/authorize/',
                tokenEndpoint: 'https://oauth.posthog.com/oauth/token/',
                region: 'us',
            },
        });
    });

    it('refuses a self-hosted origin outright rather than validating a borrowed document', () => {
        expect(acceptPosthogAuthorizationServerMetadata(SELF_HOSTED, cloudMetadata()))
            .toEqual({ ok: false, reason: 'notCloudOrigin' });
    });

    it('refuses a document whose region stamp does not match the API origin', () => {
        // The US document must not be reused to authenticate an EU tenant.
        expect(acceptPosthogAuthorizationServerMetadata(EU, cloudMetadata()))
            .toEqual({ ok: false, reason: 'regionMismatch' });
        expect(acceptPosthogAuthorizationServerMetadata(EU, cloudMetadata({ posthog_region: 'eu' })))
            .toMatchObject({ ok: true });
    });

    it('requires PKCE S256 and rejects a plain-only deployment', () => {
        expect(acceptPosthogAuthorizationServerMetadata(
            US,
            cloudMetadata({ code_challenge_methods_supported: ['plain'] }),
        )).toEqual({ ok: false, reason: 'missingPkceS256' });
        expect(acceptPosthogAuthorizationServerMetadata(
            US,
            cloudMetadata({ code_challenge_methods_supported: undefined }),
        )).toEqual({ ok: false, reason: 'missingPkceS256' });
    });

    it('requires the authorization-code grant and the code response type', () => {
        expect(acceptPosthogAuthorizationServerMetadata(
            US,
            cloudMetadata({ grant_types_supported: ['refresh_token'] }),
        )).toEqual({ ok: false, reason: 'missingAuthorizationCodeGrant' });
        expect(acceptPosthogAuthorizationServerMetadata(
            US,
            cloudMetadata({ response_types_supported: ['token'] }),
        )).toEqual({ ok: false, reason: 'missingCodeResponseType' });
    });

    it('requires the Error Tracking read scope to be grantable', () => {
        expect(acceptPosthogAuthorizationServerMetadata(
            US,
            cloudMetadata({ scopes_supported: ['openid', 'profile'] }),
        )).toEqual({ ok: false, reason: 'missingErrorTrackingScope' });
    });

    it('rejects an insecure or off-issuer endpoint', () => {
        expect(acceptPosthogAuthorizationServerMetadata(
            US,
            cloudMetadata({ token_endpoint: 'http://oauth.posthog.com/oauth/token/' }),
        )).toEqual({ ok: false, reason: 'insecureEndpoint' });
        expect(acceptPosthogAuthorizationServerMetadata(
            US,
            cloudMetadata({ token_endpoint: 'https://attacker.example/oauth/token/' }),
        )).toEqual({ ok: false, reason: 'endpointOffIssuer' });
    });

    it('rejects a malformed document without throwing', () => {
        expect(acceptPosthogAuthorizationServerMetadata(US, null))
            .toEqual({ ok: false, reason: 'malformedMetadata' });
        expect(acceptPosthogAuthorizationServerMetadata(US, []))
            .toEqual({ ok: false, reason: 'malformedMetadata' });
        expect(acceptPosthogAuthorizationServerMetadata(US, { issuer: 42 }))
            .toEqual({ ok: false, reason: 'malformedMetadata' });
    });
});
