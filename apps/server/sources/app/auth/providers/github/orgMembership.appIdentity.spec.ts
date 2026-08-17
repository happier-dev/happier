import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    app: vi.fn(),
    request: vi.fn(),
}));

vi.mock("octokit", () => ({
    App: mocks.app,
}));

import { isGithubOrgMemberViaApp } from "./orgMembership";

describe("GitHub authentication App identity", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.request.mockResolvedValue({ status: 204 });
        mocks.app.mockImplementation(() => ({
            getInstallationOctokit: vi.fn(async () => ({ request: mocks.request })),
        }));
    });

    it("does not borrow generic integration-App credentials for authentication membership", async () => {
        await expect(isGithubOrgMemberViaApp({
            org: "acme",
            username: "octocat",
            env: {
                GITHUB_APP_ID: "shared-integration-app",
                GITHUB_PRIVATE_KEY: "shared-integration-private-key",
                AUTH_GITHUB_APP_INSTALLATION_ID_BY_ORG: "acme=123",
            },
        })).resolves.toBe(false);

        expect(mocks.app).not.toHaveBeenCalled();
        expect(mocks.request).not.toHaveBeenCalled();
    });
});
