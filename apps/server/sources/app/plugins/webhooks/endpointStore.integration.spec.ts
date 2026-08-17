import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
    normalizePluginReleaseFactsV1,
    PluginWebhookEndpointEnsureInputV1Schema,
    type PluginWebhookEndpointEnsureInputV1,
} from "@happier-dev/protocol";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    PluginWebhookEndpointStoreError,
    ensurePluginWebhookEndpointV1,
    readPluginWebhookEndpointV1,
    retargetPluginWebhookEndpointV1,
    revokePluginWebhookEndpointV1,
} from "./endpointStore";
import {
    finishPluginWebhookEndpointCredentialRotationV1,
    rotatePluginWebhookEndpointCredentialV1,
} from "./endpointActions";
import { createPluginWebhookEndpointActionsV1 } from "./endpointActions";

const ACCOUNT_ID = "account-webhook-endpoint";
const TARGET = {
    materialization: {
        machineId: "machine-1",
        materializationId: "materialization-1",
        pluginId: "acme.github",
    },
    machineInstallationId: "machine-installation-1",
    pluginVersion: "1.0.0",
} as const;
const CONTRIBUTION = {
    pluginId: "acme.github",
    localId: "github-events",
    handlerActionLocalId: "handle-webhook",
    verifierKind: "github_hmac_sha256_v1" as const,
    routingKind: "accountEndpoint" as const,
};

const SHARED_CONTRIBUTION = {
    ...CONTRIBUTION,
    routingKind: "providerInstallation" as const,
};

function deterministicRandomBytes() {
    let seed = 0;
    return (length: number) => Uint8Array.from({ length }, (_, index) => (seed++ + index) & 0xff);
}

function ensureInput(overrides: Partial<PluginWebhookEndpointEnsureInputV1> = {}) {
    return PluginWebhookEndpointEnsureInputV1Schema.parse({
        webhookContribution: { pluginId: "acme.github", localId: "github-events" },
        targetMaterialization: TARGET.materialization,
        sourceInstanceId: "source-primary",
        setup: { kind: "githubAccountEndpointV1", credential: "serverGenerated" },
        idempotencyKey: "ensure-endpoint-primary-0001",
        ...overrides,
    });
}

async function seedSharedInstallationRoute() {
    const route = await db.pluginWebhookRoute.create({
        data: {
            opaqueRouteId: "wh_route_shared_installation",
            verifierKind: "github_hmac_sha256_v1",
            routingKind: "providerInstallation",
            operatorPluginId: SHARED_CONTRIBUTION.pluginId,
            operatorWebhookContributionId: SHARED_CONTRIBUTION.localId,
        },
    });
    const credential = await db.pluginWebhookCredential.create({
        data: {
            routeId: route.id,
            credentialVersionId: "wh_cred_shared_installation",
            verifierKind: "github_hmac_sha256_v1",
            encryptedSecret: Buffer.from("shared-installation-secret", "utf8"),
            state: "current",
        },
    });
    return await db.pluginWebhookRoute.update({
        where: { id: route.id },
        data: { currentCredentialId: credential.id },
    });
}

describe("plugin webhook endpoint lifecycle store", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-webhook-endpoint-store-",
            initAuth: false,
            initEncrypt: true,
            env: {
                HANDY_MASTER_SECRET: "webhook-endpoint-store-master-secret",
                HAPPIER_SERVER_IDENTITY_ID: "srv_endpointStoreCurrent1",
                HAPPIER_PUBLIC_SERVER_URL: "https://happier.example",
            },
        });
    }, 120_000);

    afterAll(async () => await harness?.close());

    afterEach(async () => {
        harness?.resetEnv();
        await harness?.resetDbTables([
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

    async function seedAccount() {
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
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

    it("commits route, endpoint, credential, and ensure idempotency atomically without redisclosing a lost secret", async () => {
        await seedAccount();
        const input = ensureInput();
        const params = {
            accountId: ACCOUNT_ID,
            input,
            contribution: CONTRIBUTION,
            target: TARGET,
            publicBaseUrl: "https://happier.example",
            randomBytes: deterministicRandomBytes(),
        } as const;

        const created = await ensurePluginWebhookEndpointV1(params);
        expect(created).toMatchObject({
            revision: 1,
            publicUrl: expect.stringMatching(/^https:\/\/happier\.example\/v1\/plugins\/webhooks\/[A-Za-z0-9_-]+$/u),
            readiness: "providerConfirmationRequired",
            oneTimeGeneratedSecret: expect.any(String),
        });
        expect(await db.pluginWebhookEndpoint.count()).toBe(1);
        expect(await db.pluginWebhookRoute.count()).toBe(1);
        expect(await db.pluginWebhookCredential.count()).toBe(1);
        const createdChange = await readWebhookChange();
        expect(createdChange).toEqual({
            cursor: expect.any(Number),
            hint: { pluginDomain: "webhook", pluginId: "acme.github" },
        });

        await expect(ensurePluginWebhookEndpointV1(params)).resolves.toEqual({
            webhookEndpointId: created.webhookEndpointId,
            revision: 1,
            publicUrl: created.publicUrl,
            readiness: "credentialDisclosureLost",
        });
        await expect(readWebhookChange()).resolves.toEqual(createdChange);

        await expect(ensurePluginWebhookEndpointV1({
            ...params,
            input: ensureInput({ sourceInstanceId: "source-changed" }),
        })).rejects.toMatchObject({ code: "idempotency_conflict" } satisfies Partial<PluginWebhookEndpointStoreError>);
    });

    it("classifies an existing source binding before generating retry identities", async () => {
        await seedAccount();
        await ensurePluginWebhookEndpointV1({
            accountId: ACCOUNT_ID,
            input: ensureInput(),
            contribution: CONTRIBUTION,
            target: TARGET,
            publicBaseUrl: "https://happier.example",
            randomBytes: deterministicRandomBytes(),
        });
        const randomBytes = vi.fn(deterministicRandomBytes());

        await expect(ensurePluginWebhookEndpointV1({
            accountId: ACCOUNT_ID,
            input: ensureInput({ idempotencyKey: "ensure-endpoint-source-conflict-0002" }),
            contribution: CONTRIBUTION,
            target: TARGET,
            publicBaseUrl: "https://happier.example",
            randomBytes,
        })).rejects.toMatchObject({ code: "source_conflict" } satisfies Partial<PluginWebhookEndpointStoreError>);

        expect(randomBytes).not.toHaveBeenCalled();
        await expect(db.pluginWebhookEndpoint.count()).resolves.toBe(1);
    });

    it("classifies an authorized duplicate shared installation before generating retry identities", async () => {
        await seedAccount();
        await seedSharedInstallationRoute();
        const first = ensureInput({
            sourceInstanceId: "source-shared-installation-1",
            setup: {
                kind: "githubSharedInstallationV1",
                installationId: "123",
                installationAuthorizationRef: "authorized-shared-installation",
            },
            idempotencyKey: "ensure-shared-installation-0001",
        });
        await ensurePluginWebhookEndpointV1({
            accountId: ACCOUNT_ID,
            input: first,
            contribution: SHARED_CONTRIBUTION,
            target: TARGET,
            publicBaseUrl: "https://happier.example",
            randomBytes: deterministicRandomBytes(),
        });
        const randomBytes = vi.fn(deterministicRandomBytes());

        await expect(ensurePluginWebhookEndpointV1({
            accountId: ACCOUNT_ID,
            input: ensureInput({
                sourceInstanceId: "source-shared-installation-2",
                setup: first.setup,
                idempotencyKey: "ensure-shared-installation-0002",
            }),
            contribution: SHARED_CONTRIBUTION,
            target: TARGET,
            publicBaseUrl: "https://happier.example",
            randomBytes,
        })).rejects.toMatchObject({ code: "installation_conflict" } satisfies Partial<PluginWebhookEndpointStoreError>);

        expect(randomBytes).not.toHaveBeenCalled();
        await expect(db.pluginWebhookEndpoint.count()).resolves.toBe(1);
    });

    it("reads without secret custody, retargets under revision CAS, and idempotently revokes", async () => {
        await seedAccount();
        const created = await ensurePluginWebhookEndpointV1({
            accountId: ACCOUNT_ID,
            input: ensureInput(),
            contribution: CONTRIBUTION,
            target: TARGET,
            publicBaseUrl: "https://happier.example/",
            randomBytes: deterministicRandomBytes(),
        });

        const read = await readPluginWebhookEndpointV1({ accountId: ACCOUNT_ID, webhookEndpointId: created.webhookEndpointId, publicBaseUrl: "https://happier.example" });
        expect(read).toMatchObject({
            webhookEndpointId: created.webhookEndpointId,
            revision: 1,
            contribution: { pluginId: "acme.github", localId: "github-events" },
            targetMaterialization: TARGET.materialization,
        });
        expect(read).not.toHaveProperty("credential");
        const ensuredChange = await readWebhookChange();

        const nextTarget = {
            materialization: { ...TARGET.materialization, materializationId: "materialization-2" },
            machineInstallationId: "machine-installation-1",
            pluginVersion: "1.1.0",
        } as const;
        await expect(retargetPluginWebhookEndpointV1({
            accountId: ACCOUNT_ID,
            webhookEndpointId: created.webhookEndpointId,
            expectedRevision: 1,
            idempotencyKey: "retarget-endpoint-0001",
            target: nextTarget,
        })).resolves.toMatchObject({ kind: "retargeted", revision: 2, targetMaterialization: nextTarget.materialization });
        const retargetedChange = await readWebhookChange();
        expect(retargetedChange).toEqual({
            cursor: expect.any(Number),
            hint: { pluginDomain: "webhook", pluginId: "acme.github" },
        });
        expect(retargetedChange.cursor).toBeGreaterThan(ensuredChange.cursor);

        const revoke = {
            accountId: ACCOUNT_ID,
            webhookEndpointId: created.webhookEndpointId,
            expectedRevision: 2,
            idempotencyKey: "revoke-endpoint-0001",
        } as const;
        await expect(revokePluginWebhookEndpointV1(revoke)).resolves.toMatchObject({ kind: "revoked", revision: 3 });
        const revokedChange = await readWebhookChange();
        expect(revokedChange.cursor).toBeGreaterThan(retargetedChange.cursor);
        await expect(revokePluginWebhookEndpointV1(revoke)).resolves.toMatchObject({ kind: "revoked", revision: 3 });
        await expect(readWebhookChange()).resolves.toEqual(revokedChange);
    });

    it("rotates and explicitly retires Account-route credentials under endpoint revision CAS", async () => {
        await seedAccount();
        const created = await ensurePluginWebhookEndpointV1({
            accountId: ACCOUNT_ID,
            input: ensureInput(),
            contribution: CONTRIBUTION,
            target: TARGET,
            publicBaseUrl: "https://happier.example",
            randomBytes: deterministicRandomBytes(),
        });
        const now = new Date("2026-08-10T12:00:00.000Z");
        const rotated = await rotatePluginWebhookEndpointCredentialV1({
            accountId: ACCOUNT_ID,
            input: {
                webhookEndpointId: created.webhookEndpointId,
                expectedRevision: 1,
            },
            randomBytes: deterministicRandomBytes(),
            now,
        });
        expect(rotated).toMatchObject({
            kind: "rotated",
            webhookEndpointId: created.webhookEndpointId,
            revision: 2,
            oneTimeGeneratedSecret: expect.any(String),
            previousAcceptUntilMs: now.getTime() + 24 * 60 * 60 * 1_000,
        });
        const rotatedChange = await readWebhookChange();
        expect(rotatedChange).toEqual({
            cursor: expect.any(Number),
            hint: { pluginDomain: "webhook", pluginId: "acme.github" },
        });

        await expect(finishPluginWebhookEndpointCredentialRotationV1({
            accountId: ACCOUNT_ID,
            input: {
                webhookEndpointId: created.webhookEndpointId,
                expectedRevision: 2,
                expectedPreviousCredentialVersionId: rotated.previousCredentialVersionId,
            },
        })).resolves.toEqual({
            kind: "retired",
            webhookEndpointId: created.webhookEndpointId,
            revision: 3,
        });
        const retiredChange = await readWebhookChange();
        expect(retiredChange.cursor).toBeGreaterThan(rotatedChange.cursor);
        const route = await db.pluginWebhookRoute.findFirstOrThrow({
            where: { accountEndpointId: created.webhookEndpointId },
            select: { previousCredentialId: true },
        });
        expect(route.previousCredentialId).toBeNull();
    });

    it("creates through the facade and refuses a retarget after the endpoint contribution retires", async () => {
        await seedAccount();
        const manifest = {
            schemaVersion: 2,
            id: "acme.github",
            version: "1.0.0",
            displayName: "GitHub",
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: "./dist/index.js" },
            contributes: {
                actions: [{
                    id: "handle-webhook",
                    title: "Handle webhook",
                    scopes: ["global"],
                    surfaces: ["plugin"],
                    dangerLevel: "safe",
                }],
                webhooks: [{
                    id: "github-events",
                    title: "GitHub events",
                    verifier: { kind: "github_hmac_sha256_v1", routing: "accountEndpoint" },
                    handlerAction: { localId: "handle-webhook" },
                }],
            },
        } as const;
        const releaseFacts = normalizePluginReleaseFactsV1({
            ref: { pluginId: "acme.github", version: "1.0.0" },
            archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            normalizedManifest: manifest,
            collectionContracts: [],
            uiSlots: [],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${"d".repeat(64)}`,
                resources: [],
            },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: TARGET.machineInstallationId,
                pluginMaterializationRevision: 1n,
                operationProtocolCapabilities: {
                    pluginWebhookClaim: { protocolVersions: [1] },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: "acme.github",
                desiredVersion: "1.0.0",
                enabled: true,
                writableCollections: [],
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: "acme.github",
                version: "1.0.0",
                archiveDigestSha256: releaseFacts.archiveDigestSha256,
                normalizedManifest: releaseFacts.normalizedManifest,
                collectionContracts: [],
                uiSlots: [],
                packageAssetArchive: releaseFacts.packageAssetArchive,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: "srv_endpointStoreCurrent1",
                machineId: "machine-1",
                materializationId: "materialization-1",
                pluginId: "acme.github",
                version: "1.0.0",
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: releaseFacts.archiveDigestSha256,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date(),
            },
        });

        const actions = createPluginWebhookEndpointActionsV1();
        const created = await actions.ensure({ accountId: ACCOUNT_ID, input: ensureInput() });
        expect(created).toMatchObject({
            revision: 1,
            readiness: "providerConfirmationRequired",
        });

        const nextTarget = {
            ...TARGET.materialization,
            machineId: "machine-2",
            materializationId: "materialization-2",
        } as const;
        await db.machine.create({
            data: {
                id: nextTarget.machineId,
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: "machine-installation-2",
                pluginMaterializationRevision: 1n,
                operationProtocolCapabilities: {
                    pluginWebhookClaim: { protocolVersions: [1] },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: "srv_endpointStoreCurrent1",
                machineId: nextTarget.machineId,
                materializationId: nextTarget.materializationId,
                pluginId: nextTarget.pluginId,
                version: "1.0.0",
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: releaseFacts.archiveDigestSha256,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date(),
            },
        });
        const retiredFacts = normalizePluginReleaseFactsV1({
            ref: { pluginId: "acme.github", version: "1.0.0" },
            archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            normalizedManifest: {
                ...manifest,
                contributes: { ...manifest.contributes, webhooks: [] },
            },
            collectionContracts: [],
            uiSlots: [],
            packageAssetArchive: releaseFacts.packageAssetArchive,
        });
        await db.accountPluginRelease.update({
            where: {
                accountId_pluginId_version: {
                    accountId: ACCOUNT_ID,
                    pluginId: "acme.github",
                    version: "1.0.0",
                },
            },
            data: { normalizedManifest: retiredFacts.normalizedManifest },
        });

        await expect(actions.retarget({
            accountId: ACCOUNT_ID,
            input: {
                webhookEndpointId: created.webhookEndpointId,
                expectedRevision: 1,
                targetMaterialization: nextTarget,
                idempotencyKey: "retarget-retired-contribution-0001",
            },
        })).resolves.toEqual({ kind: "incompatible", currentRevision: 1 });
        await expect(db.pluginWebhookEndpoint.findUniqueOrThrow({
            where: { id: created.webhookEndpointId },
            select: { revision: true, targetMachineId: true, targetMaterializationId: true },
        })).resolves.toEqual({
            revision: 1,
            targetMachineId: TARGET.materialization.machineId,
            targetMaterializationId: TARGET.materialization.materializationId,
        });
    });
});
