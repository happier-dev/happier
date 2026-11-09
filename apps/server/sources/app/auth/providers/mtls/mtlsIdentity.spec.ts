import { describe, expect, it } from "vitest";
import { Socket } from 'node:net';

import {
    ACCOUNT_IDENTITY_PROVIDER_LOGIN_MAX_CODE_UNITS,
    ACCOUNT_IDENTITY_PROVIDER_USER_ID_MAX_CODE_UNITS,
} from "@/app/auth/providers/accountIdentityBounds";
import { resolveMtlsIdentityFromForwardedHeaders } from "@/app/auth/providers/mtls/mtlsIdentity";

// An ordinary accepted socket boundary; no network connection or file descriptor is opened.
const request = { socket: new Socket() };

describe("resolveMtlsIdentityFromForwardedHeaders", () => {
    it("returns null when forwarded headers are not trusted", () => {
        const identity = resolveMtlsIdentityFromForwardedHeaders({
            request,
            env: {
                HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "0",
            } as any,
            headers: {
                "x-happier-client-cert-email": "alice@example.com",
            },
        });

        expect(identity).toBeNull();
    });

    it("normalizes SAN email/UPN to lowercase and includes issuer in the profile", () => {
        const identity = resolveMtlsIdentityFromForwardedHeaders({
            request,
            env: {
                HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
                HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
                HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
                HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_UPN_HEADER: "x-happier-client-cert-upn",
                HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: "x-happier-client-cert-issuer",
            } as any,
            headers: {
                "x-happier-client-cert-email": " Alice@Example.com ",
                "x-happier-client-cert-upn": " ALICE@EXAMPLE.COM ",
                "x-happier-client-cert-issuer": " CN=Example Root CA ",
            },
        });

        expect(identity).toEqual({
            providerUserId: "alice@example.com",
            providerLogin: "alice@example.com",
            profile: {
                email: "alice@example.com",
                upn: "alice@example.com",
                subject: null,
                fingerprint: null,
                issuer: "CN=Example Root CA",
            },
        });
    });

    it("extracts CN from the subject when identitySource=subject_cn", () => {
        const identity = resolveMtlsIdentityFromForwardedHeaders({
            request,
            env: {
                HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
                HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "subject_cn",
                HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_SUBJECT_HEADER: "x-happier-client-cert-subject",
            } as any,
            headers: {
                "x-happier-client-cert-subject": "CN=Alice Example,OU=Users,O=Example Corp",
            },
        });

        expect(identity?.providerUserId).toBe("Alice Example");
        expect(identity?.profile.subject).toBe("CN=Alice Example,OU=Users,O=Example Corp");
    });

    it("rejects a forwarded subject beyond the shared AccountIdentity semantic bound", () => {
        const env = {
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "subject_cn",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_SUBJECT_HEADER: "x-happier-client-cert-subject",
        } as any;
        const resolve = (commonName: string) => resolveMtlsIdentityFromForwardedHeaders({
            request,
            env,
            headers: { "x-happier-client-cert-subject": `CN=${commonName},OU=Users` },
        });

        const atBound = "a".repeat(ACCOUNT_IDENTITY_PROVIDER_USER_ID_MAX_CODE_UNITS);
        expect(resolve(atBound)?.providerUserId).toBe(atBound);
        // Two distinct certificate subjects must never collapse into one stored
        // provider subject, so an over-long value is refused rather than passed
        // to a column that would reject or silently truncate it.
        expect(resolve(`${atBound}b`)).toBeNull();
        expect(resolve(`${atBound}c`)).toBeNull();
    });

    it("rejects a forwarded SAN email beyond the shared login bound", () => {
        const env = {
            HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: "1",
            HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: "san_email",
            HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: "x-happier-client-cert-email",
        } as any;
        const resolve = (email: string) => resolveMtlsIdentityFromForwardedHeaders({
            request,
            env,
            headers: { "x-happier-client-cert-email": email },
        });

        const domain = "@example.com";
        const local = "a".repeat(ACCOUNT_IDENTITY_PROVIDER_LOGIN_MAX_CODE_UNITS - domain.length);
        expect(resolve(`${local}${domain}`)?.providerLogin).toBe(`${local}${domain}`);
        // `san_email` publishes the same value as providerLogin, so the narrower
        // login bound decides admission for this identity source.
        expect(resolve(`a${local}${domain}`)).toBeNull();
    });
});

