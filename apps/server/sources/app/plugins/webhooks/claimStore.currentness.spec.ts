import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    acquireFence: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
    resolveTarget: vi.fn(),
}));

vi.mock("@/storage/inTx", () => ({
    inTx: async (fn: (tx: unknown) => Promise<unknown>) => await fn({
        pluginWebhookDelivery: {
            findFirst: mocks.findFirst,
            updateMany: mocks.updateMany,
        },
    }),
}));
vi.mock("@/storage/prisma", () => ({
    getActivePrismaRuntime: () => ({ DbNull: null }),
}));
vi.mock("@/storage/db", () => ({ db: { pluginWebhookDelivery: {} } }));
vi.mock("@/app/encryption/accountEncryptionTransition", () => ({
    acquireAccountEncryptionTransitionFenceInTx: mocks.acquireFence,
}));
vi.mock("@/app/plugins/availability/operations", () => ({
    resolveCurrentClaimablePluginMachineMaterializationTx: mocks.resolveTarget,
}));
vi.mock("@/app/serverIdentity/serverIdentity", () => ({
    getOrCreateServerIdentityId: vi.fn(async () => "server-identity-1"),
}));

import {
    completePluginWebhookDeliveryV1,
    failPluginWebhookDeliveryV1,
    renewPluginWebhookDeliveryV1,
} from "./claimStore";

const TARGET = {
    materialization: {
        machineId: "machine-1",
        materializationId: "materialization-1",
        pluginId: "acme.github",
    },
    machineInstallationId: "installation-1",
} as const;
const LEASE = { leaseId: "wh_lease_AAECAwQFBgcICQoLDA0ODw", revision: 3 } as const;
const NOW = new Date("2026-08-10T00:00:00.000Z");

describe("plugin webhook settlement target currentness", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.acquireFence.mockResolvedValue({
            status: "ready",
            account: { version: 1, currentness: { encryptionMode: "plain" } },
        });
        mocks.updateMany.mockResolvedValue({ count: 1 });
        mocks.resolveTarget.mockResolvedValue({ kind: "notCurrent" });
    });

    it("loses renew, complete, and fail authority after the frozen target is no longer current", async () => {
        mocks.findFirst.mockResolvedValue({
            firstClaimAt: new Date(NOW.getTime() - 1_000),
            executionStartedAt: new Date(NOW.getTime() - 500),
            leaseExpiresAt: new Date(NOW.getTime() + 60_000),
            attemptCount: 1,
            targetPluginVersion: "1.0.0",
            endpoint: { enabled: true, revokedAt: null, releasedAt: null },
        });

        await expect(renewPluginWebhookDeliveryV1({
            accountId: "account-1",
            deliveryId: "delivery-1",
            target: TARGET,
            lease: LEASE,
            transition: "renew",
            now: NOW,
        })).resolves.toEqual({ kind: "leaseLost" });
        await expect(completePluginWebhookDeliveryV1({
            accountId: "account-1",
            deliveryId: "delivery-1",
            target: TARGET,
            lease: LEASE,
            disposition: "accepted",
            now: NOW,
        })).resolves.toEqual({ kind: "leaseLost" });
        await expect(failPluginWebhookDeliveryV1({
            accountId: "account-1",
            deliveryId: "delivery-1",
            target: TARGET,
            lease: LEASE,
            result: { kind: "retry", code: "provider_busy" },
            retryDelayMs: 5_000,
            now: NOW,
        })).resolves.toEqual({ kind: "leaseLost" });

        expect(mocks.resolveTarget).toHaveBeenCalledTimes(3);
        expect(mocks.updateMany).not.toHaveBeenCalled();
    });
});
