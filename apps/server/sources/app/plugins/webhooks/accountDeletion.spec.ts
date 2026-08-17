import { describe, expect, it, vi } from "vitest";

const acquireAccountFence = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/app/encryption/accountSessionOwnerMetadataFence", () => ({
    acquireAccountSessionOwnerMetadataFenceInTx: acquireAccountFence,
}));

import { cleanupPluginWebhooksForAccountDeletionTxV1 } from "./accountDeletion";

function createTx() {
    const findMany = vi.fn(async () => [
        {
            id: "wh_ep_account",
            routeId: "route-account",
            routingKind: "accountEndpoint",
            providerInstallationId: null,
        },
        {
            id: "wh_ep_shared",
            routeId: "route-shared",
            routingKind: "providerInstallation",
            providerInstallationId: "123456789",
        },
    ]);
    const deliveryDeleteMany = vi.fn(async () => ({ count: 2 }));
    const operationDeleteMany = vi.fn(async () => ({ count: 2 }));
    const endpointDeleteMany = vi.fn(async () => ({ count: 1 }));
    const endpointUpdateMany = vi.fn(async () => ({ count: 1 }));
    let routeCredentialPointersCleared = false;
    const routeUpdateMany = vi.fn(async () => {
        routeCredentialPointersCleared = true;
        return { count: 1 };
    });
    const routeDeleteMany = vi.fn(async () => {
        if (!routeCredentialPointersCleared) {
            throw new Error("Plugin webhook route credentials must be detached before route deletion");
        }
        return { count: 1 };
    });
    return {
        tx: {
            pluginWebhookEndpoint: {
                findMany,
                deleteMany: endpointDeleteMany,
                updateMany: endpointUpdateMany,
            },
            pluginWebhookDelivery: { deleteMany: deliveryDeleteMany },
            pluginWebhookEndpointOperation: { deleteMany: operationDeleteMany },
            pluginWebhookRoute: { updateMany: routeUpdateMany, deleteMany: routeDeleteMany },
        },
        findMany,
        deliveryDeleteMany,
        operationDeleteMany,
        endpointDeleteMany,
        endpointUpdateMany,
        routeUpdateMany,
        routeDeleteMany,
    };
}

describe("cleanupPluginWebhooksForAccountDeletionTxV1", () => {
    it("purges Account-owned custody and scrubs shared bindings to replay-isolation tombstones", async () => {
        const fixture = createTx();
        const now = new Date("2026-08-10T09:00:00.000Z");

        await expect(cleanupPluginWebhooksForAccountDeletionTxV1(
            fixture.tx as never,
            { accountId: "account-1", now },
        )).resolves.toEqual({
            deliveriesDeleted: 2,
            operationsDeleted: 2,
            accountEndpointsDeleted: 1,
            accountRoutesDeleted: 1,
            sharedEndpointsScrubbed: 1,
        });

        expect(acquireAccountFence).toHaveBeenCalledWith(fixture.tx, "account-1");
        expect(fixture.deliveryDeleteMany).toHaveBeenCalledWith({ where: { accountId: "account-1" } });
        expect(fixture.operationDeleteMany).toHaveBeenCalledWith({ where: { accountId: "account-1" } });
        expect(fixture.endpointDeleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["wh_ep_account"] },
                accountId: "account-1",
                routingKind: "accountEndpoint",
            },
        });
        expect(fixture.endpointUpdateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["wh_ep_shared"] },
                accountId: "account-1",
                routingKind: "providerInstallation",
                providerInstallationId: { not: null },
            },
            data: {
                accountId: null,
                pluginId: null,
                webhookContributionId: null,
                handlerActionId: null,
                sourceInstanceId: null,
                ensureIdempotencyKey: null,
                ensureRequestFingerprint: null,
                setupKind: null,
                enabled: false,
                revision: { increment: 1 },
                revokedAt: null,
                releasedAt: now,
                tombstoneExpiresAt: new Date("2026-08-17T09:00:00.000Z"),
                targetMachineId: null,
                targetMachineInstallationId: null,
                targetMaterializationId: null,
                targetPluginVersion: null,
                previousTargetMachineId: null,
                previousTargetMachineInstallationId: null,
                previousTargetMaterializationId: null,
                previousTargetPluginVersion: null,
            },
        });
        expect(fixture.routeUpdateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["route-account"] },
                routingKind: "accountEndpoint",
                endpoints: { none: {} },
            },
            data: {
                currentCredentialId: null,
                previousCredentialId: null,
            },
        });
        expect(fixture.routeDeleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ["route-account"] },
                routingKind: "accountEndpoint",
                endpoints: { none: {} },
            },
        });
    });

    it("fails closed before mutation when a shared binding lacks canonical installation identity", async () => {
        const fixture = createTx();
        fixture.findMany.mockResolvedValue([{
            id: "wh_ep_shared",
            routeId: "route-shared",
            routingKind: "providerInstallation",
            providerInstallationId: null,
        }]);

        await expect(cleanupPluginWebhooksForAccountDeletionTxV1(
            fixture.tx as never,
            { accountId: "account-1" },
        )).rejects.toThrow("shared endpoint is missing canonical installation identity");
        expect(fixture.deliveryDeleteMany).not.toHaveBeenCalled();
        expect(fixture.operationDeleteMany).not.toHaveBeenCalled();
        expect(fixture.endpointDeleteMany).not.toHaveBeenCalled();
        expect(fixture.endpointUpdateMany).not.toHaveBeenCalled();
        expect(fixture.routeUpdateMany).not.toHaveBeenCalled();
        expect(fixture.routeDeleteMany).not.toHaveBeenCalled();
    });
});
