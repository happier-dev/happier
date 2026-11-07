import { randomUUID } from "node:crypto";

import {
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    normalizePluginReleaseFactsV1,
    openAutomationTriggerDefinitionStoredEnvelopeV1,
    type PluginJsonSchemaV2,
} from "@happier-dev/protocol";
import { createPluginEventAutomationSetupResultV1JsonSchema } from "@happier-dev/protocol/automations/event-setup-result";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { inTx, type Tx } from "@/storage/inTx";
import { observeLazyPrismaQuery } from "@/app/changes/accountPublicationContention.testkit";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createAutomationWorkflowRecipeFixture } from "@/testkit/automationWorkflowRecipe";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { AutomationDefinitionCreateRequestSchema } from "@happier-dev/protocol/automations/automationApiV3";
import { deriveAutomationOccurrenceKeyV1 } from "@happier-dev/protocol/automations/automationOccurrenceV1";

import {
    AutomationTriggerMutationConflictError,
    createAutomation,
    getAutomation,
    deleteAutomation,
    disableAutomationInTx,
    finalizeDeletedAutomationsWithoutRetainedRunsTx,
    runAutomationNow,
    setAutomationEnabled,
    reconcileAutomationDefinition,
    updateAutomation,
    updateAutomationTrigger,
} from "./automationCrudService";
import { toAutomationDefinitionDetailApiDto, toAutomationDefinitionListItemApiDto } from "./automationApiProjection";
import { AutomationValidationError } from "./automationValidation";
import { admitAutomationRunTx } from "./automationRunAdmissionService";
import { readAutomationEventStoredDefinitionsV1 } from "./automationEventStoredDefinitionService";
import { getOrCreateServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { ensurePluginWebhookEndpointV1, revokePluginWebhookEndpointV1 } from "@/app/plugins/webhooks/endpointStore";
import { reportAutomationEventSourceStatusV1 } from "./automationEventSourceStatusService";
import { initEncrypt } from "@/modules/encrypt";

const EVENT_PLUGIN_ID = "com.happier.event-crud-dbcontract";
const EVENT_PLUGIN_VERSION = "1.0.0";
const EVENT_LOCAL_ID = "repository-event";
const SERVER_IDENTITY_ID = "srv_eventCrudDbcontract";
const SETUP_ACTION_LOCAL_ID = "setup-repository-source";

function resolveContractProviderFromEnv(): "postgres" | "mysql" | "sqlite" {
    const raw = String(
        process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres",
    ).trim().toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    if (raw === "sqlite") return "sqlite";
    throw new Error(
        `Unsupported contract provider: ${raw}. Set HAPPIER_DB_PROVIDER=postgres|mysql.`,
    );
}

function eventWriterReleaseFacts(supportsDurablePush = false) {
    const sourceConfigSchema = {
        type: "object",
        additionalProperties: false,
        properties: { repositoryId: { type: "string" } },
        required: ["repositoryId"],
    } satisfies PluginJsonSchemaV2;
    return normalizePluginReleaseFactsV1({
        ref: { pluginId: EVENT_PLUGIN_ID, version: EVENT_PLUGIN_VERSION },
        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"b".repeat(64)}`,
            resources: [],
        },
        normalizedManifest: {
            schemaVersion: 2,
            id: EVENT_PLUGIN_ID,
            version: EVENT_PLUGIN_VERSION,
            displayName: "Event CRUD DB contract fixture",
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: "./dist/index.js" },
            contributes: {
                actions: [{
                    id: SETUP_ACTION_LOCAL_ID,
                    title: "Set up repository source",
                    scopes: ["global"],
                    surfaces: ["plugin"],
                    dangerLevel: "safe",
                    execution: { target: "daemon" },
                    inputSchema: sourceConfigSchema,
                    resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, sourceConfigSchema),
                }, ...(supportsDurablePush ? [{ id: "receive-repository-events", title: "Receive repository events",
                    scopes: ["global"], surfaces: ["plugin"], dangerLevel: "safe", execution: { target: "daemon" } }] : [])],
                events: [{
                    id: EVENT_LOCAL_ID,
                    kind: "event",
                    title: "Repository event",
                    payloadSchema: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                            action: { type: "string" },
                        },
                        required: ["action"],
                    },
                    automation: {
                        v: 1,
                        eligible: true,
                        source: {
                            sourceContractVersion: 1,
                            supportedObservationTransports: supportsDurablePush ? ["checkpointedPull", "durablePush"] : ["checkpointedPull"],
                            ...(supportsDurablePush ? { webhookContributionRef: { pluginId: EVENT_PLUGIN_ID, localId: "repository-events" } } : {}),
                            sourceConfigSchema,
                            setupActionRef: { pluginId: EVENT_PLUGIN_ID, localId: SETUP_ACTION_LOCAL_ID },
                        },
                    },
                }],
                webhooks: supportsDurablePush ? [{ id: "repository-events", title: "Repository events",
                    verifier: { kind: "github_hmac_sha256_v1", routing: "accountEndpoint" },
                    handlerAction: { localId: "receive-repository-events" } }] : [],
            },
        },
        collectionContracts: [],
        uiSlots: [],
    });
}

type EventWriterAccount = Readonly<{
    id: string;
    seq: number;
    machineId: string;
    machineInstallationId: string;
    materializationId: string;
}>;

function eventExecutionRecipe(params: Readonly<{
    templateVersion: number;
    machineId: string;
}>) {
    return createAutomationWorkflowRecipeFixture({ templateVersion: params.templateVersion,
        directory: "/tmp/event-crud-dbcontract", prompt: `Event CRUD DB contract ${params.templateVersion}` });
}

function eventWriterTrigger(
    account: EventWriterAccount,
    sourceInstanceId: string,
    displayLabel = sourceInstanceId,
) {
    return {
        kind: "pluginEvent" as const,
        enabled: true,
        eventRef: { pluginId: EVENT_PLUGIN_ID, localId: EVENT_LOCAL_ID },
        sourceInstanceId,
        sourceContractVersion: 1,
        sourceConfig: { repositoryId: sourceInstanceId },
        displayLabel,
        observationTransport: {
            kind: "checkpointedPull" as const,
            watcherMaterializationRef: {
                machineId: account.machineId,
                materializationId: account.materializationId,
                pluginId: EVENT_PLUGIN_ID,
            },
        },
        filter: null,
        maximumObservationAgeMs: null,
    };
}

function eventWriterTriggerInput(trigger: ReturnType<typeof eventWriterTrigger>) {
    return {
        triggerId: AutomationTriggerIdSchema.parse(randomUUID()),
        trigger,
    };
}

const ownedAccountIds = new Set<string>();

/** Hold the first real parent read until its peer reads or requests the parent lock. */
async function withConcurrentDefinitionReads<T>(operation: () => Promise<T>): Promise<T> {
    const original = db.$transaction;
    let release!: () => void;
    const peerArrived = new Promise<void>(resolve => { release = resolve; });
    let firstReader: Tx | undefined;
    const parentLockRequesters = new Set<Tx>();
    db.$transaction = new Proxy(original, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        if (typeof callback !== "function") return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [async (tx: Tx) => {
            let readObserved = false;
            return callback(new Proxy(tx, { get(owner, property, proxyReceiver) {
                if (property === "$queryRawUnsafe") return (...values: Parameters<Tx["$queryRawUnsafe"]>) => {
                    // With serialization in place the peer waits before its read;
                    // release the holder so the real database can hand over its lock.
                    if (values[0].includes('FROM "Automation"') && values[0].includes("FOR ")) {
                        parentLockRequesters.add(tx);
                        if (firstReader && firstReader !== tx) release();
                    }
                    return tx.$queryRawUnsafe(...values);
                };
                if (property !== "automation") return Reflect.get(owner, property, proxyReceiver);
                return new Proxy(owner.automation, { get(model, method, modelReceiver) {
                    if (method !== "findFirst") return Reflect.get(model, method, modelReceiver);
                    return (...values: Parameters<typeof model.findFirst>) => observeLazyPrismaQuery(
                        model.findFirst(...values),
                        () => ({ started() {}, settled() {} }),
                        undefined,
                        async consume => {
                            const row = await consume();
                            if (!readObserved) {
                                readObserved = true;
                                if (!firstReader) {
                                    firstReader = tx;
                                    if ([...parentLockRequesters].some(requester => requester !== tx)) release();
                                    await peerArrived;
                                }
                                else release();
                            }
                            return row;
                        },
                    );
                } });
            } }));
        }, ...args.slice(1)]);
    } });
    try { return await operation(); }
    finally { release(); db.$transaction = original; }
}

async function seedEventWriterAccount(mode: "plain" | "e2ee" = "plain"): Promise<EventWriterAccount> {
    const suffix = randomUUID();
    const account = await db.account.create({
        data: mode === "plain"
            ? { encryptionMode: "plain" }
            : { ...createSignedAccountContentBinding(), encryptionMode: "e2ee" },
        select: { id: true, seq: true },
    });
    ownedAccountIds.add(account.id);

    const machineId = `event-crud-dbcontract-machine-${suffix}`;
    const machineInstallationId = `event-crud-dbcontract-installation-${suffix}`;
    const materializationId = `event-crud-dbcontract-materialization-${suffix}`;
    const release = eventWriterReleaseFacts();
    await db.machine.create({
        data: {
            id: machineId,
            accountId: account.id,
            metadata: "{}",
            installationId: machineInstallationId,
            pluginMaterializationRevision: 1n,
        },
    });
    await db.accountPluginIntent.create({
        data: {
            accountId: account.id,
            pluginId: EVENT_PLUGIN_ID,
            desiredVersion: EVENT_PLUGIN_VERSION,
            enabled: true,
            writableCollections: [],
        },
    });
    await db.accountPluginRelease.create({
        data: {
            accountId: account.id,
            pluginId: EVENT_PLUGIN_ID,
            version: EVENT_PLUGIN_VERSION,
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
            machineId,
            materializationId,
            pluginId: EVENT_PLUGIN_ID,
            version: EVENT_PLUGIN_VERSION,
            sourceClass: "registryPackage",
            portableRelease: true,
            archiveDigestSha256: release.archiveDigestSha256,
            uiArtifacts: [],
            enabled: true,
            trustState: "trusted",
            observedAt: new Date("2026-08-13T00:00:00.000Z"),
        },
    });
    return {
        ...account,
        machineId,
        machineInstallationId,
        materializationId,
    };
}

async function readEventCatalogRevision(accountId: string): Promise<bigint | null> {
    return (await db.automationEventCatalogState.findUnique({
        where: { accountId },
        select: { eventSourceDefinitionsRevision: true },
    }))?.eventSourceDefinitionsRevision ?? null;
}

async function cleanupOwnedAccounts(): Promise<void> {
    for (const accountId of ownedAccountIds) {
        const automationIds = (await db.automation.findMany({
            where: { accountId },
            select: { id: true },
        })).map((automation) => automation.id);
        if (automationIds.length > 0) {
            await db.automationRun.deleteMany({ where: { accountId } });
            await db.automationEventSourceStatus.deleteMany({
                where: { trigger: { automationId: { in: automationIds } } },
            });
            await db.automationAssignment.deleteMany({
                where: { automationId: { in: automationIds } },
            });
            await db.automation.deleteMany({ where: { accountId } });
        }
        await db.accountChange.deleteMany({ where: { accountId } });
        await db.automationEventSourceCatalogStatus.deleteMany({ where: { accountId } });
        await db.automationEventCatalogState.deleteMany({ where: { accountId } });
        const endpointRouteIds = (await db.pluginWebhookEndpoint.findMany({ where: { accountId }, select: { routeId: true } })).map(endpoint => endpoint.routeId);
        await db.pluginWebhookEndpoint.deleteMany({ where: { accountId } });
        await db.pluginWebhookRoute.deleteMany({ where: { id: { in: endpointRouteIds } } });
        await db.pluginMachineMaterialization.deleteMany({ where: { accountId } });
        await db.accountPluginIntent.deleteMany({ where: { accountId } });
        await db.accountPluginRelease.deleteMany({ where: { accountId } });
        await db.machine.deleteMany({ where: { accountId } });
        await db.account.deleteMany({ where: { id: accountId } });
    }
    ownedAccountIds.clear();
}

describe("Automation Event CRUD database contract", () => {
    const provider = resolveContractProviderFromEnv();
    let dbConnected = false;
    let sqliteHarness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        if (provider === "sqlite") {
            sqliteHarness = await createLightSqliteHarness({ tempDirPrefix: "happier-observation-only-crud-" });
            dbConnected = true;
            return;
        }
        if (provider === "postgres" && (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL)) {
            throw new Error("Use the disposable PostgreSQL DB-contract harness");
        }
        if (!process.env.DATABASE_URL) {
            throw new Error("Missing DATABASE_URL (required for Automation Event CRUD database contracts).");
        }
        if (provider === "mysql") {
            await initDbMysql();
        } else {
            initDbPostgres();
        }
        await db.$connect();
        dbConnected = true;
    }, 120_000);

    afterEach(async () => {
        await cleanupOwnedAccounts();
    });

    afterAll(async () => {
        if (sqliteHarness) await sqliteHarness.close();
        else if (dbConnected) await db.$disconnect();
    });

    it("creates, reads, pauses and resumes an observation-only Event without a recipe or execution assignment", async () => {
        const account = await seedEventWriterAccount();
        const input = AutomationDefinitionCreateRequestSchema.parse({
            automationId: randomUUID(), name: "Deployment monitoring", enabled: true,
            observationOnly: { kind: "observationOnly", templateVersion: 1 },
            triggers: [eventWriterTriggerInput(eventWriterTrigger(account, "deployment-monitor"))],
            assignments: [],
        });
        const created = await createAutomation({ accountId: account.id, input });
        const read = await getAutomation({ accountId: account.id, automationId: created.id });
        expect(read).not.toBeNull();
        expect(created.assignments).toEqual([]);
        expect((await createAutomation({ accountId: account.id, input })).id).toBe(created.id);
        await db.pluginMachineMaterialization.update({
            where: { machineId_materializationId: { machineId: account.machineId, materializationId: account.materializationId } },
            data: { serverIdentityId: await getOrCreateServerIdentityId() },
        });
        const sources = await readAutomationEventStoredDefinitionsV1({ accountId: account.id,
            caller: { pluginId: EVENT_PLUGIN_ID, machineId: account.machineId,
                machineInstallationId: account.machineInstallationId, materializationId: account.materializationId,
                sourceCustody: { kind: "managed", immutableGenerationId: "observation-crud-fixture", installSource: "archive" } },
            input: { transport: { kind: "checkpointedPull" }, pageSize: 500 },
        });
        expect(sources).toMatchObject({ kind: "page", definitions: [{
            automationId: created.id, observationOnly: { kind: "observationOnly" },
        }] });
        const now = new Date();
        expect(await inTx(tx => admitAutomationRunTx({ tx, accountId: account.id,
            automationId: created.id, now, cause: { kind: "manual", invokedAt: now.getTime() } })))
            .toEqual({ kind: "ineligible", reason: "observationOnly" });
        await expect(updateAutomation({ accountId: account.id, automationId: created.id,
            input: { assignments: [{ machineId: account.machineId }] } })).rejects.toBeInstanceOf(AutomationValidationError);
        expect(await db.automationAssignment.count({ where: { automationId: created.id } })).toBe(0);
        expect(await db.automationRun.count({ where: { automationId: created.id } })).toBe(0);
        const detail = toAutomationDefinitionDetailApiDto(read!, { mode: "plain", version: 0, contentKeyFingerprint: null }, null);
        expect(detail).toMatchObject({ observationOnly: { kind: "observationOnly", templateVersion: 1 } });
        expect(detail).not.toHaveProperty("executionRecipe");
        expect(detail).not.toHaveProperty("templateCiphertext");
        expect(toAutomationDefinitionListItemApiDto(created, null)).toMatchObject({ observationOnly: { kind: "observationOnly", templateVersion: 1 } });
        expect(await readEventCatalogRevision(account.id)).toBe(1n);
        await setAutomationEnabled({ accountId: account.id, automationId: created.id, enabled: false });
        expect(await getAutomation({ accountId: account.id, automationId: created.id })).toMatchObject({ enabled: false, assignments: [] });
        expect(await readEventCatalogRevision(account.id)).toBe(2n);
        await setAutomationEnabled({ accountId: account.id, automationId: created.id, enabled: true });
        expect(await getAutomation({ accountId: account.id, automationId: created.id })).toMatchObject({ enabled: true, assignments: [] });
        expect(await readEventCatalogRevision(account.id)).toBe(3n);
        const executable = await updateAutomation({ accountId: account.id, automationId: created.id,
            expectedTemplateVersion: 1, input: { executionRecipe: eventExecutionRecipe({ templateVersion: 2, machineId: account.machineId }),
                assignments: [{ machineId: account.machineId }] } });
        expect(executable?.templateVersion).toBe(2);
        expect(await readEventCatalogRevision(account.id)).toBe(4n);
        const observing = await updateAutomation({ accountId: account.id, automationId: created.id,
            expectedTemplateVersion: 2, input: { observationOnly: { kind: "observationOnly", templateVersion: 3 }, assignments: [] } });
        expect(observing?.assignments).toEqual([]);
        expect(await readEventCatalogRevision(account.id)).toBe(5n);
        const retainedTriggers = created.triggers.map(trigger => ({ kind: "existing" as const,
            triggerId: AutomationTriggerIdSchema.parse(trigger.id), expectedRevision: trigger.revision }));
        const reconciledExecutable = await reconcileAutomationDefinition({ accountId: account.id, automationId: created.id,
            input: { expectedTemplateVersion: 3, name: created.name, description: created.description, enabled: true,
                executionRecipe: eventExecutionRecipe({ templateVersion: 4, machineId: account.machineId }),
                assignments: [{ machineId: account.machineId }], triggers: retainedTriggers, removedTriggers: [] } });
        expect(reconciledExecutable?.templateVersion).toBe(4);
        expect(await readEventCatalogRevision(account.id)).toBe(6n);
        const reconciledObserver = await reconcileAutomationDefinition({ accountId: account.id, automationId: created.id,
            input: { expectedTemplateVersion: 4, name: created.name, description: created.description, enabled: true,
                observationOnly: { kind: "observationOnly", templateVersion: 5 }, assignments: [],
                triggers: retainedTriggers, removedTriggers: [] } });
        expect(reconciledObserver?.assignments).toEqual([]);
        expect(await readEventCatalogRevision(account.id)).toBe(7n);
        const metadataOnly = await reconcileAutomationDefinition({ accountId: account.id, automationId: created.id,
            input: { expectedTemplateVersion: 5, name: "Renamed monitoring", description: created.description, enabled: true,
                assignments: [], triggers: retainedTriggers, removedTriggers: [] } });
        expect(toAutomationDefinitionDetailApiDto(metadataOnly!, { mode: "plain", version: 0, contentKeyFingerprint: null }, null))
            .toMatchObject({ name: "Renamed monitoring", observationOnly: { kind: "observationOnly", templateVersion: 6 } });
        expect(await readEventCatalogRevision(account.id)).toBe(7n);
    });

    it("disables future Automation admission inside its caller transaction without republishing an equal disable", async () => {
        const account = await seedEventWriterAccount();
        const created = await createAutomation({ accountId: account.id, input: {
            automationId: randomUUID(), name: "Retire preview admission", enabled: true,
            executionRecipe: eventExecutionRecipe({ templateVersion: 1, machineId: account.machineId }),
            assignments: [{ machineId: account.machineId }], triggers: [
                eventWriterTriggerInput(eventWriterTrigger(account, "preview-source")),
                { triggerId: AutomationTriggerIdSchema.parse(randomUUID()), trigger: {
                    kind: "schedule", enabled: true,
                    schedule: { kind: "interval", everyMs: 60_000, scheduleExpr: null, timezone: null },
                } },
            ],
        } });
        const admitted = await runAutomationNow({ accountId: account.id, automationId: created.id });
        const revisionBefore = await readEventCatalogRevision(account.id);
        const schedule = created.triggers.find(trigger => trigger.kind === "schedule")!;
        expect(schedule.nextRunAt).not.toBeNull();
        const publicationState = async () => {
            const owner = await db.account.findUniqueOrThrow({ where: { id: account.id }, select: { seq: true } });
            const change = await db.accountChange.findUniqueOrThrow({ where: {
                accountId_kind_entityId: { accountId: account.id, kind: "automation", entityId: created.id },
            }, select: { cursor: true } });
            return { seq: owner.seq, cursor: change.cursor };
        };
        const publicationBefore = await publicationState();
        const rollback = new Error("caller transaction rolled back");
        await expect(inTx(async tx => {
            expect(await disableAutomationInTx(tx, { accountId: account.id, automationId: created.id }))
                .toMatchObject({ enabled: false });
            throw rollback;
        })).rejects.toBe(rollback);
        expect(await db.automation.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ enabled: true });
        expect(await db.automationTrigger.findUniqueOrThrow({ where: { id: schedule.id } }))
            .toMatchObject({ nextRunAt: schedule.nextRunAt });
        expect(await readEventCatalogRevision(account.id)).toBe(revisionBefore);
        expect(await publicationState()).toEqual(publicationBefore);

        const disabled = await inTx(tx => disableAutomationInTx(tx, { accountId: account.id, automationId: created.id }));
        expect(disabled).toMatchObject({ enabled: false, templateVersion: created.templateVersion });
        expect(disabled!.triggers.find(trigger => trigger.id === schedule.id)?.nextRunAt).toBeNull();
        expect(await readEventCatalogRevision(account.id)).toBe(revisionBefore! + 1n);
        const publicationAfter = { seq: publicationBefore.seq + 1, cursor: publicationBefore.seq + 1 };
        expect(await publicationState()).toEqual(publicationAfter);
        expect(await db.automationRun.findUniqueOrThrow({ where: { id: admitted!.id } }))
            .toMatchObject({ state: "queued" });
        const updatedAt = disabled!.updatedAt;
        await inTx(async tx => {
            for (let attempt = 0; attempt < 3; attempt += 1) {
                expect(await disableAutomationInTx(tx, { accountId: account.id, automationId: created.id }))
                    .toMatchObject({ enabled: false, updatedAt });
            }
        });
        expect(await readEventCatalogRevision(account.id)).toBe(revisionBefore! + 1n);
        expect(await publicationState()).toEqual(publicationAfter);
    });

    it("retains exact durable monitoring placement and fallback through route revocation, pause and resume", async () => {
        const previousSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET = "durable-monitor-dbcontract-test-secret";
        try { await initEncrypt(); }
        finally {
            if (previousSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
            else process.env.HANDY_MASTER_SECRET = previousSecret;
        }
        const account = await seedEventWriterAccount();
        await db.accountPluginRelease.update({
            where: { accountId_pluginId_version: { accountId: account.id, pluginId: EVENT_PLUGIN_ID, version: EVENT_PLUGIN_VERSION } },
            data: { normalizedManifest: eventWriterReleaseFacts(true).normalizedManifest },
        });
        const materialization = { machineId: account.machineId, materializationId: account.materializationId, pluginId: EVENT_PLUGIN_ID };
        const sourceInstanceId = `monitor-${randomUUID()}`;
        await db.machine.update({ where: { id: account.machineId }, data: {
            operationProtocolCapabilities: { pluginWebhookClaim: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
        } });
        await db.pluginMachineMaterialization.update({
            where: { machineId_materializationId: { machineId: account.machineId, materializationId: account.materializationId } },
            data: { serverIdentityId: await getOrCreateServerIdentityId() },
        });
        const endpoint = await ensurePluginWebhookEndpointV1({
            accountId: account.id,
            input: { webhookContribution: { pluginId: EVENT_PLUGIN_ID, localId: "repository-events" }, targetMaterialization: materialization,
                sourceInstanceId, setup: { kind: "accountEndpointV1", credential: "serverGenerated" }, idempotencyKey: randomUUID() },
            contribution: { pluginId: EVENT_PLUGIN_ID, localId: "repository-events", handlerActionLocalId: "receive-repository-events",
                verifierKind: "github_hmac_sha256_v1", routingKind: "accountEndpoint" },
            target: { materialization, machineInstallationId: account.machineInstallationId, pluginVersion: EVENT_PLUGIN_VERSION },
            publicBaseUrl: "https://happier.example",
        });
        const created = await createAutomation({ accountId: account.id, input: AutomationDefinitionCreateRequestSchema.parse({
            automationId: randomUUID(), name: "Durable deployment monitoring", enabled: true,
            observationOnly: { kind: "observationOnly", templateVersion: 1 }, assignments: [],
            triggers: [{ triggerId: randomUUID(), trigger: { ...eventWriterTrigger(account, sourceInstanceId),
                observationTransport: { kind: "durablePush", webhookEndpointId: endpoint.webhookEndpointId,
                    endpointMaterializationRef: materialization, webhookRoutingSourceInstanceId: sourceInstanceId,
                    setup: { kind: "accountEndpointV1", credential: "serverGenerated" } } } }],
        }) });
        const caller = { ...materialization, machineInstallationId: account.machineInstallationId,
            sourceCustody: { kind: "managed" as const, immutableGenerationId: "durable-monitor-fixture", installSource: "archive" as const } };
        const read = () => readAutomationEventStoredDefinitionsV1({ accountId: account.id, caller, input: { transport: { kind: "durablePush" } } });
        const projection = { kind: "page", definitions: [{ automationId: created.id, observationOnly: { kind: "observationOnly" },
            observationTransport: { kind: "durablePush", endpointMaterializationRef: materialization } }] };
        await expect(read()).resolves.toMatchObject(projection);
        await revokePluginWebhookEndpointV1({ accountId: account.id, webhookEndpointId: endpoint.webhookEndpointId,
            expectedRevision: endpoint.revision, idempotencyKey: randomUUID() });
        await expect(read()).resolves.toMatchObject(projection);
        await expect(reportAutomationEventSourceStatusV1({ accountId: account.id, caller, input: {
            kind: "catalogReconciliation", scope: { kind: "durablePush", webhookEndpointId: endpoint.webhookEndpointId },
            observedRevision: "1", adoptedRevision: "1", state: "current", scanStartedAt: null, nextRetryAt: null,
        } })).resolves.toEqual({});
        await setAutomationEnabled({ accountId: account.id, automationId: created.id, enabled: false });
        await expect(read()).resolves.toMatchObject({ kind: "page", definitions: [] });
        await setAutomationEnabled({ accountId: account.id, automationId: created.id, enabled: true });
        await expect(read()).resolves.toMatchObject(projection);
        await db.pluginWebhookEndpoint.update({ where: { id: endpoint.webhookEndpointId }, data: { targetMaterializationId: "moved-materialization" } });
        await expect(read()).resolves.toMatchObject({ kind: "page", definitions: [] });
    });

    it("keeps one plain Event definition's lifecycle, CAS, selector identity, and catalog cursor atomic", async () => {
        const account = await seedEventWriterAccount();
        const firstSource = `repository-first-${randomUUID()}`;
        const privateDisplayLabel = "Private first repository";
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Repository updates",
                enabled: true,
                triggers: [eventWriterTriggerInput(eventWriterTrigger(
                    account,
                    firstSource,
                    privateDisplayLabel,
                ))],
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 1,
                    machineId: account.machineId,
                }),
                assignments: [{ machineId: account.machineId }],
            },
        });
        const createdTrigger = created.triggers[0]!;
        const createdTriggerId = AutomationTriggerIdSchema.parse(createdTrigger.id);
        const firstSelector = AutomationSourceSelectorIdV1Schema.parse(createdTrigger.sourceSelectorId);
        expect(await readEventCatalogRevision(account.id)).toBe(1n);

        const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "plain",
            binding: {
                v: 1,
                automationId: created.id,
                triggerId: createdTriggerId,
                triggerRevision: createdTrigger.revision,
                triggerKind: "pluginEvent",
                eventRef: { pluginId: EVENT_PLUGIN_ID, localId: EVENT_LOCAL_ID },
                sourceSelectorId: firstSelector,
            },
            envelope: JSON.parse(createdTrigger.definitionEnvelope ?? "null"),
        });
        expect(opened).toMatchObject({
            kind: "available",
            definition: {
                sourceInstanceId: firstSource,
                displayLabel: privateDisplayLabel,
                sourceConfig: { repositoryId: firstSource },
            },
        });
        const listItem = toAutomationDefinitionListItemApiDto(created, null);
        expect(listItem.triggers[0]).not.toHaveProperty("definitionEnvelope");
        expect(JSON.stringify(listItem)).not.toContain(privateDisplayLabel);

        const recipeEdited = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTemplateVersion: 1,
            input: {
                name: "Renamed repository updates",
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 2,
                    machineId: account.machineId,
                }),
            },
        });
        expect(recipeEdited).toEqual(expect.objectContaining({ templateVersion: 2 }));
        expect(recipeEdited?.triggers[0]).toEqual(expect.objectContaining({
            id: createdTrigger.id,
            revision: createdTrigger.revision,
            sourceSelectorId: firstSelector,
        }));
        expect(await readEventCatalogRevision(account.id)).toBe(1n);

        const sameSource = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: createdTrigger.id,
            expectedRevision: createdTrigger.revision,
            trigger: eventWriterTrigger(account, firstSource, "Private renamed repository"),
        });
        const sameSourceTrigger = sameSource?.triggers[0]!;
        expect(sameSource?.templateVersion).toBe(3);
        expect(sameSourceTrigger).toEqual(expect.objectContaining({
            id: createdTrigger.id,
            revision: createdTrigger.revision + 1,
            sourceSelectorId: firstSelector,
        }));
        expect(await readEventCatalogRevision(account.id)).toBe(2n);

        const secondSource = `repository-second-${randomUUID()}`;
        const changedSource = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: createdTrigger.id,
            expectedRevision: sameSourceTrigger.revision,
            trigger: eventWriterTrigger(account, secondSource),
        });
        const changedTrigger = changedSource?.triggers[0]!;
        expect(changedSource?.templateVersion).toBe(4);
        expect(changedTrigger).toEqual(expect.objectContaining({
            id: createdTrigger.id,
            revision: createdTrigger.revision + 2,
            eventPluginId: EVENT_PLUGIN_ID,
            eventLocalId: EVENT_LOCAL_ID,
        }));
        expect(changedTrigger.sourceSelectorId).not.toBe(firstSelector);
        expect(AutomationSourceSelectorIdV1Schema.safeParse(
            changedTrigger.sourceSelectorId,
        ).success).toBe(true);
        expect(await readEventCatalogRevision(account.id)).toBe(3n);

        await expect(updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: createdTrigger.id,
            expectedRevision: sameSourceTrigger.revision,
            trigger: eventWriterTrigger(account, `repository-stale-${randomUUID()}`),
        })).rejects.toBeInstanceOf(AutomationTriggerMutationConflictError);
        expect(await db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: {
                name: true,
                templateVersion: true,
                triggers: {
                    where: { deletedAt: null },
                    select: { sourceSelectorId: true, revision: true },
                },
            },
        })).toEqual({
            name: "Renamed repository updates",
            templateVersion: 4,
            triggers: [{
                sourceSelectorId: changedTrigger.sourceSelectorId,
                revision: createdTrigger.revision + 2,
            }],
        });
        expect(await readEventCatalogRevision(account.id)).toBe(3n);

        const paused = await setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: false,
        });
        expect(paused).toEqual(expect.objectContaining({ enabled: false }));
        expect(await readEventCatalogRevision(account.id)).toBe(4n);
        const resumed = await setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: true,
        });
        expect(resumed).toEqual(expect.objectContaining({ enabled: true }));
        expect(await readEventCatalogRevision(account.id)).toBe(5n);
        await expect(deleteAutomation({
            accountId: account.id,
            automationId: created.id,
        })).resolves.toEqual({ removedRevision: expect.any(Number) });
        expect(await readEventCatalogRevision(account.id)).toBe(6n);
        expect(await db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: { deletedAt: true, enabled: true },
        })).toEqual({
            deletedAt: expect.any(Date),
            enabled: false,
        });
        expect(await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        })).toEqual({ seq: account.seq + 7 });

        const e2ee = await seedEventWriterAccount("e2ee");
        await expect(createAutomation({
            accountId: e2ee.id,
            input: {
                automationId: randomUUID(),
                name: "E2EE Event writer is unavailable",
                enabled: true,
                triggers: [eventWriterTriggerInput(eventWriterTrigger(
                    e2ee,
                    `repository-e2ee-${randomUUID()}`,
                ))],
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 1,
                    machineId: e2ee.machineId,
                }),
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        expect(await db.automation.count({ where: { accountId: e2ee.id } })).toBe(0);
        expect(await readEventCatalogRevision(e2ee.id)).toBeNull();
    });

    it("does not advance the Event catalog when final Run retention physically deletes an already-deleted Event Automation", async () => {
        const account = await seedEventWriterAccount();
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Retained repository event",
                enabled: true,
                triggers: [eventWriterTriggerInput(eventWriterTrigger(
                    account,
                    `retained-repository-${randomUUID()}`,
                ))],
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 1,
                    machineId: account.machineId,
                }),
                assignments: [{ machineId: account.machineId }],
            },
        });
        const trigger = created.triggers[0]!;
        const retainedRunId = randomUUID();
        const occurredAt = new Date("2026-08-31T00:00:00.000Z");
        await db.automationRun.create({
            data: {
                id: retainedRunId,
                automationId: created.id,
                accountId: account.id,
                state: "failed",
                triggerId: trigger.id,
                causeKind: "trigger",
                causeTriggerKind: "pluginEvent",
                causeTriggerRevision: trigger.revision,
                causeOccurredAt: occurredAt,
                occurrenceKey: deriveAutomationOccurrenceKeyV1({ triggerId: trigger.id, evidence: {
                    v: 1, kind: "pluginEvent", eventRef: { pluginId: EVENT_PLUGIN_ID, localId: EVENT_LOCAL_ID },
                    sourceSelectorId: AutomationSourceSelectorIdV1Schema.parse(trigger.sourceSelectorId),
                    occurrenceId: retainedRunId, occurredAt: occurredAt.getTime(), payload: {},
                } }),
                causeEventPluginId: EVENT_PLUGIN_ID,
                causeEventLocalId: EVENT_LOCAL_ID,
                causeSourceSelectorId: trigger.sourceSelectorId,
                triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                scheduledAt: occurredAt,
                dueAt: occurredAt,
                finishedAt: occurredAt,
                errorCode: "retained_event_catalog_test",
            },
        });

        await expect(deleteAutomation({
            accountId: account.id,
            automationId: created.id,
        })).resolves.toEqual({ removedRevision: created.templateVersion });
        expect(await readEventCatalogRevision(account.id)).toBe(2n);
        await expect(inTx(async (tx) => await finalizeDeletedAutomationsWithoutRetainedRunsTx({
            tx,
            accountId: account.id,
            limit: 1,
        }))).resolves.toBe(0);
        expect(await readEventCatalogRevision(account.id)).toBe(2n);

        await db.automationRun.delete({ where: { id: retainedRunId } });
        await expect(inTx(async (tx) => await finalizeDeletedAutomationsWithoutRetainedRunsTx({
            tx,
            accountId: account.id,
            limit: 1,
        }))).resolves.toBe(1);
        expect(await readEventCatalogRevision(account.id)).toBe(2n);
        await expect(db.automation.findUnique({ where: { id: created.id } })).resolves.toBeNull();

        await expect(inTx(async (tx) => await finalizeDeletedAutomationsWithoutRetainedRunsTx({
            tx,
            accountId: account.id,
            limit: 1,
        }))).resolves.toBe(0);
        expect(await readEventCatalogRevision(account.id)).toBe(2n);
    });

    it("keeps multiple Event trigger rows independently identifiable and resumable", async () => {
        const account = await seedEventWriterAccount();
        const leftSource = `capacity-left-${randomUUID()}`;
        const rightSource = `capacity-right-${randomUUID()}`;
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Independent Event sources",
                enabled: true,
                triggers: [
                    eventWriterTriggerInput({ ...eventWriterTrigger(account, leftSource), enabled: false }),
                    eventWriterTriggerInput({ ...eventWriterTrigger(account, rightSource), enabled: false }),
                ],
                executionRecipe: eventExecutionRecipe({
                    templateVersion: 1,
                    machineId: account.machineId,
                }),
                assignments: [{ machineId: account.machineId }],
            },
        });
        expect(await readEventCatalogRevision(account.id)).toBeNull();
        const resumeSeq = (await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        })).seq;

        const updateBoth = () => Promise.allSettled([
            updateAutomationTrigger({
                accountId: account.id,
                automationId: created.id,
                triggerId: created.triggers[0]!.id,
                expectedRevision: created.triggers[0]!.revision,
                enabled: true,
            }),
            updateAutomationTrigger({
                accountId: account.id,
                automationId: created.id,
                triggerId: created.triggers[1]!.id,
                expectedRevision: created.triggers[1]!.revision,
                enabled: true,
            }),
        ]);
        const outcomes = provider === "postgres"
            ? await withConcurrentDefinitionReads(updateBoth)
            : await updateBoth();
        expect(outcomes.filter((outcome) => outcome.status === "rejected")).toEqual([]);
        const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
        expect(fulfilled).toHaveLength(2);
        expect(fulfilled.map(outcome => outcome.value?.templateVersion).sort()).toEqual([2, 3]);
        expect((await getAutomation({ accountId: account.id, automationId: created.id }))?.templateVersion).toBe(3);
        expect(await db.automationTrigger.findMany({
            where: {
                automationId: created.id,
                kind: "pluginEvent",
                enabled: true,
                deletedAt: null,
            },
            select: {
                id: true,
                revision: true,
                eventPluginId: true,
                eventLocalId: true,
                sourceSelectorId: true,
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        })).toEqual(created.triggers.map((trigger) => ({
            id: trigger.id,
            revision: trigger.revision + 1,
            eventPluginId: EVENT_PLUGIN_ID,
            eventLocalId: EVENT_LOCAL_ID,
            sourceSelectorId: trigger.sourceSelectorId,
        })));
        expect(await readEventCatalogRevision(account.id)).toBe(2n);
        expect(await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        })).toEqual({ seq: resumeSeq + 2 });

        const sameTrigger = created.triggers[0]!;
        // Both writers request a real change; an equal enable is a semantic no-op
        // that succeeds without a revision, so it cannot exercise the CAS race.
        const sameTriggerOutcomes = await Promise.allSettled([false, false].map(enabled => updateAutomationTrigger({
            accountId: account.id, automationId: created.id, triggerId: sameTrigger.id,
            expectedRevision: sameTrigger.revision + 1, enabled,
        })));
        expect(sameTriggerOutcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
        const conflicts = sameTriggerOutcomes.filter(outcome => outcome.status === "rejected");
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]!.reason).toBeInstanceOf(AutomationTriggerMutationConflictError);
        expect((await getAutomation({ accountId: account.id, automationId: created.id }))?.templateVersion).toBe(4);
    });

});
