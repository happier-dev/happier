import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import axios from "axios";

import {
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encodePlainArtifactStoredContent,
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentsListActionOutputV1Schema,
    PluginAccountCollectionContributionV1Schema,
    PluginAvailabilityReleaseReadActionOutputV1Schema,
    PluginAvailabilityMaterializationsReportActionInputV1Schema,
    type PluginAvailabilityMaterializationsReportActionOutputV1,
    type FeaturesResponse,
    normalizePluginAccountCollectionContractsV1,
} from "@happier-dev/protocol";
import {
    createPackageAssetArchiveV1,
    encodePackageAssetArchiveBodyV1,
} from "@happier-dev/protocol/plugins/availability";
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    createPluginUiArtifactArchiveV1,
    encodePluginUiArtifactArchiveBodyV1,
} from "@happier-dev/protocol/plugins/ui";
import { createPluginEventAutomationSetupResultV1JsonSchema } from "@happier-dev/protocol/automations/event-setup-result";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import {
    retirePluginCollectionCandidatePreparation,
    pagePluginCollectionCandidatePreparationSource,
    stagePluginCollectionCandidatePreparation,
} from "@/app/plugins/data/collections/candidatePreparation";
import { readCurrentPluginCollectionContract } from "@/app/plugins/data/collections/uiQuery";
import {
    resolveCurrentPluginWebhookClaimAuthoritiesTxV1,
    resolveCurrentPluginWebhookContributionTxV1,
} from "@/app/plugins/webhooks/currentContribution";
import {
    assertCurrentAutomationEventCallerMaterializationTx,
    resolveCurrentAutomationEventContributionTx,
} from "@/app/automations/automationEventCurrentness";

import {
    createPluginAvailabilityOperations,
    resolveCurrentClaimablePluginMachineMaterializationTx,
} from "./operations";
import { registerPluginAvailabilityRoutes } from "./routes";
import { artifactsRoutes } from "@/app/api/routes/artifacts/artifactsRoutes";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";

const ACCOUNT_ID = "account-plugin-availability";
const MACHINE_ID = "machine-plugin-availability";
const SERVER_IDENTITY_ID = "srv_availabilityIntegration";
const PLUGIN_ID = "com.acme.fixture";
const RELEASE = { pluginId: PLUGIN_ID, version: "1.2.3" } as const;
const DISABLED_PLUGIN_ID = "com.acme.disabled";
const DISABLED_RELEASE = { pluginId: DISABLED_PLUGIN_ID, version: "1.2.3" } as const;

function releaseFacts(overrides: Record<string, unknown> = {}) {
    return {
        ref: RELEASE,
        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        normalizedManifest: {
            schemaVersion: 2,
            id: PLUGIN_ID,
            version: RELEASE.version,
            displayName: "Availability fixture",
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            contributes: {},
        },
        collectionContracts: [],
        uiSlots: [{
            contributionId: "hosted",
            artifactId: "hosted",
            tier: "hostedWeb",
            platform: "web",
            artifactDigest: `sha256:${"b".repeat(64)}`,
            hostUiApiRange: "^1.0.0",
        }],
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"c".repeat(64)}`,
            resources: [],
        },
        ...overrides,
    };
}

function createBrowserArtifactArchive() {
    const entryBytes = new TextEncoder().encode("<script type=\"module\" src=\"./assets/app.js\"></script>");
    const moduleBytes = new TextEncoder().encode("export const panel = true;");
    const files = [
        { relativePath: "hosted-web/hosted/index.html", bytes: entryBytes },
        { relativePath: "hosted-web/hosted/assets/app.js", bytes: moduleBytes },
    ];
    const graph = {
        artifactId: "hosted",
        tier: "hostedWeb" as const,
        entry: "hosted-web/hosted/index.html",
        files: files.map((file) => ({
            relativePath: file.relativePath,
            digest: computePluginUiArtifactSha256DigestV1(file.bytes),
            byteSize: file.bytes.byteLength,
        })),
        digest: computePluginUiArtifactFileSetSha256DigestV1(files),
        builtWith: { staging: "staticDirectory" as const },
        hostUiApiRange: "^1.0.0",
    };
    const archive = createPluginUiArtifactArchiveV1({
        pluginId: PLUGIN_ID,
        artifactGraph: graph,
        files,
    });
    if (!archive) throw new Error("Expected fixture browser Artifact archive");
    return { graph, archive, moduleBytes };
}

const RETENTION_COLLECTION = {
    id: "tasks",
    schemaVersion: 1,
    rowIdField: "id",
    schema: {
        type: "object",
        properties: {
            id: { type: "string", maxLength: 256 },
            status: { type: "string", enum: ["closed", "open"] },
        },
        required: ["id", "status"],
        additionalProperties: false,
    },
    serverReadable: ["status"],
    indexes: [],
    relations: [],
} as const;

function createHostedReleaseFixture(input: Readonly<{
    version: string;
    ordinal: number;
    includeCollection?: boolean;
}>) {
    const ref = { pluginId: PLUGIN_ID, version: input.version } as const;
    const { graph, archive: uiArchive } = createBrowserArtifactArchive();
    const normalizedManifest = {
        ...releaseFacts().normalizedManifest,
        version: input.version,
        contributes: {
            ...(input.includeCollection
                ? { accountCollections: [RETENTION_COLLECTION] }
                : {}),
            resources: [{
                id: "brand-icon",
                kind: "asset",
                path: "assets/brand.png",
                contentType: "image/png",
            }],
        },
    };
    const packageAssetArchive = createPackageAssetArchiveV1({
        manifest: normalizedManifest,
        files: [{
            path: "assets/brand.png",
            bytes: new Uint8Array([137, 80, 78, input.ordinal]),
        }],
    });
    if (!packageAssetArchive) {
        throw new Error("Expected retention package Asset archive fixture");
    }
    const collectionContracts = input.includeCollection
        ? normalizePluginAccountCollectionContractsV1({
            pluginId: PLUGIN_ID,
            contributions: [
                PluginAccountCollectionContributionV1Schema.parse(RETENTION_COLLECTION),
            ],
        }).map(({ pluginId, collectionId, schemaVersion, contractDigest }) => ({
            pluginId,
            collectionId,
            schemaVersion,
            contractDigest,
        }))
        : [];
    const slot = {
        ...releaseFacts().uiSlots[0]!,
        artifactDigest: graph.digest,
    };
    return {
        ref,
        facts: releaseFacts({
            ref,
            archiveDigestSha256: `sha256:${String(input.ordinal).repeat(64)}`,
            normalizedManifest,
            collectionContracts,
            uiSlots: [slot],
            packageAssetArchive: packageAssetArchive.descriptor,
        }),
        collectionContracts,
        slot,
        uiArtifactId: `00000000-0000-4000-8000-${String(input.ordinal * 2 + 10).padStart(12, "0")}`,
        uiArtifact: {
            header: encodePlainArtifactStoredContent(uiArchive.header),
            body: encodePlainArtifactStoredContent({
                body: encodePluginUiArtifactArchiveBodyV1(uiArchive.body),
            }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        },
        packageArtifactId: `00000000-0000-4000-8000-${String(input.ordinal * 2 + 11).padStart(12, "0")}`,
        packageArtifact: {
            header: encodePlainArtifactStoredContent(packageAssetArchive.header),
            body: encodePlainArtifactStoredContent({
                body: encodePackageAssetArchiveBodyV1(packageAssetArchive.body),
            }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        },
    };
}

describe("plugin Availability operations", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-availability-",
            initAuth: false,
            initEncrypt: true,
            initFiles: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationEventSourceCatalogStatus.deleteMany(),
            () => db.automationEventSourceStatus.deleteMany(),
            () => db.automationTrigger.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.automationEventCatalogState.deleteMany(),
            () => db.pluginCollectionCandidatePreparationStage.deleteMany(),
            () => db.pluginCollectionIndexEntry.deleteMany(),
            () => db.pluginCollectionProjection.deleteMany(),
            () => db.pluginCollectionRelation.deleteMany(),
            () => db.pluginCollectionRow.deleteMany(),
            () => db.pluginCollectionIndexState.deleteMany(),
            () => db.pluginMachineMaterialization.deleteMany(),
            () => db.accountPluginUiArtifact.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.artifact.deleteMany(),
            () => db.pluginCollectionContract.deleteMany(),
            () => db.managedMachine.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function seedAccountAndMachine(options: Readonly<{
        encryptionMode?: "plain" | "e2ee";
    }> = {}) {
        const encryptionMode = options.encryptionMode ?? "plain";
        await db.account.create({
            data: {
                id: ACCOUNT_ID,
                ...(encryptionMode === "e2ee"
                    ? createSignedAccountContentBinding()
                    : { publicKey: null }),
                encryptionMode,
            },
        });
        await db.machine.create({
            data: {
                id: MACHINE_ID,
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: "machine-installation-availability",
            },
        });
    }

    function operations() {
        return createPluginAvailabilityOperations({
            resolveHostingCapability: () => ({
                enabled: true,
                maxArtifactBytes: 1024 * 1024,
                maxAccountBytes: 4 * 1024 * 1024,
            }),
            resolveServerIdentityId: async () => SERVER_IDENTITY_ID,
        });
    }

    it("reviews retained native resources before disabling their provisioner and permits exact manual responsibility", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const enabled = { pluginId: PLUGIN_ID, desiredVersion: null, enabled: true,
            offlineUiHosting: "disabled", writableCollections: [], expectedRevision: null };
        await service.setIntent({ accountId: ACCOUNT_ID, input: enabled });
        const provider = { pluginId: PLUGIN_ID, localId: "cloud" };
        const retained = await db.managedMachine.create({ data: {
            homeId: SERVER_IDENTITY_ID, custodianAccountId: ACCOUNT_ID, controllerMachineId: MACHINE_ID,
            controllerInstallationId: "machine-installation-availability", admittedActionRequestId: "plugin-retention-request", admittedInput: {},
            launch: { provider, schemaVersion: 1, name: "Retained", choices: {} },
            allocation: "may-exist", retention: { kind: "until-delete" }, wakeOnAcceptedMessage: false,
            recovery: { reference: "native-plugin-123", reason: "unknown_acquisition" },
        } });
        const disable = { ...enabled, enabled: false, expectedRevision: "0" };
        await expect(service.readIntent({ accountId: ACCOUNT_ID, input: { pluginId: PLUGIN_ID,
            includeManagedResources: true } })).resolves.toMatchObject({
            managedResources: [{ managedId: retained.id, allocation: "may-exist", recovery: { reference: "native-plugin-123" } }],
            managedResourcesReviewed: false,
        });
        await expect(service.readIntent({ accountId: ACCOUNT_ID, input: { pluginId: PLUGIN_ID,
            includeManagedResources: true, managedResourceDispositions: [{
                managedId: retained.id, expectedIntentRevision: 0, responsibility: "manual",
                expectedAllocation: "may-exist", expectedRecovery: { reference: "native-plugin-123", reason: "unknown_acquisition" },
            }] } })).resolves.toMatchObject({ managedResourcesReviewed: true });
        expect(await service.readIntent({ accountId: ACCOUNT_ID, input: { pluginId: PLUGIN_ID } })).not.toHaveProperty("managedResources");
        await expect(service.setIntent({ accountId: ACCOUNT_ID, input: disable })).rejects.toMatchObject({
            code: "managed_resources_review_required", resources: [{ managedId: retained.id,
                allocation: "may-exist", recovery: { reference: "native-plugin-123" } }],
        });
        expect(await db.accountPluginIntent.findUniqueOrThrow({ where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } } }))
            .toMatchObject({ enabled: true });
        await expect(service.setIntent({ accountId: ACCOUNT_ID, input: { ...disable, managedResourceDispositions: [{
            managedId: retained.id, expectedIntentRevision: 0, responsibility: "manual",
            expectedAllocation: 'may-exist', expectedRecovery: { reference: 'native-plugin-123', reason: 'unknown_acquisition' },
        }] } })).resolves.toMatchObject({ intent: { enabled: false, revision: "1" } });
        expect(await db.managedMachine.findUniqueOrThrow({ where: { id: retained.id } })).toMatchObject({ allocation: "may-exist" });
    });

    it('limits local plugin removal review to its authenticated controller installation', async () => {
        await seedAccountAndMachine();
        const homeId = await getOrCreateServerIdentityId();
        const service = operations();
        const machine = await db.machine.findUniqueOrThrow({ where: { id: MACHINE_ID } });
        const provider = { pluginId: PLUGIN_ID, localId: 'cloud' };
        const current = await db.managedMachine.create({ data: {
            homeId, custodianAccountId: ACCOUNT_ID, controllerMachineId: MACHINE_ID,
            controllerInstallationId: machine.installationId!, admittedActionRequestId: 'local-controller-resource', admittedInput: {},
            launch: { provider, schemaVersion: 1, name: 'Local controller', choices: {} },
            allocation: 'may-exist', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            archivedAt: new Date(1), creationState: 'retired',
        } });
        await db.managedMachine.create({ data: {
            homeId, custodianAccountId: ACCOUNT_ID, controllerMachineId: 'another-controller',
            controllerInstallationId: 'another-installation', admittedActionRequestId: 'other-controller-resource', admittedInput: {},
            launch: { provider, schemaVersion: 1, name: 'Other controller', choices: {} },
            allocation: 'may-exist', retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
        } });
        const result = await service.readIntent({ accountId: ACCOUNT_ID, input: { pluginId: PLUGIN_ID,
            includeManagedResources: true, homeId, controller: { machineId: MACHINE_ID, installationId: machine.installationId } } });
        expect(result.managedResources?.map(resource => resource.managedId)).toEqual([current.id]);
        await expect(service.readIntent({ accountId: ACCOUNT_ID, input: { pluginId: PLUGIN_ID,
            includeManagedResources: true, homeId, controller: { machineId: MACHINE_ID, installationId: 'replaced-installation' } } }))
            .rejects.toMatchObject({ code: 'plugin_availability_invalid_request' });
    });

    async function publishHostedRelease(
        service: ReturnType<typeof operations>,
        fixture: ReturnType<typeof createHostedReleaseFixture>,
    ) {
        await service.publishRelease({
            accountId: ACCOUNT_ID,
            input: { facts: fixture.facts, sourceClass: "registryPackage" },
        });
    }

    async function selectHostedRelease(
        service: ReturnType<typeof operations>,
        fixture: ReturnType<typeof createHostedReleaseFixture>,
        expectedRevision: string | null,
    ) {
        await service.setIntent({
            accountId: ACCOUNT_ID,
            input: {
                pluginId: PLUGIN_ID,
                desiredVersion: fixture.ref.version,
                enabled: true,
                offlineUiHosting: "enabled",
                writableCollections: fixture.collectionContracts,
                expectedRevision,
            },
        });
    }

    async function hostReleaseArchives(
        service: ReturnType<typeof operations>,
        fixture: ReturnType<typeof createHostedReleaseFixture>,
    ) {
        await service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: fixture.ref,
                slot: fixture.slot,
                accountArtifactId: fixture.uiArtifactId,
                artifact: fixture.uiArtifact,
            },
        });
        await service.publishPackageAsset({
            accountId: ACCOUNT_ID,
            input: {
                release: fixture.ref,
                artifactId: fixture.packageArtifactId,
                artifact: fixture.packageArtifact,
            },
        });
    }

    it('lists canonical intent projections including hosted archives, machine-only plugins and deleted known intents', async () => {
        await seedAccountAndMachine();
        const service = operations();
        const fixture = createHostedReleaseFixture({ version: RELEASE.version, ordinal: 1 });
        await publishHostedRelease(service, fixture);
        await selectHostedRelease(service, fixture, null);
        await hostReleaseArchives(service, fixture);
        const machineOnlyPluginId = 'com.acme.machine-only';
        const removedPluginId = 'com.acme.removed';
        const invalidPluginId = 'com.acme.invalid';
        // A malformed stored intent must not prevent healthy declarations from hydrating.
        await db.accountPluginIntent.create({ data: { accountId: ACCOUNT_ID, pluginId: invalidPluginId,
            desiredVersion: null, enabled: false, offlineUiHosting: 'disabled', writableCollections: {} } });
        await service.reportMaterializations({ accountId: ACCOUNT_ID, publisherMachineId: MACHINE_ID,
            input: { expectedRevision: null, snapshot: {
                serverIdentityId: SERVER_IDENTITY_ID, machineId: MACHINE_ID,
                materializations: [{
                    serverIdentityId: SERVER_IDENTITY_ID, machineId: MACHINE_ID,
                    materializationId: 'machine-only-install', pluginId: machineOnlyPluginId,
                    version: RELEASE.version, sourceClass: 'localPath', portableRelease: false,
                    uiArtifacts: [], enabled: true, trustState: 'trusted', observedAt: 1,
                }],
            } } });

        const listed = await service.listIntentIds({ accountId: ACCOUNT_ID,
            input: { knownPluginIds: [machineOnlyPluginId, removedPluginId, removedPluginId] } });
        expect(listed.pluginIds).toEqual([PLUGIN_ID, invalidPluginId].sort());
        expect(listed.failedPluginIds).toEqual([invalidPluginId]);
        expect(listed.intentReads).toEqual(await Promise.all([PLUGIN_ID, machineOnlyPluginId, removedPluginId]
            .sort().map(async pluginId => ({ pluginId,
                response: await service.readIntent({ accountId: ACCOUNT_ID, input: { pluginId } }),
            }))));
        expect(listed.intentReads.find(entry => entry.pluginId === PLUGIN_ID)?.response).toMatchObject({
            release: fixture.facts,
            uiArtifacts: [expect.objectContaining({ accountArtifactId: fixture.uiArtifactId })],
            packageAssets: [expect.objectContaining({ artifactId: fixture.packageArtifactId })],
        });
        expect(listed.intentReads.find(entry => entry.pluginId === removedPluginId)?.response.intent).toBeNull();
        // Exercise Fastify's real route and its default operations owner, not
        // the operation stub used by the separate route admission unit tests.
        await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
            const response = await app.inject({
                method: 'POST',
                url: PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'],
                headers: { 'x-test-user-id': ACCOUNT_ID },
                payload: { knownPluginIds: [machineOnlyPluginId, removedPluginId] },
            });
            expect(response.statusCode, response.body).toBe(200);
            const overHttp = PluginAvailabilityIntentsListActionOutputV1Schema.parse(response.json());
            expect(overHttp.pluginIds).toEqual(listed.pluginIds);
            expect(overHttp.failedPluginIds).toEqual(listed.failedPluginIds);
            expect(overHttp.intentReads.map(entry => entry.pluginId)).toEqual(listed.intentReads.map(entry => entry.pluginId));
            expect(overHttp.intentReads.find(entry => entry.pluginId === PLUGIN_ID)?.response).toMatchObject({
                release: fixture.facts,
                uiArtifacts: [expect.objectContaining({ accountArtifactId: fixture.uiArtifactId })],
                packageAssets: [expect.objectContaining({ artifactId: fixture.packageArtifactId })],
            });
            expect(overHttp.intentReads.find(entry => entry.pluginId === removedPluginId)?.response.intent).toBeNull();
        });
    });

    it('reads the complete Account transition inventory without exposing retained plugin archives to ordinary APIs', async () => {
        await seedAccountAndMachine();
        const service = operations();
        const fixture = createHostedReleaseFixture({ version: '1.2.3', ordinal: 1 });
        await publishHostedRelease(service, fixture);
        await selectHostedRelease(service, fixture, null);
        await hostReleaseArchives(service, fixture);
        // Account transition includes protected archives even when hosting is no longer selected.
        await db.accountPluginIntent.updateMany({ where: { accountId: ACCOUNT_ID }, data: { enabled: false } });
        await db.artifactRevision.create({ data: { artifactId: fixture.uiArtifactId, bodyVersion: 1,
            body: Buffer.from(fixture.uiArtifact.body, 'base64') } });
        const ordinary = Array.from({ length: 501 }, (_, index) => ({ id: `ordinary-${String(index).padStart(4, '0')}`,
            accountId: ACCOUNT_ID, header: Buffer.from(encodePlainArtifactStoredContent({ title: 'Document' }), 'base64'),
            body: Buffer.from(encodePlainArtifactStoredContent({ body: 'Content' }), 'base64'),
            dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64') }));
        await db.artifact.createMany({ data: ordinary });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const headers = { 'x-test-user-id': ACCOUNT_ID };
            const first = await app.inject({ method: 'GET', url: '/v1/account/encryption/artifacts?limit=500', headers });
            expect(first.statusCode, first.body).toBe(200);
            const page = first.json();
            expect(page.items).toHaveLength(500);
            expect(page.items.find((row: { id: string }) => row.id === fixture.uiArtifactId))
                .toMatchObject({ ownership: { kind: 'pluginUi', pluginId: PLUGIN_ID }, revisions: [{ bodyVersion: 1 }] });
            expect(page.items.find((row: { id: string }) => row.id === fixture.packageArtifactId))
                .toMatchObject({ ownership: { kind: 'packageAsset', pluginId: PLUGIN_ID } });
            const last = await app.inject({ method: 'GET', url: `/v1/account/encryption/artifacts?limit=500&afterId=${encodeURIComponent(page.nextCursor)}`, headers });
            expect(last.statusCode, last.body).toBe(200);
            expect(last.json()).toMatchObject({ nextCursor: null });
            expect(last.json().items).toHaveLength(3);
            const listed = await app.inject({ method: 'GET', url: '/v1/artifacts?limit=500', headers });
            expect(listed.statusCode).toBe(200);
            expect(listed.json().every((row: { id: string }) => row.id.startsWith('ordinary-'))).toBe(true);
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${fixture.uiArtifactId}`, headers })).statusCode).toBe(404);
            // Corrupt qualified linkage fails the migration read before returning any content.
            await db.accountPluginUiArtifact.updateMany({ where: { artifactId: fixture.uiArtifactId }, data: { artifactDigest: `sha256:${'f'.repeat(64)}` } });
            expect((await app.inject({ method: 'GET', url: '/v1/account/encryption/artifacts', headers })).statusCode).toBe(503);
        });
    });

    async function seedCurrentPlainHostedArchives() {
        harness.resetEnv({
            HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__ENABLED: "1",
            HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: "1048576",
            HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: "4194304",
        });
        await seedAccountAndMachine();
        const service = createPluginAvailabilityOperations();
        const fixture = createHostedReleaseFixture({ version: RELEASE.version, ordinal: 1 });
        await publishHostedRelease(service, fixture);
        await selectHostedRelease(service, fixture, null);
        await hostReleaseArchives(service, fixture);
        return { service, fixture };
    }

    it.each(["ui", "packageAsset"] as const)(
        "rejoins a current plain %s archive without a stored-content declaration",
        async (kind) => {
            const { service, fixture } = await seedCurrentPlainHostedArchives();
            const artifactId = "00000000-0000-4000-8000-000000000099";
            const result = kind === "ui"
                ? await service.publishUiArtifact({
                    accountId: ACCOUNT_ID,
                    input: {
                        release: fixture.ref,
                        slot: fixture.slot,
                        accountArtifactId: artifactId,
                        artifact: fixture.uiArtifact,
                    },
                })
                : await service.publishPackageAsset({
                    accountId: ACCOUNT_ID,
                    input: {
                        release: fixture.ref,
                        artifactId,
                        artifact: fixture.packageArtifact,
                    },
                });
            expect(result).toMatchObject({
                outcome: "rejoined",
                link: kind === "ui"
                    ? { accountArtifactId: fixture.uiArtifactId }
                    : { artifactId: fixture.packageArtifactId },
            });
            await expect(db.artifact.findUnique({ where: { id: artifactId } })).resolves.toBeNull();
            await expect(db.artifact.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(2);
        },
    );

    it.each(["ui", "packageAsset"] as const)(
        "reads a current plain %s archive without a declaration while preserving Account and mode admission",
        async (kind) => {
            const { service, fixture } = await seedCurrentPlainHostedArchives();
            const path = PluginAvailabilityActionHttpPathsV1[kind === "ui"
                ? "account.plugins.availability.uiArtifact.read"
                : "account.plugins.availability.packageAsset.read"];
            const payload = kind === "ui"
                ? {
                    release: fixture.ref,
                    contributionId: fixture.slot.contributionId,
                    artifactId: fixture.slot.artifactId,
                    tier: fixture.slot.tier,
                    platform: fixture.slot.platform,
                }
                : { release: fixture.ref };
            await withAuthenticatedTestApp(
                (app) => registerPluginAvailabilityRoutes(app, { operations: service }),
                async (app) => {
                    const read = (accountId: string) => app.inject({
                        method: "POST",
                        url: path,
                        headers: { "x-test-user-id": accountId },
                        payload,
                    });
                    const current = await read(ACCOUNT_ID);
                    expect(current.statusCode, current.body).toBe(200);
                    expect(current.json()).toMatchObject({
                        artifact: kind === "ui" ? fixture.uiArtifact : fixture.packageArtifact,
                    });
                    const foreignAccount = await db.account.create({
                        data: { encryptionMode: "plain" },
                        select: { id: true },
                    });
                    const foreign = await read(foreignAccount.id);
                    expect(foreign.statusCode).toBe(404);
                    await db.account.update({
                        where: { id: ACCOUNT_ID },
                        data: { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" },
                    });
                    const wrongMode = await read(ACCOUNT_ID);
                    expect(wrongMode.statusCode).toBe(400);
                    expect(wrongMode.json()).toEqual({
                        error: kind === "ui"
                            ? "plugin_ui_artifact_invalid_content"
                            : "plugin_package_asset_invalid_content",
                    });
                },
            );
        },
    );

    it("uses the operator-owned hosting capability when no test override is supplied", async () => {
        await seedAccountAndMachine();
        const defaultOperations = createPluginAvailabilityOperations({
            resolveServerIdentityId: async () => SERVER_IDENTITY_ID,
        });

        await expect(defaultOperations.readIntent({
            accountId: ACCOUNT_ID,
            input: { pluginId: PLUGIN_ID },
        })).resolves.toMatchObject({ hostingCapability: { enabled: false } });

        harness.resetEnv({
            HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__ENABLED: "1",
            HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ARTIFACT_BYTES: "1024",
            HAPPIER_FEATURE_PLUGINS_UI_ARTIFACT_HOSTING__MAX_ACCOUNT_BYTES: "4096",
        });
        const configuredOperations = createPluginAvailabilityOperations({
            resolveServerIdentityId: async () => SERVER_IDENTITY_ID,
        });

        await expect(configuredOperations.readIntent({
            accountId: ACCOUNT_ID,
            input: { pluginId: PLUGIN_ID },
        })).resolves.toMatchObject({
            hostingCapability: {
                enabled: true,
                maxArtifactBytes: 1024,
                maxAccountBytes: 4096,
            },
        });
    });

    it("binds one pluginId@version to immutable verified facts and rejects a same-version conflict", async () => {
        await seedAccountAndMachine();
        const service = operations();

        await expect(service.publishRelease({
            accountId: ACCOUNT_ID,
            input: { facts: releaseFacts(), sourceClass: "registryPackage" },
        })).resolves.toMatchObject({ outcome: "created", facts: { ref: RELEASE } });
        await expect(service.publishRelease({
            accountId: ACCOUNT_ID,
            input: { facts: releaseFacts(), sourceClass: "versionedArchive" },
        })).resolves.toMatchObject({ outcome: "rejoined", facts: { ref: RELEASE } });
        await expect(service.publishRelease({
            accountId: ACCOUNT_ID,
            input: {
                facts: releaseFacts({ archiveDigestSha256: `sha256:${"c".repeat(64)}` }),
                sourceClass: "registryPackage",
            },
        })).rejects.toMatchObject({
            code: "plugin_release_content_conflict",
        });
        await expect(db.accountPluginRelease.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);
    });

    it("reads exact immutable facts for an unselected release with the current Availability cursor", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const target = { pluginId: PLUGIN_ID, version: "2.0.0" } as const;
        const facts = releaseFacts({
            ref: target,
            archiveDigestSha256: `sha256:${"d".repeat(64)}`,
            normalizedManifest: {
                ...releaseFacts().normalizedManifest,
                version: target.version,
            },
        });

        await service.publishRelease({
            accountId: ACCOUNT_ID,
            input: { facts, sourceClass: "versionedArchive" },
        });
        await expect(db.accountPluginIntent.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(0);

        const account = await db.account.findUnique({
            where: { id: ACCOUNT_ID },
            select: { seq: true },
        });
        if (!account) throw new Error("Expected seeded Account");

        const expected = PluginAvailabilityReleaseReadActionOutputV1Schema.parse({
            availabilityCursor: account.seq,
            facts,
        });
        await expect(service.readRelease({
            accountId: ACCOUNT_ID,
            input: { release: target },
        })).resolves.toEqual(expected);
        await expect(service.readRelease({
            accountId: ACCOUNT_ID,
            input: { release: { pluginId: PLUGIN_ID, version: "9.9.9" } },
        })).rejects.toMatchObject({ code: "plugin_release_not_found" });
    });

    it("materializes immutable Data contracts from the admitted manifest before Availability stores its refs", async () => {
        await seedAccountAndMachine();
        const collection = {
            id: "tasks",
            schemaVersion: 1,
            rowIdField: "id",
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    status: { type: "string", enum: ["closed", "open"] },
                },
                required: ["id", "status"],
                additionalProperties: false,
            },
            serverReadable: ["status"],
            indexes: [{ id: "by-status", fields: [{ field: "status", direction: "asc" }] }],
            uiQueries: [{
                id: "open",
                indexId: "by-status",
                parameters: {
                    status: { kind: "string", maxUtf8Bytes: 16, enum: ["closed", "open"] },
                },
                prefix: [{ kind: "parameter", parameterId: "status" }],
                order: "asc",
                pageSize: 20,
                projectedFields: ["status"],
            }],
            relations: [],
        } as const;
        const normalizedManifest = {
            ...releaseFacts().normalizedManifest,
            contributes: { accountCollections: [collection] },
        };
        const collectionContracts = normalizePluginAccountCollectionContractsV1({
            pluginId: PLUGIN_ID,
            contributions: [PluginAccountCollectionContributionV1Schema.parse(collection)],
        }).map(({ pluginId, collectionId, schemaVersion, contractDigest }) => ({
            pluginId,
            collectionId,
            schemaVersion,
            contractDigest,
        }));

        await expect(operations().publishRelease({
            accountId: ACCOUNT_ID,
            input: {
                facts: releaseFacts({ normalizedManifest, collectionContracts }),
                sourceClass: "registryPackage",
            },
        })).resolves.toMatchObject({ outcome: "created" });
        await expect(db.pluginCollectionContract.findFirst({
            where: {
                pluginId: PLUGIN_ID,
                collectionId: "tasks",
                schemaVersion: 1,
                contractDigest: collectionContracts[0]!.contractDigest,
            },
            select: {
                normalizedSchema: true,
                privacyProjection: true,
            },
        })).resolves.toMatchObject({
            normalizedSchema: expect.objectContaining({ type: "object" }),
            privacyProjection: expect.objectContaining({
                rowIdField: "id",
                uiQueries: [expect.objectContaining({ id: "open" })],
            }),
        });
    });

    it("keeps an intent unset until Data confirms the selected release writer contracts, then uses its exact revision CAS", async () => {
        await seedAccountAndMachine();
        const collection = {
            id: "tasks",
            schemaVersion: 1,
            rowIdField: "id",
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    status: { type: "string", enum: ["closed", "open"] },
                },
                required: ["id", "status"],
                additionalProperties: false,
            },
            serverReadable: ["status"],
            indexes: [{ id: "by-status", fields: [{ field: "status", direction: "asc" }] }],
            relations: [],
        } as const;
        const normalizedManifest = {
            ...releaseFacts().normalizedManifest,
            contributes: { accountCollections: [collection] },
        };
        const collectionContracts = normalizePluginAccountCollectionContractsV1({
            pluginId: PLUGIN_ID,
            contributions: [PluginAccountCollectionContributionV1Schema.parse(collection)],
        }).map(({ pluginId, collectionId, schemaVersion, contractDigest }) => ({
            pluginId,
            collectionId,
            schemaVersion,
            contractDigest,
        }));
        const service = operations();

        await service.publishRelease({
            accountId: ACCOUNT_ID,
            input: {
                facts: releaseFacts({ normalizedManifest, collectionContracts }),
                sourceClass: "registryPackage",
            },
        });
        const contract = await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: PLUGIN_ID,
                collectionId: "tasks",
                schemaVersion: 1,
                contractDigest: collectionContracts[0]!.contractDigest,
            },
            select: { id: true },
        });
        await db.pluginCollectionRow.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: "tasks",
                rowId: "existing-task",
                schemaVersion: 1,
                revision: 1,
                contractId: contract.id,
                contractDigest: collectionContracts[0]!.contractDigest,
                contentEnvelope: { t: "plain", v: {} },
            },
        });

        const input = {
            pluginId: PLUGIN_ID,
            desiredVersion: RELEASE.version,
            enabled: true,
            offlineUiHosting: "disabled" as const,
            writableCollections: collectionContracts,
            expectedRevision: null,
        };
        await expect(service.setIntent({ accountId: ACCOUNT_ID, input }))
            .rejects.toMatchObject({
                code: "plugin_intent_writable_collections_not_ready",
            });
        await expect(db.accountPluginIntent.count({
            where: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID },
        })).resolves.toBe(0);

        await db.pluginCollectionIndexState.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: "tasks",
                indexId: "by-status",
                contractId: contract.id,
                contractDigest: collectionContracts[0]!.contractDigest,
                buildState: "ready",
                indexedThroughRevision: 1,
            },
        });
        await expect(service.setIntent({ accountId: ACCOUNT_ID, input }))
            .resolves.toMatchObject({
                intent: {
                    pluginId: PLUGIN_ID,
                    desiredVersion: RELEASE.version,
                    writableCollections: collectionContracts,
                    revision: "0",
                },
            });
        await expect(service.setIntent({
            accountId: ACCOUNT_ID,
            input: { ...input, enabled: false },
        })).rejects.toMatchObject({ code: "plugin_intent_revision_conflict" });
        await expect(service.setIntent({
            accountId: ACCOUNT_ID,
            input: { ...input, enabled: false, expectedRevision: "0" },
        })).resolves.toMatchObject({
            intent: { enabled: false, revision: "1" },
        });

        // An identical body is a rejoin: no revision, Account.seq or change hint.
        const readSeq = async () => (await db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { seq: true },
        })).seq;
        const seqBefore = await readSeq();
        const changesBefore = await db.accountChange.count({ where: { accountId: ACCOUNT_ID } });
        await expect(service.setIntent({
            accountId: ACCOUNT_ID,
            input: { ...input, enabled: false, expectedRevision: "1" },
        })).resolves.toMatchObject({
            intent: { enabled: false, revision: "1" },
        });
        await expect(readSeq()).resolves.toBe(seqBefore);
        await expect(db.accountChange.count({ where: { accountId: ACCOUNT_ID } }))
            .resolves.toBe(changesBefore);
    });

    it("promotes exactly one complete candidate generation inside the intent CAS and rolls back a partial candidate", async () => {
        await seedAccountAndMachine();
        const sourceCollection = {
            id: "tasks",
            schemaVersion: 1,
            rowIdField: "id",
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    status: { type: "string", enum: ["closed", "open"] },
                },
                required: ["id", "status"],
                additionalProperties: false,
            },
            serverReadable: ["id", "status"],
            indexes: [{ id: "by-status", fields: [{ field: "status", direction: "asc" }] }],
            relations: [],
        } as const;
        const targetCollection = {
            ...sourceCollection,
            schemaVersion: 2,
            schema: {
                type: "object" as const,
                properties: {
                    ...sourceCollection.schema.properties,
                    title: { type: "string", maxLength: 256 },
                },
                required: ["id", "status", "title"],
                additionalProperties: false,
            },
            serverReadable: ["id", "status", "title"],
            readableSchemaVersions: [1],
            migrations: [{
                id: "upgrade-tasks-v1-to-v2",
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
            }],
        } as const;
        const sourceManifest = {
            ...releaseFacts().normalizedManifest,
            version: RELEASE.version,
            contributes: { accountCollections: [sourceCollection] },
        };
        const targetRelease = { pluginId: PLUGIN_ID, version: "2.0.0" } as const;
        const targetManifest = {
            ...sourceManifest,
            version: targetRelease.version,
            contributes: { accountCollections: [targetCollection] },
        };
        const sourceContracts = normalizePluginAccountCollectionContractsV1({
            pluginId: PLUGIN_ID,
            contributions: [PluginAccountCollectionContributionV1Schema.parse(sourceCollection)],
        }).map(({ pluginId, collectionId, schemaVersion, contractDigest }) => ({
            pluginId,
            collectionId,
            schemaVersion,
            contractDigest,
        }));
        const targetContracts = normalizePluginAccountCollectionContractsV1({
            pluginId: PLUGIN_ID,
            contributions: [PluginAccountCollectionContributionV1Schema.parse(targetCollection)],
        }).map(({ pluginId, collectionId, schemaVersion, contractDigest }) => ({
            pluginId,
            collectionId,
            schemaVersion,
            contractDigest,
        }));
        const source = sourceContracts[0];
        const target = targetContracts[0];
        if (!source || !target) throw new Error("Expected source and target collection contracts.");
        const service = operations();
        await service.publishRelease({
            accountId: ACCOUNT_ID,
            input: {
                facts: releaseFacts({ normalizedManifest: sourceManifest, collectionContracts: sourceContracts }),
                sourceClass: "registryPackage",
            },
        });
        await service.publishRelease({
            accountId: ACCOUNT_ID,
            input: {
                facts: releaseFacts({
                    ref: targetRelease,
                    archiveDigestSha256: `sha256:${"b".repeat(64)}`,
                    normalizedManifest: targetManifest,
                    collectionContracts: targetContracts,
                }),
                sourceClass: "registryPackage",
            },
        });
        await service.setIntent({
            accountId: ACCOUNT_ID,
            input: {
                pluginId: PLUGIN_ID,
                desiredVersion: RELEASE.version,
                enabled: true,
                offlineUiHosting: "disabled",
                writableCollections: sourceContracts,
                expectedRevision: null,
            },
        });
        const sourceContract = await db.pluginCollectionContract.findFirstOrThrow({
            where: {
                pluginId: PLUGIN_ID,
                collectionId: "tasks",
                schemaVersion: source.schemaVersion,
                contractDigest: source.contractDigest,
            },
            select: { id: true },
        });
        const sourceRows = await Promise.all(["task-a", "task-b"].map(async (rowId) => {
            const row = await db.pluginCollectionRow.create({
                data: {
                    accountId: ACCOUNT_ID,
                    pluginId: PLUGIN_ID,
                    collectionId: "tasks",
                    rowId,
                    schemaVersion: source.schemaVersion,
                    revision: 1,
                    contractId: sourceContract.id,
                    contractDigest: source.contractDigest,
                    contentEnvelope: { t: "plain", v: {} },
                },
                select: { id: true, rowId: true },
            });
            await db.pluginCollectionProjection.createMany({
                data: [
                    { fieldId: "id", typedEncodedValue: JSON.stringify(rowId) },
                    { fieldId: "status", typedEncodedValue: JSON.stringify("open") },
                ].map((projection) => ({
                    ...projection,
                    rowDbId: row.id,
                    accountId: ACCOUNT_ID,
                    pluginId: PLUGIN_ID,
                    collectionId: "tasks",
                    rowId,
                    rowRevision: 1,
                })),
            });
            return row;
        }));
        const binding = {
            source,
            target,
            candidate: { releaseVersion: targetRelease.version, artifactDigest: `sha256:${"a".repeat(64)}` },
        } as const;
        await stagePluginCollectionCandidatePreparation({
            accountId: ACCOUNT_ID,
            request: {
                binding,
                items: [{
                    source: { rowId: sourceRows[0]!.rowId, revision: 1 },
                    target: {
                        content: { t: "plain", v: {} },
                        projection: { id: sourceRows[0]!.rowId, status: "open", title: "A" },
                    },
                }],
            },
        });

        // A stale caller must lose to Availability's currentness contract
        // before Data evaluates whether this incomplete candidate is ready.
        await expect(service.setIntent({
            accountId: ACCOUNT_ID,
            input: {
                pluginId: PLUGIN_ID,
                desiredVersion: targetRelease.version,
                enabled: true,
                offlineUiHosting: "disabled",
                writableCollections: targetContracts,
                expectedRevision: "1",
            },
        })).rejects.toMatchObject({ code: "plugin_intent_revision_conflict" });

        await expect(service.setIntent({
            accountId: ACCOUNT_ID,
            input: {
                pluginId: PLUGIN_ID,
                desiredVersion: targetRelease.version,
                enabled: true,
                offlineUiHosting: "disabled",
                writableCollections: targetContracts,
                expectedRevision: "0",
            },
        })).rejects.toMatchObject({ code: "plugin_intent_writable_collections_not_ready" });
        await expect(db.pluginCollectionRow.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { rowId: "asc" },
            select: { rowId: true, schemaVersion: true, revision: true, contractDigest: true },
        })).resolves.toEqual([
            { rowId: "task-a", schemaVersion: 1, revision: 1, contractDigest: source.contractDigest },
            { rowId: "task-b", schemaVersion: 1, revision: 1, contractDigest: source.contractDigest },
        ]);

        await stagePluginCollectionCandidatePreparation({
            accountId: ACCOUNT_ID,
            request: {
                binding,
                items: [{
                    source: { rowId: sourceRows[1]!.rowId, revision: 1 },
                    target: {
                        content: { t: "plain", v: {} },
                        projection: { id: sourceRows[1]!.rowId, status: "open", title: "B" },
                    },
                }],
            },
        });
        const replacedBinding = {
            ...binding,
            candidate: { ...binding.candidate, artifactDigest: `sha256:${"b".repeat(64)}` },
        } as const;
        for (const row of sourceRows) {
            await stagePluginCollectionCandidatePreparation({
                accountId: ACCOUNT_ID,
                request: {
                    binding: replacedBinding,
                    items: [{
                        source: { rowId: row.rowId, revision: 1 },
                        target: {
                            content: { t: "plain", v: {} },
                            projection: {
                                id: row.rowId,
                                status: "open",
                                title: row.rowId === "task-a" ? "A replacement" : "B replacement",
                            },
                        },
                    }],
                },
            });
        }
        await expect(service.setIntent({
            accountId: ACCOUNT_ID,
            input: {
                pluginId: PLUGIN_ID,
                desiredVersion: targetRelease.version,
                enabled: true,
                offlineUiHosting: "disabled",
                writableCollections: targetContracts,
                expectedRevision: "0",
            },
        })).rejects.toMatchObject({ code: "plugin_intent_writable_collections_not_ready" });
        await expect(db.pluginCollectionRow.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { rowId: "asc" },
            select: { schemaVersion: true, revision: true },
        })).resolves.toEqual([
            { schemaVersion: 1, revision: 1 },
            { schemaVersion: 1, revision: 1 },
        ]);
        await retirePluginCollectionCandidatePreparation({
            accountId: ACCOUNT_ID,
            request: { binding: replacedBinding },
        });
        await expect(service.setIntent({
            accountId: ACCOUNT_ID,
            input: {
                pluginId: PLUGIN_ID,
                desiredVersion: targetRelease.version,
                enabled: true,
                offlineUiHosting: "disabled",
                writableCollections: targetContracts,
                expectedRevision: "0",
            },
        })).resolves.toMatchObject({
            intent: { desiredVersion: targetRelease.version, writableCollections: targetContracts, revision: "1" },
        });
        await expect(db.pluginCollectionRow.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { rowId: "asc" },
            select: { rowId: true, schemaVersion: true, revision: true, contractDigest: true, projections: {
                orderBy: { fieldId: "asc" },
                select: { fieldId: true, typedEncodedValue: true, rowRevision: true },
            } },
        })).resolves.toEqual([
            {
                rowId: "task-a",
                schemaVersion: 2,
                revision: 2,
                contractDigest: target.contractDigest,
                projections: [
                    { fieldId: "id", typedEncodedValue: "\"task-a\"", rowRevision: 2 },
                    { fieldId: "status", typedEncodedValue: "\"open\"", rowRevision: 2 },
                    { fieldId: "title", typedEncodedValue: "\"A\"", rowRevision: 2 },
                ],
            },
            {
                rowId: "task-b",
                schemaVersion: 2,
                revision: 2,
                contractDigest: target.contractDigest,
                projections: [
                    { fieldId: "id", typedEncodedValue: "\"task-b\"", rowRevision: 2 },
                    { fieldId: "status", typedEncodedValue: "\"open\"", rowRevision: 2 },
                    { fieldId: "title", typedEncodedValue: "\"B\"", rowRevision: 2 },
                ],
            },
        ]);
        await expect(db.pluginCollectionCandidatePreparationStage.count({
            where: { accountId: ACCOUNT_ID },
        })).resolves.toBe(0);
    });

    it.each(["plain", "e2ee"] as const)(
        "lists every Account intent identity, including release-less ones, in sorted order without fabricating a machine materialization for a %s Account",
        async (encryptionMode) => {
            await seedAccountAndMachine({ encryptionMode });
            const service = operations();
            await service.publishRelease({
                accountId: ACCOUNT_ID,
                input: { facts: releaseFacts(), sourceClass: "registryPackage" },
            });
            await service.publishRelease({
                accountId: ACCOUNT_ID,
                input: {
                    facts: releaseFacts({
                        ref: DISABLED_RELEASE,
                        normalizedManifest: {
                            ...releaseFacts().normalizedManifest,
                            id: DISABLED_PLUGIN_ID,
                        },
                    }),
                    sourceClass: "registryPackage",
                },
            });
            await service.setIntent({
                accountId: ACCOUNT_ID,
                input: {
                    pluginId: PLUGIN_ID,
                    desiredVersion: RELEASE.version,
                    enabled: true,
                    offlineUiHosting: "disabled",
                    writableCollections: [],
                    expectedRevision: null,
                },
            });
            await service.setIntent({
                accountId: ACCOUNT_ID,
                input: {
                    pluginId: DISABLED_PLUGIN_ID,
                    desiredVersion: DISABLED_RELEASE.version,
                    enabled: false,
                    offlineUiHosting: "disabled",
                    writableCollections: [],
                    expectedRevision: null,
                },
            });
            await service.setIntent({
                accountId: ACCOUNT_ID,
                input: {
                    pluginId: "com.acme.unselected",
                    desiredVersion: null,
                    enabled: false,
                    offlineUiHosting: "disabled",
                    writableCollections: [],
                    expectedRevision: null,
                },
            });

            const discovery = await service.listIntentIds({
                accountId: ACCOUNT_ID,
                input: {},
            });
            const materializations = await service.readMaterializations({
                accountId: ACCOUNT_ID,
                input: {},
            });
            const account = await db.account.findUniqueOrThrow({
                where: { id: ACCOUNT_ID },
                select: { seq: true },
            });

            expect(discovery).toEqual({
                availabilityCursor: account.seq,
                pluginIds: [DISABLED_PLUGIN_ID, PLUGIN_ID, "com.acme.unselected"],
                intentReads: await Promise.all([DISABLED_PLUGIN_ID, PLUGIN_ID, "com.acme.unselected"].map(async (pluginId) => ({
                    pluginId,
                    response: await service.readIntent({ accountId: ACCOUNT_ID, input: { pluginId } }),
                }))),
                failedPluginIds: [],
            });
            expect(materializations.snapshots).toEqual([]);
        },
    );

    describe("release-less Collection writer claims", () => {
        const CLAIMED_TASKS_V1 = {
            id: "tasks",
            schemaVersion: 1,
            rowIdField: "id",
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    status: { type: "string", enum: ["closed", "open"] },
                    privateNote: { type: "string", maxLength: 256 },
                },
                required: ["id", "status"],
                additionalProperties: false,
            },
            serverReadable: ["status"],
            indexes: [{ id: "by-status", fields: [{ field: "status", direction: "asc" }] }],
            relations: [],
        } as const;
        const CLAIMED_TASKS_V2 = {
            ...CLAIMED_TASKS_V1,
            schemaVersion: 2,
            readableSchemaVersions: [1, 2],
            migrations: [{ id: "tasks-v1-to-v2", fromSchemaVersion: 1, toSchemaVersion: 2 }],
            // A projected addition needs the callback/stage path, not the
            // existing optional-private-addition identity adoption shortcut.
            serverReadable: ["status", "title"],
            schema: {
                ...CLAIMED_TASKS_V1.schema,
                properties: {
                    ...CLAIMED_TASKS_V1.schema.properties,
                    title: { type: "string", maxLength: 256 },
                },
            },
        } as const;

        function claimedRef(collection: unknown) {
            const [contract] = normalizePluginAccountCollectionContractsV1({
                pluginId: PLUGIN_ID,
                contributions: [PluginAccountCollectionContributionV1Schema.parse(collection)],
            });
            return {
                pluginId: contract!.pluginId,
                collectionId: contract!.collectionId,
                schemaVersion: contract!.schemaVersion,
                contractDigest: contract!.contractDigest,
            };
        }

        function claimManifest(accountCollections: readonly unknown[], version: string = RELEASE.version) {
            return {
                ...releaseFacts().normalizedManifest,
                version,
                contributes: { accountCollections },
            };
        }

        async function readAccountSeq(accountId = ACCOUNT_ID) {
            return (await db.account.findUniqueOrThrow({
                where: { id: accountId },
                select: { seq: true },
            })).seq;
        }

        it("creates a release-less writer pointer that Data admits and Availability discovery lists", async () => {
            await seedAccountAndMachine();
            const service = operations();

            await expect(service.claimCollectionWriters({
                accountId: ACCOUNT_ID,
                input: { manifest: claimManifest([CLAIMED_TASKS_V1]) },
            })).resolves.toEqual({
                intent: {
                    pluginId: PLUGIN_ID,
                    desiredVersion: null,
                    enabled: true,
                    offlineUiHosting: "disabled",
                    writableCollections: [claimedRef(CLAIMED_TASKS_V1)],
                    revision: "0",
                },
            });
            await expect(db.pluginCollectionIndexState.findMany({
                where: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID },
                select: { indexId: true, buildState: true },
            })).resolves.toEqual([{ indexId: "by-status", buildState: "ready" }]);
            await expect(readCurrentPluginCollectionContract({
                accountId: ACCOUNT_ID,
                request: { ref: claimedRef(CLAIMED_TASKS_V1) },
            })).resolves.toMatchObject({ access: "writable" });
            await expect(service.listIntentIds({ accountId: ACCOUNT_ID, input: {} }))
                .resolves.toMatchObject({ pluginIds: [PLUGIN_ID] });
        });

        it("promotes a populated release-less Collection through candidate preparation with retained rows", async () => {
            await seedAccountAndMachine();
            await db.account.update({ where: { id: ACCOUNT_ID }, data: { encryptionMode: "plain" } });
            const service = operations();
            await service.claimCollectionWriters({
                accountId: ACCOUNT_ID,
                input: { manifest: claimManifest([CLAIMED_TASKS_V1]) },
            });
            const source = claimedRef(CLAIMED_TASKS_V1);
            const contract = await db.pluginCollectionContract.findFirstOrThrow({
                where: { pluginId: PLUGIN_ID, collectionId: source.collectionId, contractDigest: source.contractDigest },
                select: { id: true },
            });
            const retained = await db.pluginCollectionRow.create({
                data: {
                    accountId: ACCOUNT_ID, pluginId: PLUGIN_ID, collectionId: source.collectionId,
                    rowId: "retained-task", schemaVersion: source.schemaVersion, revision: 1,
                    contractId: contract.id, contractDigest: source.contractDigest,
                    contentEnvelope: { t: "plain", v: { privateNote: "retained private bytes" } },
                },
            });
            await db.pluginCollectionProjection.createMany({
                data: [
                    { fieldId: "status", typedEncodedValue: JSON.stringify("open") },
                ].map((projection) => ({
                    ...projection, rowDbId: retained.id, accountId: ACCOUNT_ID, pluginId: PLUGIN_ID,
                    collectionId: source.collectionId, rowId: retained.rowId, rowRevision: retained.revision,
                })),
            });

            await expect(service.claimCollectionWriters({
                accountId: ACCOUNT_ID,
                input: { manifest: claimManifest([CLAIMED_TASKS_V2]) },
            })).rejects.toMatchObject({ code: "plugin_intent_writable_collections_not_ready" });
            await expect(db.pluginCollectionRow.findUnique({ where: { id: retained.id } })).resolves.toEqual(retained);
            await expect(service.readIntent({ accountId: ACCOUNT_ID, input: { pluginId: PLUGIN_ID } }))
                .resolves.toMatchObject({ intent: { writableCollections: [source], revision: "0" } });
            await expect(readCurrentPluginCollectionContract({ accountId: ACCOUNT_ID, request: { ref: source } }))
                .resolves.toMatchObject({ access: "writable" });

            const preparation = await service.claimCollectionWriters({
                accountId: ACCOUNT_ID,
                input: { manifest: claimManifest([CLAIMED_TASKS_V2]), prepare: true },
            });
            expect(preparation.intent.writableCollections).toEqual([source]);
            const binding = preparation.preparation![0]!.binding;
            await expect(pagePluginCollectionCandidatePreparationSource({
                accountId: ACCOUNT_ID,
                request: { binding: { ...binding, candidate: { ...binding.candidate, artifactDigest: `sha256:${"f".repeat(64)}` } }, limit: 50 },
            })).rejects.toMatchObject({ code: "collection_candidate_preparation_contract_mismatch" });
            const page = await pagePluginCollectionCandidatePreparationSource({
                accountId: ACCOUNT_ID, request: { binding, limit: 50 },
            });
            expect(page.rows).toHaveLength(1);
            await stagePluginCollectionCandidatePreparation({
                accountId: ACCOUNT_ID,
                request: {
                    binding,
                    items: [{
                        source: { rowId: retained.rowId, revision: retained.revision },
                        target: {
                            content: retained.contentEnvelope,
                            projection: { status: "open", title: null },
                        },
                    }],
                },
            });
            await expect(readCurrentPluginCollectionContract({ accountId: ACCOUNT_ID, request: { ref: source } }))
                .resolves.toMatchObject({ access: "writable" });
            // An old writer can still commit during preparation. Promotion must
            // refuse the obsolete stage atomically, then accept a fresh retry.
            await db.pluginCollectionRow.update({ where: { id: retained.id }, data: { revision: 2 } });
            await db.pluginCollectionProjection.updateMany({ where: { rowDbId: retained.id }, data: { rowRevision: 2 } });
            await expect(service.claimCollectionWriters({ accountId: ACCOUNT_ID, input: { manifest: claimManifest([CLAIMED_TASKS_V2]) } }))
                .rejects.toMatchObject({ code: "plugin_intent_writable_collections_not_ready" });
            await expect(service.readIntent({ accountId: ACCOUNT_ID, input: { pluginId: PLUGIN_ID } }))
                .resolves.toMatchObject({ intent: { writableCollections: [source], revision: "0" } });
            await retirePluginCollectionCandidatePreparation({ accountId: ACCOUNT_ID, request: { binding } });
            await stagePluginCollectionCandidatePreparation({
                accountId: ACCOUNT_ID,
                request: { binding, items: [{ source: { rowId: retained.rowId, revision: 2 }, target: { content: retained.contentEnvelope, projection: { status: "open", title: null } } }] },
            });
            await expect(service.claimCollectionWriters({
                accountId: ACCOUNT_ID, input: { manifest: claimManifest([CLAIMED_TASKS_V2]) },
            })).resolves.toMatchObject({
                intent: { writableCollections: [claimedRef(CLAIMED_TASKS_V2)], revision: "1" },
            });
            const promoted = await db.pluginCollectionRow.findUniqueOrThrow({ where: { id: retained.id } });
            expect(promoted).toMatchObject({ rowId: retained.rowId, schemaVersion: 2, contentEnvelope: retained.contentEnvelope });
            await expect(readCurrentPluginCollectionContract({
                accountId: ACCOUNT_ID, request: { ref: claimedRef(CLAIMED_TASKS_V2) },
            })).resolves.toMatchObject({ access: "writable" });
            await expect(db.pluginCollectionCandidatePreparationStage.count({ where: { accountId: ACCOUNT_ID } }))
                .resolves.toBe(0);
        });

        it("rejoins an identical claim, never lowers a schemaVersion, and refuses an unbumped schema change", async () => {
            await seedAccountAndMachine();
            const service = operations();
            const claim = (collection: unknown, version?: string) => service.claimCollectionWriters({
                accountId: ACCOUNT_ID,
                input: { manifest: claimManifest([collection], version) },
            });

            await claim(CLAIMED_TASKS_V1);
            await expect(claim(CLAIMED_TASKS_V2)).resolves.toMatchObject({
                intent: { writableCollections: [claimedRef(CLAIMED_TASKS_V2)], revision: "1" },
            });
            await expect(readCurrentPluginCollectionContract({
                accountId: ACCOUNT_ID, request: { ref: claimedRef(CLAIMED_TASKS_V2) },
            })).resolves.toMatchObject({ access: "writable" });
            const seqAfterClaim = await readAccountSeq();

            await expect(claim(CLAIMED_TASKS_V2)).resolves.toMatchObject({
                intent: { writableCollections: [claimedRef(CLAIMED_TASKS_V2)], revision: "1" },
            });
            // A lagging machine's lower claim is settled by the monotonic rule:
            // the pointer stays at v2, the newer declaration stays, and nothing
            // semantic changes.
            await expect(claim(CLAIMED_TASKS_V1, "1.2.2")).resolves.toMatchObject({
                intent: { writableCollections: [claimedRef(CLAIMED_TASKS_V2)], revision: "1" },
            });
            await expect(readAccountSeq()).resolves.toBe(seqAfterClaim);

            await expect(claim({
                ...CLAIMED_TASKS_V2,
                relations: [],
                schema: {
                    ...CLAIMED_TASKS_V2.schema,
                    properties: {
                        ...CLAIMED_TASKS_V2.schema.properties,
                        id: { type: "string", maxLength: 128 },
                    },
                },
            })).rejects.toMatchObject({ code: "plugin_collection_contract_conflict" });
            await expect(service.readIntent({
                accountId: ACCOUNT_ID,
                input: { pluginId: PLUGIN_ID },
            })).resolves.toMatchObject({
                intent: { writableCollections: [claimedRef(CLAIMED_TASKS_V2)], revision: "1" },
            });
        });

        it("never overrides a present-user release selection, while the user can select a release over a claim", async () => {
            await seedAccountAndMachine();
            const service = operations();
            const normalizedManifest = {
                ...releaseFacts().normalizedManifest,
                contributes: { accountCollections: [CLAIMED_TASKS_V1] },
            };
            await service.publishRelease({
                accountId: ACCOUNT_ID,
                input: {
                    facts: releaseFacts({
                        normalizedManifest,
                        collectionContracts: [claimedRef(CLAIMED_TASKS_V1)],
                    }),
                    sourceClass: "registryPackage",
                },
            });

            await service.claimCollectionWriters({
                accountId: ACCOUNT_ID,
                input: { manifest: claimManifest([CLAIMED_TASKS_V1]) },
            });
            await expect(service.setIntent({
                accountId: ACCOUNT_ID,
                input: {
                    pluginId: PLUGIN_ID,
                    desiredVersion: RELEASE.version,
                    enabled: true,
                    offlineUiHosting: "disabled",
                    writableCollections: [claimedRef(CLAIMED_TASKS_V1)],
                    expectedRevision: "0",
                },
            })).resolves.toMatchObject({
                intent: { desiredVersion: RELEASE.version, revision: "1" },
            });

            await expect(service.claimCollectionWriters({
                accountId: ACCOUNT_ID,
                input: { manifest: claimManifest([CLAIMED_TASKS_V2]) },
            })).rejects.toMatchObject({ code: "plugin_intent_release_selected" });
            await expect(service.readIntent({
                accountId: ACCOUNT_ID,
                input: { pluginId: PLUGIN_ID },
            })).resolves.toMatchObject({
                intent: {
                    desiredVersion: RELEASE.version,
                    writableCollections: [claimedRef(CLAIMED_TASKS_V1)],
                    revision: "1",
                },
            });
        });

        it("keeps another Account's release from squatting a plugin's Collection identity", async () => {
            await seedAccountAndMachine();
            const squatterAccountId = "account-plugin-availability-squatter";
            await db.account.create({
                data: { id: squatterAccountId, publicKey: null, encryptionMode: "plain" },
            });
            const service = operations();
            const squattingCollection = {
                ...CLAIMED_TASKS_V1,
                schema: {
                    ...CLAIMED_TASKS_V1.schema,
                    properties: {
                        ...CLAIMED_TASKS_V1.schema.properties,
                        id: { type: "string", maxLength: 64 },
                    },
                },
            };
            await service.publishRelease({
                accountId: squatterAccountId,
                input: {
                    facts: releaseFacts({
                        normalizedManifest: {
                            ...releaseFacts().normalizedManifest,
                            contributes: { accountCollections: [squattingCollection] },
                        },
                        collectionContracts: [claimedRef(squattingCollection)],
                    }),
                    sourceClass: "registryPackage",
                },
            });

            await expect(service.claimCollectionWriters({
                accountId: ACCOUNT_ID,
                input: { manifest: claimManifest([CLAIMED_TASKS_V1]) },
            })).resolves.toMatchObject({
                intent: { writableCollections: [claimedRef(CLAIMED_TASKS_V1)] },
            });
        });
    });

    describe("release-less declarations for webhooks and automation Events", () => {
        const DECLARED_VERSION = "2.0.0";
        const MATERIALIZATION_ID = "daemon-selected-materialization";
        const WEBHOOK_LOCAL_ID = "repository-events";
        const EVENT_LOCAL_ID = "repository-event";
        const SOURCE_CONFIG_SCHEMA = { type: "object", additionalProperties: false } as const;
        const BUNDLED_CUSTODY = {
            kind: "bundled_first_party",
            packagedRuntime: { kind: "cli_version_root", versionRootId: "cli-2.0.0" },
        } as const;

        function declaredManifest(version = DECLARED_VERSION, eventTitle = "Repository event") {
            return {
                ...releaseFacts().normalizedManifest,
                version,
                entrypoints: { daemon: "./dist/index.js" },
                contributes: {
                    actions: [{
                        id: "receive-repository-events",
                        title: "Receive repository events",
                        scopes: ["global"],
                        surfaces: ["plugin"],
                        dangerLevel: "safe",
                        execution: { target: "daemon" },
                    }, {
                        id: "setup-repository-source",
                        title: "Set up repository source",
                        scopes: ["global"],
                        surfaces: ["plugin"],
                        dangerLevel: "safe",
                        execution: { target: "daemon" },
                        inputSchema: SOURCE_CONFIG_SCHEMA,
                        resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, SOURCE_CONFIG_SCHEMA),
                    }],
                    webhooks: [{
                        id: WEBHOOK_LOCAL_ID,
                        title: "Repository events",
                        verifier: { kind: "github_hmac_sha256_v1", routing: "accountEndpoint" },
                        handlerAction: { localId: "receive-repository-events" },
                    }],
                    events: [{
                        id: EVENT_LOCAL_ID,
                        kind: "event",
                        title: eventTitle,
                        payloadSchema: { type: "object", additionalProperties: false },
                        automation: {
                            v: 1,
                            eligible: true,
                            source: {
                                sourceContractVersion: 1,
                                supportedObservationTransports: ["checkpointedPull"],
                                sourceConfigSchema: SOURCE_CONFIG_SCHEMA,
                                setupActionRef: { pluginId: PLUGIN_ID, localId: "setup-repository-source" },
                            },
                        },
                    }],
                },
            };
        }

        async function seedWebhookCapableMachine() {
            await seedAccountAndMachine();
            await db.machine.update({
                where: { accountId_id: { accountId: ACCOUNT_ID, id: MACHINE_ID } },
                data: {
                    operationProtocolCapabilities: { pluginWebhookClaim: { protocolVersions: [1] } },
                    operationProtocolCapabilitiesRevision: 1,
                },
            });
        }

        async function reportMaterialization(
            service: ReturnType<typeof operations>,
            materialization: Readonly<{
                sourceClass: "bundledFirstParty" | "localPath" | "registryPackage";
                version: string;
                archiveDigestSha256?: string;
            }>,
        ) {
            const portableRelease = materialization.sourceClass === "registryPackage";
            const { pluginMaterializationRevision } = await db.machine.findUniqueOrThrow({
                where: { accountId_id: { accountId: ACCOUNT_ID, id: MACHINE_ID } },
                select: { pluginMaterializationRevision: true },
            });
            await service.reportMaterializations({
                accountId: ACCOUNT_ID,
                publisherMachineId: MACHINE_ID,
                input: {
                    expectedRevision: pluginMaterializationRevision === null
                        ? null
                        : Number(pluginMaterializationRevision),
                    snapshot: {
                        serverIdentityId: SERVER_IDENTITY_ID,
                        machineId: MACHINE_ID,
                        materializations: [{
                            serverIdentityId: SERVER_IDENTITY_ID,
                            machineId: MACHINE_ID,
                            materializationId: MATERIALIZATION_ID,
                            pluginId: PLUGIN_ID,
                            version: materialization.version,
                            sourceClass: materialization.sourceClass,
                            portableRelease,
                            ...(materialization.archiveDigestSha256
                                ? { archiveDigestSha256: materialization.archiveDigestSha256 }
                                : {}),
                            uiArtifacts: [],
                            enabled: true,
                            trustState: "trusted" as const,
                            observedAt: 1_700_000_000_000,
                        }],
                    },
                },
            });
        }

        const TARGET = {
            materialization: { machineId: MACHINE_ID, materializationId: MATERIALIZATION_ID, pluginId: PLUGIN_ID },
            machineInstallationId: "machine-installation-availability",
        } as const;
        const CALLER = {
            pluginId: PLUGIN_ID,
            machineId: MACHINE_ID,
            machineInstallationId: "machine-installation-availability",
            materializationId: MATERIALIZATION_ID,
            sourceCustody: BUNDLED_CUSTODY,
        } as const;

        async function readCurrentness(version: string) {
            return await inTx(async (tx) => {
                const materialization = await resolveCurrentClaimablePluginMachineMaterializationTx({
                    tx,
                    accountId: ACCOUNT_ID,
                    serverIdentityId: SERVER_IDENTITY_ID,
                    machineId: MACHINE_ID,
                    machineInstallationId: TARGET.machineInstallationId,
                    materializationId: MATERIALIZATION_ID,
                    pluginId: PLUGIN_ID,
                    version,
                    requiredMachineOperationCapability: "pluginWebhookClaim",
                });
                const webhook = await resolveCurrentPluginWebhookContributionTxV1({
                    tx,
                    accountId: ACCOUNT_ID,
                    contribution: { pluginId: PLUGIN_ID, localId: WEBHOOK_LOCAL_ID },
                    target: { ...TARGET, pluginVersion: version },
                });
                const claimAuthorities = await resolveCurrentPluginWebhookClaimAuthoritiesTxV1({
                    tx,
                    accountId: ACCOUNT_ID,
                    targets: [{ materializationId: MATERIALIZATION_ID, pluginId: PLUGIN_ID, version }],
                });
                return { materialization, webhook, claimAuthorities };
            });
        }

        async function readEventCurrentness() {
            return await inTx(async (tx) => {
                const caller = await assertCurrentAutomationEventCallerMaterializationTx({
                    tx,
                    accountId: ACCOUNT_ID,
                    serverIdentityId: SERVER_IDENTITY_ID,
                    caller: CALLER,
                });
                const event = await resolveCurrentAutomationEventContributionTx({
                    tx,
                    accountId: ACCOUNT_ID,
                    pluginId: PLUGIN_ID,
                    version: caller.version,
                    eventLocalId: EVENT_LOCAL_ID,
                    sourceContractVersion: 1,
                });
                return { caller, event };
            });
        }

        it.each([
            ["bundled first-party", "bundledFirstParty"],
            ["development", "localPath"],
        ] as const)("admits a %s plugin's webhook and automation Event through its release-less claim", async (_label, sourceClass) => {
            await seedWebhookCapableMachine();
            const service = operations();
            await service.claimCollectionWriters({
                accountId: ACCOUNT_ID,
                input: { manifest: declaredManifest() },
            });
            await reportMaterialization(service, { sourceClass, version: DECLARED_VERSION });

            const current = await readCurrentness(DECLARED_VERSION);
            expect(current.materialization).toMatchObject({
                kind: "current",
                materialization: { materializationId: MATERIALIZATION_ID, sourceClass },
            });
            expect(current.webhook).toMatchObject({ pluginId: PLUGIN_ID, localId: WEBHOOK_LOCAL_ID });
            expect(current.claimAuthorities).toMatchObject([{
                materializationId: MATERIALIZATION_ID,
                contribution: { localId: WEBHOOK_LOCAL_ID },
            }]);
            const first = await readEventCurrentness();
            expect(first.caller.eventDeclarationRelease).toEqual({
                release: { pluginId: PLUGIN_ID, version: DECLARED_VERSION },
                archiveDigestSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
            });
            expect(first.event).toMatchObject({ id: EVENT_LOCAL_ID, kind: "event" });

            // A development edit that keeps its version re-claims in place, and
            // the Event declaration identity follows the new declaration.
            await service.claimCollectionWriters({
                accountId: ACCOUNT_ID,
                input: { manifest: declaredManifest(DECLARED_VERSION, "Edited repository event") },
            });
            const edited = await readEventCurrentness();
            expect(edited.event).toMatchObject({ title: "Edited repository event" });
            expect(edited.caller.eventDeclarationRelease.archiveDigestSha256)
                .not.toBe(first.caller.eventDeclarationRelease.archiveDigestSha256);
        });

        it("refuses a daemon-selected materialization whose version differs from the claimed declaration", async () => {
            await seedWebhookCapableMachine();
            const service = operations();
            await service.claimCollectionWriters({
                accountId: ACCOUNT_ID,
                input: { manifest: declaredManifest() },
            });
            await reportMaterialization(service, { sourceClass: "bundledFirstParty", version: "2.0.1" });

            await expect(readCurrentness("2.0.1")).resolves.toEqual({
                materialization: { kind: "notCurrent" },
                webhook: null,
                claimAuthorities: [],
            });
            await expect(readEventCurrentness()).rejects.toMatchObject({
                code: "caller_materialization_not_current",
            });

            // A lagging machine's lower claim never replaces the newer declaration.
            await reportMaterialization(service, { sourceClass: "bundledFirstParty", version: DECLARED_VERSION });
            await service.claimCollectionWriters({
                accountId: ACCOUNT_ID,
                input: { manifest: declaredManifest("1.9.0") },
            });
            await expect(readCurrentness(DECLARED_VERSION)).resolves.toMatchObject({
                materialization: { kind: "current" },
            });
        });

        it("lets a user-selected release win over the release-less claim", async () => {
            await seedWebhookCapableMachine();
            const service = operations();
            await service.claimCollectionWriters({
                accountId: ACCOUNT_ID,
                input: { manifest: declaredManifest() },
            });
            await reportMaterialization(service, { sourceClass: "bundledFirstParty", version: DECLARED_VERSION });
            const facts = releaseFacts({
                normalizedManifest: declaredManifest(RELEASE.version),
                uiSlots: [],
            });
            await service.publishRelease({
                accountId: ACCOUNT_ID,
                input: { facts, sourceClass: "registryPackage" },
            });
            await service.setIntent({
                accountId: ACCOUNT_ID,
                input: {
                    pluginId: PLUGIN_ID,
                    desiredVersion: RELEASE.version,
                    enabled: true,
                    offlineUiHosting: "disabled",
                    writableCollections: [],
                    expectedRevision: "0",
                },
            });

            await expect(readCurrentness(DECLARED_VERSION)).resolves.toEqual({
                materialization: { kind: "notCurrent" },
                webhook: null,
                claimAuthorities: [],
            });
            await expect(service.claimCollectionWriters({
                accountId: ACCOUNT_ID,
                input: { manifest: declaredManifest() },
            })).rejects.toMatchObject({ code: "plugin_intent_release_selected" });

            await reportMaterialization(service, {
                sourceClass: "registryPackage",
                version: RELEASE.version,
                archiveDigestSha256: facts.archiveDigestSha256,
            });
            await expect(readCurrentness(RELEASE.version)).resolves.toMatchObject({
                materialization: { kind: "current" },
                webhook: { localId: WEBHOOK_LOCAL_ID },
            });
            await expect(readEventCurrentness()).resolves.toMatchObject({
                caller: {
                    eventDeclarationRelease: {
                        release: RELEASE,
                        archiveDigestSha256: facts.archiveDigestSha256,
                    },
                },
            });
        });
    });

    it("pages every Account intent and caller-known deletion beyond the former total and byte limits", async () => {
        await seedAccountAndMachine();
        const ids = Array.from({ length: 401 }, (_, index) =>
            `com.acme.${'x'.repeat(170)}-${String(index).padStart(3, '0')}`);
        await db.accountPluginIntent.createMany({
            data: ids.map(pluginId => ({
                accountId: ACCOUNT_ID,
                pluginId,
                desiredVersion: null,
                enabled: false,
                offlineUiHosting: "disabled",
                writableCollections: [],
            })),
        });

        const service = operations();
        const deletedIds = ['com.acme.aa-deleted', `${ids[200]}-deleted`, 'com.acme.zz-deleted'];
        const reads: string[] = [];
        let cursor: string | null = null;
        do {
            const page = await service.listIntentIds({ accountId: ACCOUNT_ID,
                input: { knownPluginIds: [...deletedIds, ids[200]!], ...(cursor ? { cursor } : {}) } });
            expect(page.failedPluginIds).toEqual([]);
            reads.push(...page.intentReads.map(entry => entry.pluginId));
            cursor = page.nextCursor ?? null;
        } while (cursor);
        expect(reads).toEqual([...ids, ...deletedIds].sort());
    });

    it("replaces only a newer complete machine inventory and retains the high-watermark for an accepted empty snapshot", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const materialization = {
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId: MACHINE_ID,
            materializationId: "install-epoch-1",
            pluginId: PLUGIN_ID,
            version: RELEASE.version,
            sourceClass: "registryPackage" as const,
            portableRelease: true,
            uiArtifacts: [],
            enabled: true,
            trustState: "trusted" as const,
            observedAt: 1_700_000_000_000,
        };
        const first = {
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId: MACHINE_ID,
            materializations: [materialization],
        };

        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: { expectedRevision: null, snapshot: first },
        })).resolves.toMatchObject({ outcome: "replaced" });
        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: { expectedRevision: 1, snapshot: first },
        })).resolves.toMatchObject({ outcome: "rejoined" });
        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: {
                expectedRevision: 0,
                snapshot: {
                    ...first,
                    materializations: [{ ...materialization, version: "1.2.4" }],
                },
            },
        })).resolves.toMatchObject({ outcome: "conflict", revision: 1 });
        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: {
                expectedRevision: 1,
                snapshot: {
                    serverIdentityId: SERVER_IDENTITY_ID,
                    machineId: MACHINE_ID,
                    materializations: [],
                },
            },
        })).resolves.toMatchObject({ outcome: "replaced" });

        await expect(db.machine.findUnique({
            where: { id: MACHINE_ID },
            select: { pluginMaterializationRevision: true },
        })).resolves.toEqual({ pluginMaterializationRevision: BigInt(2) });
        await expect(db.pluginMachineMaterialization.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(0);
    });

    it("rejoins descriptor-bearing reports from fresh reporter lifetimes without revising installation facts", async () => {
        await seedAccountAndMachine();
        const cliHome = join(harness.baseDir, "reporter-home");
        process.env.HAPPIER_HOME_DIR = cliHome;
        process.env.HAPPIER_SERVER_URL = "http://127.0.0.1:1";
        const { configuration } = await vi.importActual<{ configuration: { happyHomeDir: string } }>("../../../../../cli/src/configuration");
        expect(configuration.happyHomeDir).toBe(cliHome);
        // Each lifetime starts without an acknowledged CAS token. Descriptors
        // remain live daemon facts and never round-trip through server storage.
        const freshReport = (enabled = true) => ({
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId: MACHINE_ID,
            materializations: [{
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: "daemon-selected:fixture",
                pluginId: PLUGIN_ID,
                version: RELEASE.version,
                sourceClass: "localPath" as const,
                portableRelease: false,
                declaredManifest: releaseFacts().normalizedManifest,
                declaredUiEntries: {},
                uiArtifacts: [],
                enabled,
                trustState: "trusted" as const,
                observedAt: 1_700_000_000_000,
            }],
        });
        const report = (expectedRevision: number | null, enabled = true) => operations().reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: { expectedRevision, snapshot: freshReport(enabled) },
        });
        const outcomes: PluginAvailabilityMaterializationsReportActionOutputV1[] = [];
        const originalAdapter = axios.defaults.adapter;
        const inventory = (enabled = true) => ({ revision: 1, releasePublications: [], materializations: freshReport(enabled).materializations });
        // Nearest-project Vitest resolution loads the real CLI source. This
        // test-only exercised boundary avoids applying Server TS aliases to CLI.
        const { createDaemonPluginAvailabilityReporter } = await vi.importActual<{
            createDaemonPluginAvailabilityReporter: (params: Readonly<{
                credentials: { token: string; encryption: null };
                serverFeaturesSnapshotStore: { getSnapshot: () => { status: "ready"; features: FeaturesResponse } };
                getMachineId: () => string;
            }>) => Readonly<{ report: (input: ReturnType<typeof inventory>) => Promise<void> }>;
        }>("../../../../../cli/src/plugins/availability/daemonReporter");
        const freshReporter = () => createDaemonPluginAvailabilityReporter({
            credentials: { token: "disposable-test-account", encryption: null },
            serverFeaturesSnapshotStore: { getSnapshot: () => ({
                status: "ready",
                // This transport fixture supplies only the identity the real
                // reporter reads; it is not a feature/domain implementation.
                features: { capabilities: { serverIdentity: { serverIdentityId: SERVER_IDENTITY_ID } } } as unknown as FeaturesResponse,
            }) },
            getMachineId: () => MACHINE_ID,
        });
        // Only HTTP is substituted: real CLI reporter/publisher, Protocol
        // admission, server reconciliation and disposable SQLite remain live.
        axios.defaults.adapter = async (config) => {
            expect(config.url).toContain(PluginAvailabilityActionHttpPathsV1["account.plugins.availability.materializations.report"]);
            const input = PluginAvailabilityMaterializationsReportActionInputV1Schema.parse(JSON.parse(config.data));
            const result = await operations().reportMaterializations({ accountId: ACCOUNT_ID, publisherMachineId: MACHINE_ID, input });
            outcomes.push(result);
            return { data: result, status: 200, statusText: "OK", headers: {}, config };
        };
        try {
            await freshReporter().report(inventory());
            expect(outcomes).toEqual([{ outcome: "replaced", revision: 1 }]);
            const before = await db.accountChange.findMany({ where: { accountId: ACCOUNT_ID } });
            await freshReporter().report(inventory());
            expect(outcomes).toEqual([{ outcome: "replaced", revision: 1 }, { outcome: "rejoined", revision: 1 }]);
            await expect(db.accountChange.findMany({ where: { accountId: ACCOUNT_ID } })).resolves.toEqual(before);
            await freshReporter().report(inventory(false));
            expect(outcomes.slice(2)).toEqual([{ outcome: "conflict", revision: 1 }, { outcome: "replaced", revision: 2 }]);
        } finally {
            axios.defaults.adapter = originalAdapter;
        }
        // Descriptor-bearing input from an earlier reporter remains accepted,
        // and is compared only against facts the server actually persists.
        await expect(report(null, false)).resolves.toEqual({ outcome: "rejoined", revision: 2 });
        await expect(db.machine.findUnique({ where: { id: MACHINE_ID }, select: { pluginMaterializationRevision: true } }))
            .resolves.toEqual({ pluginMaterializationRevision: BigInt(2) });
        const read = await operations().readMaterializations({ accountId: ACCOUNT_ID, input: {} });
        expect(read.snapshots[0]?.materializations[0]).not.toHaveProperty("declaredManifest");
        expect(read.snapshots[0]?.materializations[0]).not.toHaveProperty("declaredUiEntries");
        await expect(db.pluginMachineMaterialization.findFirst({
            where: { accountId: ACCOUNT_ID, machineId: MACHINE_ID }, select: { enabled: true },
        })).resolves.toEqual({ enabled: false });
        await expect(db.accountChange.findMany({ where: { accountId: ACCOUNT_ID }, select: { cursor: true } }))
            .resolves.toEqual([{ cursor: 2 }]);
    });

    it("lets a current full-body report replace an unreadable refreshable projection without weakening CAS", async () => {
        await seedAccountAndMachine();
        await db.machine.update({
            where: { id: MACHINE_ID },
            data: { pluginMaterializationRevision: BigInt(1) },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: "install-epoch-1",
                pluginId: PLUGIN_ID,
                version: RELEASE.version,
                sourceClass: "bundledFirstParty",
                portableRelease: true,
                archiveDigestSha256: `sha256:${"a".repeat(64)}`,
                uiArtifacts: [{
                    contributionId: "hosted",
                    tier: "hostedWeb",
                    platform: "web",
                    artifactDigest: `sha256:${"b".repeat(64)}`,
                }],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date(1_700_000_000_000),
            },
        });
        const service = operations();
        const currentSnapshot = {
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId: MACHINE_ID,
            materializations: [{
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: "install-epoch-1",
                pluginId: PLUGIN_ID,
                version: RELEASE.version,
                sourceClass: "registryPackage" as const,
                portableRelease: true,
                archiveDigestSha256: `sha256:${"a".repeat(64)}`,
                uiArtifacts: [{
                    contributionId: "hosted",
                    artifactId: "hosted",
                    tier: "hostedWeb" as const,
                    platform: "web" as const,
                    artifactDigest: `sha256:${"b".repeat(64)}`,
                    hostUiApiRange: "^1.0.0",
                }],
                enabled: true,
                trustState: "trusted" as const,
                observedAt: 1_700_000_001_000,
            }],
        };

        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: { expectedRevision: null, snapshot: currentSnapshot },
        })).resolves.toEqual({ outcome: "conflict", revision: 1 });
        await expect(db.pluginMachineMaterialization.findFirstOrThrow({
            where: { accountId: ACCOUNT_ID, machineId: MACHINE_ID },
            select: { sourceClass: true, uiArtifacts: true },
        })).resolves.toMatchObject({ sourceClass: "bundledFirstParty" });

        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: { expectedRevision: 1, snapshot: currentSnapshot },
        })).resolves.toEqual({ outcome: "replaced", revision: 2 });
        await expect(service.readMaterializations({
            accountId: ACCOUNT_ID,
            input: {},
        })).resolves.toMatchObject({
            snapshots: [{
                machineId: MACHINE_ID,
                materializations: [{
                    materializationId: "install-epoch-1",
                    sourceClass: "registryPackage",
                    uiArtifacts: [{ artifactId: "hosted", hostUiApiRange: "^1.0.0" }],
                }],
            }],
        });
        await expect(db.accountChange.findMany({
            where: { accountId: ACCOUNT_ID, kind: "pluginDomain" },
            select: { cursor: true, hint: true },
        })).resolves.toEqual([{
            cursor: 1,
            hint: { pluginDomain: "availability", pluginId: PLUGIN_ID },
        }]);
    });

    it("keeps valid machine availability readable when an offline machine has unreadable projection rows", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const validMaterialization = {
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId: MACHINE_ID,
            materializationId: "install-epoch-current",
            pluginId: PLUGIN_ID,
            version: RELEASE.version,
            sourceClass: "registryPackage" as const,
            portableRelease: true,
            archiveDigestSha256: `sha256:${"a".repeat(64)}`,
            uiArtifacts: [],
            enabled: true,
            trustState: "trusted" as const,
            observedAt: 1_700_000_001_000,
        };
        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: {
                expectedRevision: null,
                snapshot: {
                    serverIdentityId: SERVER_IDENTITY_ID,
                    machineId: MACHINE_ID,
                    materializations: [validMaterialization],
                },
            },
        })).resolves.toMatchObject({ outcome: "replaced", revision: 1 });

        const offlineMachineId = "machine-plugin-availability-offline";
        await db.machine.create({
            data: {
                id: offlineMachineId,
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: "machine-installation-availability-offline",
                pluginMaterializationRevision: BigInt(7),
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: offlineMachineId,
                materializationId: "install-epoch-offline",
                pluginId: DISABLED_PLUGIN_ID,
                version: DISABLED_RELEASE.version,
                // A machine-bound local path can never claim a portable release.
                sourceClass: "localPath",
                portableRelease: true,
                archiveDigestSha256: null,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date(1_700_000_000_000),
            },
        });

        const result = await service.readMaterializations({
            accountId: ACCOUNT_ID,
            input: {},
        });
        expect(result).toHaveProperty("inventoryComplete", false);
        expect(result.snapshots.map((snapshot) => ({
            machineId: snapshot.machineId,
            pluginIds: snapshot.materializations.map((row) => row.pluginId),
        }))).toEqual([{
            machineId: MACHINE_ID,
            pluginIds: [PLUGIN_ID],
        }]);
    });

    it("omits revoked and replaced machines from Account materialization availability, matching the claim rule", async () => {
        await seedAccountAndMachine();
        const service = operations();
        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: {
                expectedRevision: null,
                snapshot: {
                    serverIdentityId: SERVER_IDENTITY_ID,
                    machineId: MACHINE_ID,
                    materializations: [{
                        serverIdentityId: SERVER_IDENTITY_ID,
                        machineId: MACHINE_ID,
                        materializationId: "install-epoch-current",
                        pluginId: PLUGIN_ID,
                        version: RELEASE.version,
                        sourceClass: "registryPackage" as const,
                        portableRelease: true,
                        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
                        uiArtifacts: [],
                        enabled: true,
                        trustState: "trusted" as const,
                        observedAt: 1_700_000_001_000,
                    }],
                },
            },
        })).resolves.toMatchObject({ outcome: "replaced" });

        const retiredMachines = [
            { id: "machine-plugin-availability-revoked", data: { revokedAt: new Date(1_700_000_002_000) } },
            { id: "machine-plugin-availability-replaced", data: { replacedByMachineId: MACHINE_ID } },
        ] as const;
        for (const retired of retiredMachines) {
            await db.machine.create({
                data: {
                    id: retired.id,
                    accountId: ACCOUNT_ID,
                    metadata: "{}",
                    installationId: `${retired.id}-installation`,
                    pluginMaterializationRevision: BigInt(3),
                    ...retired.data,
                },
            });
            await db.pluginMachineMaterialization.create({
                data: {
                    accountId: ACCOUNT_ID,
                    serverIdentityId: SERVER_IDENTITY_ID,
                    machineId: retired.id,
                    materializationId: `${retired.id}-epoch`,
                    pluginId: PLUGIN_ID,
                    version: RELEASE.version,
                    sourceClass: "registryPackage",
                    portableRelease: true,
                    archiveDigestSha256: `sha256:${"a".repeat(64)}`,
                    uiArtifacts: [],
                    enabled: true,
                    trustState: "trusted",
                    observedAt: new Date(1_700_000_000_000),
                },
            });
        }

        const result = await service.readMaterializations({
            accountId: ACCOUNT_ID,
            input: {},
        });
        expect(result.snapshots.map((snapshot) => snapshot.machineId)).toEqual([MACHINE_ID]);
    });

    it("hints only plugin materializations whose effective rows changed", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const materialization = (input: Readonly<{
            materializationId: string;
            pluginId: string;
            version?: string;
        }>) => ({
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId: MACHINE_ID,
            materializationId: input.materializationId,
            pluginId: input.pluginId,
            version: input.version ?? RELEASE.version,
            sourceClass: "registryPackage" as const,
            portableRelease: true,
            uiArtifacts: [],
            enabled: true,
            trustState: "trusted" as const,
            observedAt: 1_700_000_000_000,
        });
        const unchangedY = materialization({
            materializationId: "install-epoch-y",
            pluginId: DISABLED_PLUGIN_ID,
        });
        const x = materialization({
            materializationId: "install-epoch-x",
            pluginId: PLUGIN_ID,
        });
        const readChanges = () => db.accountChange.findMany({
            where: { accountId: ACCOUNT_ID, kind: "pluginDomain" },
            orderBy: { entityId: "asc" },
            select: { entityId: true, cursor: true, hint: true },
        });
        const expectChanges = async (expected: readonly Readonly<{
            pluginId: string;
            cursor: number;
        }>[]) => {
            await expect(readChanges()).resolves.toEqual(expected.map(({ pluginId, cursor }) => ({
                entityId: `pluginDomain/${pluginId}/availability`,
                cursor,
                hint: { pluginDomain: "availability", pluginId },
            })));
        };
        const report = async (
            expectedRevision: number | null,
            materializations: readonly ReturnType<typeof materialization>[],
        ) => await service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: {
                expectedRevision,
                snapshot: {
                    serverIdentityId: SERVER_IDENTITY_ID,
                    machineId: MACHINE_ID,
                    materializations,
                },
            },
        });

        await expect(report(null, [unchangedY])).resolves.toMatchObject({ outcome: "replaced", revision: 1 });
        await expectChanges([{ pluginId: DISABLED_PLUGIN_ID, cursor: 1 }]);

        // Adding X to the newer full snapshot does not republish unchanged Y.
        await expect(report(1, [unchangedY, x])).resolves.toMatchObject({ outcome: "replaced", revision: 2 });
        await expectChanges([
            { pluginId: DISABLED_PLUGIN_ID, cursor: 1 },
            { pluginId: PLUGIN_ID, cursor: 2 },
        ]);

        // A changed X still leaves Y's prior hint untouched even when the
        // reporter changes the input ordering.
        await expect(report(2, [{ ...x, version: "1.2.4" }, unchangedY]))
            .resolves.toMatchObject({ outcome: "replaced" });
        await expectChanges([
            { pluginId: DISABLED_PLUGIN_ID, cursor: 1 },
            { pluginId: PLUGIN_ID, cursor: 3 },
        ]);

        // Omitting X from a newer full snapshot removes it and therefore
        // republishes X, without republishing the retained Y row.
        await expect(report(3, [unchangedY])).resolves.toMatchObject({ outcome: "replaced" });
        await expectChanges([
            { pluginId: DISABLED_PLUGIN_ID, cursor: 1 },
            { pluginId: PLUGIN_ID, cursor: 4 },
        ]);

        // An equal complete body rejoins without changing either server revision
        // or Account semantic availability.
        await expect(report(4, [unchangedY])).resolves.toMatchObject({ outcome: "rejoined", revision: 4 });
        await expectChanges([
            { pluginId: DISABLED_PLUGIN_ID, cursor: 1 },
            { pluginId: PLUGIN_ID, cursor: 4 },
        ]);
        await expect(db.account.findUnique({
            where: { id: ACCOUNT_ID },
            select: { seq: true },
        })).resolves.toEqual({ seq: 4 });
        await expect(db.machine.findUnique({
            where: { id: MACHINE_ID },
            select: { pluginMaterializationRevision: true },
        })).resolves.toEqual({ pluginMaterializationRevision: BigInt(4) });
    });

    it("rejoins a two-plugin snapshot when only observation timestamps advance", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const observedAtT1 = 1_700_000_000_000;
        const observedAtT2 = observedAtT1 + 1_000;
        const materializations = [
            {
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: "install-epoch-x",
                pluginId: PLUGIN_ID,
                version: String(RELEASE.version),
                sourceClass: "registryPackage" as const,
                portableRelease: true,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted" as const,
                observedAt: observedAtT1,
            },
            {
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: "install-epoch-y",
                pluginId: DISABLED_PLUGIN_ID,
                version: String(DISABLED_RELEASE.version),
                sourceClass: "registryPackage" as const,
                portableRelease: true,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted" as const,
                observedAt: observedAtT1,
            },
        ];
        const snapshot = (rows: typeof materializations) => ({
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId: MACHINE_ID,
            materializations: rows,
        });

        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: { expectedRevision: null, snapshot: snapshot(materializations) },
        })).resolves.toMatchObject({ outcome: "replaced", revision: 1 });
        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: {
                expectedRevision: 1,
                snapshot: snapshot(materializations.map((row) => ({ ...row, observedAt: observedAtT2 }))),
            },
        })).resolves.toMatchObject({ outcome: "rejoined", revision: 1 });

        await expect(db.machine.findUnique({
            where: { id: MACHINE_ID },
            select: { pluginMaterializationRevision: true },
        })).resolves.toEqual({ pluginMaterializationRevision: BigInt(1) });
        await expect(db.account.findUnique({
            where: { id: ACCOUNT_ID },
            select: { seq: true },
        })).resolves.toEqual({ seq: 2 });
        await expect(db.pluginMachineMaterialization.findMany({
            where: { accountId: ACCOUNT_ID, machineId: MACHINE_ID },
            orderBy: { materializationId: "asc" },
            select: { materializationId: true, observedAt: true },
        })).resolves.toEqual(materializations.map((row) => ({
            materializationId: row.materializationId,
            observedAt: new Date(observedAtT1),
        })));
    });

    it("changes only the semantic row and retains the sibling observation timestamp", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const observedAtT1 = 1_700_000_000_000;
        const observedAtT2 = observedAtT1 + 1_000;
        const initial = [
            {
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: "install-epoch-x",
                pluginId: PLUGIN_ID,
                version: String(RELEASE.version),
                sourceClass: "registryPackage" as const,
                portableRelease: true,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted" as const,
                observedAt: observedAtT1,
            },
            {
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: "install-epoch-y",
                pluginId: DISABLED_PLUGIN_ID,
                version: String(DISABLED_RELEASE.version),
                sourceClass: "registryPackage" as const,
                portableRelease: true,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted" as const,
                observedAt: observedAtT1,
            },
        ];
        const report = async (
            expectedRevision: number | null,
            rows: typeof initial,
        ) => await service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: {
                expectedRevision,
                snapshot: {
                    serverIdentityId: SERVER_IDENTITY_ID,
                    machineId: MACHINE_ID,
                    materializations: rows,
                },
            },
        });

        await expect(report(null, initial)).resolves.toMatchObject({ outcome: "replaced", revision: 1 });
        await expect(report(1, initial.map((row) => ({
            ...row,
            ...(row.materializationId === "install-epoch-x" ? { version: "1.2.4" } : {}),
            observedAt: observedAtT2,
        })))).resolves.toMatchObject({ outcome: "replaced", revision: 2 });

        await expect(db.pluginMachineMaterialization.findMany({
            where: { accountId: ACCOUNT_ID, machineId: MACHINE_ID },
            orderBy: { materializationId: "asc" },
            select: { materializationId: true, version: true, observedAt: true },
        })).resolves.toEqual([
            { materializationId: "install-epoch-x", version: "1.2.4", observedAt: new Date(observedAtT2) },
            { materializationId: "install-epoch-y", version: DISABLED_RELEASE.version, observedAt: new Date(observedAtT1) },
        ]);
        await expect(db.accountChange.findMany({
            where: { accountId: ACCOUNT_ID, kind: "pluginDomain" },
            orderBy: { cursor: "asc" },
            select: { cursor: true, hint: true },
        })).resolves.toEqual([
            { cursor: 1, hint: { pluginDomain: "availability", pluginId: DISABLED_PLUGIN_ID } },
            { cursor: 3, hint: { pluginDomain: "availability", pluginId: PLUGIN_ID } },
        ]);
        await expect(db.account.findUnique({
            where: { id: ACCOUNT_ID },
            select: { seq: true },
        })).resolves.toEqual({ seq: 3 });
    });

    it("deletes source and catalog status only for a materialization removed by an accepted snapshot replacement", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const removedMaterializationId = "install-epoch-removed";
        const retainedMaterializationId = "install-epoch-retained";
        const materialization = (input: Readonly<{
            materializationId: string;
            pluginId: string;
        }>) => ({
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId: MACHINE_ID,
            materializationId: input.materializationId,
            pluginId: input.pluginId,
            version: RELEASE.version,
            sourceClass: "registryPackage" as const,
            portableRelease: true,
            uiArtifacts: [],
            enabled: true,
            trustState: "trusted" as const,
            observedAt: 1_700_000_000_000,
        });
        const removed = materialization({
            materializationId: removedMaterializationId,
            pluginId: PLUGIN_ID,
        });
        const retained = materialization({
            materializationId: retainedMaterializationId,
            pluginId: DISABLED_PLUGIN_ID,
        });
        await service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: {
                expectedRevision: null,
                snapshot: {
                    serverIdentityId: SERVER_IDENTITY_ID,
                    machineId: MACHINE_ID,
                    materializations: [removed, retained],
                },
            },
        });

        const triggerIds = ["removed-materialization-trigger", "retained-materialization-trigger"];
        await db.automation.create({
            data: {
                id: "materialization-status-automation",
                accountId: ACCOUNT_ID,
                name: "Materialization status lifecycle",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: "{}",
                templateVersion: 1,
                triggers: {
                    create: triggerIds.map((id, index) => ({
                        id,
                        kind: "pluginEvent" as const,
                        enabled: true,
                        revision: 0,
                        eventPluginId: index === 0 ? PLUGIN_ID : DISABLED_PLUGIN_ID,
                        eventLocalId: "fixture-event",
                        sourceSelectorId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
                        sourceContractVersion: 1,
                        observationTransport: "checkpointedPull" as const,
                        watcherMachineId: MACHINE_ID,
                        watcherMachineInstallationId: "machine-installation-availability",
                        watcherPluginId: index === 0 ? PLUGIN_ID : DISABLED_PLUGIN_ID,
                        watcherMaterializationId: index === 0
                            ? removedMaterializationId
                            : retainedMaterializationId,
                        definitionEnvelope: "{}",
                    })),
                },
            },
        });
        for (const [index, materializationId] of [
            removedMaterializationId,
            retainedMaterializationId,
        ].entries()) {
            const eventPluginId = index === 0 ? PLUGIN_ID : DISABLED_PLUGIN_ID;
            await db.automationEventSourceStatus.create({
                data: {
                    triggerId: triggerIds[index]!,
                    eventPluginId,
                    eventLocalId: "fixture-event",
                    sourceSelectorId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
                    triggerRevision: 0,
                    reporterMachineId: MACHINE_ID,
                    reporterMachineInstallationId: "machine-installation-availability",
                    reporterMaterializationId: materializationId,
                    reporterSourceCustody: { kind: "development", registeredRootId: `generation-${index}` },
                    state: "observing",
                },
            });
            await db.automationEventSourceCatalogStatus.create({
                data: {
                    accountId: ACCOUNT_ID,
                    eventPluginId,
                    reporterMachineId: MACHINE_ID,
                    reporterMachineInstallationId: "machine-installation-availability",
                    reporterMaterializationId: materializationId,
                    reporterSourceCustody: { kind: "development", registeredRootId: `generation-${index}` },
                    scopeKey: "checkpointedPull",
                    observedRevision: 1n,
                    adoptedRevision: 1n,
                    state: "current",
                    reportedAt: new Date(),
                },
            });
        }

        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: {
                expectedRevision: 1,
                snapshot: {
                    serverIdentityId: SERVER_IDENTITY_ID,
                    machineId: MACHINE_ID,
                    materializations: [retained],
                },
            },
        })).resolves.toMatchObject({ outcome: "replaced" });

        await expect(db.automationEventSourceStatus.findMany({
            select: { reporterMaterializationId: true },
        })).resolves.toEqual([{ reporterMaterializationId: retainedMaterializationId }]);
        await expect(db.automationEventSourceCatalogStatus.findMany({
            select: { reporterMaterializationId: true },
        })).resolves.toEqual([{ reporterMaterializationId: retainedMaterializationId }]);
    });

    it("refuses a machine inventory published by another machine or under another server identity", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const materialization = {
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId: MACHINE_ID,
            materializationId: "install-epoch-1",
            pluginId: PLUGIN_ID,
            version: RELEASE.version,
            sourceClass: "registryPackage" as const,
            portableRelease: true,
            uiArtifacts: [],
            enabled: true,
            trustState: "trusted" as const,
            observedAt: 1_700_000_000_000,
        };
        const snapshot = {
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId: MACHINE_ID,
            materializations: [materialization],
        };

        // A machine may only report its own inventory; the authenticated
        // publisher, not the body, decides whose inventory this is.
        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: "machine-availability-other",
            input: { expectedRevision: null, snapshot },
        })).rejects.toMatchObject({ code: "plugin_materialization_machine_mismatch" });

        // A server alias change cannot be absorbed silently: portable identity
        // is the server's own, never the reporter's claim.
        const aliasedServerIdentityId = "srv_availabilityAlias000001";
        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: {
                expectedRevision: null,
                snapshot: {
                    ...snapshot,
                    serverIdentityId: aliasedServerIdentityId,
                    materializations: [{ ...materialization, serverIdentityId: aliasedServerIdentityId }],
                },
            },
        })).rejects.toMatchObject({ code: "plugin_materialization_server_identity_mismatch" });

        await expect(db.pluginMachineMaterialization.count()).resolves.toBe(0);
        await expect(db.machine.findUnique({
            where: { id: MACHINE_ID },
            select: { pluginMaterializationRevision: true },
        })).resolves.toEqual({ pluginMaterializationRevision: null });

        // Positive twin: the identical inventory from its own machine under the
        // server's own identity is accepted.
        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: { expectedRevision: null, snapshot },
        })).resolves.toMatchObject({ outcome: "replaced" });
        await expect(db.pluginMachineMaterialization.count()).resolves.toBe(1);
    });

    it("refuses an inventory body that names a sibling machine of the same Account", async () => {
        await seedAccountAndMachine();
        const SIBLING_MACHINE_ID = "machine-plugin-availability-sibling";
        await db.machine.create({
            data: {
                id: SIBLING_MACHINE_ID,
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: "machine-installation-availability-sibling",
            },
        });
        const service = operations();
        const materializationFor = (machineId: string) => ({
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId,
            materializationId: `install-epoch-${machineId}`,
            pluginId: PLUGIN_ID,
            version: RELEASE.version,
            sourceClass: "registryPackage" as const,
            portableRelease: true,
            uiArtifacts: [],
            enabled: true,
            trustState: "trusted" as const,
            observedAt: 1_700_000_000_000,
        });
        const snapshotFor = (machineId: string) => ({
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId,
            materializations: [materializationFor(machineId)],
        });

        // The publisher is a real machine of this Account, so the in-transaction
        // ownership lookup cannot catch this: only the body/publisher comparison
        // stops one machine from writing another machine's installation epochs.
        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: { expectedRevision: null, snapshot: snapshotFor(SIBLING_MACHINE_ID) },
        })).rejects.toMatchObject({ code: "plugin_materialization_machine_mismatch" });
        await expect(db.pluginMachineMaterialization.count()).resolves.toBe(0);
        await expect(db.machine.findUnique({
            where: { id: MACHINE_ID },
            select: { pluginMaterializationRevision: true },
        })).resolves.toEqual({ pluginMaterializationRevision: null });
        await expect(db.machine.findUnique({
            where: { id: SIBLING_MACHINE_ID },
            select: { pluginMaterializationRevision: true },
        })).resolves.toEqual({ pluginMaterializationRevision: null });

        // Positive twin: each machine may still publish its own inventory, and
        // one machine's report never disturbs the sibling's rows or watermark.
        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: SIBLING_MACHINE_ID,
            input: { expectedRevision: null, snapshot: snapshotFor(SIBLING_MACHINE_ID) },
        })).resolves.toMatchObject({ outcome: "replaced" });
        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: { expectedRevision: null, snapshot: snapshotFor(MACHINE_ID) },
        })).resolves.toMatchObject({ outcome: "replaced" });
        await expect(db.pluginMachineMaterialization.count({
            where: { machineId: SIBLING_MACHINE_ID },
        })).resolves.toBe(1);
        await expect(db.pluginMachineMaterialization.count({
            where: { machineId: MACHINE_ID },
        })).resolves.toBe(1);
    });

    it("retains conflicting portable materialization evidence so currentness can reject it visibly", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const facts = releaseFacts();
        await service.publishRelease({
            accountId: ACCOUNT_ID,
            input: { facts, sourceClass: "registryPackage" },
        });
        const materialization = {
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId: MACHINE_ID,
            materializationId: "install-epoch-1",
            pluginId: PLUGIN_ID,
            version: RELEASE.version,
            sourceClass: "registryPackage" as const,
            portableRelease: true,
            archiveDigestSha256: facts.archiveDigestSha256,
            uiArtifacts: facts.uiSlots,
            enabled: true,
            trustState: "trusted" as const,
            observedAt: 1_700_000_000_000,
        };

        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: {
                expectedRevision: null,
                snapshot: {
                    serverIdentityId: SERVER_IDENTITY_ID,
                    machineId: MACHINE_ID,
                    materializations: [{
                        ...materialization,
                        archiveDigestSha256: `sha256:${"c".repeat(64)}`,
                    }],
                },
            },
        })).resolves.toMatchObject({ outcome: "replaced" });
        await expect(db.pluginMachineMaterialization.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);
        await expect(inTx(async (tx) => (
            await resolveCurrentClaimablePluginMachineMaterializationTx({
                tx,
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                pluginId: PLUGIN_ID,
                version: RELEASE.version,
                machineId: MACHINE_ID,
                machineInstallationId: "machine-installation-availability",
                materializationId: "install-epoch-1",
            })
        ))).resolves.toEqual({ kind: "notCurrent" });

        await expect(service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: {
                expectedRevision: 1,
                snapshot: {
                    serverIdentityId: SERVER_IDENTITY_ID,
                    machineId: MACHINE_ID,
                    materializations: [materialization],
                },
            },
        })).resolves.toMatchObject({ outcome: "replaced" });
        await expect(inTx(async (tx) => (
            await resolveCurrentClaimablePluginMachineMaterializationTx({
                tx,
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                machineInstallationId: "machine-installation-availability",
                materializationId: materialization.materializationId,
                pluginId: PLUGIN_ID,
                version: RELEASE.version,
            })
        ))).resolves.toMatchObject({
            kind: "current",
            materialization: {
                materializationId: materialization.materializationId,
            },
        });
        const read = await service.readMaterializations({ accountId: ACCOUNT_ID, input: {} });
        expect(read).toMatchObject({
            releases: [expect.objectContaining({ ref: RELEASE, archiveDigestSha256: facts.archiveDigestSha256 })],
            snapshots: [expect.objectContaining({
                materializations: [expect.objectContaining({
                    materializationId: materialization.materializationId,
                })],
            })],
        });
        expect(read.snapshots[0]?.materializations[0]).not.toHaveProperty("releaseFacts");
        await expect(db.pluginMachineMaterialization.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);
    });

    it("admits only the exact current, trusted materialization tuple through one transaction-local owner", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const facts = releaseFacts();
        await service.publishRelease({
            accountId: ACCOUNT_ID,
            input: { facts, sourceClass: "registryPackage" },
        });
        const snapshot = {
            serverIdentityId: SERVER_IDENTITY_ID,
            machineId: MACHINE_ID,
            materializations: [{
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: "install-epoch-1",
                pluginId: PLUGIN_ID,
                version: RELEASE.version,
                sourceClass: "registryPackage" as const,
                portableRelease: true,
                archiveDigestSha256: facts.archiveDigestSha256,
                uiArtifacts: facts.uiSlots,
                enabled: true,
                trustState: "trusted" as const,
                observedAt: 1_700_000_000_000,
            }],
        };
        await service.reportMaterializations({
            accountId: ACCOUNT_ID,
            publisherMachineId: MACHINE_ID,
            input: { expectedRevision: null, snapshot },
        });

        await expect(inTx(async (tx) => (
            await resolveCurrentClaimablePluginMachineMaterializationTx({
                tx,
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                machineInstallationId: "machine-installation-availability",
                materializationId: "install-epoch-1",
                pluginId: PLUGIN_ID,
                version: RELEASE.version,
            })
        ))).resolves.toMatchObject({
            kind: "current",
            materialization: {
                materializationId: "install-epoch-1",
                trustState: "trusted",
            },
        });
        await expect(inTx(async (tx) => (
            await resolveCurrentClaimablePluginMachineMaterializationTx({
                tx,
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                machineInstallationId: "machine-installation-availability",
                materializationId: "install-epoch-1",
                pluginId: PLUGIN_ID,
                version: RELEASE.version,
                requiredMachineOperationCapability: "pluginWebhookClaim",
            })
        ))).resolves.toEqual({ kind: "notCurrent" });

        await db.machine.update({
            where: { accountId_id: { accountId: ACCOUNT_ID, id: MACHINE_ID } },
            data: {
                operationProtocolCapabilities: {
                    pluginWebhookClaim: { protocolVersions: [1] },
                },
                operationProtocolCapabilitiesRevision: 1,
            },
        });
        await expect(inTx(async (tx) => (
            await resolveCurrentClaimablePluginMachineMaterializationTx({
                tx,
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                machineInstallationId: "machine-installation-availability",
                materializationId: "install-epoch-1",
                pluginId: PLUGIN_ID,
                version: RELEASE.version,
                requiredMachineOperationCapability: "pluginWebhookClaim",
            })
        ))).resolves.toMatchObject({
            kind: "current",
            materialization: { materializationId: "install-epoch-1" },
        });
        await expect(inTx(async (tx) => (
            await resolveCurrentClaimablePluginMachineMaterializationTx({
                tx,
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                machineInstallationId: "machine-installation-availability",
                materializationId: "install-epoch-1",
                pluginId: PLUGIN_ID,
                version: "1.2.4",
            })
        ))).resolves.toEqual({ kind: "notCurrent" });
        await expect(inTx(async (tx) => (
            await resolveCurrentClaimablePluginMachineMaterializationTx({
                tx,
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                machineInstallationId: "stale-machine-installation",
                materializationId: "install-epoch-1",
                pluginId: PLUGIN_ID,
                version: RELEASE.version,
            })
        ))).resolves.toEqual({ kind: "notCurrent" });
        await db.machine.update({
            where: { accountId_id: { accountId: ACCOUNT_ID, id: MACHINE_ID } },
            data: { revokedAt: new Date() },
        });
        await expect(inTx(async (tx) => (
            await resolveCurrentClaimablePluginMachineMaterializationTx({
                tx,
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                machineInstallationId: "machine-installation-availability",
                materializationId: "install-epoch-1",
                pluginId: PLUGIN_ID,
                version: RELEASE.version,
            })
        ))).resolves.toEqual({ kind: "notCurrent" });
    });

    it("publishes and reads one mode-correct generic Artifact through a portable slot plus transient link compatibility", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const { graph, archive } = createBrowserArtifactArchive();
        const slot = {
            ...releaseFacts().uiSlots[0]!,
            artifactDigest: graph.digest,
        };
        await service.publishRelease({
            accountId: ACCOUNT_ID,
            input: {
                facts: releaseFacts({ uiSlots: [slot] }),
                sourceClass: "registryPackage",
            },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                desiredVersion: RELEASE.version,
                enabled: true,
                offlineUiHosting: "enabled",
                writableCollections: [],
                revision: BigInt(1),
            },
        });
        const artifactId = "00000000-0000-4000-8000-000000000001";
        const artifact = {
            header: encodePlainArtifactStoredContent(archive.header),
            body: encodePlainArtifactStoredContent({
                body: encodePluginUiArtifactArchiveBodyV1(archive.body),
            }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        };

        await expect(service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                slot,
                accountArtifactId: artifactId,
                artifact: {
                    ...artifact,
                    body: encodePlainArtifactStoredContent({ body: "malformed archive" }),
                },
            },
        })).rejects.toMatchObject({ code: "plugin_ui_artifact_invalid_content" });
        await expect(db.accountPluginUiArtifact.count()).resolves.toBe(0);
        await expect(db.artifact.count()).resolves.toBe(0);

        const published = await service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                slot,
                accountArtifactId: artifactId,
                artifact,
            },
        });

        expect(published).toMatchObject({
            outcome: "created",
            link: {
                release: RELEASE,
                artifactId: slot.artifactId,
                accountArtifactId: artifactId,
                hostUiApiRange: slot.hostUiApiRange,
            },
        });
        await expect(service.readUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                contributionId: slot.contributionId,
                artifactId: slot.artifactId,
                tier: slot.tier,
                platform: slot.platform,
            },
        })).resolves.toMatchObject({
            link: {
                artifactId: slot.artifactId,
                accountArtifactId: artifactId,
                hostUiApiRange: slot.hostUiApiRange,
            },
            artifact: {
                header: artifact.header,
                body: artifact.body,
            },
        });
        await expect(service.readIntent({
            accountId: ACCOUNT_ID,
            input: { pluginId: PLUGIN_ID },
        })).resolves.toMatchObject({
            release: { uiSlots: [slot] },
            uiArtifacts: [{
                release: RELEASE,
                artifactId: slot.artifactId,
                accountArtifactId: artifactId,
                hostUiApiRange: slot.hostUiApiRange,
            }],
        });
        await expect(db.accountPluginUiArtifact.count()).resolves.toBe(1);
        await expect(db.artifact.count()).resolves.toBe(1);
        await expect(db.accountChange.findMany({
            where: { accountId: ACCOUNT_ID },
            select: { kind: true, entityId: true },
        })).resolves.toEqual([{
            kind: "pluginDomain",
            entityId: `pluginDomain/${PLUGIN_ID}/availability`,
        }]);
        await expect(service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                slot,
                accountArtifactId: "00000000-0000-4000-8000-000000000003",
                artifact,
            },
        })).resolves.toMatchObject({
            outcome: "rejoined",
            link: { accountArtifactId: artifactId },
        });
        await expect(db.artifact.findUnique({
            where: { id: "00000000-0000-4000-8000-000000000003" },
        })).resolves.toBeNull();
        await expect(service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                slot,
                accountArtifactId: artifactId,
                artifact,
            },
        })).resolves.toMatchObject({ outcome: "rejoined", link: { accountArtifactId: artifactId } });
        await expect(service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                slot,
                accountArtifactId: "00000000-0000-4000-8000-000000000002",
                artifact: {
                    header: Buffer.from([1, 2, 3]).toString("base64"),
                    body: Buffer.from([4, 5, 6]).toString("base64"),
                    dataEncryptionKey: Buffer.from([7, 8, 9]).toString("base64"),
                },
            },
        })).rejects.toMatchObject({ code: "plugin_ui_artifact_conflict" });
        await expect(service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                slot,
                accountArtifactId: "00000000-0000-4000-8000-000000000002",
                artifact,
            },
        })).resolves.toMatchObject({ outcome: "rejoined", link: { accountArtifactId: artifactId } });
        await expect(service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                slot,
                accountArtifactId: artifactId,
                artifact: {
                    ...artifact,
                    // Same valid logical archive, deliberately encoded with
                    // different stored header bytes: rejoin is byte-exact.
                    header: encodePlainArtifactStoredContent({
                        artifactGraph: archive.header.artifactGraph,
                        title: archive.header.title,
                        kind: archive.header.kind,
                        v: archive.header.v,
                    }),
                },
            },
        })).rejects.toMatchObject({ code: "plugin_ui_artifact_conflict" });
        await expect(db.artifact.count()).resolves.toBe(1);

        await db.accountPluginIntent.update({
            where: {
                accountId_pluginId: {
                    accountId: ACCOUNT_ID,
                    pluginId: PLUGIN_ID,
                },
            },
            data: {
                enabled: false,
                offlineUiHosting: "disabled",
            },
        });
        const exactReadInput = {
            release: RELEASE,
            contributionId: slot.contributionId,
            artifactId: slot.artifactId,
            tier: slot.tier,
            platform: slot.platform,
        } as const;
        await expect(service.readUiArtifact({
            accountId: ACCOUNT_ID,
            input: exactReadInput,
        })).rejects.toMatchObject({ code: "plugin_ui_artifact_hosting_not_opted_in" });
        await expect(service.readUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                ...exactReadInput,
                purpose: "candidatePreparation",
                expectedArtifactDigest: slot.artifactDigest,
            },
        })).resolves.toMatchObject({
            link: {
                release: RELEASE,
                contributionId: slot.contributionId,
                artifactId: slot.artifactId,
                accountArtifactId: artifactId,
                artifactDigest: slot.artifactDigest,
            },
        });
        await expect(service.readUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                ...exactReadInput,
                purpose: "candidatePreparation",
                expectedArtifactDigest: `sha256:${"f".repeat(64)}`,
            },
        })).rejects.toMatchObject({ code: "plugin_release_content_conflict" });
    });

    it("refuses hosted publish and exact read while the operator has not enabled Artifact hosting", async () => {
        await seedAccountAndMachine();
        const hostingEnabled = operations();
        const { graph, archive } = createBrowserArtifactArchive();
        const slot = {
            ...releaseFacts().uiSlots[0]!,
            artifactDigest: graph.digest,
        };
        const hostingDisabled = createPluginAvailabilityOperations({
            resolveHostingCapability: () => ({ enabled: false }),
            resolveServerIdentityId: async () => SERVER_IDENTITY_ID,
        });
        await hostingEnabled.publishRelease({
            accountId: ACCOUNT_ID,
            input: {
                facts: releaseFacts({ uiSlots: [slot] }),
                sourceClass: "registryPackage",
            },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                desiredVersion: RELEASE.version,
                enabled: true,
                offlineUiHosting: "enabled",
                writableCollections: [],
                revision: BigInt(1),
            },
        });
        const artifactId = "00000000-0000-4000-8000-000000000009";
        const publishInput = {
            release: RELEASE,
            slot,
            accountArtifactId: artifactId,
            artifact: {
                header: encodePlainArtifactStoredContent(archive.header),
                body: encodePlainArtifactStoredContent({
                    body: encodePluginUiArtifactArchiveBodyV1(archive.body),
                }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            },
        } as const;

        // Present-user hosting intent is enabled; only the operator capability is off.
        await expect(hostingDisabled.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: publishInput,
        })).rejects.toMatchObject({ code: "plugin_ui_artifact_hosting_unsupported" });
        await expect(db.artifact.count()).resolves.toBe(0);
        await expect(db.accountPluginUiArtifact.count()).resolves.toBe(0);

        // Positive twin: the identical envelope commits once the operator supports hosting.
        await expect(hostingEnabled.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: publishInput,
        })).resolves.toMatchObject({ outcome: "created", link: { accountArtifactId: artifactId } });

        const exactReadInput = {
            release: RELEASE,
            contributionId: slot.contributionId,
            artifactId: slot.artifactId,
            tier: slot.tier,
            platform: slot.platform,
        } as const;
        await expect(hostingEnabled.readUiArtifact({
            accountId: ACCOUNT_ID,
            input: exactReadInput,
        })).resolves.toMatchObject({ link: { accountArtifactId: artifactId } });
        // A committed archive stays behind the same typed unsupported result.
        await expect(hostingDisabled.readUiArtifact({
            accountId: ACCOUNT_ID,
            input: exactReadInput,
        })).rejects.toMatchObject({ code: "plugin_ui_artifact_hosting_unsupported" });
    });

    it("keeps an E2EE UI archive opaque to Availability while exact qualified read and removal use the generic Artifact owner", async () => {
        await seedAccountAndMachine({ encryptionMode: "e2ee" });
        const service = operations();
        await service.publishRelease({
            accountId: ACCOUNT_ID,
            input: { facts: releaseFacts(), sourceClass: "registryPackage" },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                desiredVersion: RELEASE.version,
                enabled: true,
                offlineUiHosting: "enabled",
                writableCollections: [],
                revision: BigInt(1),
            },
        });
        const slot = releaseFacts().uiSlots[0]!;
        const artifact = {
            header: Buffer.from([1, 2, 3]).toString("base64"),
            body: Buffer.from([4, 5, 6]).toString("base64"),
            dataEncryptionKey: Buffer.from([7, 8, 9]).toString("base64"),
        };

        await expect(service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                slot,
                accountArtifactId: "00000000-0000-4000-8000-000000000003",
                artifact,
            },
        })).resolves.toMatchObject({ outcome: "created" });
        await expect(service.readUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                contributionId: slot.contributionId,
                artifactId: slot.artifactId,
                tier: slot.tier,
                platform: slot.platform,
            },
        })).resolves.toMatchObject({ artifact });
        // Same-ID replay is byte-exact. A fresh publication identity rejoins
        // the classified slot even when the client reseals equivalent bytes.
        await expect(service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                slot,
                accountArtifactId: "00000000-0000-4000-8000-000000000003",
                artifact,
            },
        })).resolves.toMatchObject({
            outcome: "rejoined",
            link: { accountArtifactId: "00000000-0000-4000-8000-000000000003" },
        });
        await expect(service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                slot,
                accountArtifactId: "00000000-0000-4000-8000-000000000004",
                artifact: {
                    header: Buffer.from([11, 12, 13]).toString("base64"),
                    body: Buffer.from([14, 15, 16]).toString("base64"),
                    dataEncryptionKey: Buffer.from([17, 18, 19]).toString("base64"),
                },
            },
        })).resolves.toMatchObject({
            outcome: "rejoined",
            link: { accountArtifactId: "00000000-0000-4000-8000-000000000003" },
        });
        await expect(service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                slot,
                accountArtifactId: "00000000-0000-4000-8000-000000000003",
                artifact: {
                    ...artifact,
                    body: Buffer.from([4, 5, 7]).toString("base64"),
                },
            },
        })).rejects.toMatchObject({ code: "plugin_ui_artifact_conflict" });
        await expect(db.artifact.count()).resolves.toBe(1);
        await expect(db.accountPluginUiArtifact.count()).resolves.toBe(1);
        await expect(service.removeUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                contributionId: slot.contributionId,
                artifactId: slot.artifactId,
                tier: slot.tier,
                platform: slot.platform,
            },
        })).resolves.toMatchObject({ removed: true });
        await expect(db.accountPluginUiArtifact.count()).resolves.toBe(0);
        await expect(db.artifact.count()).resolves.toBe(0);
        await expect(service.readUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                contributionId: slot.contributionId,
                artifactId: slot.artifactId,
                tier: slot.tier,
                platform: slot.platform,
            },
        })).rejects.toMatchObject({ code: "plugin_ui_artifact_not_found" });
    });

    it.each([false, true])("rejects an Artifact id already owned outside the qualified UI slot (occupied: %s)", async (occupied) => {
        await seedAccountAndMachine();
        const service = operations();
        const { graph, archive } = createBrowserArtifactArchive();
        const slot = { ...releaseFacts().uiSlots[0]!, artifactDigest: graph.digest };
        await service.publishRelease({
            accountId: ACCOUNT_ID,
            input: { facts: releaseFacts({ uiSlots: [slot] }), sourceClass: "registryPackage" },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                desiredVersion: RELEASE.version,
                enabled: true,
                offlineUiHosting: "enabled",
                writableCollections: [],
                revision: BigInt(1),
            },
        });
        const artifactId = "00000000-0000-4000-8000-000000000019";
        await db.artifact.create({
            data: {
                id: artifactId,
                accountId: ACCOUNT_ID,
                header: Buffer.from([1]),
                headerVersion: 1,
                body: Buffer.from([2]),
                bodyVersion: 1,
                dataEncryptionKey: Buffer.from([3]),
                seq: 0,
            },
        });
        if (occupied) {
            await service.publishUiArtifact({
                accountId: ACCOUNT_ID,
                input: {
                    release: RELEASE,
                    slot,
                    accountArtifactId: "00000000-0000-4000-8000-000000000020",
                    artifact: {
                        header: encodePlainArtifactStoredContent(archive.header),
                        body: encodePlainArtifactStoredContent({ body: encodePluginUiArtifactArchiveBodyV1(archive.body) }),
                        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    },
                },
            });
        }
        await expect(service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                slot,
                accountArtifactId: artifactId,
                artifact: {
                    header: encodePlainArtifactStoredContent(archive.header),
                    body: encodePlainArtifactStoredContent({
                        body: encodePluginUiArtifactArchiveBodyV1(archive.body),
                    }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                },
            },
        })).rejects.toMatchObject({ code: "plugin_ui_artifact_conflict" });
        await expect(db.accountPluginUiArtifact.count()).resolves.toBe(occupied ? 1 : 0);
        await expect(db.artifact.count()).resolves.toBe(occupied ? 2 : 1);
    });

    it.each([false, true])("rechecks current hosting intent when recovering a slot uniqueness race (withdrawn: %s)", async (withdrawn) => {
        await seedAccountAndMachine();
        const service = operations();
        const fixture = createHostedReleaseFixture({ version: RELEASE.version, ordinal: 1 });
        await publishHostedRelease(service, fixture);
        await selectHostedRelease(service, fixture, null);
        const request = {
            accountId: ACCOUNT_ID,
            input: {
                release: fixture.ref,
                slot: fixture.slot,
                accountArtifactId: fixture.uiArtifactId,
                artifact: fixture.uiArtifact,
            },
        };
        // Inject the database's losing-writer outcome after another real
        // transaction commits the winner; internal Availability logic is real.
        const runTransaction = db.$transaction;
        const losingTransaction = vi.fn(runTransaction).mockImplementationOnce(async () => {
            await service.publishUiArtifact(request);
            if (withdrawn) {
                await db.accountPluginIntent.update({
                    where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } },
                    data: { offlineUiHosting: "disabled" },
                });
            }
            throw Object.assign(new Error("Unique slot conflict"), { code: "P2002" });
        });
        // The DB adapter's generic overloads are lost by Vitest's mock type.
        db.$transaction = losingTransaction as unknown as typeof db.$transaction;
        try {
            const retry = service.publishUiArtifact({
                ...request,
                input: { ...request.input, accountArtifactId: "00000000-0000-4000-8000-000000000099" },
            });
            if (withdrawn) {
                await expect(retry).rejects.toMatchObject({ code: "plugin_ui_artifact_hosting_not_opted_in" });
            } else {
                await expect(retry).resolves.toMatchObject({ outcome: "rejoined", link: { accountArtifactId: fixture.uiArtifactId } });
            }
            await expect(db.artifact.count()).resolves.toBe(1);
            await expect(db.accountPluginUiArtifact.count()).resolves.toBe(1);
        } finally {
            db.$transaction = runTransaction;
        }
    });

    it("publishes and rereads the exact release-declared package Asset archive through one protected Artifact link", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const manifest = {
            schemaVersion: 2,
            id: PLUGIN_ID,
            version: RELEASE.version,
            displayName: "Availability fixture",
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            contributes: {
                resources: [{
                    id: "brand-icon",
                    kind: "asset",
                    path: "assets/brand.png",
                    contentType: "image/png",
                }],
            },
        };
        const archive = createPackageAssetArchiveV1({
            manifest,
            files: [{
                path: "assets/brand.png",
                bytes: new Uint8Array([137, 80, 78, 71]),
            }],
        });
        if (!archive) throw new Error("Expected package Asset archive fixture");
        const facts = releaseFacts({
            normalizedManifest: manifest,
            packageAssetArchive: archive.descriptor,
        });
        await service.publishRelease({
            accountId: ACCOUNT_ID,
            input: { facts, sourceClass: "registryPackage" },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                desiredVersion: RELEASE.version,
                enabled: true,
                offlineUiHosting: "enabled",
                writableCollections: [],
                revision: BigInt(1),
            },
        });
        const artifactId = "00000000-0000-4000-8000-000000000004";
        const artifact = {
            header: encodePlainArtifactStoredContent(archive.header),
            body: encodePlainArtifactStoredContent({
                body: encodePackageAssetArchiveBodyV1(archive.body),
            }),
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        };
        await expect(service.publishPackageAsset({
            accountId: ACCOUNT_ID,
            input: { release: RELEASE, artifactId, artifact },
        })).resolves.toMatchObject({
            outcome: "created",
            link: {
                release: RELEASE,
                artifactId,
                descriptor: archive.descriptor,
            },
        });
        await expect(service.readPackageAsset({
            accountId: ACCOUNT_ID,
            input: { release: RELEASE },
        })).resolves.toMatchObject({
            link: {
                release: RELEASE,
                artifactId,
                descriptor: archive.descriptor,
            },
            artifact,
        });
        await expect(service.publishPackageAsset({
            accountId: ACCOUNT_ID,
            input: { release: RELEASE, artifactId, artifact },
        })).resolves.toMatchObject({ outcome: "rejoined" });
        // A fresh publisher rejoins the immutable release link without
        // repointing it or persisting another Artifact.
        await expect(service.publishPackageAsset({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                artifactId: "00000000-0000-4000-8000-000000000005",
                artifact,
            },
        })).resolves.toMatchObject({ outcome: "rejoined", link: { artifactId } });
        expect(await db.artifact.count({ where: { accountId: ACCOUNT_ID } })).toBe(1);
        await expect(service.readIntent({ accountId: ACCOUNT_ID, input: { pluginId: PLUGIN_ID } }))
            .resolves.toMatchObject({ packageAssets: [{ release: RELEASE, artifactId, descriptor: archive.descriptor }] });
        await expect(service.publishPackageAsset({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                artifactId: "00000000-0000-4000-8000-000000000005",
                artifact: { ...artifact, body: encodePlainArtifactStoredContent({ body: "different bytes" }) },
            },
        })).rejects.toMatchObject({ code: "plugin_package_asset_invalid_content" });
        await expect(service.publishPackageAsset({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                artifactId,
                artifact: {
                    ...artifact,
                    body: encodePlainArtifactStoredContent({ body: "different bytes" }),
                },
            },
        })).rejects.toMatchObject({ code: "plugin_package_asset_conflict" });

        await db.accountPluginIntent.update({
            where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } },
            data: { enabled: false },
        });
        await expect(service.readPackageAsset({
            accountId: ACCOUNT_ID,
            input: { release: RELEASE },
        })).rejects.toMatchObject({
            code: "plugin_package_asset_hosting_not_opted_in",
        });
        await expect(service.removePackageAsset({ accountId: "another-account", input: { release: RELEASE } }))
            .rejects.toMatchObject({ code: "plugin_package_asset_not_found" });
        await expect(service.removePackageAsset({ accountId: ACCOUNT_ID, input: { release: RELEASE } }))
            .resolves.toMatchObject({ removed: true, link: { artifactId } });
        expect(await db.artifact.count({ where: { accountId: ACCOUNT_ID } })).toBe(0);
        expect(await db.accountPluginRelease.findFirst({ where: { accountId: ACCOUNT_ID } }))
            .toMatchObject({ packageAssetArtifactId: null });
    });

    it("keeps package Asset archive bytes opaque for E2EE Accounts while currentness remains server-owned", async () => {
        await seedAccountAndMachine({ encryptionMode: "e2ee" });
        const service = operations();
        await service.publishRelease({
            accountId: ACCOUNT_ID,
            input: { facts: releaseFacts(), sourceClass: "registryPackage" },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                desiredVersion: RELEASE.version,
                enabled: true,
                offlineUiHosting: "enabled",
                writableCollections: [],
                revision: BigInt(1),
            },
        });
        const artifact = {
            header: Buffer.from([1, 2, 3]).toString("base64"),
            body: Buffer.from([4, 5, 6]).toString("base64"),
            dataEncryptionKey: Buffer.from([7, 8, 9]).toString("base64"),
        };

        await expect(service.publishPackageAsset({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                artifactId: "00000000-0000-4000-8000-000000000005",
                artifact,
            },
        })).resolves.toMatchObject({ outcome: "created" });
        await expect(service.readPackageAsset({
            accountId: ACCOUNT_ID,
            input: { release: RELEASE },
        })).resolves.toMatchObject({ artifact });
        const freshArtifact = {
            header: Buffer.from([11, 12, 13]).toString("base64"),
            body: Buffer.from([14, 15, 16]).toString("base64"),
            dataEncryptionKey: Buffer.from([17, 18, 19]).toString("base64"),
        };
        await expect(service.publishPackageAsset({
            accountId: ACCOUNT_ID,
            input: { release: RELEASE, artifactId: "00000000-0000-4000-8000-000000000006", artifact: freshArtifact },
        })).resolves.toMatchObject({ outcome: "rejoined", link: { artifactId: "00000000-0000-4000-8000-000000000005" } });
        expect(await db.artifact.count({ where: { accountId: ACCOUNT_ID } })).toBe(1);
        await expect(service.readPackageAsset({ accountId: ACCOUNT_ID, input: { release: RELEASE } }))
            .resolves.toMatchObject({ artifact });
        await expect(service.publishPackageAsset({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                artifactId: "00000000-0000-4000-8000-000000000006",
                artifact: {
                    header: encodePlainArtifactStoredContent({ title: "wrong mode" }),
                    body: encodePlainArtifactStoredContent({ body: "wrong mode" }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                },
            },
        })).rejects.toMatchObject({ code: "plugin_package_asset_conflict" });
    });

    it("keeps unchanged-Collection release metadata while retaining hosted archives only for selected and prior across A -> B -> C", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const fixtures = ["1.0.0", "2.0.0", "3.0.0"].map((version, index) => (
            createHostedReleaseFixture({
                version,
                ordinal: index + 1,
                includeCollection: true,
            })
        ));
        for (const [index, fixture] of fixtures.entries()) {
            await publishHostedRelease(service, fixture);
            if (index === 0) {
                const contract = await db.pluginCollectionContract.findFirstOrThrow({
                    where: {
                        pluginId: PLUGIN_ID,
                        collectionId: "tasks",
                        schemaVersion: 1,
                        contractDigest: fixture.collectionContracts[0]!.contractDigest,
                    },
                    select: { id: true },
                });
                await db.pluginCollectionRow.create({
                    data: {
                        accountId: ACCOUNT_ID,
                        pluginId: PLUGIN_ID,
                        collectionId: "tasks",
                        rowId: "retained-task",
                        schemaVersion: 1,
                        revision: 1,
                        contractId: contract.id,
                        contractDigest: fixture.collectionContracts[0]!.contractDigest,
                        contentEnvelope: {
                            t: "plain",
                            v: { id: "retained-task", status: "open" },
                        },
                    },
                });
            }
            await selectHostedRelease(
                service,
                fixture,
                index === 0 ? null : String(index - 1),
            );
            await hostReleaseArchives(service, fixture);
        }

        await expect(db.accountPluginRelease.findMany({
            where: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID },
            select: {
                version: true,
                packageAssetArtifactId: true,
                uiArtifacts: { select: { artifactId: true } },
            },
            orderBy: { version: "asc" },
        })).resolves.toEqual([
            { version: "1.0.0", packageAssetArtifactId: null, uiArtifacts: [] },
            {
                version: "2.0.0",
                packageAssetArtifactId: fixtures[1]!.packageArtifactId,
                uiArtifacts: [{ artifactId: fixtures[1]!.uiArtifactId }],
            },
            {
                version: "3.0.0",
                packageAssetArtifactId: fixtures[2]!.packageArtifactId,
                uiArtifacts: [{ artifactId: fixtures[2]!.uiArtifactId }],
            },
        ]);
        await expect(db.accountPluginUiArtifact.count()).resolves.toBe(2);
        await expect(db.artifact.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(4);
    });

    it("prunes hosted archives independently of nonmonotonic release creation order", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const fixtures = new Map(
            ["2.0.0", "1.0.0", "3.0.0"].map((version, index) => {
                const fixture = createHostedReleaseFixture({
                    version,
                    ordinal: index + 4,
                });
                return [version, fixture] as const;
            }),
        );
        for (const fixture of fixtures.values()) {
            await publishHostedRelease(service, fixture);
        }
        for (const [index, version] of ["1.0.0", "2.0.0", "3.0.0"].entries()) {
            const fixture = fixtures.get(version);
            if (!fixture) throw new Error(`Missing ${version} fixture`);
            await selectHostedRelease(
                service,
                fixture,
                index === 0 ? null : String(index - 1),
            );
            await hostReleaseArchives(service, fixture);
        }

        const first = fixtures.get("1.0.0")!;
        const second = fixtures.get("2.0.0")!;
        const third = fixtures.get("3.0.0")!;
        await expect(db.accountPluginRelease.findMany({
            where: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID },
            select: {
                version: true,
                packageAssetArtifactId: true,
                uiArtifacts: { select: { artifactId: true } },
            },
            orderBy: { version: "asc" },
        })).resolves.toEqual([
            { version: "1.0.0", packageAssetArtifactId: null, uiArtifacts: [] },
            {
                version: "2.0.0",
                packageAssetArtifactId: second.packageArtifactId,
                uiArtifacts: [{ artifactId: second.uiArtifactId }],
            },
            {
                version: "3.0.0",
                packageAssetArtifactId: third.packageArtifactId,
                uiArtifacts: [{ artifactId: third.uiArtifactId }],
            },
        ]);
        await expect(db.artifact.findMany({
            where: { accountId: ACCOUNT_ID },
            select: { id: true },
            orderBy: { id: "asc" },
        })).resolves.toEqual([
            second.uiArtifactId,
            second.packageArtifactId,
            third.uiArtifactId,
            third.packageArtifactId,
        ].sort().map((id) => ({ id })));
        expect(first.uiArtifactId).not.toBe(second.uiArtifactId);
    });

    it("retains immutable release facts after archive pruning so an old coordinate can only rejoin", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const fixtures = [1, 2, 3].map((ordinal) => createHostedReleaseFixture({
            version: `${ordinal}.0.0`,
            ordinal: ordinal + 3,
        }));
        for (const [index, fixture] of fixtures.entries()) {
            await publishHostedRelease(service, fixture);
            await selectHostedRelease(service, fixture, index === 0 ? null : String(index - 1));
            await hostReleaseArchives(service, fixture);
        }

        const first = fixtures[0]!;
        await expect(service.publishRelease({
            accountId: ACCOUNT_ID,
            input: { facts: first.facts, sourceClass: "registryPackage" },
        })).resolves.toMatchObject({ outcome: "rejoined" });
        const changedFirst = createHostedReleaseFixture({ version: "1.0.0", ordinal: 9 });
        await expect(service.publishRelease({
            accountId: ACCOUNT_ID,
            input: { facts: changedFirst.facts, sourceClass: "registryPackage" },
        })).rejects.toMatchObject({ code: "plugin_release_content_conflict" });
    });

    it("does not prune retained archives after the persisted Account mode stops matching their marker", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const fixtures = [1, 2, 3].map((ordinal) => createHostedReleaseFixture({
            version: `${ordinal}.0.0`,
            ordinal,
        }));
        for (const [index, fixture] of fixtures.entries()) {
            await publishHostedRelease(service, fixture);
            if (index < 2) {
                await selectHostedRelease(
                    service,
                    fixture,
                    index === 0 ? null : "0",
                );
                await hostReleaseArchives(service, fixture);
            }
        }
        await db.account.update({
            where: { id: ACCOUNT_ID },
            data: {
                encryptionMode: "e2ee",
                ...createSignedAccountContentBinding(),
            },
        });

        await expect(selectHostedRelease(service, fixtures[2]!, "1"))
            .rejects.toMatchObject({
                code: "plugin_package_asset_invalid_content",
            });

        await expect(db.accountPluginIntent.findUnique({
            where: {
                accountId_pluginId: {
                    accountId: ACCOUNT_ID,
                    pluginId: PLUGIN_ID,
                },
            },
            select: { desiredVersion: true, revision: true },
        })).resolves.toMatchObject({ desiredVersion: "2.0.0", revision: BigInt(1) });
        await expect(db.artifact.count({ where: { accountId: ACCOUNT_ID } }))
            .resolves.toBe(4);
        await expect(db.accountPluginUiArtifact.count()).resolves.toBe(2);
    });

    it("rejects qualified hosted reads when stored Artifact representation disagrees with Account mode", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const fixture = createHostedReleaseFixture({ version: "1.0.0", ordinal: 4 });
        await publishHostedRelease(service, fixture);
        await selectHostedRelease(service, fixture, null);
        await hostReleaseArchives(service, fixture);

        await db.artifact.updateMany({
            where: {
                accountId: ACCOUNT_ID,
                id: { in: [fixture.uiArtifactId, fixture.packageArtifactId] },
            },
            data: { dataEncryptionKey: Buffer.from([1, 2, 3]) },
        });

        const slot = fixture.facts.uiSlots[0]!;
        await expect(service.readUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: fixture.ref,
                contributionId: slot.contributionId,
                artifactId: slot.artifactId,
                tier: slot.tier,
                platform: slot.platform,
            },
        })).rejects.toMatchObject({ code: "plugin_ui_artifact_invalid_content" });
        await expect(service.readPackageAsset({
            accountId: ACCOUNT_ID,
            input: { release: fixture.ref },
        })).rejects.toMatchObject({ code: "plugin_package_asset_invalid_content" });
    });

    it("keeps qualified links and Artifact content when removal finds a persisted mode mismatch", async () => {
        await seedAccountAndMachine({ encryptionMode: "e2ee" });
        const service = operations();
        const facts = releaseFacts();
        const slot = facts.uiSlots[0]!;
        const uiArtifactId = "00000000-0000-4000-8000-000000000081";
        const packageArtifactId = "00000000-0000-4000-8000-000000000082";
        const encryptedArtifact = {
            header: Buffer.from([1, 2, 3]).toString("base64"),
            body: Buffer.from([4, 5, 6]).toString("base64"),
            dataEncryptionKey: Buffer.from([7, 8, 9]).toString("base64"),
        };
        await service.publishRelease({
            accountId: ACCOUNT_ID,
            input: { facts, sourceClass: "registryPackage" },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                desiredVersion: RELEASE.version,
                enabled: true,
                offlineUiHosting: "enabled",
                writableCollections: [],
                revision: BigInt(1),
            },
        });
        await service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                slot,
                accountArtifactId: uiArtifactId,
                artifact: encryptedArtifact,
            },
        });
        await service.publishPackageAsset({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                artifactId: packageArtifactId,
                artifact: encryptedArtifact,
            },
        });
        await db.artifact.updateMany({
            where: { id: { in: [uiArtifactId, packageArtifactId] } },
            data: {
                dataEncryptionKey: Buffer.from(
                    ARTIFACT_PLAIN_DATA_KEY_MARKER,
                    "base64",
                ),
            },
        });

        await expect(service.removePackageAsset({
            accountId: ACCOUNT_ID,
            input: { release: RELEASE },
        })).rejects.toMatchObject({ code: "plugin_package_asset_invalid_content" });
        await expect(service.removeUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                contributionId: slot.contributionId,
                artifactId: slot.artifactId,
                tier: slot.tier,
                platform: slot.platform,
            },
        })).rejects.toMatchObject({ code: "plugin_ui_artifact_invalid_content" });

        const retainedArtifacts = await db.artifact.findMany({
            where: { id: { in: [uiArtifactId, packageArtifactId] } },
            select: { id: true, header: true, body: true },
            orderBy: { id: "asc" },
        });
        expect(retainedArtifacts).toHaveLength(2);
        expect(retainedArtifacts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: uiArtifactId,
                header: Buffer.from([1, 2, 3]),
                body: Buffer.from([4, 5, 6]),
            }),
            expect.objectContaining({
                id: packageArtifactId,
                header: Buffer.from([1, 2, 3]),
                body: Buffer.from([4, 5, 6]),
            }),
        ]));
        await expect(db.accountPluginUiArtifact.count({
            where: { artifactId: uiArtifactId },
        })).resolves.toBe(1);
        await expect(db.accountPluginRelease.findFirst({
            where: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID },
            select: { packageAssetArtifactId: true },
        })).resolves.toMatchObject({
            packageAssetArtifactId: packageArtifactId,
        });
    });

    it("keeps the captured prior-version archives when a later intent mutation stays on the selected version", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const first = createHostedReleaseFixture({ version: "1.0.0", ordinal: 7 });
        const second = createHostedReleaseFixture({ version: "2.0.0", ordinal: 8 });

        await publishHostedRelease(service, first);
        await selectHostedRelease(service, first, null);
        await hostReleaseArchives(service, first);
        await publishHostedRelease(service, second);
        await selectHostedRelease(service, second, "0");
        await hostReleaseArchives(service, second);

        await service.setIntent({
            accountId: ACCOUNT_ID,
            input: {
                pluginId: PLUGIN_ID,
                desiredVersion: second.ref.version,
                enabled: false,
                offlineUiHosting: "enabled",
                writableCollections: second.collectionContracts,
                expectedRevision: "1",
            },
        });

        await expect(db.accountPluginRelease.findMany({
            where: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID },
            select: {
                version: true,
                packageAssetArtifactId: true,
                uiArtifacts: { select: { artifactId: true } },
            },
            orderBy: { version: "asc" },
        })).resolves.toEqual([
            {
                version: first.ref.version,
                packageAssetArtifactId: first.packageArtifactId,
                uiArtifacts: [{ artifactId: first.uiArtifactId }],
            },
            {
                version: second.ref.version,
                packageAssetArtifactId: second.packageArtifactId,
                uiArtifacts: [{ artifactId: second.uiArtifactId }],
            },
        ]);
    });

    it("fails closed for a selected pre-feature release without an immutable package Asset descriptor", async () => {
        await seedAccountAndMachine();
        const service = operations();
        const legacyFacts = releaseFacts();
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                version: RELEASE.version,
                archiveDigestSha256: legacyFacts.archiveDigestSha256,
                normalizedManifest: legacyFacts.normalizedManifest,
                collectionContracts: legacyFacts.collectionContracts,
                uiSlots: legacyFacts.uiSlots,
                packageAssetArchive: null,
            },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                desiredVersion: RELEASE.version,
                enabled: true,
                offlineUiHosting: "enabled",
                writableCollections: [],
                revision: BigInt(1),
            },
        });

        await expect(service.readIntent({
            accountId: ACCOUNT_ID,
            input: { pluginId: PLUGIN_ID },
        })).resolves.toMatchObject({
            release: null,
            uiArtifacts: [],
        });
        await expect(service.readPackageAsset({
            accountId: ACCOUNT_ID,
            input: { release: RELEASE },
        })).rejects.toMatchObject({
            code: "plugin_package_asset_not_found",
        });
    });

    it("issues a browser frame only for the current plain exact Artifact graph", async () => {
        await seedAccountAndMachine();
        harness.resetEnv({
            HAPPIER_PLUGIN_UI_ARTIFACT_BROWSER_ORIGIN: "https://artifacts.happier.test",
            HAPPIER_WEBAPP_URL: "https://app.happier.test/base",
        });
        const service = operations();
        const { graph, archive, moduleBytes } = createBrowserArtifactArchive();
        const slot = {
            ...releaseFacts().uiSlots[0]!,
            artifactDigest: graph.digest,
        };
        await service.publishRelease({
            accountId: ACCOUNT_ID,
            input: {
                facts: releaseFacts({ uiSlots: [slot] }),
                sourceClass: "registryPackage",
            },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                desiredVersion: RELEASE.version,
                enabled: true,
                offlineUiHosting: "enabled",
                writableCollections: [],
                revision: BigInt(1),
            },
        });
        await service.publishUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                slot,
                accountArtifactId: "00000000-0000-4000-8000-000000000004",
                artifact: {
                    header: encodePlainArtifactStoredContent(archive.header),
                    body: encodePlainArtifactStoredContent({
                        body: encodePluginUiArtifactArchiveBodyV1(archive.body),
                    }),
                    dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                },
            },
        });

        const issued = await service.issueBrowserArtifactFrame({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                contributionId: slot.contributionId,
                artifactId: slot.artifactId,
                tier: slot.tier,
                platform: slot.platform,
                expectedArtifactDigest: graph.digest,
            },
        });
        expect(issued).toMatchObject({
            url: expect.stringMatching(/^https:\/\/artifacts\.happier\.test\/v1\/plugins\/availability\/ui-artifacts\/browser\/hwb1\./u),
            expiresAt: expect.any(Number),
        });
        const capability = new URL(issued.url).pathname
            .split("/")
            .filter(Boolean)
            .pop();
        if (!capability) throw new Error("Expected browser Artifact capability path");

        const served = await service.readBrowserArtifactFrame({
            capability,
            requestPath: "assets/app.js",
            request: {
                protocol: "https",
                host: "artifacts.happier.test",
            },
        });
        expect(new TextDecoder().decode(served.bytes)).toBe(
            new TextDecoder().decode(moduleBytes),
        );
        expect(served).toMatchObject({
            contentType: "text/javascript; charset=utf-8",
            headers: expect.objectContaining({
                "Cache-Control": "no-store",
                "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
            }),
        });

        await expect(service.readBrowserArtifactFrame({
            capability,
            requestPath: "assets/app.js",
            request: {
                protocol: "https",
                host: "app.happier.test",
            },
        })).rejects.toMatchObject({
            code: "plugin_ui_artifact_not_found",
        });

        await service.removeUiArtifact({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                contributionId: slot.contributionId,
                artifactId: slot.artifactId,
                tier: slot.tier,
                platform: slot.platform,
            },
        });
        await expect(service.readBrowserArtifactFrame({
            capability,
            requestPath: "assets/app.js",
            request: {
                protocol: "https",
                host: "artifacts.happier.test",
            },
        })).rejects.toMatchObject({
            code: "plugin_ui_artifact_not_found",
        });
    });

    it("returns the exact typed browser-unavailable result for an E2EE Account before opening archive bytes", async () => {
        await seedAccountAndMachine({ encryptionMode: "e2ee" });
        const service = operations();
        const slot = releaseFacts().uiSlots[0]!;

        await expect(service.issueBrowserArtifactFrame({
            accountId: ACCOUNT_ID,
            input: {
                release: RELEASE,
                contributionId: slot.contributionId,
                artifactId: slot.artifactId,
                tier: slot.tier,
                platform: slot.platform,
                expectedArtifactDigest: slot.artifactDigest,
            },
        })).rejects.toMatchObject({
            code: "plugin_ui_artifact_browser_e2ee_unavailable",
        });
    });
});
