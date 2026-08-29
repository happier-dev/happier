import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    configurePluginWebhookEndpointCredentialV1,
    finishPluginWebhookEndpointCredentialRotationV1,
    rotatePluginWebhookEndpointCredentialV1,
} from "./endpointActions";
import { readPluginWebhookEndpointV1 } from "./endpointStore";

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
                setupKind: "accountEndpointV1",
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

    async function readReadiness() {
        const read = await readPluginWebhookEndpointV1({
            accountId: ACCOUNT_ID,
            webhookEndpointId: ENDPOINT_ID,
            publicBaseUrl: "https://happier.example",
            resolveTarget: async ({ target }) => ({
                materialization: target,
                machineInstallationId: "installation-1",
                pluginVersion: "1.0.0",
            }),
        });
        return read.readiness;
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
        // Rotation has no operation identity, so a repeat of an already
        // superseded revision conflicts instead of claiming someone else's
        // rotation as this request's result. Nothing changes.
        await expect(rotatePluginWebhookEndpointCredentialV1({
            accountId: ACCOUNT_ID,
            input: { webhookEndpointId: ENDPOINT_ID, expectedRevision: 2 },
        })).rejects.toMatchObject({ code: "idempotency_conflict" });
        await expect(readWebhookChange()).resolves.toEqual(rotatedChange);
        await expect(db.pluginWebhookCredential.count()).resolves.toBe(2);

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

    it("returns a confirmed endpoint to provider-confirmation attention when its credential rotates", async () => {
        await seedEndpoint();
        await configurePluginWebhookEndpointCredentialV1({
            accountId: ACCOUNT_ID,
            input: { webhookEndpointId: ENDPOINT_ID, expectedRevision: 1 },
        });
        // The delivery owner's one confirmation fact, as it stands after a
        // signature-verified delivery under the credential configured above.
        await db.pluginWebhookEndpoint.update({
            where: { id: ENDPOINT_ID },
            data: { providerConfirmedAt: new Date("2026-08-09T00:00:00.000Z") },
        });

        // Positive twin: without a rotation the confirmed endpoint really does
        // read as a working delivery path, so the assertion below is about the
        // rotation and not about a permanently unready projection.
        await expect(readReadiness()).resolves.toBe("ready");

        await rotatePluginWebhookEndpointCredentialV1({
            accountId: ACCOUNT_ID,
            input: { webhookEndpointId: ENDPOINT_ID, expectedRevision: 2 },
            now: new Date("2026-08-10T00:00:00.000Z"),
        });

        // The provider still holds the superseded secret until the user
        // reconfigures it, and every delivery signed with it stops verifying
        // when the overlap ends. Carrying the old confirmation across the
        // rotation would report that dead configuration as ready.
        await expect(readReadiness()).resolves.toBe("providerConfirmationRequired");
        await expect(db.pluginWebhookEndpoint.findUniqueOrThrow({
            where: { id: ENDPOINT_ID },
            select: { providerConfirmedAt: true },
        })).resolves.toEqual({ providerConfirmedAt: null });
    });

    it("does not report a rotation an unrelated revision bump caused", async () => {
        await seedEndpoint();
        const configured = await configurePluginWebhookEndpointCredentialV1({
            accountId: ACCOUNT_ID,
            input: { webhookEndpointId: ENDPOINT_ID, expectedRevision: 1 },
        });
        const rotated = await rotatePluginWebhookEndpointCredentialV1({
            accountId: ACCOUNT_ID,
            input: { webhookEndpointId: ENDPOINT_ID, expectedRevision: 2 },
            now: new Date("2026-08-10T00:00:00.000Z"),
        });
        expect(rotated).toMatchObject({ kind: "rotated", revision: 3 });

        // Some other present-user operation (a retarget, for example) advances
        // the endpoint revision while the first rotation's previous credential
        // is still inside its 24h overlap window.
        await db.pluginWebhookEndpoint.update({
            where: { id: ENDPOINT_ID },
            data: { revision: 4 },
        });

        // A rotate request that expected revision 3 now observes 3 + 1 with a
        // current credential and an accepting previous credential. Reporting
        // `alreadyRotated` here would hand this caller the earlier rotation's
        // credential versions as proof its own rotation happened.
        await expect(rotatePluginWebhookEndpointCredentialV1({
            accountId: ACCOUNT_ID,
            input: { webhookEndpointId: ENDPOINT_ID, expectedRevision: 3 },
        })).rejects.toMatchObject({ code: "idempotency_conflict" });

        const route = await db.pluginWebhookRoute.findUniqueOrThrow({
            where: { id: ROUTE_ID },
            select: {
                currentCredential: { select: { credentialVersionId: true } },
                previousCredential: { select: { credentialVersionId: true } },
            },
        });
        expect(route.currentCredential?.credentialVersionId).toBe(rotated.credentialVersionId);
        expect(route.previousCredential?.credentialVersionId).toBe(configured.credentialVersionId);
        await expect(db.pluginWebhookEndpoint.findUniqueOrThrow({
            where: { id: ENDPOINT_ID },
            select: { revision: true },
        })).resolves.toEqual({ revision: 4 });
    });

    /**
     * The equivalent claim against finish-rotation is false and must stay
     * false: its input names the exact previous credential it expects retired,
     * and it only rejoins when that credential is actually gone.
     */
    it("conflicts rather than claiming retirement when an unrelated bump moved the revision", async () => {
        await seedEndpoint();
        const configured = await configurePluginWebhookEndpointCredentialV1({
            accountId: ACCOUNT_ID,
            input: { webhookEndpointId: ENDPOINT_ID, expectedRevision: 1 },
        });
        await rotatePluginWebhookEndpointCredentialV1({
            accountId: ACCOUNT_ID,
            input: { webhookEndpointId: ENDPOINT_ID, expectedRevision: 2 },
            now: new Date("2026-08-10T00:00:00.000Z"),
        });
        await db.pluginWebhookEndpoint.update({
            where: { id: ENDPOINT_ID },
            data: { revision: 4 },
        });

        await expect(finishPluginWebhookEndpointCredentialRotationV1({
            accountId: ACCOUNT_ID,
            input: {
                webhookEndpointId: ENDPOINT_ID,
                expectedRevision: 3,
                expectedPreviousCredentialVersionId: configured.credentialVersionId,
            },
        })).resolves.toEqual({ kind: "revisionConflict", currentRevision: 4 });
        await expect(db.pluginWebhookCredential.count()).resolves.toBe(2);
    });
});
