import { beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthStateUnavailableError } from "@/app/auth/oauthStateErrors";
import type { OAuthFlowProvider } from "@/app/oauth/providers/types";
import type { ProviderReference } from "@/app/auth/providers/providerReference";

const testProviderReference: ProviderReference = {
    id: "github",
    source: "built_in",
    runtimeFingerprint: "builtin:github:v1",
    context: { kind: "home" },
};

import { createDbMocks, installDbModuleMock } from "../../../testkit/dbMocks";

const createOauthStateToken = vi.fn();
const dbMocks = createDbMocks({
    repeatKey: ["create", "delete"],
} as const);
const repeatKeyCreate = dbMocks.db.repeatKey.create;
const repeatKeyDelete = dbMocks.db.repeatKey.delete;

vi.mock("@/app/auth/auth", () => ({
    auth: {
        createOauthStateToken,
    },
}));

installDbModuleMock(() => ({
    db: dbMocks.db,
}));

vi.mock("@/app/oauth/pkce", () => ({
    generatePkceVerifier: () => "pkce-verifier",
    pkceChallengeS256: () => "pkce-challenge",
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({
    randomKeyNaked: () => "sid_123",
}));

const { createExternalAuthorizeAttempt, createExternalAuthorizeUrl } = await import("./createExternalAuthorizeUrl");

function createProviderStub(overrides: Partial<OAuthFlowProvider> = {}): OAuthFlowProvider {
    return {
        id: "github",
        resolveStatus: () => ({ enabled: true, configured: true }),
        isConfigured: () => true,
        resolveRedirectUrl: () => "https://api.example.test/v1/oauth/github/callback",
        resolveScope: () => "scope",
        resolveAuthorizeUrl: vi.fn(async () => "https://provider.example/auth"),
        exchangeCodeForAccessToken: vi.fn(async () => ({ accessToken: "token" })),
        fetchProfile: vi.fn(async () => ({ id: "u1" })),
        getLogin: () => "login",
        getProviderUserId: () => "provider-u1",
        ...overrides,
    };
}

describe("createExternalAuthorizeUrl", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dbMocks.reset();
        repeatKeyCreate.mockResolvedValue(undefined);
        repeatKeyDelete.mockResolvedValue(undefined);
    });


    it("cleans up oauth_state repeatKey when oauth_state backend is unavailable", async () => {
        createOauthStateToken.mockRejectedValue(new OAuthStateUnavailableError());

        const provider = createProviderStub();

        const result = await createExternalAuthorizeUrl({
            flow: "connect",
            providerId: "github",
            provider,
            reference: testProviderReference,
            env: {},
            userId: "u1",
        });

        expect(result).toBeNull();
        expect(provider.resolveAuthorizeUrl).not.toHaveBeenCalled();
        expect(repeatKeyDelete).toHaveBeenCalledWith({
            where: { key: "oauth_state_sid_123" },
        });
    });

    it("rethrows unexpected oauth state creation errors", async () => {
        createOauthStateToken.mockRejectedValue(new Error("boom"));

        const provider = createProviderStub();

        await expect(
            createExternalAuthorizeUrl({
                flow: "connect",
                providerId: "github",
                provider,
                reference: testProviderReference,
                env: {},
                userId: "u1",
            })
        ).rejects.toThrow(/boom/);
    });

    it("binds a first-key step-up to the current Account and canonical migration digest", async () => {
        createOauthStateToken.mockResolvedValue("signed-state");

        await createExternalAuthorizeUrl({
            flow: "auth",
            providerId: "github",
            provider: createProviderStub(),
            reference: testProviderReference,
            env: {},
            publicKeyHex: null,
            proofHash: "b".repeat(64),
            purpose: "account_encryption_first_key",
            userId: "account-1",
            requestDigest: `aemrb1_${"A".repeat(43)}`,
        });

        expect(createOauthStateToken).toHaveBeenCalledWith({
            flow: "auth",
            provider: "github",
            sid: "sid_123",
            publicKey: null,
            proofHash: "b".repeat(64),
            purpose: "account_encryption_first_key",
            userId: "account-1",
            requestDigest: `aemrb1_${"A".repeat(43)}`,
        });
        const attempt = JSON.parse(repeatKeyCreate.mock.calls[0]![0].data.value);
        expect(attempt).toMatchObject({
            userId: "account-1",
            proofHash: "b".repeat(64),
            requestDigest: `aemrb1_${"A".repeat(43)}`,
            securityBinding: {
                provider: testProviderReference,
                connection: null,
                admission: null,
                purpose: "account_encryption_first_key",
            },
        });
        expect(attempt).not.toHaveProperty("purpose");
    });

    it("creates a provider-neutral identity-connection test attempt bound to the initiating Account and exact Team connection", async () => {
        createOauthStateToken.mockResolvedValue("signed-state");
        const provider = createProviderStub();
        const teamReference: ProviderReference = {
            ...testProviderReference,
            id: "provider-team-1",
            source: "managed",
            runtimeFingerprint: "managed:team-runtime:7",
            context: { kind: "team", teamId: "team-1" },
        };

        await expect(createExternalAuthorizeAttempt({
            flow: "connect",
            providerId: teamReference.id,
            provider,
            reference: teamReference,
            env: {},
            userId: "admin-1",
            purpose: "identity_connection_test",
            connection: { id: "connection-1", revision: 7 },
            webAppOAuthReturnUrl: "https://app.example.test/teams/team-1/authentication",
        })).resolves.toEqual({
            url: "https://provider.example/auth",
            attemptId: "sid_123",
        });

        expect(createOauthStateToken).toHaveBeenCalledWith({
            flow: "connect",
            provider: teamReference.id,
            sid: "sid_123",
            userId: "admin-1",
        });
        const attempt = JSON.parse(repeatKeyCreate.mock.calls[0]![0].data.value);
        expect(attempt).toMatchObject({
            provider: teamReference.id,
            securityBinding: {
                provider: teamReference,
                connection: { id: "connection-1", revision: 7 },
                admission: null,
                purpose: "identity_connection_test",
            },
        });
    });

    it("keeps the exact managed provider in the attempt while signing its registered callback route", async () => {
        createOauthStateToken.mockResolvedValue("signed-state");
        const reference: ProviderReference = {
            id: "managed-github-1",
            source: "managed",
            runtimeFingerprint: "managed-github:v1:exact",
            context: { kind: "home" },
        };

        await expect(createExternalAuthorizeAttempt({
            flow: "connect",
            providerId: reference.id,
            provider: createProviderStub({ id: reference.id, callbackProviderId: "github-app" }),
            reference,
            env: {},
            userId: "account-1",
        })).resolves.toMatchObject({ attemptId: "sid_123" });

        expect(createOauthStateToken).toHaveBeenCalledWith({
            flow: "connect",
            provider: "github-app",
            sid: "sid_123",
            userId: "account-1",
        });
        const attempt = JSON.parse(repeatKeyCreate.mock.calls[0]![0].data.value);
        expect(attempt).toMatchObject({
            provider: reference.id,
            callbackProvider: "github-app",
            securityBinding: { provider: reference },
        });
    });

    it("binds Team admission OAuth to the exact server-created admission source", async () => {
        createOauthStateToken.mockResolvedValue("signed-state");
        const teamReference: ProviderReference = {
            ...testProviderReference,
            source: "managed",
            runtimeFingerprint: "managed:team-runtime:8",
            context: { kind: "team", teamId: "team-1" },
        };
        await expect(createExternalAuthorizeAttempt({
            flow: "auth",
            providerId: "github",
            provider: createProviderStub(),
            reference: teamReference,
            env: {},
            publicKeyHex: "a".repeat(64),
            proofHash: null,
            purpose: "team_admission",
            connection: { id: "connection-1", revision: 7 },
            admission: {
                kind: "team_jit_identity",
                teamId: "team-1",
                providerId: "github",
                connectionId: "connection-1",
                connectionRevision: 7,
                admissionMode: "jit",
            },
        })).resolves.toMatchObject({ url: "https://provider.example/auth", attemptId: "sid_123" });
        const attempt = JSON.parse(repeatKeyCreate.mock.calls[0]![0].data.value);
        expect(attempt.securityBinding).toMatchObject({
            provider: teamReference,
            admission: expect.objectContaining({
                kind: "team_jit_identity",
                authAttemptId: "sid_123",
            }),
            purpose: "team_admission",
        });
        expect(createOauthStateToken).toHaveBeenCalledWith(expect.objectContaining({ purpose: "team_admission" }));
    });

    it("creates a present-user GitHub App installation attempt without a generic provider security binding", async () => {
        createOauthStateToken.mockResolvedValue("signed-state");
        const binding = {
            owner: { kind: "team" as const, teamId: "team-1" },
            registrationId: "registration-1",
            registrationRevision: 3,
            registrationSecurityRevision: 2,
            installationRevision: 0,
            networkPolicyFingerprint: "network-v1",
            githubInstallationId: "301",
            githubOrganizationId: "401",
        };

        await expect(createExternalAuthorizeAttempt({
            flow: "connect",
            purpose: "github_app_installation_verification",
            providerId: "github_app_setup",
            provider: createProviderStub({ id: "github_app_setup" }),
            env: {},
            userId: "admin-1",
            githubAppInstallationVerification: binding,
        })).resolves.toEqual({
            url: "https://provider.example/auth",
            attemptId: "sid_123",
        });

        expect(createOauthStateToken).toHaveBeenCalledWith({
            flow: "connect",
            provider: "github_app_setup",
            sid: "sid_123",
            userId: "admin-1",
            purpose: "github_app_installation_verification",
        });
        const attempt = JSON.parse(repeatKeyCreate.mock.calls[0]![0].data.value);
        expect(attempt).toMatchObject({
            provider: "github_app_setup",
            purpose: "github_app_installation_verification",
            githubAppInstallationVerification: binding,
        });
        expect(attempt).not.toHaveProperty("securityBinding");
    });
});
