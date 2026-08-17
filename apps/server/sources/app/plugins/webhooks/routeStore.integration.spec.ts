import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    findActivePluginWebhookRouteV1,
    resolveActivePluginWebhookEndpointV1,
} from "./routeStore";

describe("plugin webhook route custody", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-webhook-routes-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness?.close();
    });

    afterEach(async () => {
        harness?.resetEnv();
        await harness?.resetDbTables([
            () => db.pluginWebhookDelivery.deleteMany(),
            () => db.pluginWebhookEndpoint.deleteMany(),
            () => db.pluginWebhookRoute.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createAccountEndpoint(params: { suffix: string; enabled?: boolean; revokedAt?: Date }) {
        const account = await db.account.create({
            data: { id: `account-${params.suffix}`, publicKey: null, encryptionMode: "plain" },
        });
        const route = await db.pluginWebhookRoute.create({
            data: {
                id: `route-${params.suffix}`,
                opaqueRouteId: `opaque-${params.suffix}`,
                verifierKind: "github_hmac_sha256_v1",
                routingKind: "accountEndpoint",
                enabled: params.enabled,
                revokedAt: params.revokedAt,
            },
        });
        const endpoint = await db.pluginWebhookEndpoint.create({
            data: {
                id: `wh_ep_AAECAwQFBgcICQoLDA0O${params.suffix === "a" ? "Dw" : "DA"}`,
                accountId: account.id,
                pluginId: "acme.github",
                webhookContributionId: "github-events",
                handlerActionId: "handle-webhook",
                sourceInstanceId: `source-${params.suffix}`,
                ensureIdempotencyKey: `idempotency-${params.suffix}-0001`,
                ensureRequestFingerprint: params.suffix.repeat(64),
                setupKind: "githubAccountEndpointV1",
                routeId: route.id,
                routingKind: "accountEndpoint",
                targetMachineId: "machine-1",
                targetMachineInstallationId: "installation-1",
                targetMaterializationId: "materialization-1",
                targetPluginVersion: "1.0.0",
            },
        });
        await db.pluginWebhookRoute.update({ where: { id: route.id }, data: { accountEndpointId: endpoint.id } });
        return { account, route, endpoint };
    }

    it("makes unknown, disabled, and revoked public routes indistinguishable", async () => {
        await createAccountEndpoint({ suffix: "a", enabled: false });
        await createAccountEndpoint({ suffix: "b", revokedAt: new Date("2026-08-10T00:00:00.000Z") });

        await expect(findActivePluginWebhookRouteV1("unknown")).resolves.toBeNull();
        await expect(findActivePluginWebhookRouteV1("opaque-a")).resolves.toBeNull();
        await expect(findActivePluginWebhookRouteV1("opaque-b")).resolves.toBeNull();
    });

    it("resolves an active Account route only through its bound active endpoint", async () => {
        const fixture = await createAccountEndpoint({ suffix: "a" });
        const route = await findActivePluginWebhookRouteV1(fixture.route.opaqueRouteId);
        expect(route).toEqual({
            routeId: fixture.route.id,
            verifierKind: "github_hmac_sha256_v1",
            routingKind: "accountEndpoint",
            policyVersion: 1,
        });
        await expect(resolveActivePluginWebhookEndpointV1({
            routeId: fixture.route.id,
            routingKind: "accountEndpoint",
        })).resolves.toMatchObject({
            endpointId: fixture.endpoint.id,
            accountId: fixture.account.id,
            pluginId: "acme.github",
            targetMaterialization: {
                machineId: "machine-1",
                materializationId: "materialization-1",
                pluginId: "acme.github",
            },
            targetMachineInstallationId: "installation-1",
        });
        await db.pluginWebhookEndpoint.update({ where: { id: fixture.endpoint.id }, data: { enabled: false } });
        await expect(resolveActivePluginWebhookEndpointV1({
            routeId: fixture.route.id,
            routingKind: "accountEndpoint",
        })).resolves.toBeNull();
    });

    it("resolves a shared route only after exact verified installation lookup", async () => {
        const account = await db.account.create({
            data: { id: "account-shared", publicKey: null, encryptionMode: "plain" },
        });
        const route = await db.pluginWebhookRoute.create({
            data: {
                id: "route-shared",
                opaqueRouteId: "opaque-shared",
                verifierKind: "github_hmac_sha256_v1",
                routingKind: "providerInstallation",
                operatorPluginId: "happier.github",
                operatorWebhookContributionId: "github-events",
            },
        });
        const endpoint = await db.pluginWebhookEndpoint.create({
            data: {
                id: "wh_ep_AAECAwQFBgcICQoLDA0ODw",
                accountId: account.id,
                pluginId: "happier.github",
                webhookContributionId: "github-events",
                handlerActionId: "handle-webhook",
                sourceInstanceId: "github-installation-123",
                ensureIdempotencyKey: "idempotency-shared-0001",
                ensureRequestFingerprint: "d".repeat(64),
                setupKind: "githubSharedInstallationV1",
                routeId: route.id,
                routingKind: "providerInstallation",
                providerInstallationId: "123",
                targetMachineId: "machine-1",
                targetMachineInstallationId: "installation-1",
                targetMaterializationId: "materialization-1",
                targetPluginVersion: "1.0.0",
            },
        });

        await expect(resolveActivePluginWebhookEndpointV1({
            routeId: route.id,
            routingKind: "providerInstallation",
        })).resolves.toBeNull();
        await expect(resolveActivePluginWebhookEndpointV1({
            routeId: route.id,
            routingKind: "providerInstallation",
            providerInstallationId: "999",
        })).resolves.toBeNull();
        await expect(resolveActivePluginWebhookEndpointV1({
            routeId: route.id,
            routingKind: "providerInstallation",
            providerInstallationId: "123",
        })).resolves.toMatchObject({ endpointId: endpoint.id, accountId: account.id });
    });

});
