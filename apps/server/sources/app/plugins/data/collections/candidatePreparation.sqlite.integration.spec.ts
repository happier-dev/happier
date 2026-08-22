import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { buildPluginDomainAccountChangeEntityId } from "@happier-dev/protocol";

import {
    materializePluginCollectionContractsFromManifestTx,
    preparePluginCollectionWritableContractsTx,
} from "./contracts";
import {
    pagePluginCollectionCandidatePreparationSource,
    promotePluginCollectionCandidatePreparationInTx,
    retirePluginCollectionCandidatePreparation,
    stagePluginCollectionCandidatePreparation,
} from "./candidatePreparation";
import { readPluginCollectionAccountActivationUsageInTx } from "./quota";
import { mutatePluginCollection } from "./mutation";
import { createPluginAvailabilityOperations } from "@/app/plugins/availability/operations";
import { readPluginsFeatureEnv } from "@/app/features/catalog/readFeatureEnv";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

const ACCOUNT_ID = "candidate-preparation-account";
const OTHER_ACCOUNT_ID = "candidate-preparation-other-account";
const PLUGIN_ID = "example.candidate-preparation";
const COLLECTION_ID = "tasks";
const SOURCE_VERSION = "1.0.0";
const TARGET_VERSION = "2.0.0";

const SOURCE_MANIFEST = {
    schemaVersion: 2,
    id: PLUGIN_ID,
    version: SOURCE_VERSION,
    displayName: "Candidate preparation fixture",
    engines: { happier: "^1.0.0" },
    runtime: { apiVersion: 1 },
    contributes: {
        accountCollections: [{
            id: COLLECTION_ID,
            schemaVersion: 1,
            rowIdField: "id",
            schema: {
                type: "object",
                properties: {
                    id: { type: "string", maxLength: 256 },
                    status: { type: "string", enum: ["closed", "open"] },
                    title: { type: "string", maxLength: 256 },
                },
                required: ["id", "status", "title"],
                additionalProperties: false,
            },
            serverReadable: ["id", "status", "title"],
            indexes: [],
            relations: [],
        }],
    },
} as const;

const TARGET_MANIFEST = {
    ...SOURCE_MANIFEST,
    version: TARGET_VERSION,
    contributes: {
        accountCollections: [{
            ...SOURCE_MANIFEST.contributes.accountCollections[0],
            schemaVersion: 2,
            readableSchemaVersions: [1],
            migrations: [{
                id: "upgrade-v1-to-v2",
                fromSchemaVersion: 1,
                toSchemaVersion: 2,
            }],
        }],
    },
} as const;

const TARGET_MANIFEST_WITHOUT_ROW_MIGRATION = {
    ...SOURCE_MANIFEST,
    version: TARGET_VERSION,
    contributes: {
        accountCollections: [{
            ...SOURCE_MANIFEST.contributes.accountCollections[0],
            // This target deliberately does not declare source v1 as
            // readable. With no live source row, no row callback is
            // meaningful even though the target has a new immutable schema
            // and contract digest.
            schemaVersion: 2,
        }],
    },
} as const;

const TARGET_MANIFEST_OMITTING_CURRENT_COLLECTION = {
    ...SOURCE_MANIFEST,
    version: TARGET_VERSION,
    contributes: {
        accountCollections: [],
    },
} as const;

const TARGET_MANIFEST_REPLACING_CURRENT_COLLECTION = {
    ...SOURCE_MANIFEST,
    version: TARGET_VERSION,
    contributes: {
        accountCollections: [{
            ...SOURCE_MANIFEST.contributes.accountCollections[0],
            id: "projects",
            indexes: [{
                id: "by-status",
                fields: [{ field: "status", direction: "asc" }],
            }],
        }],
    },
} as const;

const TARGET_MANIFEST_WITH_INDEX = {
    ...TARGET_MANIFEST,
    contributes: {
        accountCollections: [{
            ...TARGET_MANIFEST.contributes.accountCollections[0],
            indexes: [{
                id: "by-status",
                fields: [{ field: "status", direction: "asc" }],
            }],
        }],
    },
} as const;

const TARGET_MANIFEST_WITH_INDEX_AND_RELATION = {
    ...TARGET_MANIFEST_WITH_INDEX,
    contributes: {
        accountCollections: [{
            ...TARGET_MANIFEST_WITH_INDEX.contributes.accountCollections[0],
            indexes: [
                ...TARGET_MANIFEST_WITH_INDEX.contributes.accountCollections[0].indexes,
                {
                    id: "by-title",
                    fields: [{ field: "title", direction: "asc" }],
                },
            ],
            relations: [{
                id: "required-related-task",
                kind: "collection",
                field: "title",
                collectionId: COLLECTION_ID,
                required: true,
                onDelete: "restrict",
            }],
        }],
    },
} as const;

function toPrismaJson(value: unknown): Prisma.InputJsonValue {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("Fixture JSON must be serializable.");
    return JSON.parse(serialized) as Prisma.InputJsonValue;
}

async function materialize(manifest: unknown) {
    return await inTx(async (tx) => (
        await materializePluginCollectionContractsFromManifestTx({ tx, manifest })
    ));
}

async function seedRelease(input: Readonly<{
    accountId: string;
    version: string;
    manifest: unknown;
    contracts: readonly unknown[];
}>): Promise<void> {
    await db.accountPluginRelease.create({
        data: {
            accountId: input.accountId,
            pluginId: PLUGIN_ID,
            version: input.version,
            archiveDigestSha256: `sha256:${(input.version === SOURCE_VERSION ? "a" : "b").repeat(64)}`,
            normalizedManifest: toPrismaJson(input.manifest),
            collectionContracts: toPrismaJson(input.contracts),
            uiSlots: [],
            packageAssetArchive: toPrismaJson({
                archiveDigestSha256: `sha256:${"c".repeat(64)}`,
                resources: [],
            }),
        },
    });
}

async function seedCurrentSource(input: Readonly<{
    accountId: string;
    source: Readonly<{
        pluginId: string;
        collectionId: string;
        schemaVersion: number;
        contractDigest: string;
    }>;
    enabled: boolean;
}>): Promise<Readonly<{ id: string }>> {
    const contract = await db.pluginCollectionContract.findFirstOrThrow({
        where: {
            pluginId: input.source.pluginId,
            collectionId: input.source.collectionId,
            schemaVersion: input.source.schemaVersion,
            contractDigest: input.source.contractDigest,
        },
        select: { id: true },
    });
    await db.accountPluginIntent.create({
        data: {
            accountId: input.accountId,
            pluginId: PLUGIN_ID,
            desiredVersion: SOURCE_VERSION,
            enabled: input.enabled,
            offlineUiHosting: "disabled",
            writableCollections: toPrismaJson([input.source]),
            revision: BigInt(0),
        },
    });
    return contract;
}

async function seedLiveSourceRow(input: Readonly<{
    accountId: string;
    contract: Readonly<{
        id: string;
        schemaVersion: number;
        contractDigest: string;
    }>;
    rowId: string;
    revision?: number;
}>): Promise<Readonly<{ id: string }>> {
    const revision = input.revision ?? 1;
    const row = await db.pluginCollectionRow.create({
        data: {
            accountId: input.accountId,
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
            rowId: input.rowId,
            schemaVersion: input.contract.schemaVersion,
            revision,
            contractId: input.contract.id,
            contractDigest: input.contract.contractDigest,
            contentEnvelope: { t: "plain", v: {} },
        },
        select: { id: true },
    });
    await db.pluginCollectionProjection.createMany({
        data: [
            { fieldId: "id", typedEncodedValue: JSON.stringify(input.rowId) },
            { fieldId: "status", typedEncodedValue: JSON.stringify("open") },
            { fieldId: "title", typedEncodedValue: JSON.stringify("Source title") },
        ].map((projection) => ({
            ...projection,
            rowDbId: row.id,
            accountId: input.accountId,
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
            rowId: input.rowId,
            rowRevision: revision,
        })),
    });
    return row;
}

function availabilityOperations() {
    return createPluginAvailabilityOperations({
        resolveHostingCapability: () => ({
            enabled: true,
            maxArtifactBytes: 1024 * 1024,
            maxAccountBytes: 4 * 1024 * 1024,
        }),
        resolveServerIdentityId: async () => "candidate-preparation-server",
    });
}

async function prepareAvailabilityPromotionFixture(input: Readonly<{
    targetManifest?: unknown;
    rowIds?: readonly string[];
    sourceRevisions?: readonly number[];
    targetTitles?: readonly string[];
}> = {}) {
    const [source] = await materialize(SOURCE_MANIFEST);
    const targetManifest = input.targetManifest ?? TARGET_MANIFEST_WITH_INDEX;
    const [target] = await materialize(targetManifest);
    if (!source || !target) throw new Error("Expected source and target contracts.");
    await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
    const sourceContract = await seedCurrentSource({ accountId: ACCOUNT_ID, source, enabled: true });
    await seedRelease({
        accountId: ACCOUNT_ID,
        version: SOURCE_VERSION,
        manifest: SOURCE_MANIFEST,
        contracts: [source],
    });
    await seedRelease({
        accountId: ACCOUNT_ID,
        version: TARGET_VERSION,
        manifest: targetManifest,
        contracts: [target],
    });
    const rowIds = input.rowIds ?? ["task-a", "task-b"];
    const sourceRows = [];
    for (const [index, rowId] of rowIds.entries()) {
        sourceRows.push(await seedLiveSourceRow({
            accountId: ACCOUNT_ID,
            contract: { ...sourceContract, ...source },
            rowId,
            revision: input.sourceRevisions?.[index],
        }));
    }
    const [first, second] = sourceRows;
    if (first && second) {
        await db.pluginCollectionRelation.create({
            data: {
                accountId: ACCOUNT_ID,
                sourceRowDbId: second.id,
                sourcePluginId: PLUGIN_ID,
                sourceCollectionId: COLLECTION_ID,
                sourceRowId: rowIds[1]!,
                relationId: "retired-source-edge",
                targetKind: "collection",
                targetPluginId: PLUGIN_ID,
                targetCollectionId: COLLECTION_ID,
                targetRowId: rowIds[0]!,
                sourceRevision: input.sourceRevisions?.[1] ?? 1,
            },
        });
    }
    const binding = {
        source,
        target,
        candidate: { releaseVersion: TARGET_VERSION, artifactDigest: `sha256:${"a".repeat(64)}` },
    } as const;
    const targetTitles = input.targetTitles ?? ["Target A", "Target B"];
    await stagePluginCollectionCandidatePreparation({
        accountId: ACCOUNT_ID,
        request: {
            binding,
            items: rowIds.map((rowId, index) => ({
                source: { rowId, revision: input.sourceRevisions?.[index] ?? 1 },
                target: {
                    content: { t: "plain", v: {} },
                    projection: {
                        id: rowId,
                        status: "open",
                        title: targetTitles[index] ?? `Target ${rowId}`,
                    },
                },
            })),
        },
    });
    return { source, target, service: availabilityOperations() };
}

describe("plugin Collection candidate preparation", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-candidate-preparation-",
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
            () => db.pluginCollectionCandidatePreparationStage.deleteMany(),
            () => db.pluginCollectionIndexEntry.deleteMany(),
            () => db.pluginCollectionProjection.deleteMany(),
            () => db.pluginCollectionRelation.deleteMany(),
            () => db.pluginCollectionRow.deleteMany(),
            () => db.pluginCollectionIndexState.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.pluginCollectionContract.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("accepts a disabled but current source intent, keeps first targets for a bounded batch, and retires only its exact binding", async () => {
        const [source] = await materialize(SOURCE_MANIFEST);
        const [target] = await materialize(TARGET_MANIFEST);
        if (!source || !target) throw new Error("Expected source and target contracts.");
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
        const sourceContract = await seedCurrentSource({
            accountId: ACCOUNT_ID,
            source,
            enabled: false,
        });
        await seedRelease({ accountId: ACCOUNT_ID, version: SOURCE_VERSION, manifest: SOURCE_MANIFEST, contracts: [source] });
        await seedRelease({ accountId: ACCOUNT_ID, version: TARGET_VERSION, manifest: TARGET_MANIFEST, contracts: [target] });
        await seedLiveSourceRow({ accountId: ACCOUNT_ID, contract: { ...sourceContract, ...source }, rowId: "task-1" });
        await seedLiveSourceRow({ accountId: ACCOUNT_ID, contract: { ...sourceContract, ...source }, rowId: "task-2" });

        const binding = {
            source,
            target,
            candidate: { releaseVersion: TARGET_VERSION, artifactDigest: `sha256:${"a".repeat(64)}` },
        } as const;
        const first = await pagePluginCollectionCandidatePreparationSource({
            accountId: ACCOUNT_ID,
            request: { binding, limit: 10 },
        });
        expect(first).toMatchObject({
            rows: expect.arrayContaining([
                {
                    rowId: "task-1",
                    revision: 1,
                    content: { t: "plain", v: {} },
                    projection: { id: "task-1", status: "open", title: "Source title" },
                    alreadyStaged: false,
                },
                {
                    rowId: "task-2",
                    revision: 1,
                    content: { t: "plain", v: {} },
                    projection: { id: "task-2", status: "open", title: "Source title" },
                    alreadyStaged: false,
                },
            ]),
        });

        await expect(stagePluginCollectionCandidatePreparation({
            accountId: ACCOUNT_ID,
            request: {
                binding,
                items: [
                    {
                        source: { rowId: "task-1", revision: 1 },
                        target: {
                            content: { t: "plain", v: {} },
                            projection: { id: "task-1", status: "open", title: "First target" },
                        },
                    },
                    {
                        source: { rowId: "task-2", revision: 1 },
                        target: {
                            content: { t: "plain", v: {} },
                            projection: { id: "task-2", status: "closed", title: "Second target" },
                        },
                    },
                ],
            },
        })).resolves.toEqual({ results: [{ status: "staged" }, { status: "staged" }] });
        await expect(stagePluginCollectionCandidatePreparation({
            accountId: ACCOUNT_ID,
            request: {
                binding,
                items: [
                    {
                        source: { rowId: "task-1", revision: 1 },
                        target: {
                            content: { t: "plain", v: {} },
                            projection: { id: "task-1", status: "closed", title: "Replayed target" },
                        },
                    },
                    {
                        source: { rowId: "task-2", revision: 1 },
                        target: {
                            content: { t: "plain", v: {} },
                            projection: { id: "task-2", status: "open", title: "Replayed target two" },
                        },
                    },
                ],
            },
        })).resolves.toEqual({ results: [{ status: "staged" }, { status: "staged" }] });

        await expect(pagePluginCollectionCandidatePreparationSource({
            accountId: ACCOUNT_ID,
            request: { binding, limit: 10 },
        })).resolves.toMatchObject({
            rows: expect.arrayContaining([
                expect.objectContaining({ rowId: "task-1", alreadyStaged: true }),
                expect.objectContaining({ rowId: "task-2", alreadyStaged: true }),
            ]),
        });
        await expect(db.pluginCollectionCandidatePreparationStage.findMany({
            where: { accountId: ACCOUNT_ID },
            select: { rowId: true, targetProjection: true },
            orderBy: { rowId: "asc" },
        })).resolves.toEqual([
            {
                rowId: "task-1",
                targetProjection: { id: "task-1", status: "open", title: "First target" },
            },
            {
                rowId: "task-2",
                targetProjection: { id: "task-2", status: "closed", title: "Second target" },
            },
        ]);

        await retirePluginCollectionCandidatePreparation({
            accountId: ACCOUNT_ID,
            request: { binding: { ...binding, candidate: { ...binding.candidate, artifactDigest: `sha256:${"b".repeat(64)}` } } },
        });
        await expect(db.pluginCollectionCandidatePreparationStage.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(2);
        await retirePluginCollectionCandidatePreparation({ accountId: ACCOUNT_ID, request: { binding } });
        await expect(db.pluginCollectionCandidatePreparationStage.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(0);
    });

    it("validates every stage item before a batch can insert any target", async () => {
        const [source] = await materialize(SOURCE_MANIFEST);
        const [target] = await materialize(TARGET_MANIFEST);
        if (!source || !target) throw new Error("Expected source and target contracts.");
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
        const sourceContract = await seedCurrentSource({ accountId: ACCOUNT_ID, source, enabled: true });
        await seedRelease({ accountId: ACCOUNT_ID, version: SOURCE_VERSION, manifest: SOURCE_MANIFEST, contracts: [source] });
        await seedRelease({ accountId: ACCOUNT_ID, version: TARGET_VERSION, manifest: TARGET_MANIFEST, contracts: [target] });
        await seedLiveSourceRow({ accountId: ACCOUNT_ID, contract: { ...sourceContract, ...source }, rowId: "task-1" });
        await seedLiveSourceRow({ accountId: ACCOUNT_ID, contract: { ...sourceContract, ...source }, rowId: "task-2" });
        const binding = {
            source,
            target,
            candidate: { releaseVersion: TARGET_VERSION, artifactDigest: `sha256:${"e".repeat(64)}` },
        } as const;

        await expect(stagePluginCollectionCandidatePreparation({
            accountId: ACCOUNT_ID,
            request: {
                binding,
                items: [
                    {
                        source: { rowId: "task-1", revision: 1 },
                        target: {
                            content: { t: "plain", v: {} },
                            projection: { id: "task-1", status: "open", title: "Valid target" },
                        },
                    },
                    {
                        source: { rowId: "task-2", revision: 1 },
                        target: {
                            content: { t: "plain", v: {} },
                            projection: { id: "task-2", status: "open" },
                        },
                    },
                ],
            },
        })).rejects.toMatchObject({ code: "collection_candidate_preparation_invalid" });
        await expect(db.pluginCollectionCandidatePreparationStage.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(0);
    });

    it("rejects a source row that exists only under another Account", async () => {
        const [source] = await materialize(SOURCE_MANIFEST);
        const [target] = await materialize(TARGET_MANIFEST);
        if (!source || !target) throw new Error("Expected source and target contracts.");
        await db.account.createMany({
            data: [
                { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" },
                { id: OTHER_ACCOUNT_ID, publicKey: null, encryptionMode: "plain" },
            ],
        });
        const accountSource = await seedCurrentSource({ accountId: ACCOUNT_ID, source, enabled: true });
        const otherSource = await seedCurrentSource({ accountId: OTHER_ACCOUNT_ID, source, enabled: true });
        await seedRelease({ accountId: ACCOUNT_ID, version: SOURCE_VERSION, manifest: SOURCE_MANIFEST, contracts: [source] });
        await seedRelease({ accountId: ACCOUNT_ID, version: TARGET_VERSION, manifest: TARGET_MANIFEST, contracts: [target] });
        await seedRelease({ accountId: OTHER_ACCOUNT_ID, version: SOURCE_VERSION, manifest: SOURCE_MANIFEST, contracts: [source] });
        await seedRelease({ accountId: OTHER_ACCOUNT_ID, version: TARGET_VERSION, manifest: TARGET_MANIFEST, contracts: [target] });
        await seedLiveSourceRow({ accountId: ACCOUNT_ID, contract: { ...accountSource, ...source }, rowId: "account-task" });
        await seedLiveSourceRow({ accountId: OTHER_ACCOUNT_ID, contract: { ...otherSource, ...source }, rowId: "other-task" });

        const binding = {
            source,
            target,
            candidate: { releaseVersion: TARGET_VERSION, artifactDigest: `sha256:${"a".repeat(64)}` },
        } as const;
        await expect(stagePluginCollectionCandidatePreparation({
            accountId: ACCOUNT_ID,
            request: {
                binding,
                items: [
                    {
                        source: { rowId: "other-task", revision: 1 },
                        target: {
                            content: { t: "plain", v: {} },
                            projection: { id: "other-task", status: "open", title: "Must not stage" },
                        },
                    },
                    {
                        source: { rowId: "account-task", revision: 1 },
                        target: {
                            content: { t: "plain", v: {} },
                            projection: { id: "account-task", status: "open", title: "Stages after stale source" },
                        },
                    },
                ],
            },
        })).resolves.toEqual({ results: [{ status: "sourceChanged" }, { status: "staged" }] });
        await expect(db.pluginCollectionCandidatePreparationStage.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);
    });

    it.each([
        ["tombstone-only", true],
        ["never-populated", false],
    ] as const)("adopts a digest-only target for a %s source without requiring a row migration callback", async (_sourceState, seedTombstone) => {
        const [source] = await materialize(SOURCE_MANIFEST);
        const [target] = await materialize(TARGET_MANIFEST_WITHOUT_ROW_MIGRATION);
        if (!source || !target) throw new Error("Expected source and target contracts.");
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
        const sourceContract = await seedCurrentSource({ accountId: ACCOUNT_ID, source, enabled: true });
        await seedRelease({ accountId: ACCOUNT_ID, version: SOURCE_VERSION, manifest: SOURCE_MANIFEST, contracts: [source] });
        await seedRelease({
            accountId: ACCOUNT_ID,
            version: TARGET_VERSION,
            manifest: TARGET_MANIFEST_WITHOUT_ROW_MIGRATION,
            contracts: [target],
        });
        if (seedTombstone) {
            const tombstone = await seedLiveSourceRow({
                accountId: ACCOUNT_ID,
                contract: { ...sourceContract, ...source },
                rowId: "retained-tombstone",
            });
            await db.pluginCollectionRow.update({
                where: { id: tombstone.id },
                data: { deletedAt: new Date() },
            });
        }
        const binding = {
            source,
            target,
            candidate: { releaseVersion: TARGET_VERSION, artifactDigest: `sha256:${"a".repeat(64)}` },
        } as const;

        await expect(pagePluginCollectionCandidatePreparationSource({
            accountId: ACCOUNT_ID,
            request: { binding, limit: 10 },
        })).resolves.toEqual({ rows: [] });

        const currentIntent = await db.accountPluginIntent.findUniqueOrThrow({
            where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } },
            select: {
                pluginId: true,
                desiredVersion: true,
                enabled: true,
                offlineUiHosting: true,
                writableCollections: true,
                revision: true,
            },
        });
        await expect(inTx(async (tx) => {
            await promotePluginCollectionCandidatePreparationInTx({
                tx,
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                currentIntent,
                targetReleaseVersion: TARGET_VERSION,
                targetContracts: [target],
            });
            return await preparePluginCollectionWritableContractsTx({
                tx,
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                contracts: [target],
            });
        })).resolves.toEqual({ contracts: [target] });
    });

    it("counts the canonical source plus prospective target through the existing quota owner before staging", async () => {
        const [source] = await materialize(SOURCE_MANIFEST);
        const [target] = await materialize(TARGET_MANIFEST);
        if (!source || !target) throw new Error("Expected source and target contracts.");
        harness.resetEnv({
            HAPPIER_COLLECTION_MAX_ACCOUNT_ROWS: "1",
            HAPPIER_COLLECTION_MAX_BATCH_ROWS: "1",
        });
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
        const sourceContract = await seedCurrentSource({ accountId: ACCOUNT_ID, source, enabled: true });
        await seedRelease({ accountId: ACCOUNT_ID, version: SOURCE_VERSION, manifest: SOURCE_MANIFEST, contracts: [source] });
        await seedRelease({ accountId: ACCOUNT_ID, version: TARGET_VERSION, manifest: TARGET_MANIFEST, contracts: [target] });
        await seedLiveSourceRow({ accountId: ACCOUNT_ID, contract: { ...sourceContract, ...source }, rowId: "task-1" });
        const binding = {
            source,
            target,
            candidate: { releaseVersion: TARGET_VERSION, artifactDigest: `sha256:${"c".repeat(64)}` },
        } as const;

        await expect(stagePluginCollectionCandidatePreparation({
            accountId: ACCOUNT_ID,
            request: {
                binding,
                items: [{
                    source: { rowId: "task-1", revision: 1 },
                    target: {
                        content: { t: "plain", v: {} },
                        projection: { id: "task-1", status: "open", title: "Target" },
                    },
                }],
            },
        })).rejects.toMatchObject({
            code: "collection_quota_incompatible",
            dimension: "maxRows",
            effectiveMaximum: 1,
        });
        await expect(db.pluginCollectionCandidatePreparationStage.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(0);
    });

    it("scans every live quota row through bounded compact activation pages", async () => {
        const [source] = await materialize(SOURCE_MANIFEST);
        if (!source) throw new Error("Expected source contract.");
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
        const sourceContract = await seedCurrentSource({ accountId: ACCOUNT_ID, source, enabled: true });
        // More live rows than one page sized from the deployment row-byte
        // ceiling, so a census that stopped paging would be visible here.
        const seededRowIds = Array.from({ length: 40 }, (_, index) => `task-${String(index).padStart(3, "0")}`);
        for (const rowId of seededRowIds) {
            await seedLiveSourceRow({ accountId: ACCOUNT_ID, contract: { ...sourceContract, ...source }, rowId });
        }

        await expect(inTx(async (tx) => {
            const requestedPageSizes: unknown[] = [];
            const rows = new Proxy(tx.pluginCollectionRow, {
                get(target, property, receiver) {
                    if (property !== "findMany") return Reflect.get(target, property, receiver);
                    const findMany = Reflect.get(target, property, target);
                    if (typeof findMany !== "function") {
                        throw new Error("Expected the Collection row delegate to expose findMany.");
                    }
                    return async (...args: unknown[]) => {
                        const request = args[0];
                        requestedPageSizes.push(
                            request && typeof request === "object" && "take" in request
                                ? (request as Readonly<{ take?: unknown }>).take
                                : undefined,
                        );
                        return await Reflect.apply(findMany, target, args);
                    };
                },
            });
            const boundedTx = new Proxy(tx, {
                get(target, property, receiver) {
                    if (property === "pluginCollectionRow") return rows;
                    return Reflect.get(target, property, receiver);
                },
            });
            const usage = await readPluginCollectionAccountActivationUsageInTx({
                tx: boundedTx,
                accountId: ACCOUNT_ID,
                deployment: readPluginsFeatureEnv(process.env).collectionLimits,
            });
            const collection = usage.collections.get(`${PLUGIN_ID}\u0000${COLLECTION_ID}`);
            return {
                rows: usage.rows,
                collectionRows: collection?.rows,
                retainsRowSizeMap: collection !== undefined && "rowEncodedBytesByRowId" in collection,
                // The first page is sized from the 512 KiB row ceiling, so 40
                // rows cannot arrive in one unbounded read.
                pages: requestedPageSizes.length,
                firstPageBounded: typeof requestedPageSizes[0] === "number" && requestedPageSizes[0] <= 64,
                everyPageBounded: requestedPageSizes.every((take) => typeof take === "number" && take >= 1),
            };
        })).resolves.toEqual({
            rows: 40,
            collectionRows: 40,
            retainsRowSizeMap: false,
            pages: 2,
            firstPageBounded: true,
            everyPageBounded: true,
        });
    });

    it("rejects an over-limit candidate stage batch before inserting any target", async () => {
        const [source] = await materialize(SOURCE_MANIFEST);
        const [target] = await materialize(TARGET_MANIFEST);
        if (!source || !target) throw new Error("Expected source and target contracts.");
        harness.resetEnv({ HAPPIER_COLLECTION_MAX_BATCH_ROWS: "1" });
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
        const sourceContract = await seedCurrentSource({ accountId: ACCOUNT_ID, source, enabled: true });
        await seedRelease({ accountId: ACCOUNT_ID, version: SOURCE_VERSION, manifest: SOURCE_MANIFEST, contracts: [source] });
        await seedRelease({ accountId: ACCOUNT_ID, version: TARGET_VERSION, manifest: TARGET_MANIFEST, contracts: [target] });
        await seedLiveSourceRow({ accountId: ACCOUNT_ID, contract: { ...sourceContract, ...source }, rowId: "task-1" });
        await seedLiveSourceRow({ accountId: ACCOUNT_ID, contract: { ...sourceContract, ...source }, rowId: "task-2" });
        const binding = {
            source,
            target,
            candidate: { releaseVersion: TARGET_VERSION, artifactDigest: `sha256:${"f".repeat(64)}` },
        } as const;

        await expect(stagePluginCollectionCandidatePreparation({
            accountId: ACCOUNT_ID,
            request: {
                binding,
                items: [
                    {
                        source: { rowId: "task-1", revision: 1 },
                        target: {
                            content: { t: "plain", v: {} },
                            projection: { id: "task-1", status: "open", title: "First target" },
                        },
                    },
                    {
                        source: { rowId: "task-2", revision: 1 },
                        target: {
                            content: { t: "plain", v: {} },
                            projection: { id: "task-2", status: "open", title: "Second target" },
                        },
                    },
                ],
            },
        })).rejects.toMatchObject({
            code: "collection_quota_incompatible",
            dimension: "maxBatchRows",
            effectiveMaximum: 1,
        });
        await expect(db.pluginCollectionCandidatePreparationStage.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(0);
    });

    it("retires an exact stage when the canonical source writer advances its revision", async () => {
        const [source] = await materialize(SOURCE_MANIFEST);
        const [target] = await materialize(TARGET_MANIFEST);
        if (!source || !target) throw new Error("Expected source and target contracts.");
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
        const sourceContract = await seedCurrentSource({ accountId: ACCOUNT_ID, source, enabled: true });
        await seedRelease({ accountId: ACCOUNT_ID, version: SOURCE_VERSION, manifest: SOURCE_MANIFEST, contracts: [source] });
        await seedRelease({ accountId: ACCOUNT_ID, version: TARGET_VERSION, manifest: TARGET_MANIFEST, contracts: [target] });
        await seedLiveSourceRow({ accountId: ACCOUNT_ID, contract: { ...sourceContract, ...source }, rowId: "task-1" });
        const binding = {
            source,
            target,
            candidate: { releaseVersion: TARGET_VERSION, artifactDigest: `sha256:${"d".repeat(64)}` },
        } as const;
        await stagePluginCollectionCandidatePreparation({
            accountId: ACCOUNT_ID,
            request: {
                binding,
                items: [{
                    source: { rowId: "task-1", revision: 1 },
                    target: {
                        content: { t: "plain", v: {} },
                        projection: { id: "task-1", status: "open", title: "Prepared target" },
                    },
                }],
            },
        });
        await expect(db.pluginCollectionCandidatePreparationStage.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);

        await mutatePluginCollection({
            accountId: ACCOUNT_ID,
            request: {
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                writerContext: {
                    schemaVersion: source.schemaVersion,
                    contractDigest: source.contractDigest,
                },
                operations: [{
                    kind: "put",
                    rowId: "task-1",
                    expectedRevision: 1,
                    content: { t: "plain", v: {} },
                    projection: { id: "task-1", status: "closed", title: "Current source" },
                }],
            },
        });
        await expect(db.pluginCollectionCandidatePreparationStage.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(0);
    });

    it("materializes validated rows, indexes, and relations before Availability publishes the target intent", async () => {
        const { target, service } = await prepareAvailabilityPromotionFixture();

        await expect(service.setIntent({
            accountId: ACCOUNT_ID,
            input: {
                pluginId: PLUGIN_ID,
                desiredVersion: TARGET_VERSION,
                enabled: true,
                offlineUiHosting: "disabled",
                writableCollections: [target],
                expectedRevision: "0",
            },
        })).resolves.toMatchObject({
            intent: {
                desiredVersion: TARGET_VERSION,
                writableCollections: [target],
                revision: "1",
            },
        });
        await expect(db.pluginCollectionRow.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { rowId: "asc" },
            select: {
                rowId: true,
                schemaVersion: true,
                revision: true,
                contractDigest: true,
                projections: {
                    orderBy: { fieldId: "asc" },
                    select: { fieldId: true, typedEncodedValue: true, rowRevision: true },
                },
            },
        })).resolves.toEqual([
            {
                rowId: "task-a",
                schemaVersion: 2,
                revision: 2,
                contractDigest: target.contractDigest,
                projections: [
                    { fieldId: "id", typedEncodedValue: "\"task-a\"", rowRevision: 2 },
                    { fieldId: "status", typedEncodedValue: "\"open\"", rowRevision: 2 },
                    { fieldId: "title", typedEncodedValue: "\"Target A\"", rowRevision: 2 },
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
                    { fieldId: "title", typedEncodedValue: "\"Target B\"", rowRevision: 2 },
                ],
            },
        ]);
        const indexState = await db.pluginCollectionIndexState.findFirstOrThrow({
            where: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                indexId: "by-status",
                contractDigest: target.contractDigest,
            },
            select: { id: true, indexedThroughRevision: true },
        });
        expect(indexState.indexedThroughRevision).toBe(2);
        await expect(db.pluginCollectionIndexEntry.findMany({
            where: { indexStateId: indexState.id },
            orderBy: { rowId: "asc" },
            select: { rowId: true, rowRevision: true },
        })).resolves.toEqual([
            { rowId: "task-a", rowRevision: 2 },
            { rowId: "task-b", rowRevision: 2 },
        ]);
        await expect(db.pluginCollectionRelation.findFirstOrThrow({
            where: { accountId: ACCOUNT_ID, relationId: "retired-source-edge" },
            select: { deletedAt: true },
        })).resolves.toMatchObject({ deletedAt: expect.any(Date) });
        await expect(db.pluginCollectionCandidatePreparationStage.count({
            where: { accountId: ACCOUNT_ID },
        })).resolves.toBe(0);
        const hint = {
            pluginDomain: "dataCollection" as const,
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
            contractDigest: target.contractDigest,
            revision: 2,
            full: true as const,
        };
        await expect(db.accountChange.findMany({
            where: { accountId: ACCOUNT_ID },
            select: { entityId: true, hint: true },
        })).resolves.toContainEqual({
            entityId: buildPluginDomainAccountChangeEntityId(hint),
            hint,
        });
        await expect(db.accountChange.count({
            where: {
                accountId: ACCOUNT_ID,
                kind: "pluginDomain",
                entityId: buildPluginDomainAccountChangeEntityId(hint),
            },
        })).resolves.toBe(1);
    });

    it("keeps a target index building until every promoted row has an index entry", async () => {
        const { target, service } = await prepareAvailabilityPromotionFixture();

        await db.$executeRawUnsafe(`
            CREATE TRIGGER candidate_promotion_target_index_requires_building
            BEFORE INSERT ON "PluginCollectionIndexEntry"
            WHEN COALESCE((
                SELECT "buildState"
                FROM "PluginCollectionIndexState"
                WHERE "id" = NEW."indexStateId"
            ), '') <> 'building'
            BEGIN
                SELECT RAISE(ABORT, 'target index entry requires a building state');
            END
        `);
        await db.$executeRawUnsafe(`
            CREATE TRIGGER candidate_promotion_target_index_requires_complete_entries
            BEFORE UPDATE OF "buildState" ON "PluginCollectionIndexState"
            WHEN OLD."buildState" = 'building'
                AND NEW."buildState" = 'ready'
                AND (
                    SELECT COUNT(*)
                    FROM "PluginCollectionIndexEntry"
                    WHERE "indexStateId" = NEW."id"
                ) <> (
                    SELECT COUNT(*)
                    FROM "PluginCollectionRow"
                    WHERE "accountId" = NEW."accountId"
                        AND "pluginId" = NEW."pluginId"
                        AND "collectionId" = NEW."collectionId"
                        AND "contractId" = NEW."contractId"
                        AND "contractDigest" = NEW."contractDigest"
                        AND "deletedAt" IS NULL
                )
            BEGIN
                SELECT RAISE(ABORT, 'target index became ready before all entries existed');
            END
        `);
        try {
            await expect(service.setIntent({
                accountId: ACCOUNT_ID,
                input: {
                    pluginId: PLUGIN_ID,
                    desiredVersion: TARGET_VERSION,
                    enabled: true,
                    offlineUiHosting: "disabled",
                    writableCollections: [target],
                    expectedRevision: "0",
                },
            })).resolves.toMatchObject({ intent: { desiredVersion: TARGET_VERSION, revision: "1" } });
        } finally {
            await db.$executeRawUnsafe(
                "DROP TRIGGER IF EXISTS candidate_promotion_target_index_requires_building",
            );
            await db.$executeRawUnsafe(
                "DROP TRIGGER IF EXISTS candidate_promotion_target_index_requires_complete_entries",
            );
        }

        await expect(db.pluginCollectionIndexState.findFirstOrThrow({
            where: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                collectionId: COLLECTION_ID,
                indexId: "by-status",
                contractDigest: target.contractDigest,
            },
            select: { buildState: true, indexedThroughRevision: true },
        })).resolves.toEqual({ buildState: "ready", indexedThroughRevision: 2 });
    });

    it("rolls back promotion when the target index is missing a live row entry", async () => {
        const { source, target, service } = await prepareAvailabilityPromotionFixture();

        await db.$executeRawUnsafe(`
            CREATE TRIGGER candidate_promotion_missing_target_index_entry
            BEFORE INSERT ON "PluginCollectionIndexEntry"
            WHEN NEW."rowId" = 'task-b'
            BEGIN
                SELECT RAISE(IGNORE);
            END
        `);
        try {
            await expect(service.setIntent({
                accountId: ACCOUNT_ID,
                input: {
                    pluginId: PLUGIN_ID,
                    desiredVersion: TARGET_VERSION,
                    enabled: true,
                    offlineUiHosting: "disabled",
                    writableCollections: [target],
                    expectedRevision: "0",
                },
            })).rejects.toMatchObject({ code: "plugin_intent_writable_collections_not_ready" });
        } finally {
            await db.$executeRawUnsafe(
                "DROP TRIGGER IF EXISTS candidate_promotion_missing_target_index_entry",
            );
        }

        await expect(db.pluginCollectionRow.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { rowId: "asc" },
            select: { schemaVersion: true, revision: true, contractDigest: true },
        })).resolves.toEqual([
            { schemaVersion: source.schemaVersion, revision: 1, contractDigest: source.contractDigest },
            { schemaVersion: source.schemaVersion, revision: 1, contractDigest: source.contractDigest },
        ]);
        await expect(db.pluginCollectionIndexState.count({
            where: { accountId: ACCOUNT_ID, contractDigest: target.contractDigest },
        })).resolves.toBe(0);
        await expect(db.pluginCollectionCandidatePreparationStage.count({
            where: { accountId: ACCOUNT_ID },
        })).resolves.toBe(2);
        await expect(db.accountPluginIntent.findUniqueOrThrow({
            where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } },
            select: { desiredVersion: true, revision: true },
        })).resolves.toEqual({ desiredVersion: SOURCE_VERSION, revision: BigInt(0) });
    });

    it("refuses an ordinary target release that omits a current Collection without mutating promotion state", async () => {
        const { service } = await prepareAvailabilityPromotionFixture();
        const [replacement] = await materialize(TARGET_MANIFEST_REPLACING_CURRENT_COLLECTION);
        if (!replacement) throw new Error("Expected replacement contract.");
        await db.accountPluginRelease.update({
            where: {
                accountId_pluginId_version: {
                    accountId: ACCOUNT_ID,
                    pluginId: PLUGIN_ID,
                    version: TARGET_VERSION,
                },
            },
            data: {
                normalizedManifest: toPrismaJson(TARGET_MANIFEST_REPLACING_CURRENT_COLLECTION),
                collectionContracts: toPrismaJson([replacement]),
            },
        });
        const readPromotionState = async () => await Promise.all([
            db.pluginCollectionRow.findMany({
                where: { accountId: ACCOUNT_ID },
                orderBy: { id: "asc" },
                select: { id: true, schemaVersion: true, revision: true, contractDigest: true },
            }),
            db.pluginCollectionCandidatePreparationStage.findMany({
                where: { accountId: ACCOUNT_ID },
                orderBy: { id: "asc" },
                select: { id: true, sourceRowDbId: true, sourceRevision: true, candidateIdentity: true },
            }),
            db.pluginCollectionIndexState.findMany({
                where: { accountId: ACCOUNT_ID },
                orderBy: { id: "asc" },
                select: { id: true, contractDigest: true, indexedThroughRevision: true },
            }),
            db.accountPluginIntent.findUniqueOrThrow({
                where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } },
                select: { desiredVersion: true, writableCollections: true, revision: true },
            }),
            db.accountChange.findMany({
                where: { accountId: ACCOUNT_ID },
                orderBy: [{ kind: "asc" }, { entityId: "asc" }],
                select: { kind: true, entityId: true, cursor: true, hint: true },
            }),
            db.account.findUniqueOrThrow({
                where: { id: ACCOUNT_ID },
                select: { seq: true },
            }),
        ]);
        const stateBefore = await readPromotionState();

        await expect(service.setIntent({
            accountId: ACCOUNT_ID,
            input: {
                pluginId: PLUGIN_ID,
                desiredVersion: TARGET_VERSION,
                enabled: true,
                offlineUiHosting: "disabled",
                writableCollections: [replacement],
                expectedRevision: "0",
            },
        })).rejects.toMatchObject({ code: "plugin_intent_writable_collections_not_ready" });

        await expect(readPromotionState()).resolves.toEqual(stateBefore);
    });

    it("uses the maximum committed target revision in its Collection reread hint", async () => {
        const { target, service } = await prepareAvailabilityPromotionFixture({
            sourceRevisions: [1, 7],
        });

        await expect(service.setIntent({
            accountId: ACCOUNT_ID,
            input: {
                pluginId: PLUGIN_ID,
                desiredVersion: TARGET_VERSION,
                enabled: true,
                offlineUiHosting: "disabled",
                writableCollections: [target],
                expectedRevision: "0",
            },
        })).resolves.toMatchObject({ intent: { desiredVersion: TARGET_VERSION, revision: "1" } });
        const hint = {
            pluginDomain: "dataCollection" as const,
            pluginId: PLUGIN_ID,
            collectionId: COLLECTION_ID,
            contractDigest: target.contractDigest,
            revision: 8,
            full: true as const,
        };
        await expect(db.accountChange.findUniqueOrThrow({
            where: {
                accountId_kind_entityId: {
                    accountId: ACCOUNT_ID,
                    kind: "pluginDomain",
                    entityId: buildPluginDomainAccountChangeEntityId(hint),
                },
            },
            select: { hint: true },
        })).resolves.toEqual({ hint });
    });

    it("refuses an ordinary target release that omits a current Collection even with zero live rows", async () => {
        const [source] = await materialize(SOURCE_MANIFEST);
        if (!source) throw new Error("Expected source contract.");
        await db.account.create({ data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" } });
        await seedCurrentSource({ accountId: ACCOUNT_ID, source, enabled: true });
        await seedRelease({
            accountId: ACCOUNT_ID,
            version: SOURCE_VERSION,
            manifest: SOURCE_MANIFEST,
            contracts: [source],
        });
        await seedRelease({
            accountId: ACCOUNT_ID,
            version: TARGET_VERSION,
            manifest: TARGET_MANIFEST_OMITTING_CURRENT_COLLECTION,
            contracts: [],
        });

        await expect(availabilityOperations().setIntent({
            accountId: ACCOUNT_ID,
            input: {
                pluginId: PLUGIN_ID,
                desiredVersion: TARGET_VERSION,
                enabled: true,
                offlineUiHosting: "disabled",
                writableCollections: [],
                expectedRevision: "0",
            },
        })).rejects.toMatchObject({ code: "plugin_intent_writable_collections_not_ready" });

        await expect(db.pluginCollectionRow.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(0);
        await expect(db.pluginCollectionCandidatePreparationStage.count({
            where: { accountId: ACCOUNT_ID },
        })).resolves.toBe(0);
        await expect(db.pluginCollectionIndexState.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(0);
        await expect(db.accountPluginIntent.findUniqueOrThrow({
            where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } },
            select: { desiredVersion: true, writableCollections: true, revision: true },
        })).resolves.toEqual({
            desiredVersion: SOURCE_VERSION,
            writableCollections: [source],
            revision: BigInt(0),
        });
        await expect(db.accountChange.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(0);
        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { seq: true },
        })).resolves.toEqual({ seq: 0 });
    });

    it("promotes one deployment-maximal SQLite candidate batch setwise", async () => {
        const maximumBatchRows = readPluginsFeatureEnv(process.env).collectionLimits.maxBatchRows;
        const rowIds = Array.from({ length: maximumBatchRows }, (_, index) => `task-${index}`);
        const { target, service } = await prepareAvailabilityPromotionFixture({ rowIds });

        await expect(service.setIntent({
            accountId: ACCOUNT_ID,
            input: {
                pluginId: PLUGIN_ID,
                desiredVersion: TARGET_VERSION,
                enabled: true,
                offlineUiHosting: "disabled",
                writableCollections: [target],
                expectedRevision: "0",
            },
        })).resolves.toMatchObject({ intent: { desiredVersion: TARGET_VERSION, revision: "1" } });
        await expect(db.pluginCollectionRow.count({
            where: { accountId: ACCOUNT_ID, schemaVersion: target.schemaVersion, revision: 2 },
        })).resolves.toBe(maximumBatchRows);
        const indexState = await db.pluginCollectionIndexState.findFirstOrThrow({
            where: {
                accountId: ACCOUNT_ID,
                indexId: "by-status",
                contractDigest: target.contractDigest,
            },
            select: { id: true, indexedThroughRevision: true },
        });
        expect(indexState.indexedThroughRevision).toBe(2);
        await expect(db.pluginCollectionIndexEntry.count({
            where: { indexStateId: indexState.id, rowRevision: 2 },
        })).resolves.toBe(maximumBatchRows);
        await expect(db.pluginCollectionCandidatePreparationStage.count({
            where: { accountId: ACCOUNT_ID },
        })).resolves.toBe(0);
    });

    it("rolls back one deployment-maximal SQLite promotion when stage retirement fails late", async () => {
        const maximumBatchRows = readPluginsFeatureEnv(process.env).collectionLimits.maxBatchRows;
        const rowIds = Array.from({ length: maximumBatchRows }, (_, index) => `task-${index}`);
        const { source, target, service } = await prepareAvailabilityPromotionFixture({ rowIds });

        await db.$executeRawUnsafe(`
            CREATE TRIGGER candidate_preparation_maximum_late_retirement_failure
            BEFORE DELETE ON "PluginCollectionCandidatePreparationStage"
            BEGIN
                SELECT RAISE(ABORT, 'late maximal candidate promotion failure');
            END
        `);
        try {
            await expect(service.setIntent({
                accountId: ACCOUNT_ID,
                input: {
                    pluginId: PLUGIN_ID,
                    desiredVersion: TARGET_VERSION,
                    enabled: true,
                    offlineUiHosting: "disabled",
                    writableCollections: [target],
                    expectedRevision: "0",
                },
            })).rejects.toThrow(/pluginCollectionCandidatePreparationStage\.deleteMany/);
        } finally {
            await db.$executeRawUnsafe(
                "DROP TRIGGER IF EXISTS candidate_preparation_maximum_late_retirement_failure",
            );
        }

        await expect(db.pluginCollectionRow.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { rowId: "asc" },
            select: { schemaVersion: true, revision: true, contractDigest: true },
        })).resolves.toEqual(rowIds.map(() => ({
            schemaVersion: source.schemaVersion,
            revision: 1,
            contractDigest: source.contractDigest,
        })));
        await expect(db.pluginCollectionProjection.count({
            where: { accountId: ACCOUNT_ID, rowRevision: 2 },
        })).resolves.toBe(0);
        await expect(db.pluginCollectionIndexState.count({
            where: { accountId: ACCOUNT_ID, contractDigest: target.contractDigest },
        })).resolves.toBe(0);
        await expect(db.pluginCollectionRelation.count({
            where: { accountId: ACCOUNT_ID, relationId: "retired-source-edge", deletedAt: null },
        })).resolves.toBe(1);
        await expect(db.pluginCollectionCandidatePreparationStage.count({
            where: { accountId: ACCOUNT_ID },
        })).resolves.toBe(maximumBatchRows);
        await expect(db.accountPluginIntent.findUniqueOrThrow({
            where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } },
            select: { desiredVersion: true, revision: true },
        })).resolves.toEqual({ desiredVersion: SOURCE_VERSION, revision: BigInt(0) });
    });

    it("rejects a partial setwise row CAS before Availability can publish the target intent", async () => {
        const { source, target, service } = await prepareAvailabilityPromotionFixture();

        await db.$executeRawUnsafe(`
            CREATE TRIGGER candidate_promotion_partial_row_cas
            BEFORE UPDATE ON "PluginCollectionRow"
            WHEN NEW."schemaVersion" = ${target.schemaVersion} AND OLD."rowId" = 'task-b'
            BEGIN
                SELECT RAISE(IGNORE);
            END
        `);
        try {
            await expect(service.setIntent({
                accountId: ACCOUNT_ID,
                input: {
                    pluginId: PLUGIN_ID,
                    desiredVersion: TARGET_VERSION,
                    enabled: true,
                    offlineUiHosting: "disabled",
                    writableCollections: [target],
                    expectedRevision: "0",
                },
            })).rejects.toMatchObject({ code: "plugin_intent_writable_collections_not_ready" });
        } finally {
            await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS candidate_promotion_partial_row_cas");
        }

        await expect(db.pluginCollectionRow.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { rowId: "asc" },
            select: { schemaVersion: true, revision: true, contractDigest: true },
        })).resolves.toEqual([
            { schemaVersion: source.schemaVersion, revision: 1, contractDigest: source.contractDigest },
            { schemaVersion: source.schemaVersion, revision: 1, contractDigest: source.contractDigest },
        ]);
        await expect(db.pluginCollectionProjection.count({
            where: { accountId: ACCOUNT_ID, rowRevision: 2 },
        })).resolves.toBe(0);
        await expect(db.pluginCollectionIndexState.count({
            where: { accountId: ACCOUNT_ID, contractDigest: target.contractDigest },
        })).resolves.toBe(0);
        await expect(db.pluginCollectionRelation.count({
            where: { accountId: ACCOUNT_ID, relationId: "retired-source-edge", deletedAt: null },
        })).resolves.toBe(1);
        await expect(db.pluginCollectionCandidatePreparationStage.count({
            where: { accountId: ACCOUNT_ID },
        })).resolves.toBe(2);
        await expect(db.accountPluginIntent.findUniqueOrThrow({
            where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } },
            select: { desiredVersion: true, revision: true },
        })).resolves.toEqual({ desiredVersion: SOURCE_VERSION, revision: BigInt(0) });
    });

    it("validates candidate relations before target derived-state writes", async () => {
        const { target, service } = await prepareAvailabilityPromotionFixture({
            targetManifest: TARGET_MANIFEST_WITH_INDEX_AND_RELATION,
            targetTitles: ["missing-task-a", "missing-task-b"],
        });

        await db.$executeRawUnsafe(`
            CREATE TRIGGER candidate_promotion_relation_preflight
            BEFORE INSERT ON "PluginCollectionIndexState"
            BEGIN
                SELECT RAISE(ABORT, 'target derived state was written before relation validation');
            END
        `);
        try {
            await expect(service.setIntent({
                accountId: ACCOUNT_ID,
                input: {
                    pluginId: PLUGIN_ID,
                    desiredVersion: TARGET_VERSION,
                    enabled: true,
                    offlineUiHosting: "disabled",
                    writableCollections: [target],
                    expectedRevision: "0",
                },
            })).rejects.toMatchObject({ code: "plugin_intent_writable_collections_not_ready" });
        } finally {
            await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS candidate_promotion_relation_preflight");
        }
        await expect(db.pluginCollectionIndexState.count({
            where: { accountId: ACCOUNT_ID, contractDigest: target.contractDigest },
        })).resolves.toBe(0);
    });

    it("rolls back promoted rows and Collection hints when Availability intent publication fails late", async () => {
        const { target, service } = await prepareAvailabilityPromotionFixture();
        const rowsBefore = await db.pluginCollectionRow.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { rowId: "asc" },
            select: {
                id: true,
                rowId: true,
                schemaVersion: true,
                revision: true,
                contractId: true,
                contractDigest: true,
                contentEnvelope: true,
                deletedAt: true,
            },
        });
        const projectionsBefore = await db.pluginCollectionProjection.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: [{ rowId: "asc" }, { fieldId: "asc" }],
            select: { rowDbId: true, rowId: true, fieldId: true, typedEncodedValue: true, rowRevision: true },
        });
        const indexStatesBefore = await db.pluginCollectionIndexState.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { id: "asc" },
            select: { id: true, indexId: true, contractId: true, contractDigest: true, indexedThroughRevision: true },
        });
        const indexEntriesBefore = await db.pluginCollectionIndexEntry.findMany({
            orderBy: { id: "asc" },
            select: { indexStateId: true, rowId: true, rowRevision: true, encodedSortKey: true },
        });
        const relationsBefore = await db.pluginCollectionRelation.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { id: "asc" },
            select: {
                sourceRowDbId: true,
                relationId: true,
                targetKind: true,
                targetPluginId: true,
                targetCollectionId: true,
                targetRowId: true,
                sourceRevision: true,
                deletedAt: true,
            },
        });
        const stagesBefore = await db.pluginCollectionCandidatePreparationStage.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { rowId: "asc" },
            select: { id: true, sourceRowDbId: true, sourceRevision: true, targetProjection: true },
        });
        const intentBefore = await db.accountPluginIntent.findUniqueOrThrow({
            where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } },
            select: { desiredVersion: true, writableCollections: true, revision: true },
        });
        const accountChangesBefore = await db.accountChange.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: [{ kind: "asc" }, { entityId: "asc" }],
            select: { kind: true, entityId: true, cursor: true, hint: true },
        });
        const accountBefore = await db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { seq: true },
        });

        await db.$executeRawUnsafe(`
            CREATE TRIGGER candidate_preparation_late_intent_publication_failure
            BEFORE UPDATE ON "AccountPluginIntent"
            WHEN NEW."desiredVersion" = '${TARGET_VERSION}'
            BEGIN
                SELECT RAISE(ABORT, 'late intent publication failure');
            END
        `);
        try {
            await expect(service.setIntent({
                accountId: ACCOUNT_ID,
                input: {
                    pluginId: PLUGIN_ID,
                    desiredVersion: TARGET_VERSION,
                    enabled: true,
                    offlineUiHosting: "disabled",
                    writableCollections: [target],
                    expectedRevision: "0",
                },
            })).rejects.toThrow(/accountPluginIntent\.updateMany/);
        } finally {
            await db.$executeRawUnsafe("DROP TRIGGER IF EXISTS candidate_preparation_late_intent_publication_failure");
        }

        await expect(db.pluginCollectionRow.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { rowId: "asc" },
            select: {
                id: true,
                rowId: true,
                schemaVersion: true,
                revision: true,
                contractId: true,
                contractDigest: true,
                contentEnvelope: true,
                deletedAt: true,
            },
        })).resolves.toEqual(rowsBefore);
        await expect(db.pluginCollectionProjection.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: [{ rowId: "asc" }, { fieldId: "asc" }],
            select: { rowDbId: true, rowId: true, fieldId: true, typedEncodedValue: true, rowRevision: true },
        })).resolves.toEqual(projectionsBefore);
        await expect(db.pluginCollectionIndexState.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { id: "asc" },
            select: { id: true, indexId: true, contractId: true, contractDigest: true, indexedThroughRevision: true },
        })).resolves.toEqual(indexStatesBefore);
        await expect(db.pluginCollectionIndexEntry.findMany({
            orderBy: { id: "asc" },
            select: { indexStateId: true, rowId: true, rowRevision: true, encodedSortKey: true },
        })).resolves.toEqual(indexEntriesBefore);
        await expect(db.pluginCollectionRelation.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { id: "asc" },
            select: {
                sourceRowDbId: true,
                relationId: true,
                targetKind: true,
                targetPluginId: true,
                targetCollectionId: true,
                targetRowId: true,
                sourceRevision: true,
                deletedAt: true,
            },
        })).resolves.toEqual(relationsBefore);
        await expect(db.pluginCollectionCandidatePreparationStage.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { rowId: "asc" },
            select: { id: true, sourceRowDbId: true, sourceRevision: true, targetProjection: true },
        })).resolves.toEqual(stagesBefore);
        await expect(db.accountPluginIntent.findUniqueOrThrow({
            where: { accountId_pluginId: { accountId: ACCOUNT_ID, pluginId: PLUGIN_ID } },
            select: { desiredVersion: true, writableCollections: true, revision: true },
        })).resolves.toEqual(intentBefore);
        await expect(db.accountChange.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: [{ kind: "asc" }, { entityId: "asc" }],
            select: { kind: true, entityId: true, cursor: true, hint: true },
        })).resolves.toEqual(accountChangesBefore);
        await expect(db.account.findUniqueOrThrow({
            where: { id: ACCOUNT_ID },
            select: { seq: true },
        })).resolves.toEqual(accountBefore);
    });
});
