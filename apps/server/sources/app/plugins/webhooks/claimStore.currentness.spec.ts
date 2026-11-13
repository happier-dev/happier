import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountCursorRawQueryTransactionModel, createPrismaTransactionBoundary } from "@/app/api/testkit/txHarness";
import { inTxPostgresControlStatementMock } from "@/app/api/testkit/dbMocks";

// Only the database boundary is replaced: admission, currentness and cursor
// publication run through their real owners.
const mocks = vi.hoisted(() => {
    const findFirst = vi.fn();
    const updateMany = vi.fn();
    const machineFindFirst = vi.fn();
    const accountFindUnique = vi.fn();
    const accountChange = { upsert: vi.fn(async () => ({})) };
    const tx = {
        pluginWebhookDelivery: { findFirst, updateMany },
        machine: { findFirst: machineFindFirst },
        account: { findUnique: accountFindUnique, update: vi.fn(async () => ({ seq: 123 })) },
        accountChange,
    };
    return { tx, findFirst, updateMany, machineFindFirst, accountFindUnique, accountChange };
});

// Match the database fixture's Prisma driver sentinels without initializing a server DB.
vi.mock("@/storage/prisma", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/storage/prisma")>();
    return { ...actual, getActivePrismaRuntime: () => actual.prismaRuntime };
});

vi.mock("@/storage/db", () => ({
    db: {
        pluginWebhookDelivery: mocks.tx.pluginWebhookDelivery,
        simpleCache: { findUnique: async () => ({ value: "srv_webhook_currentness_fixture" }) },
        $transaction: createPrismaTransactionBoundary(() => ({
            ...inTxPostgresControlStatementMock, ...mocks.tx,
            $queryRawUnsafe: createAccountCursorRawQueryTransactionModel(mocks.tx),
        })),
    },
    isPrismaErrorCode: (error: unknown, code: string) => typeof error === "object" && error !== null && "code" in error && error.code === code,
}));

import {
    completePluginWebhookDeliveryV1,
    failPluginWebhookDeliveryV1,
    renewPluginWebhookDeliveryV1,
    PLUGIN_WEBHOOK_LEASE_MS_V1,
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
        mocks.accountFindUnique.mockResolvedValue({
            seq: 1, publicKey: null, encryptionMode: "plain", contentPublicKey: null,
            contentPublicKeySig: null, settings: null, settingsVersion: 0,
        });
        mocks.updateMany.mockResolvedValue({ count: 1 });
        mocks.machineFindFirst.mockResolvedValue(null);
    });

    it.each([false, true])("renews only an already-started attempt after target currentness is lost (started=%s)", async (started) => {
        mocks.findFirst.mockResolvedValue({
            firstClaimAt: new Date(NOW.getTime() - 1_000),
            executionStartedAt: started ? new Date(NOW.getTime() - 500) : null,
            leaseExpiresAt: new Date(NOW.getTime() + 60_000),
            endpointId: "endpoint-1",
            endpointRevision: 1,
            endpointWebhookContributionId: "github-events",
            endpointHandlerActionId: "handle-webhook",
            endpointSourceInstanceId: "source-1",
            targetPluginId: TARGET.materialization.pluginId,
            targetPluginVersion: "1.0.0",
            endpoint: {
                id: "endpoint-1",
                routingKind: "accountEndpoint",
                enabled: true,
                revokedAt: null,
                releasedAt: null,
                route: { enabled: true, revokedAt: null, verifierKind: "github_hmac_sha256_v1" },
            },
        });

        await expect(renewPluginWebhookDeliveryV1({
            accountId: "account-1",
            deliveryId: "delivery-1",
            target: TARGET,
            lease: LEASE,
            transition: "renew",
            now: NOW,
        })).resolves.toEqual(started
            ? { kind: "renewed", revision: LEASE.revision + 1, expiresAtMs: NOW.getTime() + PLUGIN_WEBHOOK_LEASE_MS_V1 }
            : { kind: "leaseLost" });

        // Grant model APPROVED (2026-11-12): admitted work finishes; new work
        // must still have current authority before its first effect.
        if (started) {
            expect(mocks.machineFindFirst).not.toHaveBeenCalled();
            expect(mocks.updateMany).toHaveBeenCalledTimes(1);
        } else {
            expect(mocks.machineFindFirst).toHaveBeenCalledTimes(1);
            expect(mocks.updateMany).not.toHaveBeenCalled();
        }
    });

    it("settles an already-started attempt under its exact unexpired lease after currentness is lost", async () => {
        // The handler has run: `executionStartedAt` is set and the daemon holds
        // the exact lease. Re-deriving plugin/endpoint currentness here would
        // throw the known result away and force a duplicate execution once the
        // lease expires.
        mocks.findFirst.mockResolvedValue({ attemptCount: 1 });

        await expect(completePluginWebhookDeliveryV1({
            accountId: "account-1",
            deliveryId: "delivery-1",
            target: TARGET,
            lease: LEASE,
            disposition: "accepted",
            now: NOW,
        })).resolves.toEqual({ kind: "settled", state: "succeeded" });
        await expect(failPluginWebhookDeliveryV1({
            accountId: "account-1",
            deliveryId: "delivery-1",
            target: TARGET,
            lease: LEASE,
            result: { kind: "retry", code: "provider_busy" },
            retryDelayMs: 5_000,
            now: NOW,
        })).resolves.toEqual({ kind: "settled", state: "queued" });

        expect(mocks.machineFindFirst).not.toHaveBeenCalled();
        expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    });

    it("permits content-unavailable dead-letter settlement after start or under the exact pre-execution exception", async () => {
        mocks.findFirst.mockResolvedValue({ attemptCount: 0 });

        await expect(failPluginWebhookDeliveryV1({
            accountId: "account-1",
            deliveryId: "delivery-1",
            target: TARGET,
            lease: LEASE,
            result: { kind: "deadLetter", code: "content_unavailable" },
            now: NOW,
        })).resolves.toEqual({ kind: "settled", state: "dead_letter" });

        expect(mocks.findFirst).toHaveBeenCalledWith({
            where: expect.objectContaining({
                OR: [
                    { executionStartedAt: { not: null } },
                    { executionStartedAt: null, attemptCount: 0 },
                ],
                leaseExpiresAt: { gt: NOW },
            }),
            select: { attemptCount: true },
        });
        expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                OR: [
                    { executionStartedAt: { not: null } },
                    { executionStartedAt: null, attemptCount: 0 },
                ],
                leaseExpiresAt: { gt: NOW },
            }),
        }));
    });

    it("settles an already-started attempt while the Account row is unavailable", async () => {
        mocks.accountFindUnique.mockResolvedValue(null);
        mocks.findFirst.mockResolvedValue({ attemptCount: 1 });

        await expect(completePluginWebhookDeliveryV1({
            accountId: "account-1",
            deliveryId: "delivery-1",
            target: TARGET,
            lease: LEASE,
            disposition: "accepted",
            now: NOW,
        })).resolves.toEqual({ kind: "settled", state: "succeeded" });
        await expect(failPluginWebhookDeliveryV1({
            accountId: "account-1",
            deliveryId: "delivery-1",
            target: TARGET,
            lease: LEASE,
            result: { kind: "retry", code: "provider_busy" },
            retryDelayMs: 5_000,
            now: NOW,
        })).resolves.toEqual({ kind: "settled", state: "queued" });

        expect(mocks.accountFindUnique).not.toHaveBeenCalled();
        expect(mocks.updateMany).toHaveBeenCalledTimes(2);
    });

    it("settles an already-started attempt after its endpoint was revoked", async () => {
        mocks.findFirst.mockResolvedValue({ attemptCount: 1 });

        await expect(completePluginWebhookDeliveryV1({
            accountId: "account-1",
            deliveryId: "delivery-1",
            target: TARGET,
            lease: LEASE,
            disposition: "accepted",
            now: NOW,
        })).resolves.toEqual({ kind: "settled", state: "succeeded" });

        // A revoked or disabled endpoint stops new ingress and new claims. It
        // cannot strand an attempt that already produced its result.
        for (const call of mocks.updateMany.mock.calls) {
            expect(call[0].where).not.toHaveProperty("endpoint");
        }
        for (const call of mocks.findFirst.mock.calls) {
            expect(call[0].where).not.toHaveProperty("endpoint");
        }
    });

    it("settles only for the exact claimant machine installation, lease, revision and unexpired lease", async () => {
        mocks.findFirst.mockResolvedValue({ attemptCount: 1 });

        await completePluginWebhookDeliveryV1({
            accountId: "account-1",
            deliveryId: "delivery-1",
            target: TARGET,
            lease: LEASE,
            disposition: "accepted",
            now: NOW,
        });

        expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                id: "delivery-1",
                accountId: "account-1",
                state: "claimed",
                leaseId: LEASE.leaseId,
                revision: LEASE.revision,
                executionStartedAt: { not: null },
                leaseExpiresAt: { gt: NOW },
                targetMachineId: TARGET.materialization.machineId,
                targetMachineInstallationId: TARGET.machineInstallationId,
                targetMaterializationId: TARGET.materialization.materializationId,
                targetPluginId: TARGET.materialization.pluginId,
                claimedByMachineId: TARGET.materialization.machineId,
                claimedByMachineInstallationId: TARGET.machineInstallationId,
            }),
        }));
    });

    it("reports leaseLost when the exact custody row no longer matches", async () => {
        mocks.findFirst.mockResolvedValue(null);
        mocks.updateMany.mockResolvedValue({ count: 0 });

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
        expect(mocks.accountChange.upsert).not.toHaveBeenCalled();
    });
});
