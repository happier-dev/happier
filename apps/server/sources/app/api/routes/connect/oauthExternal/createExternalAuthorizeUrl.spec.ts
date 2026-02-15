import { beforeEach, describe, expect, it, vi } from "vitest";
import { OAuthStateUnavailableError } from "@/app/auth/oauthStateErrors";
import type { OAuthFlowProvider } from "@/app/oauth/providers/registry";

const createOauthStateToken = vi.fn();
const repeatKeyCreate = vi.fn();
const repeatKeyDelete = vi.fn();

vi.mock("@/app/auth/auth", () => ({
    auth: {
        createOauthStateToken,
    },
}));

vi.mock("@/storage/db", () => ({
    db: {
        repeatKey: {
            create: repeatKeyCreate,
            delete: repeatKeyDelete,
        },
    },
}));

vi.mock("@/app/oauth/pkce", () => ({
    generatePkceVerifier: () => "pkce-verifier",
    pkceChallengeS256: () => "pkce-challenge",
}));

vi.mock("@/utils/keys/randomKeyNaked", () => ({
    randomKeyNaked: () => "sid_123",
}));

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
        repeatKeyCreate.mockResolvedValue(undefined);
        repeatKeyDelete.mockResolvedValue(undefined);
    });

    it("returns null when oauth_state backend is unavailable", async () => {
        createOauthStateToken.mockRejectedValue(new OAuthStateUnavailableError());
        const { createExternalAuthorizeUrl } = await import("./createExternalAuthorizeUrl");

        const provider = createProviderStub();

        const result = await createExternalAuthorizeUrl({
            flow: "connect",
            providerId: "github",
            provider,
            env: {},
            userId: "u1",
        });

        expect(result).toBeNull();
        expect(provider.resolveAuthorizeUrl).not.toHaveBeenCalled();
    });

    it("cleans up oauth_state repeatKey when oauth_state backend is unavailable", async () => {
        createOauthStateToken.mockRejectedValue(new OAuthStateUnavailableError());
        const { createExternalAuthorizeUrl } = await import("./createExternalAuthorizeUrl");

        const provider = createProviderStub();

        const result = await createExternalAuthorizeUrl({
            flow: "connect",
            providerId: "github",
            provider,
            env: {},
            userId: "u1",
        });

        expect(result).toBeNull();
        expect(repeatKeyDelete).toHaveBeenCalledWith({
            where: { key: "oauth_state_sid_123" },
        });
    });

    it("rethrows unexpected oauth state creation errors", async () => {
        createOauthStateToken.mockRejectedValue(new Error("boom"));
        const { createExternalAuthorizeUrl } = await import("./createExternalAuthorizeUrl");

        const provider = createProviderStub();

        await expect(
            createExternalAuthorizeUrl({
                flow: "connect",
                providerId: "github",
                provider,
                env: {},
                userId: "u1",
            })
        ).rejects.toThrow(/boom/);
    });
});
