import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    const findUnique = vi.fn(async () => ({
        accountId: "account-1",
        revision: 0,
        state: "queued",
        leaseExpiresAt: null,
        replayCount: 0,
        payloadBytes: 1n,
        payloadPurgeAt: new Date("2026-08-11T00:00:00.000Z"),
        leaseId: null,
        targetMachineId: "machine-1",
        targetMachineInstallationId: "installation-1",
        targetMaterializationId: "materialization-1",
        targetPluginId: "acme.github",
        targetPluginVersion: "1.0.0",
    }));
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const findMany = vi.fn();
    const deleteMany = vi.fn(async () => ({ count: 1 }));
    const tombstoneFindMany = vi.fn();
    const tombstoneDeleteMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
        pluginWebhookDelivery: { findUnique, findMany, updateMany, deleteMany },
        pluginWebhookEndpoint: { findMany: tombstoneFindMany, deleteMany: tombstoneDeleteMany },
    };
    return {
        acquireFence: vi.fn(),
        findUnique,
        findMany,
        updateMany,
        deleteMany,
        tombstoneFindMany,
        tombstoneDeleteMany,
        tx,
        resolveTarget: vi.fn(),
        markAccountChanged: vi.fn(async () => undefined),
    };
});

vi.mock("@/storage/inTx", () => ({
    inTx: async (fn: (tx: typeof mocks.tx) => Promise<unknown>) => await fn(mocks.tx),
}));
vi.mock("@/storage/prisma", () => ({
    getActivePrismaRuntime: () => ({ DbNull: null }),
}));
vi.mock("@/app/encryption/accountEncryptionTransition", () => ({
    acquireAccountEncryptionTransitionFenceInTx: mocks.acquireFence,
}));
vi.mock("@/app/plugins/availability/operations", () => ({
    resolveCurrentClaimablePluginMachineMaterializationTx: mocks.resolveTarget,
}));
vi.mock("@/app/serverIdentity/serverIdentity", () => ({
    getOrCreateServerIdentityId: vi.fn(async () => "server-identity-1"),
}));
vi.mock("./accountChange", () => ({
    markPluginWebhookAccountChangedInTxV1: mocks.markAccountChanged,
}));

import {
    discardPluginWebhookDeliveryV1,
    purgeExpiredPluginWebhookDeliveriesV1,
    replayPluginWebhookDeliveryV1,
} from "./retention";

describe("plugin webhook discard Account encryption fence", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.findUnique.mockResolvedValue({
            accountId: "account-1",
            revision: 0,
            state: "queued",
            leaseExpiresAt: null,
            replayCount: 0,
            payloadBytes: 1n,
            payloadPurgeAt: new Date("2026-08-11T00:00:00.000Z"),
            leaseId: null,
            targetMachineId: "machine-1",
            targetMachineInstallationId: "installation-1",
            targetMaterializationId: "materialization-1",
            targetPluginId: "acme.github",
            targetPluginVersion: "1.0.0",
        });
        mocks.updateMany.mockResolvedValue({ count: 1 });
        mocks.findMany.mockReset();
        mocks.deleteMany.mockResolvedValue({ count: 1 });
        mocks.tombstoneFindMany.mockReset();
        mocks.tombstoneFindMany.mockResolvedValue([]);
        mocks.tombstoneDeleteMany.mockResolvedValue({ count: 1 });
        mocks.resolveTarget.mockReset();
    });

    it("refuses replay when the frozen target is no longer the exact current materialization", async () => {
        mocks.acquireFence.mockResolvedValue({
            status: "ready",
            account: { version: 1, currentness: { encryptionMode: "plain" } },
        });
        mocks.findUnique.mockResolvedValue({
            accountId: "account-1",
            revision: 4,
            state: "dead_letter",
            leaseExpiresAt: null,
            replayCount: 2,
            payloadBytes: 128n,
            payloadPurgeAt: new Date("2026-08-11T00:00:00.000Z"),
            leaseId: null,
            targetMachineId: "machine-1",
            targetMachineInstallationId: "installation-1",
            targetMaterializationId: "materialization-1",
            targetPluginId: "acme.github",
            targetPluginVersion: "1.0.0",
        });
        mocks.resolveTarget.mockResolvedValue({ kind: "not_current" });

        await expect(replayPluginWebhookDeliveryV1({
            accountId: "account-1",
            deliveryId: "delivery-1",
            expectedRevision: 4,
            now: new Date("2026-08-10T00:00:00.000Z"),
        })).resolves.toEqual({ kind: "unavailable" });
        expect(mocks.resolveTarget).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-1",
            serverIdentityId: "server-identity-1",
            machineId: "machine-1",
            machineInstallationId: "installation-1",
            materializationId: "materialization-1",
            pluginId: "acme.github",
            version: "1.0.0",
        }));
        expect(mocks.updateMany).not.toHaveBeenCalled();
    });

    it("waits for the canonical Account transition fence before reading or purging delivery state", async () => {
        let releaseFence!: () => void;
        mocks.acquireFence.mockImplementation(async () => await new Promise((resolve) => {
            releaseFence = () => resolve({
                status: "ready",
                account: {
                    version: 1,
                    currentness: { encryptionMode: "plain" },
                },
            });
        }));

        const pending = discardPluginWebhookDeliveryV1({
            accountId: "account-1",
            deliveryId: "delivery-1",
            expectedRevision: 0,
            discardedByUserId: "user-1",
            reasonCode: "user_requested",
            now: new Date("2026-08-10T00:00:00.000Z"),
        });
        await Promise.resolve();

        expect(mocks.acquireFence).toHaveBeenCalledWith(mocks.tx, "account-1");
        expect(mocks.findUnique).not.toHaveBeenCalled();
        expect(mocks.updateMany).not.toHaveBeenCalled();

        releaseFence();
        await expect(pending).resolves.toEqual({ kind: "discarded", revision: 1 });
        expect(mocks.updateMany).toHaveBeenCalledTimes(1);
    });

    it("fails closed without touching the delivery when Account encryption state is inconsistent", async () => {
        mocks.acquireFence.mockResolvedValue({
            status: "account_inconsistent",
            reason: "missing_content_key_binding",
        });

        await expect(discardPluginWebhookDeliveryV1({
            accountId: "account-1",
            deliveryId: "delivery-1",
            expectedRevision: 0,
            discardedByUserId: "user-1",
            reasonCode: "user_requested",
        })).resolves.toEqual({ kind: "unavailable" });
        expect(mocks.findUnique).not.toHaveBeenCalled();
        expect(mocks.updateMany).not.toHaveBeenCalled();
    });

    it("rechecks the canonical Account transition fence in each retention mutation transaction", async () => {
        mocks.findMany
            .mockResolvedValueOnce([{ id: "delivery-payload", accountId: "account-1" }])
            .mockResolvedValueOnce([{ id: "delivery-metadata", accountId: "account-1" }]);
        mocks.acquireFence.mockResolvedValue({
            status: "account_inconsistent",
            reason: "missing_content_key_binding",
        });

        await expect(purgeExpiredPluginWebhookDeliveriesV1({
            now: new Date("2026-08-10T00:00:00.000Z"),
            batchSize: 100,
        })).resolves.toEqual({ payloadsPurged: 0, metadataDeleted: 0, tombstonesDeleted: 0 });
        expect(mocks.acquireFence).toHaveBeenCalledWith(mocks.tx, "account-1");
        expect(mocks.updateMany).not.toHaveBeenCalled();
        expect(mocks.deleteMany).not.toHaveBeenCalled();
    });
});
