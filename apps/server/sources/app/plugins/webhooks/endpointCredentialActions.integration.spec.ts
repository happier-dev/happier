import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    configurePluginWebhookEndpointCredentialV1,
    finishPluginWebhookEndpointCredentialRotationV1,
    rotatePluginWebhookEndpointCredentialV1,
} from "./endpointActions";

const ACCOUNT_ID = "account-webhook-credential-actions";
const ENDPOINT_ID = "wh_ep_AAECAwQFBgcICQoLDA0ODw";
const ROUTE_ID = "route-webhook-credential-actions";

describe("plugin webhook endpoint credential Actions", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-webhook-endpoint-credential-actions-",
            initAuth: false,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => await harness.close());

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.pluginWebhookCredential.deleteMany(),
            () => db.pluginWebhookEndpoint.deleteMany(),
            () => db.pluginWebhookRoute.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function seedEndpoint() {
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
        await db.pluginWebhookRoute.create({
            data: {
                id: ROUTE_ID,
                opaqueRouteId: "opaque-webhook-credential-actions",
                verifierKind: "github_hmac_sha256_v1",
                routingKind: "accountEndpoint",
            },
        });
        await db.pluginWebhookEndpoint.create({
            data: {
                id: ENDPOINT_ID,
                accountId: ACCOUNT_ID,
                pluginId: "acme.github",
                webhookContributionId: "github-events",
                handlerActionId: "handle-webhook",
                sourceInstanceId: "source-1",
                setupKind: "githubAccountEndpointV1",
                routeId: ROUTE_ID,
                routingKind: "accountEndpoint",
                targetMachineId: "machine-1",
                targetMachineInstallationId: "installation-1",
                targetMaterializationId: "materialization-1",
                targetPluginVersion: "1.0.0",
            },
        });
        await db.pluginWebhookRoute.update({
            where: { id: ROUTE_ID },
            data: { accountEndpointId: ENDPOINT_ID },
        });
    }

    async function readWebhookChange() {
        return await db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: ACCOUNT_ID,
                    kind: "pluginDomain",
                    entityId: "pluginDomain/acme.github/webhook",
                },
            },
            select: { cursor: true, hint: true },
        });
    }

    it("configures, rotates, and finishes with revision-safe response-loss rejoin", async () => {
        await seedEndpoint();
        const configured = await configurePluginWebhookEndpointCredentialV1({
            accountId: ACCOUNT_ID,
            input: { webhookEndpointId: ENDPOINT_ID, expectedRevision: 1 },
        });
        expect(configured).toMatchObject({ kind: "configured", revision: 2, oneTimeGeneratedSecret: expect.any(String) });
        const configuredChange = await readWebhookChange();
        expect(configuredChange).toEqual({
            cursor: expect.any(Number),
            hint: { pluginDomain: "webhook", pluginId: "acme.github" },
        });
        await expect(configurePluginWebhookEndpointCredentialV1({
            accountId: ACCOUNT_ID,
            input: { webhookEndpointId: ENDPOINT_ID, expectedRevision: 1 },
        })).resolves.toMatchObject({ kind: "alreadyConfigured", revision: 2 });
        await expect(readWebhookChange()).resolves.toEqual(configuredChange);

        const rotated = await rotatePluginWebhookEndpointCredentialV1({
            accountId: ACCOUNT_ID,
            input: { webhookEndpointId: ENDPOINT_ID, expectedRevision: 2 },
            now: new Date("2026-08-10T00:00:00.000Z"),
        });
        expect(rotated).toMatchObject({
            kind: "rotated",
            revision: 3,
            previousCredentialVersionId: configured.credentialVersionId,
            oneTimeGeneratedSecret: expect.any(String),
        });
        const rotatedChange = await readWebhookChange();
        expect(rotatedChange.cursor).toBeGreaterThan(configuredChange.cursor);
        await expect(rotatePluginWebhookEndpointCredentialV1({
            accountId: ACCOUNT_ID,
            input: { webhookEndpointId: ENDPOINT_ID, expectedRevision: 2 },
        })).resolves.toMatchObject({ kind: "alreadyRotated", revision: 3 });
        await expect(readWebhookChange()).resolves.toEqual(rotatedChange);

        await expect(finishPluginWebhookEndpointCredentialRotationV1({
            accountId: ACCOUNT_ID,
            input: {
                webhookEndpointId: ENDPOINT_ID,
                expectedRevision: 3,
                expectedPreviousCredentialVersionId: configured.credentialVersionId,
            },
        })).resolves.toEqual({ kind: "retired", webhookEndpointId: ENDPOINT_ID, revision: 4 });
        const retiredChange = await readWebhookChange();
        expect(retiredChange.cursor).toBeGreaterThan(rotatedChange.cursor);
        await expect(finishPluginWebhookEndpointCredentialRotationV1({
            accountId: ACCOUNT_ID,
            input: {
                webhookEndpointId: ENDPOINT_ID,
                expectedRevision: 3,
                expectedPreviousCredentialVersionId: configured.credentialVersionId,
            },
        })).resolves.toEqual({ kind: "alreadyRetired", webhookEndpointId: ENDPOINT_ID, revision: 4 });
        await expect(readWebhookChange()).resolves.toEqual(retiredChange);
    });
});
