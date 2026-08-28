import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    type PluginWebhookDeliveryContentV1,
} from "@happier-dev/protocol";

const mocks = vi.hoisted(() => {
    const delivery = {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        aggregate: vi.fn(),
        create: vi.fn(),
        updateMany: vi.fn(),
    };
    const tx = {
        pluginWebhookEndpoint: { findFirst: vi.fn(), updateMany: vi.fn() },
        pluginWebhookDelivery: delivery,
    };
    return {
        tx,
        delivery,
        acquireFence: vi.fn(),
        resolveTarget: vi.fn(),
        afterTx: vi.fn((_tx: unknown, callback: () => void) => callback()),
        markAccountChanged: vi.fn(async () => 123),
    };
});

vi.mock("@/storage/inTx", () => ({
    inTx: async (fn: (tx: typeof mocks.tx) => Promise<unknown>) => await fn(mocks.tx),
    afterTx: mocks.afterTx,
}));
vi.mock("@/storage/db", () => ({
    db: { pluginWebhookDelivery: mocks.delivery },
    isPrismaErrorCode: (error: unknown, code: string) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === code
    ),
}));
vi.mock("@/app/encryption/accountEncryptionTransition", () => ({
    acquireAccountEncryptionTransitionFenceInTx: mocks.acquireFence,
}));
vi.mock("@/app/plugins/availability/operations", () => ({
    resolveCurrentClaimablePluginMachineMaterializationTx: mocks.resolveTarget,
}));
vi.mock("@/app/serverIdentity/serverIdentity", () => ({
    getOrCreateServerIdentityId: async () => "server-1",
}));
vi.mock("./accountChange", () => ({
    markPluginWebhookAccountChangedInTxV1: mocks.markAccountChanged,
}));

import { admitPluginWebhookDeliveryV1, movePendingPluginWebhookDeliveriesV1 } from "./deliveryStore";
import { createPluginWebhookStoredEnvelopeV1 } from "./storedEnvelope";

const content: PluginWebhookDeliveryContentV1 = {
    v: 1,
    receivedAtMs: 1,
    contentType: "application/json",
    headers: [{ name: "x-github-event", value: "issues" }],
    rawBodyBytes: 2,
    rawBodyBase64: "e30=",
    verified: {
        verifier: "github_hmac_sha256_v1",
        providerDeliveryId: "provider-delivery-1",
        eventType: "issues",
        credentialVersionId: "credential-1",
    },
};

function plainStoredEnvelope() {
    const stored = createPluginWebhookStoredEnvelopeV1({
        account: {
            publicKey: null,
            encryptionMode: "plain",
            contentPublicKey: null,
            contentPublicKeySig: null,
        },
        content,
    });
    if (!stored.ok) throw new Error("Expected a plain stored webhook envelope");
    return stored;
}

describe("plugin webhook delivery store exact-target admission", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.delivery.findUnique.mockResolvedValue(null);
        mocks.tx.pluginWebhookEndpoint.findFirst.mockResolvedValue({
            id: "endpoint-1",
            accountId: "account-1",
            pluginId: "acme.github",
            routeId: "route-1",
            revision: 2,
            providerConfirmedAt: null,
            targetMachineId: "machine-1",
            targetMachineInstallationId: "installation-1",
            targetMaterializationId: "materialization-1",
            targetPluginVersion: "1.0.0",
            webhookContributionId: "github-events",
            handlerActionId: "handle-webhook",
            sourceInstanceId: "source-1",
            route: { currentCredential: { credentialVersionId: "credential-1" } },
        });
        mocks.acquireFence.mockResolvedValue({
            status: "ready",
            account: {
                currentness: {
                    encryptionMode: "plain",
                    contentPublicKeyFingerprint: null,
                },
            },
        });
        mocks.resolveTarget.mockResolvedValue({ kind: "current", materialization: {} });
        mocks.delivery.count.mockResolvedValue(0);
        mocks.delivery.aggregate.mockResolvedValue({ _sum: { payloadBytes: 0n } });
        mocks.delivery.create.mockResolvedValue({ id: "delivery-1" });
        mocks.tx.pluginWebhookEndpoint.updateMany.mockResolvedValue({ count: 1 });
    });

    it("uses the authenticated server origin and freezes only the server-scoped materialization tuple", async () => {
        const wake = vi.fn();
        const stored = plainStoredEnvelope();
        await expect(admitPluginWebhookDeliveryV1({
            endpointId: "endpoint-1",
            expectedEndpointRevision: 2,
            routeId: "route-1",
            verifierKind: "github_hmac_sha256_v1",
            credentialVersionId: "credential-1",
            deliveryIdentityDigest: "a".repeat(64),
            stored,
            now: new Date("2026-08-10T00:00:00.000Z"),
            onCommittedWake: wake,
        })).resolves.toEqual({ kind: "admitted", deliveryId: "delivery-1" });

        expect(mocks.resolveTarget).toHaveBeenCalledWith(expect.objectContaining({
            accountId: "account-1",
            serverIdentityId: "server-1",
            machineId: "machine-1",
            machineInstallationId: "installation-1",
            materializationId: "materialization-1",
            pluginId: "acme.github",
            version: "1.0.0",
        }));
        expect(mocks.delivery.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                targetMachineId: "machine-1",
                targetMachineInstallationId: "installation-1",
                targetMaterializationId: "materialization-1",
                targetPluginId: "acme.github",
                targetPluginVersion: "1.0.0",
                endpointRevision: 2,
                endpointWebhookContributionId: "github-events",
                endpointHandlerActionId: "handle-webhook",
                endpointSourceInstanceId: "source-1",
                payload: JSON.parse(new TextDecoder().decode(stored.canonicalEnvelopeBytes)),
                payloadBytes: BigInt(stored.canonicalEnvelopeBytes.byteLength),
                metadataDeleteAt: new Date("2026-08-17T00:00:00.000Z"),
            }),
        }));
        expect(mocks.delivery.create.mock.calls[0]?.[0]?.data).not.toHaveProperty("targetServerIdentityId");
        expect(mocks.afterTx).toHaveBeenCalledTimes(1);
        expect(wake).toHaveBeenCalledWith({
            accountId: "account-1",
            targetMachineId: "machine-1",
            accountChangeCursor: 123,
        });
    });

    it("stamps the provider-confirmation fact exactly once, in the same transaction as the admitted row", async () => {
        await expect(admitPluginWebhookDeliveryV1({
            endpointId: "endpoint-1",
            expectedEndpointRevision: 2,
            routeId: "route-1",
            verifierKind: "github_hmac_sha256_v1",
            credentialVersionId: "credential-1",
            deliveryIdentityDigest: "a".repeat(64),
            stored: plainStoredEnvelope(),
            now: new Date("2026-08-10T00:00:00.000Z"),
        })).resolves.toEqual({ kind: "admitted", deliveryId: "delivery-1" });

        // Readiness projections read this column; without the write an enabled
        // endpoint the provider really is delivering to stays unconfirmed.
        expect(mocks.tx.pluginWebhookEndpoint.updateMany).toHaveBeenCalledWith({
            where: { id: "endpoint-1", providerConfirmedAt: null },
            data: { providerConfirmedAt: new Date("2026-08-10T00:00:00.000Z") },
        });

        // An endpoint already confirmed keeps its original instant.
        vi.clearAllMocks();
        mocks.delivery.findUnique.mockResolvedValue(null);
        mocks.tx.pluginWebhookEndpoint.findFirst.mockResolvedValue({
            id: "endpoint-1",
            accountId: "account-1",
            pluginId: "acme.github",
            routeId: "route-1",
            revision: 2,
            providerConfirmedAt: new Date("2026-08-01T00:00:00.000Z"),
            targetMachineId: "machine-1",
            targetMachineInstallationId: "installation-1",
            targetMaterializationId: "materialization-1",
            targetPluginVersion: "1.0.0",
            webhookContributionId: "github-events",
            handlerActionId: "handle-webhook",
            sourceInstanceId: "source-1",
            route: { currentCredential: { credentialVersionId: "credential-1" } },
        });
        mocks.acquireFence.mockResolvedValue({
            status: "ready",
            account: { currentness: { encryptionMode: "plain", contentPublicKeyFingerprint: null } },
        });
        mocks.resolveTarget.mockResolvedValue({ kind: "current", materialization: {} });
        mocks.delivery.count.mockResolvedValue(0);
        mocks.delivery.aggregate.mockResolvedValue({ _sum: { payloadBytes: 0n } });
        mocks.delivery.create.mockResolvedValue({ id: "delivery-2" });
        mocks.markAccountChanged.mockResolvedValue(123);

        await expect(admitPluginWebhookDeliveryV1({
            endpointId: "endpoint-1",
            expectedEndpointRevision: 2,
            routeId: "route-1",
            verifierKind: "github_hmac_sha256_v1",
            credentialVersionId: "credential-1",
            deliveryIdentityDigest: "b".repeat(64),
            stored: plainStoredEnvelope(),
            now: new Date("2026-08-11T00:00:00.000Z"),
        })).resolves.toEqual({ kind: "admitted", deliveryId: "delivery-2" });
        expect(mocks.tx.pluginWebhookEndpoint.updateMany).not.toHaveBeenCalled();
    });

    it("confirms only a delivery verified under the route's current credential", async () => {
        // A rotation cleared the confirmation and the provider has not been
        // reconfigured yet, so this delivery still carries the superseded
        // secret. It verifies during the overlap window, but it proves nothing
        // about the credential every later delivery will have to use.
        mocks.tx.pluginWebhookEndpoint.findFirst.mockResolvedValue({
            id: "endpoint-1",
            accountId: "account-1",
            pluginId: "acme.github",
            routeId: "route-1",
            revision: 2,
            providerConfirmedAt: null,
            targetMachineId: "machine-1",
            targetMachineInstallationId: "installation-1",
            targetMaterializationId: "materialization-1",
            targetPluginVersion: "1.0.0",
            webhookContributionId: "github-events",
            handlerActionId: "handle-webhook",
            sourceInstanceId: "source-1",
            route: { currentCredential: { credentialVersionId: "credential-2" } },
        });

        await expect(admitPluginWebhookDeliveryV1({
            endpointId: "endpoint-1",
            expectedEndpointRevision: 2,
            routeId: "route-1",
            verifierKind: "github_hmac_sha256_v1",
            credentialVersionId: "credential-1",
            deliveryIdentityDigest: "c".repeat(64),
            stored: plainStoredEnvelope(),
            now: new Date("2026-08-11T00:00:00.000Z"),
        })).resolves.toEqual({ kind: "admitted", deliveryId: "delivery-1" });
        expect(mocks.tx.pluginWebhookEndpoint.updateMany).not.toHaveBeenCalled();

        // Positive twin: the identical delivery under the current credential
        // does confirm, so the refusal above is the credential version and not
        // a broken confirmation write.
        await expect(admitPluginWebhookDeliveryV1({
            endpointId: "endpoint-1",
            expectedEndpointRevision: 2,
            routeId: "route-1",
            verifierKind: "github_hmac_sha256_v1",
            credentialVersionId: "credential-2",
            deliveryIdentityDigest: "d".repeat(64),
            stored: plainStoredEnvelope(),
            now: new Date("2026-08-11T00:00:00.000Z"),
        })).resolves.toEqual({ kind: "admitted", deliveryId: "delivery-1" });
        expect(mocks.tx.pluginWebhookEndpoint.updateMany).toHaveBeenCalledWith({
            where: { id: "endpoint-1", providerConfirmedAt: null },
            data: { providerConfirmedAt: new Date("2026-08-11T00:00:00.000Z") },
        });
    });
});

describe("plugin webhook delivery pending-target movement", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.tx.pluginWebhookEndpoint.findFirst.mockResolvedValue({
            id: "endpoint-1",
            accountId: "account-1",
            pluginId: "acme.github",
            revision: 3,
            enabled: true,
            revokedAt: null,
            targetMachineId: "machine-2",
            targetMachineInstallationId: "installation-2",
            targetMaterializationId: "materialization-2",
            targetPluginVersion: "1.0.0",
            previousTargetMachineId: "machine-1",
            previousTargetMachineInstallationId: "installation-1",
            previousTargetMaterializationId: "materialization-1",
            previousTargetPluginVersion: "1.0.0",
        });
        mocks.resolveTarget.mockResolvedValue({ kind: "current", materialization: {} });
        mocks.delivery.findMany.mockResolvedValue([
            { id: "delivery-1", state: "queued", revision: 1 },
            { id: "delivery-2", state: "claimed", revision: 2 },
            { id: "delivery-3", state: "dead_letter", revision: 3 },
        ]);
        mocks.delivery.updateMany.mockResolvedValue({ count: 1 });
    });

    it("moves eligible rows monotonically while excluding an active claim", async () => {
        await expect(movePendingPluginWebhookDeliveriesV1({
            accountId: "account-1",
            webhookEndpointId: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
            endpointRevision: 3,
            previousTargetMaterialization: {
                machineId: "machine-1",
                materializationId: "materialization-1",
                pluginId: "acme.github",
            },
            targetMaterialization: {
                machineId: "machine-2",
                materializationId: "materialization-2",
                pluginId: "acme.github",
            },
            pageSize: 3,
        })).resolves.toEqual({
            moved: 2,
            skippedClaimed: 1,
            nextCursor: null,
            done: true,
        });
        expect(mocks.delivery.updateMany).toHaveBeenCalledTimes(2);
        expect(mocks.delivery.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ id: "delivery-2" }),
        }));
    });
});
