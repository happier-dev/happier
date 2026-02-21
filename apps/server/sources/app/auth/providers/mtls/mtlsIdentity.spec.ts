import { describe, expect, it } from "vitest";

import { resolveMtlsIdentityFromForwardedHeaders } from "@/app/auth/providers/mtls/mtlsIdentity";

describe("resolveMtlsIdentityFromForwardedHeaders", () => {
    it("returns null when forwarded headers are not trusted", () => {
        const identity = resolveMtlsIdentityFromForwardedHeaders({
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
});

