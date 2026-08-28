import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const acquireAccountEncryptionTransitionFenceInTx = vi.fn();
    const admitAccountDataEraseThroughEncryptionTransitionInTx = vi.fn();
    const findUnique = vi.fn();
    const deleteAccount = vi.fn();
    const queryRawUnsafe = vi.fn();
    const executeRawUnsafe = vi.fn();
    const endpointFindMany = vi.fn();
    const endpointDeleteMany = vi.fn();
    const endpointUpdateMany = vi.fn();
    const deliveryDeleteMany = vi.fn();
    const operationDeleteMany = vi.fn();
    const routeDeleteMany = vi.fn();
    const domainDeleteMany = vi.fn();
    const sessionFindMany = vi.fn();
    const uploadedFileFindMany = vi.fn();
    const accountPetAssetFindMany = vi.fn();
    const deleteSessionTree = vi.fn();
    const deletePublicFile = vi.fn();
    const deleteDefaultAccountPetPrivateObject = vi.fn();
    const tx = {
        account: {
            findUnique,
            delete: deleteAccount,
        },
        $queryRawUnsafe: queryRawUnsafe,
        $executeRawUnsafe: executeRawUnsafe,
        pluginWebhookEndpoint: {
            findMany: endpointFindMany,
            deleteMany: endpointDeleteMany,
            updateMany: endpointUpdateMany,
        },
        pluginWebhookDelivery: { deleteMany: deliveryDeleteMany },
        pluginWebhookEndpointOperation: { deleteMany: operationDeleteMany },
        pluginWebhookRoute: { deleteMany: routeDeleteMany },
        session: { findMany: sessionFindMany }, uploadedFile: { findMany: uploadedFileFindMany, deleteMany: domainDeleteMany }, accountPetAsset: { findMany: accountPetAssetFindMany },
        sessionShareAccessLog: { deleteMany: domainDeleteMany }, publicShareAccessLog: { deleteMany: domainDeleteMany }, sessionShare: { deleteMany: domainDeleteMany }, publicSessionShare: { deleteMany: domainDeleteMany },
        accessKey: { deleteMany: domainDeleteMany }, usageReport: { deleteMany: domainDeleteMany }, accountPushToken: { deleteMany: domainDeleteMany }, accountPluginUiArtifact: { deleteMany: domainDeleteMany }, accountPluginRelease: { deleteMany: domainDeleteMany }, artifact: { deleteMany: domainDeleteMany }, machine: { deleteMany: domainDeleteMany },
    };
    return {
        acquireAccountEncryptionTransitionFenceInTx,
        admitAccountDataEraseThroughEncryptionTransitionInTx,
        findUnique,
        deleteAccount,
        queryRawUnsafe,
        executeRawUnsafe,
        endpointFindMany,
        endpointDeleteMany,
        endpointUpdateMany,
        deliveryDeleteMany,
        operationDeleteMany,
        routeDeleteMany,
        domainDeleteMany, sessionFindMany, uploadedFileFindMany, accountPetAssetFindMany, deleteSessionTree,
        deletePublicFile, deleteDefaultAccountPetPrivateObject,
        tx,
    };
});

vi.mock("@/storage/inTx", () => ({
    inTx: async (operation: (tx: typeof mocks.tx) => Promise<unknown>) => await operation(mocks.tx),
    afterTx: (_tx: typeof mocks.tx, callback: () => void) => callback(),
}));
vi.mock("@/app/session/delete/deleteSessionTree", () => ({ deleteSessionTree: mocks.deleteSessionTree }));
vi.mock("@/storage/blob/files", () => ({ deletePublicFile: mocks.deletePublicFile }));
vi.mock("@/app/pets/accountPetLibraryRuntime", () => ({
    deleteDefaultAccountPetPrivateObject: mocks.deleteDefaultAccountPetPrivateObject,
}));

vi.mock("@/app/encryption/accountEncryptionTransition", () => ({
    acquireAccountEncryptionTransitionFenceInTx:
        mocks.acquireAccountEncryptionTransitionFenceInTx,
}));

vi.mock("@/app/encryption/accountEncryptionTransitionCoordinator", () => ({
    admitAccountDataEraseThroughEncryptionTransitionInTx:
        mocks.admitAccountDataEraseThroughEncryptionTransitionInTx,
}));

import {
    deleteAccountForErasure,
    erasePluginAccountDataInTx,
} from "./accountDataErase";

describe("deleteAccountForErasure", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.findUnique.mockResolvedValue({ id: "account-1" });
        mocks.acquireAccountEncryptionTransitionFenceInTx.mockResolvedValue({
            status: "ready",
            account: {
                currentness: { encryptionMode: "plain" },
            },
        });
        mocks.admitAccountDataEraseThroughEncryptionTransitionInTx.mockResolvedValue({
            status: "ready",
        });
        mocks.deleteAccount.mockResolvedValue({ id: "account-1" });
        mocks.queryRawUnsafe.mockResolvedValue([{ id: "account-1" }]);
        mocks.executeRawUnsafe.mockResolvedValue(1);
        mocks.endpointFindMany.mockResolvedValue([]);
        mocks.endpointDeleteMany.mockResolvedValue({ count: 0 });
        mocks.endpointUpdateMany.mockResolvedValue({ count: 0 });
        mocks.deliveryDeleteMany.mockResolvedValue({ count: 0 });
        mocks.operationDeleteMany.mockResolvedValue({ count: 0 });
        mocks.routeDeleteMany.mockResolvedValue({ count: 0 });
        mocks.domainDeleteMany.mockResolvedValue({ count: 0 });
        mocks.sessionFindMany.mockResolvedValue([]);
        mocks.uploadedFileFindMany.mockResolvedValue([]);
        mocks.accountPetAssetFindMany.mockResolvedValue([]);
        mocks.deleteSessionTree.mockResolvedValue(undefined);
        mocks.deletePublicFile.mockResolvedValue(undefined);
        mocks.deleteDefaultAccountPetPrivateObject.mockResolvedValue(undefined);
    });

    it("composes webhook cleanup and the physical Account delete in one transaction", async () => {
        const now = new Date("2026-08-10T09:00:00.000Z");

        await expect(deleteAccountForErasure({ accountId: "account-1", now })).resolves.toEqual({
            status: "deleted",
        });

        expect(mocks.acquireAccountEncryptionTransitionFenceInTx).toHaveBeenCalledWith(
            mocks.tx,
            "account-1",
        );

        expect(mocks.findUnique).not.toHaveBeenCalled();
        expect(mocks.deliveryDeleteMany).toHaveBeenCalledWith({ where: { accountId: "account-1" } });
        expect(mocks.operationDeleteMany).toHaveBeenCalledWith({ where: { accountId: "account-1" } });
        expect(mocks.deleteAccount).toHaveBeenCalledWith({ where: { id: "account-1" } });
        expect(mocks.operationDeleteMany.mock.invocationCallOrder[0]!).toBeLessThan(
            mocks.deleteAccount.mock.invocationCallOrder[0]!,
        );
    });

    it("uses the Session owner and removes captured file bytes only after the Account delete", async () => {
        const updatedAt = new Date("2026-08-27T10:00:00.000Z");
        mocks.sessionFindMany.mockResolvedValue([{ id: "session-1", updatedAt }]);
        mocks.uploadedFileFindMany.mockResolvedValue([{ path: "public/users/account-1/avatar.jpg" }]);
        mocks.accountPetAssetFindMany.mockResolvedValue([{
            objectKey: "private/accounts/account-1/pets/pet-1/sheet.webp",
        }]);

        await expect(deleteAccountForErasure({ accountId: "account-1" })).resolves.toEqual({
            status: "deleted",
        });
        await Promise.resolve();

        expect(mocks.deleteSessionTree).toHaveBeenCalledWith(mocks.tx, {
            sessionId: "session-1",
            sessionUpdatedAt: updatedAt,
            actorAccountId: "account-1",
            reason: "user_request",
            sessionDeleteWhere: { accountId: "account-1" },
        });
        expect(mocks.deletePublicFile).toHaveBeenCalledWith("public/users/account-1/avatar.jpg");
        expect(mocks.deleteDefaultAccountPetPrivateObject).toHaveBeenCalledWith(
            "private/accounts/account-1/pets/pet-1/sheet.webp",
        );
        expect(mocks.deleteAccount.mock.invocationCallOrder[0]!).toBeLessThan(
            mocks.deletePublicFile.mock.invocationCallOrder[0]!,
        );
    });

    it("does not invoke a cleanup or delete for an Account that is already absent", async () => {
        mocks.acquireAccountEncryptionTransitionFenceInTx.mockResolvedValue({
            status: "account_not_found",
        });

        await expect(deleteAccountForErasure({ accountId: "account-1" })).resolves.toEqual({
            status: "already-deleted",
        });

        expect(mocks.findUnique).not.toHaveBeenCalled();
        expect(mocks.deliveryDeleteMany).not.toHaveBeenCalled();
        expect(mocks.operationDeleteMany).not.toHaveBeenCalled();
        expect(mocks.deleteAccount).not.toHaveBeenCalled();
    });

    it("takes the Account-first transition fence before a plugin-data erase can inspect a missing Account", async () => {
        mocks.admitAccountDataEraseThroughEncryptionTransitionInTx.mockResolvedValue({
            status: "account_not_found",
        });

        await expect(erasePluginAccountDataInTx({
            tx: mocks.tx as never,
            accountId: "account-1",
            pluginId: "example.erase",
        })).resolves.toEqual({ status: "account-not-found" });

        expect(mocks.admitAccountDataEraseThroughEncryptionTransitionInTx).toHaveBeenCalledWith({
            tx: mocks.tx,
            accountId: "account-1",
        });
        expect(mocks.findUnique).not.toHaveBeenCalled();
    });
});
