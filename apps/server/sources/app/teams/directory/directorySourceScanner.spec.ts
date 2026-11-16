import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    findUnique: vi.fn(),
    app: vi.fn(),
    appRequest: vi.fn(),
    octokit: vi.fn(),
    request: vi.fn(),
    updateMany: vi.fn(),
}));

vi.mock("@/storage/db", () => ({
    db: {
        teamDirectorySource: { findUnique: mocks.findUnique },
        gitHubAppInstallation: { updateMany: mocks.updateMany },
        homeGovernancePolicy: { findUnique: vi.fn(async () => null) },
    },
}));
vi.mock("octokit", () => ({
    App: mocks.app,
    Octokit: Object.assign(mocks.octokit, { defaults: vi.fn(() => mocks.octokit) }),
}));

import { initEncrypt } from "@/modules/encrypt";
import { encryptGitHubAppRegistrationSecretsV1 } from "@/app/integrations/github/githubManagedApp";
import type { ClaimedDirectorySource } from "./directorySourceService";
import { scanDirectorySource } from "./directorySourceScanner";

const previousMasterSecret = process.env.HANDY_MASTER_SECRET;

function sourceRow() {
    const registrationId = "registration-scanner";
    return {
        id: "source-scanner",
        teamId: "team-scanner",
        kind: "github_organization",
        state: "initializing",
        bindingConfig: { v: 1, kind: "github_organization", githubOrganizationLogin: "Acme" },
        githubAppInstallation: {
            id: "installation-scanner",
            githubInstallationId: 42n,
            githubOrganizationId: 84n,
            githubOrganizationLogin: "Acme",
            revision: 3,
            state: "verified",
            verifiedPermissions: { members: "read" },
            verifiedEvents: [],
            suspendedAt: null,
            registration: {
                id: registrationId,
                ownerTeamId: "team-scanner",
                githubHost: "https://github.com",
                githubAppId: 21n,
                config: { v: 1 },
                encryptedSecrets: encryptGitHubAppRegistrationSecretsV1({
                    registrationId,
                    secrets: { v: 1, privateKey: "test-private-key" },
                }),
                securityRevision: 5,
                state: "verified",
            },
        },
    };
}

function claimedSource(): ClaimedDirectorySource {
    return {
        id: "source-scanner",
        teamId: "team-scanner",
        kind: "github_organization",
        binding: { v: 1, kind: "github_organization", githubOrganizationLogin: "Acme" },
        reconcileRunId: "run-scanner",
        eventCursor: null,
        eventRangeStart: null,
        observedManualSyncRequestedAt: null,
        consecutiveFailureCount: 0,
    };
}

beforeAll(async () => {
    process.env.HANDY_MASTER_SECRET = "directory-source-scanner-test-master-secret";
    await initEncrypt();
});

afterAll(() => {
    if (previousMasterSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
    else process.env.HANDY_MASTER_SECRET = previousMasterSecret;
});

beforeEach(() => {
    vi.clearAllMocks();
    mocks.findUnique.mockResolvedValue(sourceRow());
    mocks.app.mockImplementation(() => ({ octokit: { request: mocks.appRequest } }));
    mocks.appRequest.mockImplementation(async (route: string) => route.startsWith("GET ")
        ? {
            data: {
                id: 42,
                app_id: 21,
                account: { id: 84, login: "Acme", type: "Organization" },
                repository_selection: "all",
                permissions: { members: "read" },
                events: [],
                suspended_at: null,
            },
        }
        : { data: { token: "installation-token" } });
    mocks.updateMany.mockResolvedValue({ count: 0 });
    mocks.octokit.mockImplementation(() => ({ request: mocks.request }));
});

describe("directory source scanner", () => {
    it("streams every managed GitHub resource page through the projection sink", async () => {
        mocks.request
            .mockResolvedValueOnce({ data: [{ id: 1, login: "alice" }], headers: { link: '<https://api.github.com/members?page=2>; rel="next"' } })
            .mockResolvedValueOnce({ data: [{ id: 2, login: "bob" }], headers: {} })
            .mockResolvedValueOnce({ data: [{ id: 77, name: "Engineering" }], headers: { link: '<https://api.github.com/teams?page=2>; rel="next"' } })
            .mockResolvedValueOnce({ data: [{ id: 1, login: "alice" }], headers: { link: '<https://api.github.com/team/77/members?page=2>; rel="next"' } })
            .mockResolvedValueOnce({ data: [{ id: 2, login: "bob" }], headers: {} })
            .mockResolvedValueOnce({ data: [{ id: 88, name: "Product" }], headers: {} })
            .mockResolvedValueOnce({ data: [{ id: 2, login: "bob" }], headers: {} });
        const writePeoplePage = vi.fn(async () => true);
        const writeGroupsPage = vi.fn(async () => true);
        const writeGroupMembersPage = vi.fn(async () => true);

        await expect(scanDirectorySource({
            source: claimedSource(),
            writePeoplePage,
            writeGroupsPage,
            writeGroupMembersPage,
        })).resolves.toEqual({
            ok: true,
            expectedCurrentness: {
                kind: "github_directory_read",
                directorySourceId: "source-scanner",
                githubInstallationId: 42n,
                githubOrganizationId: 84n,
                installationRevision: 3,
                registrationSecurityRevision: 5,
                organizationLogin: "Acme",
                networkPolicyFingerprint: expect.any(String),
            },
        });

        expect(writePeoplePage).toHaveBeenNthCalledWith(1, [
            { externalUserId: "1", active: true, login: "alice" },
        ]);
        expect(writePeoplePage).toHaveBeenNthCalledWith(2, [
            { externalUserId: "2", active: true, login: "bob" },
        ]);
        expect(writeGroupsPage).toHaveBeenNthCalledWith(1, [
            { externalGroupId: "77", displayName: "Engineering" },
        ]);
        expect(writeGroupsPage).toHaveBeenNthCalledWith(2, [
            { externalGroupId: "88", displayName: "Product" },
        ]);
        expect(writeGroupMembersPage).toHaveBeenNthCalledWith(1, [
            { externalGroupId: "77", externalUserId: "1" },
        ]);
        expect(writeGroupMembersPage).toHaveBeenNthCalledWith(2, [
            { externalGroupId: "77", externalUserId: "2" },
        ]);
        expect(writeGroupMembersPage).toHaveBeenNthCalledWith(3, [
            { externalGroupId: "88", externalUserId: "2" },
        ]);
    });

    it("preserves a nested member-page failure instead of misclassifying it as a stale run", async () => {
        mocks.request
            .mockResolvedValueOnce({ data: [], headers: {} })
            .mockResolvedValueOnce({ data: [{ id: 77, name: "Engineering" }], headers: {} })
            .mockRejectedValueOnce(Object.assign(new Error("rate limited"), {
                status: 429,
                response: { headers: { "retry-after": "30" } },
            }));

        await expect(scanDirectorySource({
            source: claimedSource(),
            writePeoplePage: async () => true,
            writeGroupsPage: async () => true,
            writeGroupMembersPage: async () => true,
        })).resolves.toEqual({
            ok: false,
            code: "directory_sync_rate_limited",
            retryAfterMs: 30_000,
        });
    });

    it("types GitHub network loss and server errors as unavailable and unexpected 4xx as malformed", async () => {
        const scan = () => scanDirectorySource({
            source: claimedSource(),
            writePeoplePage: async () => true,
            writeGroupsPage: async () => true,
            writeGroupMembersPage: async () => true,
        });

        // A network-level failure carries no HTTP status.
        mocks.request.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND upstream"));
        await expect(scan()).resolves.toEqual({ ok: false, code: "directory_sync_unavailable" });

        // A 5xx response is provider unavailability, not a malformed snapshot.
        mocks.request.mockRejectedValueOnce(Object.assign(new Error("upstream exploded"), {
            status: 502,
        }));
        await expect(scan()).resolves.toEqual({ ok: false, code: "directory_sync_unavailable" });

        // An unexpected 4xx response stays a malformed-snapshot failure.
        mocks.request.mockRejectedValueOnce(Object.assign(new Error("unexpected conflict"), {
            status: 409,
        }));
        await expect(scan()).resolves.toEqual({ ok: false, code: "directory_snapshot_incomplete" });
    });

});
