import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { initEncrypt } from "@/modules/encrypt";

const mocks = vi.hoisted(() => ({
    inTx: vi.fn(),
    readTarget: vi.fn(),
    readContribution: vi.fn(),
    serverIdentity: vi.fn(async () => "server-1"),
    endpointFindFirst: vi.fn(),
    markAccountChanged: vi.fn(async () => undefined),
}));

vi.mock("@/storage/inTx", () => ({ inTx: mocks.inTx }));
vi.mock("@/storage/db", () => ({
    db: { pluginWebhookEndpoint: { findFirst: mocks.endpointFindFirst } },
    isPrismaErrorCode: (error: unknown, code: string) => (
        typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === code
    ),
}));
vi.mock("@/app/serverIdentity/serverIdentity", () => ({
    getOrCreateServerIdentityId: mocks.serverIdentity,
}));
vi.mock("./accountChange", () => ({
    markPluginWebhookAccountChangedInTxV1: mocks.markAccountChanged,
}));

import { projectPluginWebhookEndpointReadinessV1 } from "./endpointReadiness";
import {
    createPluginWebhookEndpointStoreV1,
    formatPluginWebhookEndpointPublicUrlV1,
} from "./endpointStore";

const endpointId = "wh_ep_AAECAwQFBgcICQoLDA0ODw";
const contribution = { pluginId: "acme.github", localId: "issues" } as const;
const target = {
    machineId: "machine-1",
    materializationId: "materialization-1",
    pluginId: "acme.github",
} as const;

it("publishes only HTTPS webhook URLs outside the explicit loopback development exception", () => {
    expect(formatPluginWebhookEndpointPublicUrlV1(
        "https://server.example.test/base",
        "opaque-route",
    )).toBe("https://server.example.test/v1/plugins/webhooks/opaque-route");
    expect(formatPluginWebhookEndpointPublicUrlV1(
        "http://127.0.0.1:3000",
        "opaque-route",
    )).toBe("http://127.0.0.1:3000/v1/plugins/webhooks/opaque-route");
    expect(() => formatPluginWebhookEndpointPublicUrlV1(
        "http://server.example.test",
        "opaque-route",
    )).toThrow(/HTTPS/u);
});

function endpointRow(overrides: Record<string, unknown> = {}) {
    return {
        id: endpointId,
        accountId: "account-1",
        pluginId: "acme.github",
        webhookContributionId: "issues",
        handlerActionId: "receive",
        sourceInstanceId: "source-1",
        setupKind: "githubAccountEndpointV1",
        routingKind: "accountEndpoint",
        providerInstallationId: null,
        revision: 2,
        enabled: true,
        revokedAt: null,
        releasedAt: null,
        providerConfirmedAt: null,
        targetMachineId: target.machineId,
        targetMachineInstallationId: "install-1",
        targetMaterializationId: target.materializationId,
        targetPluginVersion: "1.0.0",
        previousTargetMachineId: null,
        previousTargetMachineInstallationId: null,
        previousTargetMaterializationId: null,
        previousTargetPluginVersion: null,
        createdAt: new Date("2026-08-10T00:00:00.000Z"),
        route: {
            opaqueRouteId: "wh_route_opaque",
            enabled: true,
            revokedAt: null,
            verifierKind: "github_hmac_sha256_v1",
        },
        ...overrides,
    };
}

function transaction(row: ReturnType<typeof endpointRow> | null = endpointRow()) {
    return {
        pluginWebhookEndpoint: {
            findFirst: vi.fn(async () => row),
            findUnique: vi.fn(async () => null),
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
                id: data.id,
                revision: 1,
                enabled: true,
                revokedAt: null,
                providerConfirmedAt: null,
            })),
            updateMany: vi.fn(async () => ({ count: 1 })),
        },
        pluginWebhookRoute: {
            create: vi.fn(async ({ data }: { data: { opaqueRouteId: string } }) => ({
                id: "route-1",
                opaqueRouteId: data.opaqueRouteId,
                enabled: true,
                revokedAt: null,
            })),
            update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "route-1", ...data })),
            updateMany: vi.fn(async () => ({ count: 1 })),
        },
        pluginWebhookCredential: {
            create: vi.fn(async () => ({ id: "credential-row-1" })),
        },
        pluginWebhookEndpointOperation: {
            findUnique: vi.fn<() => Promise<Record<string, unknown> | null>>(async () => null),
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "operation-1", ...data })),
        },
    };
}

describe("plugin webhook endpoint store", () => {
    beforeAll(async () => {
        process.env.HANDY_MASTER_SECRET = "plugin-webhook-endpoint-store-test-secret";
        await initEncrypt();
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.endpointFindFirst.mockResolvedValue(endpointRow());
        mocks.inTx.mockImplementation(async (callback: (tx: ReturnType<typeof transaction>) => unknown) => (
            await callback(transaction())
        ));
        mocks.readTarget.mockImplementation(async ({ target: requestedTarget }) => ({
            materialization: requestedTarget,
            machineInstallationId: "install-2",
            pluginVersion: "1.0.0",
        }));
        mocks.readContribution.mockResolvedValue({
            pluginId: contribution.pluginId,
            localId: contribution.localId,
            handlerActionLocalId: "receive",
            verifierKind: "github_hmac_sha256_v1",
            routingKind: "accountEndpoint",
        });
    });

    it("atomically creates an Account route and discloses its generated secret once", async () => {
        const tx = transaction(null);
        mocks.endpointFindFirst.mockResolvedValue(null);
        mocks.inTx.mockImplementation(async (callback: (value: typeof tx) => unknown) => await callback(tx));
        const randomBytes = vi.fn((length: number) => new Uint8Array(length));
        const store = createPluginWebhookEndpointStoreV1({
            resolveTarget: mocks.readTarget,
            resolveContribution: mocks.readContribution,
            resolvePublicBaseUrl: () => "https://server.example.test",
            randomBytes,
        });

        const result = await store.ensure({
            accountId: "account-1",
            webhookContribution: contribution,
            targetMaterialization: target,
            sourceInstanceId: "source-1",
            setup: { kind: "githubAccountEndpointV1", credential: "serverGenerated" },
            idempotencyKey: "ensure-operation-1",
        });

        expect(result).toMatchObject({
            webhookEndpointId: "wh_ep_AAAAAAAAAAAAAAAAAAAAAA",
            revision: 1,
            readiness: "providerConfirmationRequired",
            publicUrl: "https://server.example.test/v1/plugins/webhooks/wh_route_AAAAAAAAAAAAAAAAAAAAAA",
            oneTimeGeneratedSecret: expect.any(String),
        });
        expect(tx.pluginWebhookEndpoint.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.not.objectContaining({ targetServerIdentityId: expect.anything() }),
        }));
        expect(tx.pluginWebhookCredential.create).toHaveBeenCalledTimes(1);
        expect(randomBytes.mock.calls).toEqual([[16], [16], [16], [32]]);
    });

    it("does not retry an unexplained unique conflict as a generated identity collision", async () => {
        const first = transaction(null);
        first.pluginWebhookRoute.create.mockRejectedValue({ code: "P2002" });
        mocks.endpointFindFirst.mockResolvedValue(null);
        mocks.inTx.mockImplementation(async (callback: (value: typeof first) => unknown) => await callback(first));
        let seed = 0;
        const randomBytes = vi.fn((length: number) => Uint8Array.from(
            { length },
            (_, index) => (seed++ + index) & 0xff,
        ));
        const store = createPluginWebhookEndpointStoreV1({
            resolveTarget: mocks.readTarget,
            resolveContribution: mocks.readContribution,
            resolvePublicBaseUrl: () => "https://server.example.test",
            randomBytes,
        });

        await expect(store.ensure({
            accountId: "account-1",
            webhookContribution: contribution,
            targetMaterialization: target,
            sourceInstanceId: "source-1",
            setup: { kind: "githubAccountEndpointV1", credential: "serverGenerated" },
            idempotencyKey: "ensure-unexplained-unique-conflict-1",
        })).rejects.toMatchObject({ code: "P2002" });

        expect(randomBytes.mock.calls).toEqual([
            [16], [16], [16], [32],
        ]);
        expect(mocks.inTx).toHaveBeenCalledTimes(1);
    });

    it("does not let a raw shared-installation setup value create an endpoint without canonical authorization", async () => {
        mocks.readContribution.mockResolvedValueOnce({
            pluginId: contribution.pluginId,
            localId: contribution.localId,
            handlerActionLocalId: "receive",
            verifierKind: "github_hmac_sha256_v1",
            routingKind: "providerInstallation",
        });
        const store = createPluginWebhookEndpointStoreV1({
            resolveTarget: mocks.readTarget,
            resolveContribution: mocks.readContribution,
            resolvePublicBaseUrl: () => "https://server.example.test",
        });

        await expect(store.ensure({
            accountId: "account-1",
            webhookContribution: contribution,
            targetMaterialization: target,
            sourceInstanceId: "github-installation-123",
            setup: {
                kind: "githubSharedInstallationV1",
                installationId: "123",
                installationAuthorizationRef: "raw-setup-query-value",
            },
            idempotencyKey: "ensure-shared-installation-1",
        })).rejects.toMatchObject({ code: "installation_conflict" });

        expect(mocks.endpointFindFirst).not.toHaveBeenCalled();
        expect(mocks.inTx).not.toHaveBeenCalled();
    });

    it("derives one readiness ordering for every endpoint projection", async () => {
        const base = {
            endpointEnabled: true,
            endpointRevokedAt: null,
            routeEnabled: true,
            routeRevokedAt: null,
            targetStatus: "current",
            providerConfirmedAt: null,
            oneTimeCredentialDisclosureLost: false,
        } as const;

        expect(projectPluginWebhookEndpointReadinessV1(base)).toBe("providerConfirmationRequired");
        expect(projectPluginWebhookEndpointReadinessV1({
            ...base,
            providerConfirmedAt: new Date("2026-08-23T00:00:00.000Z"),
        })).toBe("ready");
        // A confirmed provider outranks a lost one-time disclosure: the user
        // does not have to rotate a credential the provider already uses.
        expect(projectPluginWebhookEndpointReadinessV1({
            ...base,
            providerConfirmedAt: new Date("2026-08-23T00:00:00.000Z"),
            oneTimeCredentialDisclosureLost: true,
        })).toBe("ready");
        expect(projectPluginWebhookEndpointReadinessV1({
            ...base,
            oneTimeCredentialDisclosureLost: true,
        })).toBe("credentialDisclosureLost");
        expect(projectPluginWebhookEndpointReadinessV1({
            ...base,
            providerConfirmedAt: new Date("2026-08-23T00:00:00.000Z"),
            targetStatus: "unavailable",
        })).toBe("targetUnavailable");
        // Availability outranks confirmation in both directions.
        expect(projectPluginWebhookEndpointReadinessV1({
            ...base,
            providerConfirmedAt: new Date("2026-08-23T00:00:00.000Z"),
            targetStatus: "unavailable",
            routeRevokedAt: new Date("2026-08-23T00:00:00.000Z"),
        })).toBe("routeUnavailable");
        expect(projectPluginWebhookEndpointReadinessV1({
            ...base,
            endpointEnabled: false,
        })).toBe("routeUnavailable");
    });

    it("reads an enabled but unconfirmed endpoint as not yet ready", async () => {
        const store = createPluginWebhookEndpointStoreV1({
            resolveTarget: mocks.readTarget,
            resolveContribution: mocks.readContribution,
            resolvePublicBaseUrl: () => "https://server.example.test",
        });
        mocks.readTarget.mockResolvedValue({
            materialization: target,
            machineInstallationId: "install-1",
            pluginVersion: "1.0.0",
        });

        await expect(store.read({ accountId: "account-1", webhookEndpointId: endpointId }))
            .resolves.toMatchObject({ readiness: "providerConfirmationRequired" });

        mocks.endpointFindFirst.mockResolvedValueOnce(endpointRow({
            providerConfirmedAt: new Date("2026-08-23T10:00:00.000Z"),
        }));
        await expect(store.read({ accountId: "account-1", webhookEndpointId: endpointId }))
            .resolves.toMatchObject({ readiness: "ready" });
    });

    it("resolves the frozen target before reading a confirmed endpoint as ready", async () => {
        const store = createPluginWebhookEndpointStoreV1({
            resolveTarget: mocks.readTarget,
            resolveContribution: mocks.readContribution,
            resolvePublicBaseUrl: () => "https://server.example.test",
        });
        const confirmed = () => endpointRow({
            providerConfirmedAt: new Date("2026-08-23T10:00:00.000Z"),
        });

        // A read that never resolved the target would report every one of
        // these as `ready`, telling the owner an undeliverable binding works.
        for (const gone of [
            null,
            { materialization: target, machineInstallationId: "install-9", pluginVersion: "1.0.0" },
            { materialization: target, machineInstallationId: "install-1", pluginVersion: "2.0.0" },
        ]) {
            mocks.endpointFindFirst.mockResolvedValueOnce(confirmed());
            mocks.readTarget.mockResolvedValueOnce(gone);
            await expect(store.read({ accountId: "account-1", webhookEndpointId: endpointId }))
                .resolves.toMatchObject({ readiness: "targetUnavailable" });
        }

        mocks.endpointFindFirst.mockResolvedValueOnce(confirmed());
        mocks.readTarget.mockResolvedValueOnce({
            materialization: target,
            machineInstallationId: "install-1",
            pluginVersion: "1.0.0",
        });
        await expect(store.read({ accountId: "account-1", webhookEndpointId: endpointId }))
            .resolves.toMatchObject({ readiness: "ready" });
        expect(mocks.readTarget).toHaveBeenLastCalledWith({
            accountId: "account-1",
            target,
        });
    });

    it("reads the Account-owned endpoint without credential material", async () => {
        const store = createPluginWebhookEndpointStoreV1({
            resolveTarget: mocks.readTarget,
            resolveContribution: mocks.readContribution,
            resolvePublicBaseUrl: () => "https://server.example.test",
        });
        mocks.readTarget.mockResolvedValue({
            materialization: target,
            machineInstallationId: "install-1",
            pluginVersion: "1.0.0",
        });
        const result = await store.read({ accountId: "account-1", webhookEndpointId: endpointId });

        expect(result).toMatchObject({
            webhookEndpointId: endpointId,
            contribution,
            targetMaterialization: target,
            publicUrl: "https://server.example.test/v1/plugins/webhooks/wh_route_opaque",
        });
        expect(result).not.toHaveProperty("credential");
        expect(result).not.toHaveProperty("secret");
    });

    it("rejoins an exact revoke operation and rejects same-key different facts", async () => {
        const tx = transaction();
        tx.pluginWebhookEndpointOperation.findUnique.mockResolvedValue({
            accountId: "account-1",
            endpointId,
            operationKind: "revoke",
            expectedRevision: 2,
            resultKind: "revoked",
            resultRevision: 3,
            requestTargetMachineId: null,
            requestTargetMaterializationId: null,
            requestTargetPluginId: null,
        });
        mocks.inTx.mockImplementation(async (callback: (value: typeof tx) => unknown) => await callback(tx));
        const store = createPluginWebhookEndpointStoreV1({
            resolveTarget: mocks.readTarget,
            resolveContribution: mocks.readContribution,
            resolvePublicBaseUrl: () => "https://server.example.test",
        });

        await expect(store.revoke({
            accountId: "account-1",
            webhookEndpointId: endpointId,
            expectedRevision: 2,
            idempotencyKey: "revoke-operation-1",
        })).resolves.toEqual({ kind: "revoked", webhookEndpointId: endpointId, revision: 3 });
        await expect(store.revoke({
            accountId: "account-1",
            webhookEndpointId: endpointId,
            expectedRevision: 3,
            idempotencyKey: "revoke-operation-1",
        })).rejects.toMatchObject({ code: "idempotency_conflict" });
        expect(tx.pluginWebhookEndpoint.updateMany).not.toHaveBeenCalled();
    });

    it("retargets future admissions and records an exact response-loss correspondence", async () => {
        const tx = transaction();
        mocks.inTx.mockImplementation(async (callback: (value: typeof tx) => unknown) => await callback(tx));
        const store = createPluginWebhookEndpointStoreV1({
            resolveTarget: mocks.readTarget,
            resolveContribution: mocks.readContribution,
            resolvePublicBaseUrl: () => "https://server.example.test",
        });
        const nextTarget = { ...target, machineId: "machine-2", materializationId: "materialization-2" };

        await expect(store.retarget({
            accountId: "account-1",
            webhookEndpointId: endpointId,
            expectedRevision: 2,
            targetMaterialization: nextTarget,
            idempotencyKey: "retarget-operation-1",
        })).resolves.toEqual({
            kind: "retargeted",
            webhookEndpointId: endpointId,
            revision: 3,
            previousTargetMaterialization: target,
            targetMaterialization: nextTarget,
        });
        expect(tx.pluginWebhookEndpoint.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                previousTargetMachineId: target.machineId,
                targetMachineId: nextTarget.machineId,
                revision: { increment: 1 },
            }),
        }));
        expect(tx.pluginWebhookEndpointOperation.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                operationKind: "retarget",
                expectedRevision: 2,
                requestTargetMachineId: nextTarget.machineId,
                resultPreviousTargetMachineId: target.machineId,
                resultTargetMachineId: nextTarget.machineId,
            }),
        }));
    });

    it("refuses to retarget future admissions after the endpoint contribution is no longer current", async () => {
        const tx = transaction();
        mocks.inTx.mockImplementation(async (callback: (value: typeof tx) => unknown) => await callback(tx));
        mocks.readContribution.mockResolvedValueOnce(null);
        const store = createPluginWebhookEndpointStoreV1({
            resolveTarget: mocks.readTarget,
            resolveContribution: mocks.readContribution,
            resolvePublicBaseUrl: () => "https://server.example.test",
        });
        const nextTarget = { ...target, machineId: "machine-2", materializationId: "materialization-2" };

        await expect(store.retarget({
            accountId: "account-1",
            webhookEndpointId: endpointId,
            expectedRevision: 2,
            targetMaterialization: nextTarget,
            idempotencyKey: "retarget-stale-contribution-1",
        })).resolves.toEqual({ kind: "incompatible", currentRevision: 2 });

        expect(mocks.readContribution).toHaveBeenCalledWith({
            accountId: "account-1",
            contribution,
            target: {
                materialization: nextTarget,
                machineInstallationId: "install-2",
                pluginVersion: "1.0.0",
            },
        });
        expect(tx.pluginWebhookEndpoint.updateMany).not.toHaveBeenCalled();
    });
});
