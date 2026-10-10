import { describe, expect, it } from "vitest";

import {
    authPendingSchema,
    connectPendingSchema,
    hasInvalidOAuthSecurityBinding,
    oauthAuthPendingSchema,
    oauthStateAttemptSchema,
} from "./oauthExternalSchemas";
import { isTeamOwnedConnectionAdmission } from "./oauthSecurityBinding";

const githubReference = {
    id: "github",
    source: "built_in" as const,
    runtimeFingerprint: "built-in:github:v1",
    context: { kind: "home" as const },
};

describe("OAuth persisted security binding", () => {
    it("keeps a Home-owned company connection under Home policy during Team admission", () => {
        const binding = {
            provider: { ...githubReference, id: "company", source: "managed" as const },
            connection: { id: "home-connection", revision: 1 },
            admission: null,
            purpose: "team_admission" as const,
        };
        expect(isTeamOwnedConnectionAdmission(binding)).toBe(false);
        expect(isTeamOwnedConnectionAdmission({ ...binding,
            provider: { ...binding.provider, context: { kind: "team", teamId: "company-team" } },
        })).toBe(true);
    });
    it("rejects unknown top-level fields on authority-bearing attempt and connect-pending records", () => {
        // ../0.2 @ b23f95ed354e8d49183017e487bdb75f217017de writes these exact
        // shapes without securityBinding. Strictness must not close that live predecessor reader.
        expect(oauthStateAttemptSchema.safeParse({
            provider: "github",
            pkceCodeVerifier: "verifier",
            nonce: "nonce",
            webAppOAuthReturnUrl: "https://home.example.test/oauth/return",
        }).success).toBe(true);
        expect(connectPendingSchema.safeParse({
            flow: "connect",
            provider: "github",
            userId: "account",
            profileEnc: "profile",
            accessTokenEnc: "access-token",
        }).success).toBe(true);
        expect(oauthStateAttemptSchema.safeParse({
            provider: "github",
            pkceCodeVerifier: "verifier",
            nonce: "nonce",
            admissionOverride: { teamId: "attacker-controlled" },
        }).success).toBe(false);
        expect(connectPendingSchema.safeParse({
            flow: "connect",
            provider: "github",
            userId: "account",
            profileEnc: "profile",
            accessTokenEnc: "access-token",
            admissionOverride: { teamId: "attacker-controlled" },
        }).success).toBe(false);
    });

    it("accepts every retained predecessor record only when securityBinding is absent", () => {
        const predecessorRecords = [
            {
                schema: oauthStateAttemptSchema,
                value: { provider: "github", pkceCodeVerifier: "verifier", nonce: "nonce" },
            },
            {
                schema: connectPendingSchema,
                value: {
                    flow: "connect", provider: "github", userId: "account",
                    profileEnc: "profile", accessTokenEnc: "access-token",
                },
            },
            {
                schema: authPendingSchema,
                value: {
                    flow: "auth", provider: "github", publicKeyHex: "a".repeat(64),
                    profileEnc: "profile", accessTokenEnc: "access-token",
                },
            },
            {
                schema: authPendingSchema,
                value: {
                    flow: "auth", provider: "github", authMode: "keyless", proofHash: "b".repeat(64),
                    profileEnc: "profile", accessTokenEnc: "access-token",
                },
            },
        ] as const;

        for (const { schema, value } of predecessorRecords) {
            expect(schema.safeParse(value).success).toBe(true);
            const malformed = { ...value, securityBinding: { provider: githubReference } };
            expect(hasInvalidOAuthSecurityBinding(malformed)).toBe(true);
            expect(schema.safeParse(malformed).success).toBe(false);
        }
    });

    it("rejects a length-valid non-canonical password mutation digest", () => {
        expect(oauthAuthPendingSchema.safeParse({
            v: 3,
            flow: "auth",
            purpose: "account_password_enrollment",
            provider: "github",
            securityBinding: {
                provider: githubReference,
                connection: null,
                admission: null,
                purpose: "account_password_enrollment",
            },
            userId: "account",
            providerUserId: "github-user",
            proofHash: "a".repeat(64),
            requestDigest: "!".repeat(43),
        }).success).toBe(false);
    });

    it("preserves the same catalog reference through attempt and every ordinary pending reader", () => {
        const securityBinding = {
            provider: githubReference,
            connection: null,
            admission: null,
            purpose: null,
        };
        const attempt = { provider: "github", pkceCodeVerifier: "verifier", nonce: "nonce", securityBinding };
        expect(oauthStateAttemptSchema.parse(JSON.parse(JSON.stringify(attempt)))).toEqual(attempt);

        const shared = { provider: "github", profileEnc: "encrypted-profile", accessTokenEnc: "encrypted-token", securityBinding };
        const pendingRecords = [
            { ...shared, flow: "connect", userId: "account" },
            { ...shared, flow: "auth", publicKeyHex: "a".repeat(64) },
            { ...shared, flow: "auth", authMode: "keyless", proofHash: "b".repeat(64) },
            { ...shared, flow: "auth", v: 2, proofHash: "b".repeat(64) },
        ];
        for (const pending of pendingRecords) {
            const schema = pending.flow === "connect" ? connectPendingSchema : authPendingSchema;
            expect(schema.parse(JSON.parse(JSON.stringify(pending)))).toEqual(pending);
        }
    });

    it("preserves an exact Team connection binding instead of stripping it into a Home attempt", () => {
        const attempt = {
            provider: "github", pkceCodeVerifier: "verifier", nonce: "nonce",
            purpose: "identity_connection_test" as const,
            securityBinding: {
                provider: { ...githubReference, context: { kind: "team", teamId: "other-team" } },
                connection: { id: "connection-exact", revision: 4 },
                admission: null,
                purpose: "identity_connection_test" as const,
            },
        };
        expect(oauthStateAttemptSchema.parse(JSON.parse(JSON.stringify(attempt)))).toEqual(attempt);
    });

    it("accepts only an exact bounded Team admission source", () => {
        const admission = {
            kind: "team_jit_identity" as const,
            teamId: "team-1",
            providerId: "github",
            connectionId: "connection-exact",
            connectionRevision: 4,
            admissionMode: "jit" as const,
            authAttemptId: "attempt-1234",
        };
        const securityBinding = {
            provider: { ...githubReference, context: { kind: "team" as const, teamId: "team-1" } },
            connection: { id: "connection-exact", revision: 4 },
            admission,
            purpose: "team_admission" as const,
        };
        const attempt = { provider: "github", pkceCodeVerifier: "verifier", nonce: "nonce", securityBinding };
        expect(oauthStateAttemptSchema.parse(attempt).securityBinding?.admission)
            .toEqual(admission);
        expect(oauthStateAttemptSchema.safeParse({
            ...attempt,
            securityBinding: { ...securityBinding, admission: "caller-controlled" },
        }).success).toBe(false);
        expect(oauthStateAttemptSchema.safeParse({
            ...attempt,
            securityBinding: { ...securityBinding, purpose: null },
        }).success).toBe(false);
    });
});
