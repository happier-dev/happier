import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
    AutomationSourceSelectorIdV1Schema,
    buildAutomationPluginEventOccurrenceEvidenceV1,
    deriveAutomationOccurrenceKeyV1,
    normalizePluginReleaseFactsV1,
    serializeAutomationRunExecutionRecipeV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    type AutomationSourceSelectorIdV1,
    type PluginJsonValueV2,
} from "@happier-dev/protocol";

import { eventRouter } from "@/app/events/eventRouter";
import { db, initDbPostgres } from "@/storage/db";

import { admitAutomationEventV1 } from "./automationEventAdmissionService";

const provider = String(
    process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "",
).trim().toLowerCase();
const SERVER_IDENTITY_ID = `srv_eventAdmissionPg${randomUUID().split("-").join("")}`;
const PLUGIN_ID = "com.happier.postgres-event-admission-contract";
const PLUGIN_VERSION = "1.0.0";
const EVENT_LOCAL_ID = "repository-event";

function releaseFacts() {
    return normalizePluginReleaseFactsV1({
        ref: { pluginId: PLUGIN_ID, version: PLUGIN_VERSION },
        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        normalizedManifest: {
            schemaVersion: 2,
            id: PLUGIN_ID,
            version: PLUGIN_VERSION,
            displayName: "PostgreSQL Event admission contract fixture",
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: "./dist/index.js" },
            contributes: {
                actions: [],
                events: [{
                    id: EVENT_LOCAL_ID,
                    kind: "event",
                    title: "Repository event",
                    payloadSchema: {
                        type: "object",
                        properties: { action: { type: "string" } },
                        required: ["action"],
                        additionalProperties: false,
                    },
                    automation: {
                        v: 1,
                        eligible: true,
                        source: {
                            sourceContractVersion: 1,
                            supportedObservationTransports: ["checkpointedPull"],
                            sourceConfigSchema: {
                                type: "object",
                                additionalProperties: false,
                            },
                        },
                    },
                }],
                webhooks: [],
            },
        },
        collectionContracts: [],
        uiSlots: [],
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"d".repeat(64)}`,
            resources: [],
        },
    });
}

function strictEventDefinitionRecipe(machineId: string): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        template: { t: "plain", v: { v: 1, prompt: "native PostgreSQL Event contract" } },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server-postgres-event-admission", machineId },
                directory: "/tmp/postgres-event-admission",
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
    });
    if (serialized.kind !== "available") {
        throw new Error("PostgreSQL Event admission fixture must use a strict recipe");
    }
    return serialized.serialized;
}

function triggerDefinitionEnvelope(params: Readonly<{
    automationId: string;
    sourceSelectorId: AutomationSourceSelectorIdV1;
}>): string {
    const definition: PluginJsonValueV2 = {
        v: 1,
        sourceInstanceId: "postgres-event-admission-repository",
        sourceConfig: {},
        displayLabel: "Postgres event repository",
        filter: null,
        maximumObservationAgeMs: null,
    };
    return JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: "plain",
        binding: {
            v: 1,
            automationId: params.automationId,
            templateVersion: 1,
            triggerKind: "pluginEvent",
            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
            sourceSelectorId: params.sourceSelectorId,
        },
        definition,
    }));
}

describe.skipIf(provider !== "postgres" && provider !== "postgresql")(
    "PostgreSQL Automation Event admission contract",
    () => {
        let dbConnected = false;
        let accountId: string | null = null;
        const originalServerIdentityId = process.env.HAPPIER_SERVER_IDENTITY_ID;

        beforeAll(async () => {
            if (!process.env.DATABASE_URL) {
                throw new Error(
                    "Missing DATABASE_URL (required for the PostgreSQL Event admission contract).",
                );
            }
            process.env.HAPPIER_SERVER_IDENTITY_ID = SERVER_IDENTITY_ID;
            initDbPostgres();
            await db.$connect();
            dbConnected = true;
        });

        afterEach(async () => {
            vi.restoreAllMocks();
            if (!accountId) return;
            await db.accountChange.deleteMany({ where: { accountId } });
            await db.automationRun.deleteMany({ where: { accountId } });
            await db.automation.deleteMany({ where: { accountId } });
            await db.pluginMachineMaterialization.deleteMany({ where: { accountId } });
            await db.accountPluginIntent.deleteMany({ where: { accountId } });
            await db.accountPluginRelease.deleteMany({ where: { accountId } });
            await db.machine.deleteMany({ where: { accountId } });
            await db.account.deleteMany({ where: { id: accountId } });
            accountId = null;
        });

        afterAll(async () => {
            if (originalServerIdentityId === undefined) {
                delete process.env.HAPPIER_SERVER_IDENTITY_ID;
            } else {
                process.env.HAPPIER_SERVER_IDENTITY_ID = originalServerIdentityId;
            }
            if (dbConnected) await db.$disconnect();
        });

        it("serializes concurrent exact occurrences without duplicate Run wakes and keeps same-source Automations independent", async () => {
            const suffix = randomUUID();
            const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(randomUUID());
            const secondSourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(randomUUID());
            const machineId = `postgres-event-admission-machine-${suffix}`;
            const machineInstallationId = `postgres-event-admission-installation-${suffix}`;
            const materializationId = `postgres-event-admission-materialization-${suffix}`;
            const automationId = `postgres-event-admission-automation-${suffix}`;
            const secondAutomationId = `postgres-event-admission-second-automation-${suffix}`;
            const account = await db.account.create({
                data: { publicKey: null, encryptionMode: "plain" },
                select: { id: true },
            });
            accountId = account.id;
            const release = releaseFacts();
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
                    pluginId: PLUGIN_ID,
                    desiredVersion: PLUGIN_VERSION,
                    enabled: true,
                    writableCollections: [],
                },
            });
            await db.accountPluginRelease.create({
                data: {
                    accountId: account.id,
                    pluginId: PLUGIN_ID,
                    version: PLUGIN_VERSION,
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
                    pluginId: PLUGIN_ID,
                    version: PLUGIN_VERSION,
                    sourceClass: "registryPackage",
                    portableRelease: true,
                    archiveDigestSha256: release.archiveDigestSha256,
                    uiArtifacts: [],
                    enabled: true,
                    trustState: "trusted",
                    observedAt: new Date("2026-08-10T00:00:00.000Z"),
                },
            });
            const createAutomation = async (params: Readonly<{
                automationId: string;
                sourceSelectorId: AutomationSourceSelectorIdV1;
            }>) => await db.automation.create({
                data: {
                    id: params.automationId,
                    accountId: account.id,
                    name: "PostgreSQL Event admission contract",
                    enabled: true,
                    scheduleKind: null,
                    targetType: "new_session",
                    templateCiphertext: strictEventDefinitionRecipe(machineId),
                    templateVersion: 1,
                    triggerKind: "pluginEvent",
                    triggerEventPluginId: PLUGIN_ID,
                    triggerEventLocalId: EVENT_LOCAL_ID,
                    triggerSourceSelectorId: params.sourceSelectorId,
                    triggerSourceContractVersion: 1,
                    triggerObservationTransport: "checkpointedPull",
                    watcherMachineId: machineId,
                    watcherMachineInstallationId: machineInstallationId,
                    watcherPluginId: PLUGIN_ID,
                    watcherMaterializationId: materializationId,
                    triggerDefinitionEnvelope: triggerDefinitionEnvelope({
                        automationId: params.automationId,
                        sourceSelectorId: params.sourceSelectorId,
                    }),
                },
            });
            await createAutomation({ automationId, sourceSelectorId });
            await db.automationAssignment.create({
                data: { automationId, machineId, enabled: true },
            });
            const currentness = async () => {
                const current = await db.account.findUniqueOrThrow({
                    where: { id: account.id },
                    select: { seq: true },
                });
                return {
                    v: 1,
                    t: "plain" as const,
                    accountCurrentness: {
                        mode: "plain" as const,
                        version: current.seq,
                        contentKeyFingerprint: null,
                    },
                };
            };
            const eventInput = (
                action: string,
                definitions: readonly Readonly<{
                    automationId: string;
                    templateVersion: number;
                    sourceSelectorId: AutomationSourceSelectorIdV1;
                }>[] = [{
                    automationId,
                    templateVersion: 1,
                    sourceSelectorId,
                }],
            ) => ({
                eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                occurrenceId: `postgres-event-admission-delivery-${suffix}`,
                occurredAt: 1_723_247_200_000,
                observationReceivedAt: 1_723_247_201_000,
                payload: { action },
                definitions,
            });
            const caller = {
                pluginId: PLUGIN_ID,
                machineId,
                machineInstallationId,
                materializationId,
            };
            const admit = async (params: Readonly<{
                input: ReturnType<typeof eventInput>;
                hostEvidence: Awaited<ReturnType<typeof currentness>>;
            }>) => await admitAutomationEventV1({
                accountId: account.id,
                caller,
                request: {
                    v: 1,
                    caller: {
                        pluginId: caller.pluginId,
                        materialization: {
                            pluginId: caller.pluginId,
                            machineId: caller.machineId,
                            materializationId: caller.materializationId,
                        },
                    },
                    input: params.input,
                    hostEvidence: params.hostEvidence,
                },
            });
            const emitUpdate = vi.spyOn(eventRouter, "emitUpdate").mockImplementation(() => {});
            const concurrentHostEvidence = await currentness();
            const [first, second] = await Promise.all([
                admit({
                    input: eventInput("opened"),
                    hostEvidence: concurrentHostEvidence,
                }),
                admit({
                    input: eventInput("opened"),
                    hostEvidence: concurrentHostEvidence,
                }),
            ]);

            const results = [first.results[0]!, second.results[0]!];
            expect(results.map((result) => result.kind).sort()).toEqual([
                "admitted",
                "rejoined",
            ]);
            expect(results.every((result) => result.checkpointSafe)).toBe(true);
            const runIds = results.flatMap((result) => (
                result.kind === "admitted" || result.kind === "rejoined" ? [result.runId] : []
            ));
            expect(new Set(runIds).size).toBe(1);
            const runId = runIds[0];
            if (!runId) {
                throw new Error("PostgreSQL concurrent admission must return one Run ID");
            }
            expect(await db.automationRun.count({ where: { accountId: account.id } })).toBe(1);
            const occurrenceEvidence = buildAutomationPluginEventOccurrenceEvidenceV1({
                eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                sourceSelectorId,
                occurrenceId: `postgres-event-admission-delivery-${suffix}`,
                occurredAt: 1_723_247_200_000,
                payload: { action: "opened" },
            });
            await expect(db.automationRun.findUniqueOrThrow({
                where: { id: runId },
                select: {
                    state: true,
                    revision: true,
                    originKind: true,
                    originOccurredAt: true,
                    occurrenceKey: true,
                    occurrenceEvidenceEqualityTag: true,
                    originSourceSelectorId: true,
                    triggerEvidenceEnvelope: true,
                },
            })).resolves.toEqual({
                state: "queued",
                revision: 0,
                originKind: "pluginEvent",
                originOccurredAt: new Date(1_723_247_200_000),
                occurrenceKey: deriveAutomationOccurrenceKeyV1(occurrenceEvidence),
                occurrenceEvidenceEqualityTag: null,
                originSourceSelectorId: sourceSelectorId,
                triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: occurrenceEvidence }),
            });
            expect((await currentness()).accountCurrentness.version).toBe(
                concurrentHostEvidence.accountCurrentness.version + 1,
            );
            expect(await db.accountChange.count({
                where: { accountId: account.id, kind: "automation", entityId: automationId },
            })).toBe(1);
            expect(emitUpdate).toHaveBeenCalledTimes(4);
            expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
                userId: account.id,
                payload: expect.objectContaining({
                    body: expect.objectContaining({
                        t: "automation-run-updated",
                        runId,
                        automationId,
                        state: "queued",
                    }),
                }),
                recipientFilter: { type: "user-scoped-only" },
            }));
            expect(emitUpdate).toHaveBeenCalledWith(expect.objectContaining({
                userId: account.id,
                payload: expect.objectContaining({
                    body: expect.objectContaining({
                        t: "automation-run-updated",
                        runId,
                        automationId,
                        state: "queued",
                        targetMachineId: machineId,
                    }),
                }),
                recipientFilter: { type: "machine-only", machineId },
            }));

            emitUpdate.mockClear();
            await createAutomation({
                automationId: secondAutomationId,
                sourceSelectorId: secondSourceSelectorId,
            });
            await db.automationAssignment.create({
                data: { automationId: secondAutomationId, machineId, enabled: true },
            });
            const secondAdmission = await admit({
                input: eventInput("opened", [{
                    automationId: secondAutomationId,
                    templateVersion: 1,
                    sourceSelectorId: secondSourceSelectorId,
                }]),
                hostEvidence: await currentness(),
            });
            expect(secondAdmission.results).toEqual([
                expect.objectContaining({ kind: "admitted", checkpointSafe: true }),
            ]);
            const secondResult = secondAdmission.results[0];
            if (!secondResult || secondResult.kind !== "admitted") {
                throw new Error("same-source second Automation admission must create a Run");
            }
            const secondRunId = secondResult.runId;
            expect(secondRunId).not.toBe(runId);
            expect(await db.automationRun.findMany({
                where: { accountId: account.id },
                select: { automationId: true, occurrenceKey: true, originSourceSelectorId: true },
                orderBy: { automationId: "asc" },
            })).resolves.toEqual([
                {
                    automationId,
                    occurrenceKey: deriveAutomationOccurrenceKeyV1(occurrenceEvidence),
                    originSourceSelectorId: sourceSelectorId,
                },
                {
                    automationId: secondAutomationId,
                    occurrenceKey: deriveAutomationOccurrenceKeyV1(
                        buildAutomationPluginEventOccurrenceEvidenceV1({
                            eventRef: { pluginId: PLUGIN_ID, localId: EVENT_LOCAL_ID },
                            sourceSelectorId: secondSourceSelectorId,
                            occurrenceId: `postgres-event-admission-delivery-${suffix}`,
                            occurredAt: 1_723_247_200_000,
                            payload: { action: "opened" },
                        }),
                    ),
                    originSourceSelectorId: secondSourceSelectorId,
                },
            ]);

            await expect(admit({
                input: eventInput("closed"),
                hostEvidence: await currentness(),
            })).resolves.toEqual({
                results: [{
                    kind: "blocked",
                    reason: "occurrenceConflict",
                    checkpointSafe: false,
                }],
            });
            expect(await db.automationRun.count({ where: { accountId: account.id } })).toBe(2);
        });
    },
);
