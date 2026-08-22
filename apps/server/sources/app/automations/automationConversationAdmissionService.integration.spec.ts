import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
    MAX_NON_TERMINAL_AUTOMATIC_RUNS_PER_ACCOUNT,
    normalizePluginReleaseFactsV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    serializeAutomationRunExecutionRecipeV1,
    type AutomationConversationResultDeliveryV1,
    type PluginJsonValueV2,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    claimNextAutomationReplyHandoff,
    findNextAutomationReplyHandoffDueAt,
} from "./automationReplyHandoffService";
import {
    admitAutomationConversationV1,
} from "./automationConversationAdmissionService";
import {
    listAutomationConversationTargetsV1,
    verifyAutomationConversationTargetV1,
} from "./automationConversationTargetVerificationService";

const ACCOUNT_ID = "account-conversation-admission";
const MACHINE_ID = "machine-conversation-admission";
const MACHINE_INSTALLATION_ID = "installation-conversation-admission";
const MATERIALIZATION_ID = "materialization-conversation-admission";
const SERVER_IDENTITY_ID = "srv_conversationAdmission";
const PLUGIN_ID = "happier.channels";
const PLUGIN_VERSION = "1.0.0";
const OTHER_PLUGIN_ID = "com.example.other";
const AUTOMATION_ID = "automation-conversation-admission";
const ARCHIVE_DIGEST = `sha256:${"a".repeat(64)}`;
const CONTRIBUTION_LOCAL_ID = "provider/observation-ingest-v1";
const BINDING_ID = "binding-conversation-admission";

const caller = {
    pluginId: PLUGIN_ID,
    contributionLocalId: CONTRIBUTION_LOCAL_ID,
    machineId: MACHINE_ID,
    machineInstallationId: MACHINE_INSTALLATION_ID,
    materializationId: MATERIALIZATION_ID,
} as const;

const releaseFacts = normalizePluginReleaseFactsV1({
    ref: { pluginId: PLUGIN_ID, version: PLUGIN_VERSION },
    archiveDigestSha256: ARCHIVE_DIGEST,
    normalizedManifest: {
        schemaVersion: 2,
        id: PLUGIN_ID,
        version: PLUGIN_VERSION,
        displayName: "Channels conversation admission fixture",
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

function strictConversationDefinitionRecipe(): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 3,
        template: {
            t: "plain",
            v: { v: 1, prompt: "Respond to the Conversation message." },
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
        throw new Error("Failed to construct a strict Conversation Automation definition");
    }
    return serialized.serialized;
}

const FINAL_RESULT_DELIVERY: AutomationConversationResultDeliveryV1 = {
    kind: "finalResult",
    actionRef: {
        pluginId: "happier.channels",
        localId: "automation/result-deliver-v1",
    },
    opaqueContext: {
        connectionId: "connection-1",
        bindingId: BINDING_ID,
    },
};

function conversationInput(params: Readonly<{
    resultDelivery?: AutomationConversationResultDeliveryV1;
}> = {}) {
    return {
        automationId: AUTOMATION_ID,
        bindingId: BINDING_ID,
        templateVersion: 3,
        occurrenceId: "conversation-occurrence-admission",
        occurredAt: 1_723_247_200_000,
        sender: { id: "sender-1" },
        text: "Please summarize the latest change.",
        resultDelivery: params.resultDelivery ?? FINAL_RESULT_DELIVERY,
    };
}

describe("Automation Conversation admission database boundary", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-conversation-admission-",
            initAuth: false,
            env: { HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID },
        });
    }, 120_000);

    afterAll(async () => await harness?.close());

    afterEach(async () => {
        harness?.resetEnv();
        await harness?.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.pluginMachineMaterialization.deleteMany(),
            () => db.accountPluginIntent.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
            () => db.simpleCache.deleteMany(),
        ]);
    });

    beforeEach(async () => {
        await db.account.create({
            data: { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" },
        });
        await db.machine.create({
            data: {
                id: MACHINE_ID,
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: MACHINE_INSTALLATION_ID,
                pluginMaterializationRevision: 1n,
            },
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                desiredVersion: PLUGIN_VERSION,
                enabled: true,
                writableCollections: [],
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: PLUGIN_ID,
                version: PLUGIN_VERSION,
                archiveDigestSha256: releaseFacts.archiveDigestSha256,
                normalizedManifest: releaseFacts.normalizedManifest,
                collectionContracts: releaseFacts.collectionContracts,
                uiSlots: releaseFacts.uiSlots,
                packageAssetArchive: releaseFacts.packageAssetArchive,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: MATERIALIZATION_ID,
                pluginId: PLUGIN_ID,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: ARCHIVE_DIGEST,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-12T00:00:00.000Z"),
            },
        });
        await db.automation.create({
            data: {
                id: AUTOMATION_ID,
                accountId: ACCOUNT_ID,
                name: "Conversation admission",
                enabled: true,
                targetType: "execution_run",
                templateCiphertext: strictConversationDefinitionRecipe(),
                templateVersion: 3,
                triggerKind: "manual",
            },
        });
    });

    it("persists resultDelivery:none without handoff facts, a wake, or a claim", async () => {
        const input = conversationInput({ resultDelivery: { kind: "none" } });
        const admitted = await admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        });

        expect(admitted).toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        if (admitted.kind !== "admitted") throw new Error("Expected Conversation admission");
        const run = await db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: {
                originKind: true,
                originOccurredAt: true,
                occurrenceKey: true,
                triggerEvidenceEnvelope: true,
                executionDispatchState: true,
                replyContextEnvelope: true,
                replyHandoffActionPluginId: true,
                replyHandoffActionLocalId: true,
                replyHandoffTargetMachineId: true,
                replyHandoffTargetMachineInstallationId: true,
                replyHandoffTargetMaterializationId: true,
                replyHandoffId: true,
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
                replyHandoffReceiptEnvelope: true,
            },
        });

        expect(run).toEqual({
            originKind: "conversation",
            originOccurredAt: new Date(input.occurredAt),
            occurrenceKey: expect.any(String),
            triggerEvidenceEnvelope: expect.any(String),
            executionDispatchState: "notStarted",
            replyContextEnvelope: null,
            replyHandoffActionPluginId: null,
            replyHandoffActionLocalId: null,
            replyHandoffTargetMachineId: null,
            replyHandoffTargetMachineInstallationId: null,
            replyHandoffTargetMaterializationId: null,
            replyHandoffId: null,
            replyHandoffState: "none",
            replyHandoffAttempt: 0,
            replyHandoffDueAt: null,
            replyHandoffReceiptEnvelope: null,
        });
        await expect(findNextAutomationReplyHandoffDueAt({ now: new Date() })).resolves.toBeNull();
        await expect(claimNextAutomationReplyHandoff({ now: new Date() })).resolves.toBeNull();
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        })).resolves.toEqual({
            kind: "rejoined",
            runId: admitted.runId,
            checkpointSafe: true,
        });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input: conversationInput(),
        })).resolves.toEqual({
            kind: "blocked",
            reason: "occurrenceConflict",
            checkpointSafe: false,
        });
    });

    it("feeds one Automation from several conversation bindings without disturbing its trigger", async () => {
        // A Discord thread and a Telegram chat can both drive the same daily
        // Automation. Each binding keeps its own occurrence identity, so both
        // admit distinct Runs against one durable target.
        const first = await admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...conversationInput({ resultDelivery: { kind: "none" } }),
                bindingId: "binding-discord-thread-a",
            },
        });
        const second = await admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                ...conversationInput({ resultDelivery: { kind: "none" } }),
                bindingId: "binding-telegram-chat-b",
            },
        });

        expect(first).toEqual({ kind: "admitted", runId: expect.any(String), checkpointSafe: true });
        expect(second).toEqual({ kind: "admitted", runId: expect.any(String), checkpointSafe: true });
        if (first.kind !== "admitted" || second.kind !== "admitted") {
            throw new Error("Expected both bindings to admit into the same Automation");
        }
        expect(first.runId).not.toBe(second.runId);
        await expect(db.automationRun.count({
            where: { accountId: ACCOUNT_ID, automationId: AUTOMATION_ID },
        })).resolves.toBe(2);
        // The Automation's own trigger is untouched by either binding.
        await expect(db.automation.findUniqueOrThrow({
            where: { id: AUTOMATION_ID },
            select: { triggerKind: true, triggerDefinitionEnvelope: true },
        })).resolves.toEqual({ triggerKind: "manual", triggerDefinitionEnvelope: null });
    });

    it("rejoins only the same logical Channels caller across a materialization rollover", async () => {
        const input = conversationInput({ resultDelivery: { kind: "none" } });
        const admitted = await admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        });
        expect(admitted).toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        if (admitted.kind !== "admitted") throw new Error("Expected Conversation admission");

        await db.pluginMachineMaterialization.update({
            where: {
                machineId_materializationId: {
                    machineId: MACHINE_ID,
                    materializationId: MATERIALIZATION_ID,
                },
            },
            data: { enabled: false },
        });
        const replacementMaterializationId = "materialization-conversation-admission-v2";
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: replacementMaterializationId,
                pluginId: PLUGIN_ID,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: ARCHIVE_DIGEST,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-12T00:01:00.000Z"),
            },
        });
        const replacementCaller = {
            ...caller,
            materializationId: replacementMaterializationId,
        };
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller: replacementCaller,
            input,
        })).resolves.toEqual({
            kind: "rejoined",
            runId: admitted.runId,
            checkpointSafe: true,
        });

        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller: {
                ...replacementCaller,
                contributionLocalId: "provider/other-observation-ingest-v1",
            },
            input,
        })).resolves.toEqual({
            kind: "blocked",
            reason: "occurrenceConflict",
            checkpointSafe: false,
        });

        const otherMachineId = "machine-conversation-admission-other";
        const otherMachineInstallationId = "installation-conversation-admission-other";
        const otherMachineMaterializationId = "materialization-conversation-admission-other";
        await db.machine.create({
            data: {
                id: otherMachineId,
                accountId: ACCOUNT_ID,
                metadata: "{}",
                installationId: otherMachineInstallationId,
                pluginMaterializationRevision: 1n,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: otherMachineId,
                materializationId: otherMachineMaterializationId,
                pluginId: PLUGIN_ID,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: ARCHIVE_DIGEST,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-12T00:02:00.000Z"),
            },
        });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller: {
                ...caller,
                machineId: otherMachineId,
                machineInstallationId: otherMachineInstallationId,
                materializationId: otherMachineMaterializationId,
            },
            input,
        })).resolves.toEqual({
            kind: "blocked",
            reason: "occurrenceConflict",
            checkpointSafe: false,
        });
        await expect(db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);
    });

    it("creates one Run and equality-rejoins an exact concurrent Conversation admission", async () => {
        const input = conversationInput({ resultDelivery: { kind: "none" } });
        const [first, second] = await Promise.all([
            admitAutomationConversationV1({ accountId: ACCOUNT_ID, caller, input }),
            admitAutomationConversationV1({ accountId: ACCOUNT_ID, caller, input }),
        ]);
        const results = [first, second];
        expect(results.map((result) => result.kind).sort()).toEqual(["admitted", "rejoined"]);
        expect(results.every((result) => result.checkpointSafe)).toBe(true);
        const runIds = results.flatMap((result) => (
            result.kind === "admitted" || result.kind === "rejoined" ? [result.runId] : []
        ));
        expect(new Set(runIds).size).toBe(1);
        await expect(db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);
    });

    it("releases automatic-origin capacity after an exhausted execution Run is terminally failed", async () => {
        const now = new Date();
        await db.automationRun.createMany({
            data: Array.from({ length: MAX_NON_TERMINAL_AUTOMATIC_RUNS_PER_ACCOUNT }, (_, index) => ({
                id: `conversation-capacity-run-${index}`,
                automationId: AUTOMATION_ID,
                accountId: ACCOUNT_ID,
                state: "queued" as const,
                originKind: "conversation" as const,
                originOccurredAt: now,
                occurrenceKey: `conversation-capacity-occurrence-${index}`,
                triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
                scheduledAt: now,
                dueAt: now,
            })),
        });

        const input = conversationInput({ resultDelivery: { kind: "none" } });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        })).resolves.toEqual({
            kind: "blocked",
            reason: "capacity",
            checkpointSafe: false,
        });

        await db.automationRun.update({
            where: { id: "conversation-capacity-run-9999" },
            data: {
                state: "failed",
                executionDispatchState: "settled",
                executionAttempt: 3,
                executionDispatchDueAt: null,
                executionNativeRunId: null,
                executionNativeCallId: null,
                executionNativeSidechainId: null,
                claimedByMachineId: null,
                leaseExpiresAt: null,
                finishedAt: now,
                errorCode: "execution_run_retry_exhausted",
            },
        });

        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        })).resolves.toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: "conversation-capacity-run-9999" },
            select: {
                state: true,
                executionDispatchState: true,
                executionAttempt: true,
                errorCode: true,
            },
        })).resolves.toEqual({
            state: "failed",
            executionDispatchState: "settled",
            executionAttempt: 3,
            errorCode: "execution_run_retry_exhausted",
        });
    });

    it("admits the same observed occurrence independently for each matching Automation", async () => {
        const secondAutomationId = "automation-conversation-admission-second";
        await db.automation.create({
            data: {
                id: secondAutomationId,
                accountId: ACCOUNT_ID,
                name: "Second Conversation admission",
                enabled: true,
                targetType: "execution_run",
                templateCiphertext: strictConversationDefinitionRecipe(),
                templateVersion: 3,
                triggerKind: "schedule",
                scheduleKind: "interval",
                everyMs: 60_000,
            },
        });

        const input = conversationInput({ resultDelivery: { kind: "none" } });
        const [first, second] = await Promise.all([
            admitAutomationConversationV1({ accountId: ACCOUNT_ID, caller, input }),
            admitAutomationConversationV1({
                accountId: ACCOUNT_ID,
                caller,
                input: { ...input, automationId: secondAutomationId },
            }),
        ]);

        expect(first).toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        expect(second).toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        if (first.kind !== "admitted" || second.kind !== "admitted") {
            throw new Error("Expected both matching Automations to admit the occurrence");
        }
        expect(first.runId).not.toBe(second.runId);

        const runs = await db.automationRun.findMany({
            where: { accountId: ACCOUNT_ID },
            orderBy: { automationId: "asc" },
            select: { automationId: true, occurrenceKey: true },
        });
        expect(runs).toEqual([
            { automationId: AUTOMATION_ID, occurrenceKey: expect.any(String) },
            { automationId: secondAutomationId, occurrenceKey: expect.any(String) },
        ]);
        expect(new Set(runs.map((run) => run.occurrenceKey)).size).toBe(1);
    });

    it("creates one Run and conflicts a concurrent same occurrence from a different logical caller", async () => {
        const input = conversationInput({ resultDelivery: { kind: "none" } });
        const [first, second] = await Promise.all([
            admitAutomationConversationV1({ accountId: ACCOUNT_ID, caller, input }),
            admitAutomationConversationV1({
                accountId: ACCOUNT_ID,
                caller: {
                    ...caller,
                    contributionLocalId: "provider/other-observation-ingest-v1",
                },
                input,
            }),
        ]);
        const results = [first, second];
        expect(results.map((result) => result.kind).sort()).toEqual(["admitted", "blocked"]);
        expect(results.find((result) => result.kind === "blocked")).toEqual({
            kind: "blocked",
            reason: "occurrenceConflict",
            checkpointSafe: false,
        });
        await expect(db.automationRun.count({ where: { accountId: ACCOUNT_ID } })).resolves.toBe(1);
    });

    it("lists, verifies, and admits an existing Account Automation for an out-of-tree plugin", async () => {
        const externalPluginId = "acme.slack-bridge";
        const externalMaterializationId = "materialization-acme-slack-bridge";
        const externalReleaseFacts = normalizePluginReleaseFactsV1({
            ref: { pluginId: externalPluginId, version: PLUGIN_VERSION },
            archiveDigestSha256: ARCHIVE_DIGEST,
            normalizedManifest: {
                schemaVersion: 2,
                id: externalPluginId,
                version: PLUGIN_VERSION,
                displayName: "Out-of-tree bridge fixture",
                engines: { happier: "^1.0.0" },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: "./dist/index.js" },
                contributes: { actions: [], events: [], webhooks: [] },
            },
            collectionContracts: [],
            uiSlots: [],
            packageAssetArchive: releaseFacts.packageAssetArchive,
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: externalPluginId,
                desiredVersion: PLUGIN_VERSION,
                enabled: true,
                writableCollections: [],
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: externalPluginId,
                version: PLUGIN_VERSION,
                archiveDigestSha256: externalReleaseFacts.archiveDigestSha256,
                normalizedManifest: externalReleaseFacts.normalizedManifest,
                collectionContracts: externalReleaseFacts.collectionContracts,
                uiSlots: externalReleaseFacts.uiSlots,
                packageAssetArchive: externalReleaseFacts.packageAssetArchive,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: externalMaterializationId,
                pluginId: externalPluginId,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: ARCHIVE_DIGEST,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-12T00:00:00.000Z"),
            },
        });

        const externalCaller = {
            pluginId: externalPluginId,
            contributionLocalId: "slack/observation-ingest-v1",
            machineId: MACHINE_ID,
            machineInstallationId: MACHINE_INSTALLATION_ID,
            materializationId: externalMaterializationId,
        } as const;
        const externalBindingId = "binding-acme-slack-bridge";

        // The target is an ordinary Account Automation with its own schedule.
        // The out-of-tree plugin never authors it; it binds the one the user
        // already has, exactly as the bundled plugin would.
        const scheduledAutomationId = "automation-conversation-admission-scheduled";
        await db.automation.create({
            data: {
                id: scheduledAutomationId,
                accountId: ACCOUNT_ID,
                name: "Slack bridge conversation",
                enabled: true,
                targetType: "execution_run",
                templateCiphertext: strictConversationDefinitionRecipe(),
                templateVersion: 3,
                triggerKind: "schedule",
                scheduleKind: "interval",
                everyMs: 60_000,
            },
        });
        await db.automationAssignment.create({
            data: {
                automationId: scheduledAutomationId,
                machineId: MACHINE_ID,
                enabled: true,
            },
        });
        const created = { kind: "created" as const, automationId: scheduledAutomationId };

        const externalTargets = await listAutomationConversationTargetsV1({
            accountId: ACCOUNT_ID,
            caller: externalCaller,
            input: {},
        });
        const channelsTargets = await listAutomationConversationTargetsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {},
        });
        // Identical capability: the out-of-tree plugin sees exactly the same
        // Account targets the bundled plugin does.
        expect(externalTargets).toEqual(channelsTargets);
        expect(externalTargets.items.map((item) => item.automationId).sort())
            .toEqual([AUTOMATION_ID, scheduledAutomationId].sort());

        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller: externalCaller,
            input: { automationId: created.automationId, expectedTemplateVersion: 3 },
        })).resolves.toEqual({ kind: "verified", templateVersion: 3 });
        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { automationId: created.automationId, expectedTemplateVersion: 3 },
        })).resolves.toEqual({ kind: "verified", templateVersion: 3 });

        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller: externalCaller,
            input: {
                automationId: created.automationId,
                bindingId: externalBindingId,
                templateVersion: 3,
                occurrenceId: "slack:event:1",
                occurredAt: 1_724_000_000_000,
                sender: { id: "U-123" },
                text: "Please summarize the latest change.",
                resultDelivery: {
                    kind: "finalResult",
                    actionRef: {
                        pluginId: externalPluginId,
                        localId: "automation/reply-deliver-v1",
                    },
                    opaqueContext: { channelId: "C-123" },
                },
            },
        })).resolves.toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });

        // The reply handoff is frozen onto the authoring plugin's own Action.
        await expect(db.automationRun.findFirst({
            where: { automationId: created.automationId },
            select: {
                replyHandoffActionPluginId: true,
                replyHandoffActionLocalId: true,
                replyHandoffTargetMachineId: true,
                replyHandoffState: true,
            },
        })).resolves.toEqual({
            replyHandoffActionPluginId: externalPluginId,
            replyHandoffActionLocalId: "automation/reply-deliver-v1",
            replyHandoffTargetMachineId: MACHINE_ID,
            replyHandoffState: "awaitingResult",
        });
    });

    it("admits a current external plugin materialization through the generic conversation policy", async () => {
        const otherReleaseFacts = normalizePluginReleaseFactsV1({
            ref: { pluginId: OTHER_PLUGIN_ID, version: PLUGIN_VERSION },
            archiveDigestSha256: ARCHIVE_DIGEST,
            normalizedManifest: {
                schemaVersion: 2,
                id: OTHER_PLUGIN_ID,
                version: PLUGIN_VERSION,
                displayName: "Other plugin fixture",
                engines: { happier: "^1.0.0" },
                runtime: { apiVersion: 1 },
                entrypoints: { daemon: "./dist/index.js" },
                contributes: { actions: [], events: [], webhooks: [] },
            },
            collectionContracts: [],
            uiSlots: [],
            packageAssetArchive: releaseFacts.packageAssetArchive,
        });
        await db.accountPluginIntent.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: OTHER_PLUGIN_ID,
                desiredVersion: PLUGIN_VERSION,
                enabled: true,
                writableCollections: [],
            },
        });
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: OTHER_PLUGIN_ID,
                version: PLUGIN_VERSION,
                archiveDigestSha256: otherReleaseFacts.archiveDigestSha256,
                normalizedManifest: otherReleaseFacts.normalizedManifest,
                collectionContracts: otherReleaseFacts.collectionContracts,
                uiSlots: otherReleaseFacts.uiSlots,
                packageAssetArchive: otherReleaseFacts.packageAssetArchive,
            },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: "materialization-other-plugin",
                pluginId: OTHER_PLUGIN_ID,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: ARCHIVE_DIGEST,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-12T00:00:00.000Z"),
            },
        });

        const externalCaller = {
            ...caller,
            pluginId: OTHER_PLUGIN_ID,
            materializationId: "materialization-other-plugin",
        };
        // The Account's Automations belong to the user, not to a plugin: an
        // out-of-tree plugin binds the very same target the bundled plugin can,
        // with byte-identical capability and no policy row naming either id.
        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller: externalCaller,
            input: { automationId: AUTOMATION_ID, expectedTemplateVersion: 3 },
        })).resolves.toEqual({ kind: "verified", templateVersion: 3 });
        await expect(listAutomationConversationTargetsV1({
            accountId: ACCOUNT_ID,
            caller: externalCaller,
            input: {},
        })).resolves.toEqual({
            items: [{
                automationId: AUTOMATION_ID,
                templateVersion: 3,
                label: "Conversation admission",
            }],
            nextCursor: null,
        });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller: externalCaller,
            input: {
                ...conversationInput({ resultDelivery: { kind: "none" } }),
                bindingId: "binding-out-of-tree",
            },
        })).resolves.toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        await expect(db.automationRun.count()).resolves.toBe(1);
    });

    it("freezes finalResult custody and rejects a rejoin with a changed opaque context", async () => {
        const input = conversationInput();
        const finalResultDelivery = input.resultDelivery;
        if (finalResultDelivery.kind !== "finalResult") {
            throw new Error("Expected final-result test fixture");
        }
        const admitted = await admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        });

        expect(admitted).toEqual({
            kind: "admitted",
            runId: expect.any(String),
            checkpointSafe: true,
        });
        if (admitted.kind !== "admitted") throw new Error("Expected Conversation admission");
        const run = await db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: {
                replyContextEnvelope: true,
                replyHandoffActionPluginId: true,
                replyHandoffActionLocalId: true,
                replyHandoffTargetMachineId: true,
                replyHandoffTargetMachineInstallationId: true,
                replyHandoffTargetMaterializationId: true,
                replyHandoffId: true,
                replyHandoffState: true,
                replyHandoffAttempt: true,
                replyHandoffDueAt: true,
                replyHandoffReceiptEnvelope: true,
            },
        });

        expect(run).toEqual({
            replyContextEnvelope: expect.any(String),
            replyHandoffActionPluginId: "happier.channels",
            replyHandoffActionLocalId: "automation/result-deliver-v1",
            replyHandoffTargetMachineId: MACHINE_ID,
            replyHandoffTargetMachineInstallationId: MACHINE_INSTALLATION_ID,
            replyHandoffTargetMaterializationId: MATERIALIZATION_ID,
            replyHandoffId: expect.any(String),
            replyHandoffState: "awaitingResult",
            replyHandoffAttempt: 0,
            replyHandoffDueAt: null,
            replyHandoffReceiptEnvelope: null,
        });
        expect(JSON.parse(run.replyContextEnvelope!)).toEqual({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    accountId: ACCOUNT_ID,
                    automationId: AUTOMATION_ID,
                    runId: admitted.runId,
                    handoffId: run.replyHandoffId,
                },
                source: {
                    kind: "automationResult",
                    automationRunId: admitted.runId,
                    resultId: run.replyHandoffId,
                    automationId: AUTOMATION_ID,
                    templateVersion: 3,
                    resultDelivery: "finalResult",
                },
                opaqueContext: finalResultDelivery.opaqueContext,
            },
        });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        })).resolves.toEqual({
            kind: "rejoined",
            runId: admitted.runId,
            checkpointSafe: true,
        });
        await db.pluginMachineMaterialization.update({
            where: {
                machineId_materializationId: {
                    machineId: MACHINE_ID,
                    materializationId: MATERIALIZATION_ID,
                },
            },
            data: { enabled: false },
        });
        await db.pluginMachineMaterialization.create({
            data: {
                accountId: ACCOUNT_ID,
                serverIdentityId: SERVER_IDENTITY_ID,
                machineId: MACHINE_ID,
                materializationId: "materialization-conversation-admission-v2",
                pluginId: PLUGIN_ID,
                version: PLUGIN_VERSION,
                sourceClass: "registryPackage",
                portableRelease: true,
                archiveDigestSha256: ARCHIVE_DIGEST,
                uiArtifacts: [],
                enabled: true,
                trustState: "trusted",
                observedAt: new Date("2026-08-12T00:01:00.000Z"),
            },
        });
        const replacementCaller = {
            ...caller,
            materializationId: "materialization-conversation-admission-v2",
        };
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller: replacementCaller,
            input,
        })).resolves.toEqual({
            kind: "rejoined",
            runId: admitted.runId,
            checkpointSafe: true,
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: { replyHandoffTargetMaterializationId: true },
        })).resolves.toEqual({
            replyHandoffTargetMaterializationId: MATERIALIZATION_ID,
        });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller: replacementCaller,
            input: conversationInput({
                resultDelivery: {
                    kind: "finalResult",
                    actionRef: {
                        pluginId: "happier.channels",
                        localId: "automation/result-deliver-v1",
                    },
                    opaqueContext: {
                        connectionId: "connection-1",
                        bindingId: "binding-conversation-admission",
                        replacement: true,
                    },
                },
            }),
        })).resolves.toEqual({
            kind: "blocked",
            reason: "occurrenceConflict",
            checkpointSafe: false,
        });
        await db.automation.update({
            where: { id: AUTOMATION_ID },
            data: { templateVersion: 4 },
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: { replyContextEnvelope: true },
        })).resolves.toEqual({
            replyContextEnvelope: JSON.stringify({
                t: "plain",
                v: {
                    v: 1,
                    correspondence: {
                        accountId: ACCOUNT_ID,
                        automationId: AUTOMATION_ID,
                        runId: admitted.runId,
                        handoffId: run.replyHandoffId,
                    },
                    source: {
                        kind: "automationResult",
                        automationRunId: admitted.runId,
                        resultId: run.replyHandoffId,
                        automationId: AUTOMATION_ID,
                        templateVersion: 3,
                        resultDelivery: "finalResult",
                    },
                    opaqueContext: finalResultDelivery.opaqueContext,
                },
            }),
        });
    });

    it.each([
        ["a template edit", async () => {
            await db.automation.update({
                where: { id: AUTOMATION_ID },
                data: { templateVersion: 4 },
            });
        }],
        ["disabling the Automation", async () => {
            await db.automation.update({
                where: { id: AUTOMATION_ID },
                data: { enabled: false },
            });
        }],
    ] as const)("rejoins an exact frozen final-result handoff after %s", async (_description, mutate) => {
        const input = conversationInput();
        const finalResultDelivery = input.resultDelivery;
        if (finalResultDelivery.kind !== "finalResult") {
            throw new Error("Expected final-result test fixture");
        }
        const admitted = await admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        });
        if (admitted.kind !== "admitted") throw new Error("Expected Conversation admission");

        const frozenHandoff = await db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: {
                replyHandoffId: true,
                replyHandoffState: true,
                replyContextEnvelope: true,
            },
        });
        expect(JSON.parse(frozenHandoff.replyContextEnvelope!)).toMatchObject({
            v: {
                source: {
                    kind: "automationResult",
                    automationRunId: admitted.runId,
                    resultId: frozenHandoff.replyHandoffId,
                    automationId: AUTOMATION_ID,
                    templateVersion: 3,
                    resultDelivery: "finalResult",
                },
            },
        });
        const accountChangesBeforeReplay = await db.accountChange.count({
            where: { accountId: ACCOUNT_ID },
        });

        await mutate();

        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input,
        })).resolves.toEqual({
            kind: "rejoined",
            runId: admitted.runId,
            checkpointSafe: true,
        });
        await expect(admitAutomationConversationV1({
            accountId: ACCOUNT_ID,
            caller,
            input: conversationInput({
                resultDelivery: {
                    ...finalResultDelivery,
                    opaqueContext: {
                        connectionId: "connection-1",
                        bindingId: BINDING_ID,
                        changedAfterAdmission: true,
                    },
                },
            }),
        })).resolves.toEqual({
            kind: "blocked",
            reason: "occurrenceConflict",
            checkpointSafe: false,
        });
        await expect(db.automationRun.count({
            where: { accountId: ACCOUNT_ID },
        })).resolves.toBe(1);
        await expect(db.accountChange.count({
            where: { accountId: ACCOUNT_ID },
        })).resolves.toBe(accountChangesBeforeReplay);
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted.runId },
            select: {
                replyHandoffId: true,
                replyHandoffState: true,
                replyContextEnvelope: true,
            },
        })).resolves.toEqual(frozenHandoff);
    });
});
