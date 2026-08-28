import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    normalizePluginReleaseFactsV1,
    serializeAutomationStoredDefinitionExecutionRecipeV1,
} from "@happier-dev/protocol";

import { db, initDbPostgres } from "@/storage/db";

import { admitAutomationConversationV1 } from "./automationConversationAdmissionService";

const provider = String(
    process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "",
).trim().toLowerCase();
const SERVER_IDENTITY_ID = `srv_conversationAdmissionPg${randomUUID().split("-").join("")}`;
const PLUGIN_ID = "happier.channels";
const PLUGIN_VERSION = "1.0.0";
const CONTRIBUTION_LOCAL_ID = "provider/observation-ingest-v1";

function releaseFacts() {
    return normalizePluginReleaseFactsV1({
        ref: { pluginId: PLUGIN_ID, version: PLUGIN_VERSION },
        archiveDigestSha256: `sha256:${"a".repeat(64)}`,
        normalizedManifest: {
            schemaVersion: 2,
            id: PLUGIN_ID,
            version: PLUGIN_VERSION,
            displayName: "PostgreSQL Conversation admission contract fixture",
            engines: { happier: "^1.0.0" },
            runtime: { apiVersion: 1 },
            entrypoints: { daemon: "./dist/index.js" },
            contributes: { actions: [], events: [], webhooks: [] },
        },
        collectionContracts: [],
        uiSlots: [],
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${"d".repeat(64)}`,
            resources: [],
        },
    });
}

function strictConversationRunRecipe(): string {
    const serialized = serializeAutomationStoredDefinitionExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        template: {
            t: "plain",
            v: { v: 1, prompt: "native PostgreSQL Conversation contract" },
        },
        triggerEvidence: null,
        target: {
            kind: "executionRun",
            request: {
                intent: "task",
                backendTarget: { kind: "builtInAgent", agentId: "codex" },
                permissionMode: "read_only",
                retentionPolicy: "ephemeral",
                runClass: "bounded",
                ioMode: "request_response",
            },
        },
    });
    if (serialized.kind !== "available") {
        throw new Error("PostgreSQL Conversation admission fixture must use a strict recipe");
    }
    return serialized.serialized;
}

describe.skipIf(provider !== "postgres" && provider !== "postgresql")(
    "PostgreSQL Automation Conversation admission contract",
    () => {
        let dbConnected = false;
        let accountId: string | null = null;
        const originalServerIdentityId = process.env.HAPPIER_SERVER_IDENTITY_ID;

        beforeAll(async () => {
            if (!process.env.DATABASE_URL) {
                throw new Error(
                    "Missing DATABASE_URL (required for the PostgreSQL Conversation admission contract).",
                );
            }
            process.env.HAPPIER_SERVER_IDENTITY_ID = SERVER_IDENTITY_ID;
            initDbPostgres();
            await db.$connect();
            dbConnected = true;
        });

        afterEach(async () => {
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

        it("rejoins an exact native concurrent occurrence and conflicts a different logical caller", async () => {
            const suffix = randomUUID();
            const machineId = `postgres-conversation-admission-machine-${suffix}`;
            const machineInstallationId = `postgres-conversation-admission-installation-${suffix}`;
            const materializationId = `postgres-conversation-admission-materialization-${suffix}`;
            const automationId = `postgres-conversation-admission-automation-${suffix}`;
            const bindingId = `postgres-conversation-admission-binding-${suffix}`;
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
                    observedAt: new Date("2026-08-12T00:00:00.000Z"),
                },
            });
            await db.automation.create({
                data: {
                    id: automationId,
                    accountId: account.id,
                    name: "PostgreSQL Conversation admission contract",
                    enabled: true,
                    targetType: "execution_run",
                    templateCiphertext: strictConversationRunRecipe(),
                    templateVersion: 1,
                },
            });
            await db.automationTrigger.create({
                data: {
                    automationId,
                    kind: "schedule",
                    enabled: true,
                    revision: 1,
                    scheduleKind: "interval",
                    everyMs: 60_000,
                },
            });

            const caller = {
                pluginId: PLUGIN_ID,
                contributionLocalId: CONTRIBUTION_LOCAL_ID,
                machineId,
                machineInstallationId,
                materializationId,
                immutableGenerationId: `generation-${suffix}`,
            };
            const input = (occurrenceId: string) => ({
                automationId,
                bindingId,
                occurrenceId,
                occurredAt: 1_723_247_200_000,
                sender: { id: "sender-postgres" },
                text: "native PostgreSQL Conversation admission",
                resultDelivery: { kind: "none" as const },
            });

            const exactInput = input(`postgres-conversation-exact-${suffix}`);
            const [first, second] = await Promise.all([
                admitAutomationConversationV1({ accountId: account.id, caller, input: exactInput }),
                admitAutomationConversationV1({ accountId: account.id, caller, input: exactInput }),
            ]);
            const exactResults = [first, second];
            expect(exactResults.map((result) => result.kind).sort()).toEqual([
                "admitted",
                "rejoined",
            ]);
            const exactRunIds = exactResults.flatMap((result) => (
                result.kind === "admitted" || result.kind === "rejoined" ? [result.runId] : []
            ));
            expect(new Set(exactRunIds).size).toBe(1);

            const conflictingInput = input(`postgres-conversation-conflict-${suffix}`);
            const [matching, conflicting] = await Promise.all([
                admitAutomationConversationV1({ accountId: account.id, caller, input: conflictingInput }),
                admitAutomationConversationV1({
                    accountId: account.id,
                    caller: {
                        ...caller,
                        contributionLocalId: "provider/other-observation-ingest-v1",
                    },
                    input: conflictingInput,
                }),
            ]);
            const conflictResults = [matching, conflicting];
            expect(conflictResults.map((result) => result.kind).sort()).toEqual([
                "admitted",
                "blocked",
            ]);
            expect(conflictResults.find((result) => result.kind === "blocked")).toEqual({
                kind: "blocked",
                reason: "occurrenceConflict",
                checkpointSafe: false,
            });
            expect(await db.automationRun.count({ where: { accountId: account.id } })).toBe(2);
        });
    },
);
