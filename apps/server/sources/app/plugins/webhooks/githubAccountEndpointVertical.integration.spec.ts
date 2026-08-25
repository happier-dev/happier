import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    normalizePluginReleaseFactsV1,
    readDeclaredPackageAssetsV1,
    PluginWebhookEndpointEnsureInputV1Schema,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    createPluginWebhookEndpointActionsV1,
    rotatePluginWebhookEndpointCredentialV1,
} from "./endpointActions";
import { ingestPluginWebhookV1 } from "./ingest";
import { readPluginWebhookAccountStatusV1 } from "./statusStore";

/**
 * The end-to-end reachability proof for the durable-push producer the GitHub
 * plugin actually ships. It deliberately reads the plugin's own published
 * normalized manifest rather than a fixture: the routing declared there is the
 * single fact that decides whether `ensure` can mint an Account endpoint at
 * all, and a fixture copy would pass while the shipped plugin stayed
 * unreachable.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const GITHUB_PLUGIN_MANIFEST_PATH = resolve(
    REPO_ROOT,
    "packages/plugins/scm-github/.happier-plugin/plugin.json",
);

const SERVER_IDENTITY_ID = "srv_githubAccountEndpoint1";
const PUBLIC_SERVER_URL = "https://happier.example";
const MACHINE_ID = "github-endpoint-machine";
const MACHINE_INSTALLATION_ID = "github-endpoint-installation";
const MATERIALIZATION_ID = "github-endpoint-materialization";
const ROUTING_SOURCE_INSTANCE_ID = "github:repository:849312001";

type GithubPluginManifestFacts = Readonly<{
    pluginId: string;
    version: string;
    normalizedManifest: Record<string, unknown>;
    webhookLocalId: string;
    handlerActionLocalId: string;
}>;

function readGithubPluginManifestFacts(): GithubPluginManifestFacts {
    const normalizedManifest = JSON.parse(
        readFileSync(GITHUB_PLUGIN_MANIFEST_PATH, "utf8"),
    ) as Record<string, unknown>;
    const contributes = normalizedManifest.contributes as Record<string, unknown>;
    const webhooks = contributes.webhooks as ReadonlyArray<Record<string, unknown>>;
    const webhook = webhooks[0]!;
    const handlerAction = webhook.handlerAction as Record<string, unknown>;
    return {
        pluginId: String(normalizedManifest.id),
        version: String(normalizedManifest.version),
        normalizedManifest,
        webhookLocalId: String(webhook.id),
        handlerActionLocalId: String(handlerAction.localId),
    };
}

const MANIFEST = readGithubPluginManifestFacts();

const MATERIALIZATION_REF = {
    machineId: MACHINE_ID,
    materializationId: MATERIALIZATION_ID,
    pluginId: MANIFEST.pluginId,
} as const;

/**
 * Rewrites only the webhook routing of the shipped manifest. It reproduces the
 * exact predecessor declaration (`providerInstallation`) so the reason the
 * plugin had to move to `accountEndpoint` stays falsifiable instead of being
 * asserted from the constant it changed.
 */
function manifestWithWebhookRouting(routing: string): Record<string, unknown> {
    const copy = JSON.parse(JSON.stringify(MANIFEST.normalizedManifest)) as Record<string, unknown>;
    const contributes = copy.contributes as Record<string, unknown>;
    const webhooks = contributes.webhooks as Array<Record<string, unknown>>;
    for (const webhook of webhooks) {
        (webhook.verifier as Record<string, unknown>).routing = routing;
    }
    return copy;
}

async function seedAccount(
    normalizedManifest: Record<string, unknown> = MANIFEST.normalizedManifest,
): Promise<string> {
    const release = normalizePluginReleaseFactsV1({
        ref: { pluginId: MANIFEST.pluginId, version: MANIFEST.version },
        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"b".repeat(64)}`,
            resources: (readDeclaredPackageAssetsV1(normalizedManifest) ?? []).map((asset) => ({
                ...asset,
                byteSize: 1,
                digestSha256: `sha256:${"c".repeat(64)}`,
            })),
        },
        normalizedManifest,
        collectionContracts: [],
        uiSlots: [],
    });
    const account = await db.account.create({
        data: { encryptionMode: "plain" },
        select: { id: true },
    });
    await db.machine.create({
        data: {
            id: MACHINE_ID,
            accountId: account.id,
            metadata: "{}",
            installationId: MACHINE_INSTALLATION_ID,
            pluginMaterializationRevision: 1n,
            operationProtocolCapabilities: { pluginWebhookClaim: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        },
    });
    await db.accountPluginIntent.create({
        data: {
            accountId: account.id,
            pluginId: MANIFEST.pluginId,
            desiredVersion: MANIFEST.version,
            enabled: true,
            writableCollections: [],
        },
    });
    await db.accountPluginRelease.create({
        data: {
            accountId: account.id,
            pluginId: MANIFEST.pluginId,
            version: MANIFEST.version,
            archiveDigestSha256: release.archiveDigestSha256,
            normalizedManifest: release.normalizedManifest,
            collectionContracts: [],
            uiSlots: [],
            packageAssetArchive: release.packageAssetArchive,
        },
    });
    await db.pluginMachineMaterialization.create({
        data: {
            accountId: account.id,
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId: MACHINE_ID,
            materializationId: MATERIALIZATION_ID,
            pluginId: MANIFEST.pluginId,
            version: MANIFEST.version,
            sourceClass: "registryPackage",
            portableRelease: true,
            archiveDigestSha256: release.archiveDigestSha256,
            uiArtifacts: [],
            enabled: true,
            trustState: "trusted",
            observedAt: new Date("2026-08-22T00:00:00.000Z"),
        },
    });
    return account.id;
}

async function ensureGithubEndpoint(accountId: string, idempotencyKey: string) {
    return await createPluginWebhookEndpointActionsV1().ensure({
        accountId,
        input: PluginWebhookEndpointEnsureInputV1Schema.parse({
            webhookContribution: {
                pluginId: MANIFEST.pluginId,
                localId: MANIFEST.webhookLocalId,
            },
            targetMaterialization: MATERIALIZATION_REF,
            sourceInstanceId: ROUTING_SOURCE_INSTANCE_ID,
            setup: { kind: "githubAccountEndpointV1", credential: "serverGenerated" },
            idempotencyKey,
        }),
    });
}

function readOpaqueRouteId(publicUrl: string): string {
    const path = new URL(publicUrl).pathname;
    const prefix = "/v1/plugins/webhooks/";
    expect(path.startsWith(prefix)).toBe(true);
    return path.slice(prefix.length);
}

const PUSH_BODY = Buffer.from(JSON.stringify({
    action: "opened",
    repository: { full_name: "happier-dev/happier" },
}), "utf8");

function githubHeaders(secret: string, deliveryId: string) {
    return {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(PUSH_BODY).digest("hex")}`,
    };
}

describe("GitHub Account webhook endpoint vertical", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-github-account-endpoint-",
            initEncrypt: true,
            env: {
                HANDY_MASTER_SECRET: "github-account-endpoint-master-secret",
                HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID,
                HAPPIER_PUBLIC_SERVER_URL: PUBLIC_SERVER_URL,
            },
        });
    }, 180_000);

    afterAll(async () => await harness.close());

    afterEach(async () => {
        harness.resetEnv({
            HANDY_MASTER_SECRET: "github-account-endpoint-master-secret",
            HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID,
            HAPPIER_PUBLIC_SERVER_URL: PUBLIC_SERVER_URL,
        });
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.pluginWebhookEndpointOperation.deleteMany(),
            () => db.pluginWebhookCredential.deleteMany(),
            () => db.pluginWebhookDelivery.deleteMany(),
            () => db.pluginWebhookEndpoint.deleteMany(),
            () => db.pluginWebhookRoute.deleteMany(),
            () => db.pluginMachineMaterialization.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("mints a usable endpoint from the shipped GitHub manifest and admits a signed delivery for its handler", async () => {
        const accountId = await seedAccount();

        const ensured = await ensureGithubEndpoint(accountId, "ensure-github-account-endpoint-1");
        expect(ensured.readiness).toBe("providerConfirmationRequired");
        expect(ensured.publicUrl.startsWith(`${PUBLIC_SERVER_URL}/v1/plugins/webhooks/wh_route_`)).toBe(true);
        const secret = ensured.oneTimeGeneratedSecret;
        expect(typeof secret).toBe("string");

        const ingested = await ingestPluginWebhookV1({
            opaqueRouteId: readOpaqueRouteId(ensured.publicUrl),
            rawBody: PUSH_BODY,
            headers: githubHeaders(secret!, "delivery-github-1"),
        });
        expect(ingested).toMatchObject({ kind: "accepted", duplicate: false });

        // The admitted delivery is bound to the endpoint whose handler Action is
        // the GitHub plugin's own webhook handler — the Action the daemon invokes
        // to admit the Automation Event.
        const endpoint = await db.pluginWebhookEndpoint.findFirstOrThrow({
            where: { accountId },
            select: {
                id: true,
                routingKind: true,
                handlerActionId: true,
                pluginId: true,
                sourceInstanceId: true,
                deliveries: { select: { state: true } },
            },
        });
        expect(endpoint).toMatchObject({
            routingKind: "accountEndpoint",
            pluginId: MANIFEST.pluginId,
            handlerActionId: MANIFEST.handlerActionLocalId,
            sourceInstanceId: ROUTING_SOURCE_INSTANCE_ID,
        });
        expect(endpoint.deliveries).toHaveLength(1);
    });

    it("keeps every readiness projection unconfirmed until a verified delivery proves the provider was configured", async () => {
        const accountId = await seedAccount();
        const ensured = await ensureGithubEndpoint(accountId, "ensure-github-account-endpoint-readiness");
        const opaqueRouteId = readOpaqueRouteId(ensured.publicUrl);
        const readReadiness = async () => (await createPluginWebhookEndpointActionsV1().read({
            accountId,
            input: { webhookEndpointId: ensured.webhookEndpointId },
        })).readiness;
        const statusReadiness = async () => (await readPluginWebhookAccountStatusV1({
            accountId,
            input: { pageSize: 50, deadLetterPageSize: 0 },
        })).endpoints.map((endpoint) => endpoint.readiness);

        // An enabled endpoint with a live route is NOT a working delivery path.
        expect(ensured.readiness).toBe("providerConfirmationRequired");
        await expect(readReadiness()).resolves.toBe("providerConfirmationRequired");
        await expect(statusReadiness()).resolves.toEqual(["providerConfirmationRequired"]);

        // A request the verifier rejected is not provider confirmation.
        await expect(ingestPluginWebhookV1({
            opaqueRouteId,
            rawBody: PUSH_BODY,
            headers: githubHeaders(`${ensured.oneTimeGeneratedSecret!}-tampered`, "delivery-readiness-rejected"),
        })).resolves.toMatchObject({ kind: "rejected", statusCode: 401 });
        await expect(readReadiness()).resolves.toBe("providerConfirmationRequired");
        await expect(statusReadiness()).resolves.toEqual(["providerConfirmationRequired"]);

        await expect(ingestPluginWebhookV1({
            opaqueRouteId,
            rawBody: PUSH_BODY,
            headers: githubHeaders(ensured.oneTimeGeneratedSecret!, "delivery-readiness-verified"),
        })).resolves.toMatchObject({ kind: "accepted" });

        await expect(readReadiness()).resolves.toBe("ready");
        await expect(statusReadiness()).resolves.toEqual(["ready"]);

        // The same idempotency key rejoins a confirmed endpoint, so the lost
        // one-time disclosure no longer blocks provider setup.
        await expect(ensureGithubEndpoint(accountId, "ensure-github-account-endpoint-readiness"))
            .resolves.toMatchObject({ readiness: "ready" });
    });

    it("returns readiness to provider confirmation across a credential rotation until the new secret delivers", async () => {
        const accountId = await seedAccount();
        const ensured = await ensureGithubEndpoint(accountId, "ensure-github-account-endpoint-rotation");
        const opaqueRouteId = readOpaqueRouteId(ensured.publicUrl);
        const readEndpoint = async () => await createPluginWebhookEndpointActionsV1().read({
            accountId,
            input: { webhookEndpointId: ensured.webhookEndpointId },
        });

        await expect(ingestPluginWebhookV1({
            opaqueRouteId,
            rawBody: PUSH_BODY,
            headers: githubHeaders(ensured.oneTimeGeneratedSecret!, "delivery-rotation-1"),
        })).resolves.toMatchObject({ kind: "accepted" });
        const confirmed = await readEndpoint();
        expect(confirmed.readiness).toBe("ready");

        const rotated = await rotatePluginWebhookEndpointCredentialV1({
            accountId,
            input: { webhookEndpointId: ensured.webhookEndpointId, expectedRevision: confirmed.revision },
        });
        expect(rotated).toMatchObject({ kind: "rotated", oneTimeGeneratedSecret: expect.any(String) });
        const rotatedSecret = rotated.oneTimeGeneratedSecret;
        if (rotatedSecret === undefined) throw new Error("Expected the rotation to disclose its new secret");

        // The provider still holds the superseded secret. Reporting `ready`
        // here would call a configuration that breaks when the overlap ends a
        // working delivery path.
        await expect(readEndpoint()).resolves.toMatchObject({ readiness: "providerConfirmationRequired" });

        // A delivery still signed with the superseded secret verifies inside
        // the overlap window and is admitted, but it proves nothing about the
        // credential the provider now has to be reconfigured with.
        await expect(ingestPluginWebhookV1({
            opaqueRouteId,
            rawBody: PUSH_BODY,
            headers: githubHeaders(ensured.oneTimeGeneratedSecret!, "delivery-rotation-2"),
        })).resolves.toMatchObject({ kind: "accepted" });
        await expect(readEndpoint()).resolves.toMatchObject({ readiness: "providerConfirmationRequired" });

        // Positive twin: the reconfigured provider's first delivery confirms
        // the current credential, so the states above are the rotation and not
        // a permanently unconfirmable endpoint.
        await expect(ingestPluginWebhookV1({
            opaqueRouteId,
            rawBody: PUSH_BODY,
            headers: githubHeaders(rotatedSecret, "delivery-rotation-3"),
        })).resolves.toMatchObject({ kind: "accepted" });
        await expect(readEndpoint()).resolves.toMatchObject({ readiness: "ready" });
    });

    it("rejects a delivery signed with any secret other than the one disclosed by ensure", async () => {
        const accountId = await seedAccount();
        const ensured = await ensureGithubEndpoint(accountId, "ensure-github-account-endpoint-2");

        const ingested = await ingestPluginWebhookV1({
            opaqueRouteId: readOpaqueRouteId(ensured.publicUrl),
            rawBody: PUSH_BODY,
            headers: githubHeaders(`${ensured.oneTimeGeneratedSecret!}-tampered`, "delivery-github-2"),
        });

        expect(ingested).toMatchObject({ kind: "rejected", statusCode: 401 });
        expect(await db.pluginWebhookDelivery.count()).toBe(0);
    });

    it("cannot mint an Account endpoint while the same plugin declares shared-installation routing", async () => {
        const accountId = await seedAccount(manifestWithWebhookRouting("providerInstallation"));

        await expect(ensureGithubEndpoint(accountId, "ensure-github-account-endpoint-3"))
            .rejects.toThrow("endpoint_unavailable");
        expect(await db.pluginWebhookEndpoint.count()).toBe(0);
        expect(await db.pluginWebhookRoute.count()).toBe(0);
    });
});
