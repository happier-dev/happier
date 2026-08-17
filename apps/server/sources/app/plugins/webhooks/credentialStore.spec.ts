import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const route = {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        updateMany: vi.fn(),
    };
    const credential = {
        findMany: vi.fn(),
        deleteMany: vi.fn(),
    };
    return {
        tx: {
            pluginWebhookRoute: route,
            pluginWebhookCredential: credential,
        },
        route,
        credential,
        decryptSecret: vi.fn(),
        markRouteAccountsChanged: vi.fn(async () => undefined),
    };
});

vi.mock("@/storage/inTx", () => ({
    inTx: async (fn: (tx: typeof mocks.tx) => Promise<unknown>) => await fn(mocks.tx),
}));
vi.mock("./credentialCipher", () => ({
    encryptPluginWebhookCredentialSecretV1: vi.fn(),
    decryptPluginWebhookCredentialSecretV1: mocks.decryptSecret,
}));
vi.mock("./accountChange", () => ({
    markPluginWebhookRouteAccountsChangedInTxV1: mocks.markRouteAccountsChanged,
}));

import {
    finishPluginWebhookCredentialRotationV1,
    readPluginWebhookVerificationCredentialsV1,
    retireExpiredPluginWebhookCredentialsV1,
} from "./credentialStore";

describe("plugin webhook previous credential retirement", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.route.updateMany.mockResolvedValue({ count: 1 });
        mocks.credential.deleteMany.mockResolvedValue({ count: 1 });
        mocks.decryptSecret.mockImplementation(({ credentialVersionId }: { credentialVersionId: string }) => (
            `secret-for-${credentialVersionId}`
        ));
    });

    it("admits previous strictly before acceptUntil and retires it at equality", async () => {
        const acceptUntil = new Date("2026-08-11T01:00:00.000Z");
        const route = {
            verifierKind: "github_hmac_sha256_v1",
            currentCredential: {
                credentialVersionId: "current-version",
                verifierKind: "github_hmac_sha256_v1",
                encryptedSecret: Uint8Array.of(1),
                state: "current",
            },
            previousCredential: {
                id: "previous-row",
                routeId: "route-1",
                credentialVersionId: "previous-version",
                verifierKind: "github_hmac_sha256_v1",
                encryptedSecret: Uint8Array.of(2),
                state: "previous",
                acceptUntil,
            },
        };
        mocks.route.findFirst.mockResolvedValue(route);

        await expect(readPluginWebhookVerificationCredentialsV1({
            routeId: "route-1",
            now: new Date(acceptUntil.getTime() - 1),
        })).resolves.toEqual([
            { credentialVersionId: "current-version", secret: "secret-for-current-version" },
            { credentialVersionId: "previous-version", secret: "secret-for-previous-version" },
        ]);
        expect(mocks.route.updateMany).not.toHaveBeenCalled();
        expect(mocks.credential.deleteMany).not.toHaveBeenCalled();

        vi.clearAllMocks();
        mocks.route.findFirst.mockResolvedValue(route);
        mocks.route.updateMany.mockResolvedValue({ count: 1 });
        mocks.credential.deleteMany.mockResolvedValue({ count: 1 });
        mocks.decryptSecret.mockImplementation(({ credentialVersionId }: { credentialVersionId: string }) => (
            `secret-for-${credentialVersionId}`
        ));

        await expect(readPluginWebhookVerificationCredentialsV1({
            routeId: "route-1",
            now: acceptUntil,
        })).resolves.toEqual([
            { credentialVersionId: "current-version", secret: "secret-for-current-version" },
        ]);
        expect(mocks.route.updateMany).toHaveBeenCalledWith({
            where: {
                id: "route-1",
                previousCredentialId: "previous-row",
                NOT: { currentCredentialId: "previous-row" },
            },
            data: { previousCredentialId: null },
        });
        expect(mocks.credential.deleteMany).toHaveBeenCalledWith({
            where: {
                id: "previous-row",
                routeId: "route-1",
                state: "previous",
                acceptUntil: { lte: acceptUntil },
                currentForRoute: { is: null },
                previousForRoute: { is: null },
            },
        });
        expect(mocks.decryptSecret).not.toHaveBeenCalledWith(expect.objectContaining({
            credentialVersionId: "previous-version",
        }));
        expect(mocks.markRouteAccountsChanged).toHaveBeenCalledWith(mocks.tx, "route-1");
    });

    it("retires ciphertext at the exact acceptUntil boundary after clearing the route pointer", async () => {
        const acceptUntil = new Date("2026-08-11T01:00:00.000Z");
        mocks.credential.findMany.mockResolvedValue([{
            id: "credential-row-1",
            routeId: "route-1",
        }]);

        await expect(retireExpiredPluginWebhookCredentialsV1({
            now: acceptUntil,
            batchSize: 25,
        })).resolves.toEqual({ retired: 1 });

        expect(mocks.credential.findMany).toHaveBeenCalledWith({
            where: {
                state: "previous",
                acceptUntil: { lte: acceptUntil },
            },
            orderBy: [{ acceptUntil: "asc" }, { id: "asc" }],
            take: 25,
            select: { id: true, routeId: true },
        });
        expect(mocks.route.updateMany).toHaveBeenCalledWith({
            where: {
                id: "route-1",
                previousCredentialId: "credential-row-1",
                NOT: { currentCredentialId: "credential-row-1" },
            },
            data: { previousCredentialId: null },
        });
        expect(mocks.credential.deleteMany).toHaveBeenCalledWith({
            where: {
                id: "credential-row-1",
                routeId: "route-1",
                state: "previous",
                acceptUntil: { lte: acceptUntil },
                currentForRoute: { is: null },
                previousForRoute: { is: null },
            },
        });
        expect(mocks.route.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.credential.deleteMany.mock.invocationCallOrder[0]!,
        );
        expect(mocks.markRouteAccountsChanged).toHaveBeenCalledWith(mocks.tx, "route-1");
    });

    it("does not delete an expired candidate if a concurrent owner still references it", async () => {
        mocks.credential.findMany.mockResolvedValue([{
            id: "credential-row-1",
            routeId: "route-1",
        }]);
        mocks.route.updateMany.mockResolvedValue({ count: 0 });
        mocks.credential.deleteMany.mockResolvedValue({ count: 0 });

        await expect(retireExpiredPluginWebhookCredentialsV1({
            now: new Date("2026-08-11T01:00:00.000Z"),
        })).resolves.toEqual({ retired: 0 });

        expect(mocks.credential.deleteMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                currentForRoute: { is: null },
                previousForRoute: { is: null },
            }),
        }));
    });

    it("finishes rotation by exact previous version with a CAS pointer clear and ciphertext deletion", async () => {
        mocks.route.findUnique.mockResolvedValue({
            verifierKind: "github_hmac_sha256_v1",
            previousCredentialId: "credential-row-1",
            previousCredential: {
                credentialVersionId: "credential-version-1",
                state: "previous",
            },
        });

        await expect(finishPluginWebhookCredentialRotationV1({
            routeId: "route-1",
            expectedPreviousCredentialVersionId: "credential-version-1",
        })).resolves.toEqual({ kind: "retired" });

        expect(mocks.route.updateMany).toHaveBeenCalledWith({
            where: {
                id: "route-1",
                previousCredentialId: "credential-row-1",
                NOT: { currentCredentialId: "credential-row-1" },
            },
            data: { previousCredentialId: null },
        });
        expect(mocks.credential.deleteMany).toHaveBeenCalledWith({
            where: {
                id: "credential-row-1",
                routeId: "route-1",
                state: "previous",
                credentialVersionId: "credential-version-1",
                currentForRoute: { is: null },
                previousForRoute: { is: null },
            },
        });
        expect(mocks.markRouteAccountsChanged).toHaveBeenCalledWith(mocks.tx, "route-1");
    });

    it("fails closed when the expected previous credential changed", async () => {
        mocks.route.findUnique.mockResolvedValue({
            verifierKind: "github_hmac_sha256_v1",
            previousCredentialId: "credential-row-2",
            previousCredential: {
                credentialVersionId: "credential-version-2",
                state: "previous",
            },
        });

        await expect(finishPluginWebhookCredentialRotationV1({
            routeId: "route-1",
            expectedPreviousCredentialVersionId: "credential-version-1",
        })).resolves.toEqual({ kind: "credentialChanged" });
        expect(mocks.route.updateMany).not.toHaveBeenCalled();
        expect(mocks.credential.deleteMany).not.toHaveBeenCalled();
    });

    it("treats a repeated finish after successful retirement as already retired", async () => {
        mocks.route.findUnique.mockResolvedValue({
            verifierKind: "github_hmac_sha256_v1",
            previousCredentialId: null,
            previousCredential: null,
        });

        await expect(finishPluginWebhookCredentialRotationV1({
            routeId: "route-1",
            expectedPreviousCredentialVersionId: "credential-version-1",
        })).resolves.toEqual({ kind: "alreadyRetired" });
        expect(mocks.route.updateMany).not.toHaveBeenCalled();
        expect(mocks.credential.deleteMany).not.toHaveBeenCalled();
    });

    it("does not delete ciphertext when the route-pointer CAS loses a race", async () => {
        mocks.route.findUnique.mockResolvedValue({
            verifierKind: "github_hmac_sha256_v1",
            previousCredentialId: "credential-row-1",
            previousCredential: {
                credentialVersionId: "credential-version-1",
                state: "previous",
            },
        });
        mocks.route.updateMany.mockResolvedValue({ count: 0 });

        await expect(finishPluginWebhookCredentialRotationV1({
            routeId: "route-1",
            expectedPreviousCredentialVersionId: "credential-version-1",
        })).resolves.toEqual({ kind: "credentialChanged" });
        expect(mocks.credential.deleteMany).not.toHaveBeenCalled();
    });
});
