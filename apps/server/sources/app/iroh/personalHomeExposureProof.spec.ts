import { describe, expect, it } from 'vitest';

import { verifyPersonalHomeExposureProof } from './personalHomeExposureProof';

describe('Home Iroh exposure admission', () => {
    const listener = { host: '127.0.0.1', port: 3005 };

    it.each(['http://home-qa.localhost:3039', 'https://home.example.test'])('keeps the stable %s audience independent of purpose and listener port', (canonicalServerUrl) => {
        expect(verifyPersonalHomeExposureProof({
            env: { HAPPIER_CANONICAL_SERVER_URL: canonicalServerUrl, AUTH_ANONYMOUS_SIGNUP_ENABLED: '0' },
            listener,
        })).toBe(true);
    });

    it('preserves an intentionally public Home signup policy', () => {
        expect(verifyPersonalHomeExposureProof({
            env: {
                HAPPIER_CANONICAL_SERVER_URL: 'https://home.example.test',
                HAPPIER_PUBLIC_SERVER_URL: 'https://ingress.example.test',
                AUTH_ANONYMOUS_SIGNUP_ENABLED: '1',
            },
            listener,
        })).toBe(true);
    });

    it('allows an all-interface API with its existing signup policy', () => {
        expect(verifyPersonalHomeExposureProof({
            env: { HAPPIER_CANONICAL_SERVER_URL: 'https://home.example.test', AUTH_ANONYMOUS_SIGNUP_ENABLED: '1' },
            listener: { host: '0.0.0.0', port: 3005 },
        })).toBe(true);
    });

    it.each([undefined, '1', 'not-a-boolean'])('does not expose ingress-less bootstrap signup (%s)', (signup) => {
        expect(verifyPersonalHomeExposureProof({
            env: { HAPPIER_CANONICAL_SERVER_URL: 'http://home.localhost:3039', AUTH_ANONYMOUS_SIGNUP_ENABLED: signup },
            listener,
        })).toBe(false);
    });

    it('does not mistake a declared same-computer ingress for remote signup exposure', () => {
        expect(verifyPersonalHomeExposureProof({
            env: {
                HAPPIER_CANONICAL_SERVER_URL: 'http://home.localhost:3039',
                HAPPIER_PUBLIC_SERVER_URL: 'http://home.localhost:3039',
                AUTH_ANONYMOUS_SIGNUP_ENABLED: '1',
            },
            listener,
        })).toBe(false);
    });

    it('requires a configured stable audience and an API listener', () => {
        expect(verifyPersonalHomeExposureProof({ env: { AUTH_ANONYMOUS_SIGNUP_ENABLED: '0' }, listener })).toBe(false);
        expect(verifyPersonalHomeExposureProof({ env: { HAPPIER_CANONICAL_SERVER_URL: 'https://home.example.test' }, listener: null })).toBe(false);
    });

    it('leaves provisioning restrictions with the live ingress-aware policy owner', () => {
        const env = {
            HAPPIER_CANONICAL_SERVER_URL: 'https://home.example.test',
            HAPPIER_PUBLIC_SERVER_URL: 'https://home.example.test',
            AUTH_ANONYMOUS_SIGNUP_ENABLED: '1',
            HAPPIER_AUTH_PUBLIC_PROVISION_DENY_METHODS: 'key_challenge',
        };
        expect(verifyPersonalHomeExposureProof({ env, listener })).toBe(true);
        expect(verifyPersonalHomeExposureProof({ env: { ...env, HAPPIER_AUTH_PUBLIC_PROVISION_DENY_IP_CLASSES: '*' }, listener })).toBe(true);
    });

    it('leaves certificate identity admission with the ingress-aware authenticator', () => {
        const env = {
            HAPPIER_CANONICAL_SERVER_URL: 'https://home.example.test',
            AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
            HAPPIER_FEATURE_AUTH_MTLS__ENABLED: '1',
            HAPPIER_FEATURE_AUTH_MTLS__MODE: 'forwarded',
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: '1',
            HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        };
        expect(verifyPersonalHomeExposureProof({ env, listener })).toBe(true);
        expect(verifyPersonalHomeExposureProof({ env: { ...env, HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: '0' }, listener })).toBe(true);
    });

    it.each(['192.0.2.1', '127.0.0.2', '::1'])('allows the dedicated ingress independently of the public listener on %s', (host) => {
        expect(verifyPersonalHomeExposureProof({
            env: { HAPPIER_CANONICAL_SERVER_URL: 'https://home.example.test', AUTH_ANONYMOUS_SIGNUP_ENABLED: '0' },
            listener: { host, port: 3005 },
        })).toBe(true);
    });
});
