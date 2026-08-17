import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { normalizePluginReleaseFactsV1 } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    AutomationConversationTargetVerificationCallerError,
    listAutomationConversationTargetsV1,
    verifyAutomationConversationTargetV1,
} from "./automationConversationTargetVerificationService";

const ACCOUNT_ID = "account-conversation-target-verifier";
const FOREIGN_ACCOUNT_ID = "account-conversation-target-verifier-foreign";
const MACHINE_ID = "machine-conversation-target-verifier";
const MACHINE_INSTALLATION_ID = "installation-conversation-target-verifier";
const MATERIALIZATION_ID = "materialization-conversation-target-verifier";
const SERVER_IDENTITY_ID = "srv_conversationTargetVerifier";
const PLUGIN_ID = "happier.channels";
const PLUGIN_VERSION = "1.0.0";
const ARCHIVE_DIGEST = `sha256:${"a".repeat(64)}`;

const caller = {
    pluginId: PLUGIN_ID,
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
        displayName: "Channels verifier fixture",
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

describe("Automation conversation target verification database boundary", () => {
    let harness: LightSqliteHarness | undefined;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-conversation-target-verifier-",
            initAuth: false,
            env: { HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID },
        });
    }, 120_000);

    afterAll(async () => await harness?.close());

    afterEach(async () => {
        harness?.resetEnv();
        await harness?.resetDbTables([
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.pluginMachineMaterialization.deleteMany(),
            () => db.accountPluginRelease.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
            () => db.simpleCache.deleteMany(),
        ]);
    });

    beforeEach(async () => {
        await db.account.createMany({
            data: [
                { id: ACCOUNT_ID, publicKey: null, encryptionMode: "plain" },
                { id: FOREIGN_ACCOUNT_ID, publicKey: null, encryptionMode: "plain" },
            ],
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
        await db.automation.createMany({
            data: [
                {
                    id: "automation-conversation-owned",
                    accountId: ACCOUNT_ID,
                    name: "Owned conversation",
                    enabled: true,
                    targetType: "execution_run",
                    templateCiphertext: "owned-definition-content",
                    templateVersion: 3,
                    triggerKind: "conversation",
                    triggerDefinitionEnvelope: "owned-trigger-content",
                },
                {
                    id: "automation-conversation-deleted",
                    accountId: ACCOUNT_ID,
                    name: "Deleted conversation",
                    enabled: true,
                    deletedAt: new Date("2026-08-12T00:00:00.000Z"),
                    targetType: "execution_run",
                    templateCiphertext: "deleted-definition-content",
                    templateVersion: 3,
                    triggerKind: "conversation",
                    triggerDefinitionEnvelope: "deleted-trigger-content",
                },
                {
                    id: "automation-schedule-owned",
                    accountId: ACCOUNT_ID,
                    name: "Owned schedule",
                    enabled: true,
                    scheduleKind: "interval",
                    everyMs: 60_000,
                    targetType: "execution_run",
                    templateCiphertext: "schedule-definition-content",
                    templateVersion: 3,
                    triggerKind: "schedule",
                },
                {
                    id: "automation-conversation-foreign",
                    accountId: FOREIGN_ACCOUNT_ID,
                    name: "Foreign conversation",
                    enabled: true,
                    targetType: "execution_run",
                    templateCiphertext: "foreign-definition-content",
                    templateVersion: 3,
                    triggerKind: "conversation",
                    triggerDefinitionEnvelope: "foreign-trigger-content",
                },
            ],
        });
    });

    it("returns the owned exact version through the real currentness and Automation read owners", async () => {
        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                automationId: "automation-conversation-owned",
                expectedTemplateVersion: 3,
            },
        })).resolves.toEqual({ kind: "verified", templateVersion: 3 });
    });

    it.each([
        "automation-conversation-missing",
        "automation-conversation-deleted",
        "automation-conversation-foreign",
    ])("folds inaccessible target %s into the same notFound result", async (automationId) => {
        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { automationId, expectedTemplateVersion: 3 },
        })).resolves.toEqual({ kind: "notVerified", reason: "notFound" });
    });

    it("classifies a visible non-Conversation Automation without exposing content", async () => {
        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                automationId: "automation-schedule-owned",
                expectedTemplateVersion: 3,
            },
        })).resolves.toEqual({ kind: "notVerified", reason: "notConversation" });
    });

    it("reports version mismatch without returning the current version or stored content", async () => {
        const result = await verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                automationId: "automation-conversation-owned",
                expectedTemplateVersion: 2,
            },
        });

        expect(result).toEqual({ kind: "notVerified", reason: "templateVersionMismatch" });
        expect(result).not.toHaveProperty("templateVersion");
        expect(result).not.toHaveProperty("templateCiphertext");
        expect(result).not.toHaveProperty("triggerDefinitionEnvelope");
    });

    it("projects only current Account conversation targets, including disabled targets, without Automation content", async () => {
        await db.automation.create({
            data: {
                id: "automation-conversation-disabled",
                accountId: ACCOUNT_ID,
                name: "Disabled conversation",
                enabled: false,
                targetType: "execution_run",
                templateCiphertext: "disabled-definition-content",
                templateVersion: 4,
                triggerKind: "conversation",
                triggerDefinitionEnvelope: "disabled-trigger-content",
            },
        });

        await expect(listAutomationConversationTargetsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { limit: 100 },
        })).resolves.toEqual({
            items: [
                {
                    automationId: "automation-conversation-disabled",
                    templateVersion: 4,
                    label: "Disabled conversation",
                },
                {
                    automationId: "automation-conversation-owned",
                    templateVersion: 3,
                    label: "Owned conversation",
                },
            ],
            nextCursor: null,
        });
    });

    it("uses a stateless ID keyset with the server's 100-item default", async () => {
        await db.automation.createMany({
            data: Array.from({ length: 101 }, (_, index) => {
                const serial = String(index + 1).padStart(3, "0");
                return {
                    id: `automation-page-${serial}`,
                    accountId: ACCOUNT_ID,
                    name: `Target ${serial}`,
                    enabled: index % 2 === 0,
                    targetType: "execution_run" as const,
                    templateCiphertext: `page-definition-${serial}`,
                    templateVersion: index,
                    triggerKind: "conversation" as const,
                    triggerDefinitionEnvelope: `page-trigger-${serial}`,
                };
            }),
        });

        const firstPage = await listAutomationConversationTargetsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {},
        });
        expect(firstPage.items).toHaveLength(100);
        expect(firstPage.items.map((item) => item.automationId)).toEqual([
            "automation-conversation-owned",
            ...Array.from({ length: 99 }, (_, index) =>
                `automation-page-${String(index + 1).padStart(3, "0")}`,
            ),
        ]);
        expect(firstPage.nextCursor).toBe("automation-page-099");

        await expect(listAutomationConversationTargetsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { cursor: firstPage.nextCursor },
        })).resolves.toEqual({
            items: [
                { automationId: "automation-page-100", templateVersion: 99, label: "Target 100" },
                { automationId: "automation-page-101", templateVersion: 100, label: "Target 101" },
            ],
            nextCursor: null,
        });
    });

    it("accepts a deleted cursor and returns a later insert without cursor state", async () => {
        await db.automation.createMany({
            data: ["a", "b"].map((suffix, index) => ({
                id: `automation-keyset-${suffix}`,
                accountId: ACCOUNT_ID,
                name: `Keyset ${suffix}`,
                enabled: true,
                targetType: "execution_run" as const,
                templateCiphertext: `keyset-definition-${suffix}`,
                templateVersion: index,
                triggerKind: "conversation" as const,
                triggerDefinitionEnvelope: `keyset-trigger-${suffix}`,
            })),
        });
        await db.automation.delete({ where: { id: "automation-keyset-a" } });
        await db.automation.create({
            data: {
                id: "automation-keyset-c",
                accountId: ACCOUNT_ID,
                name: "Keyset c",
                enabled: false,
                targetType: "execution_run",
                templateCiphertext: "keyset-definition-c",
                templateVersion: 2,
                triggerKind: "conversation",
                triggerDefinitionEnvelope: "keyset-trigger-c",
            },
        });

        await expect(listAutomationConversationTargetsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { cursor: "automation-keyset-a" },
        })).resolves.toEqual({
            items: [
                { automationId: "automation-keyset-b", templateVersion: 1, label: "Keyset b" },
                { automationId: "automation-keyset-c", templateVersion: 2, label: "Keyset c" },
            ],
            nextCursor: null,
        });
    });

    it("rejects a stale exact materialization before disclosing Automation classification", async () => {
        await db.pluginMachineMaterialization.update({
            where: {
                machineId_materializationId: {
                    machineId: MACHINE_ID,
                    materializationId: MATERIALIZATION_ID,
                },
            },
            data: { enabled: false },
        });

        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                automationId: "automation-conversation-owned",
                expectedTemplateVersion: 2,
            },
        })).rejects.toBeInstanceOf(AutomationConversationTargetVerificationCallerError);
    });

    it("rejects a stale exact materialization before querying the target-list projection", async () => {
        await db.pluginMachineMaterialization.update({
            where: {
                machineId_materializationId: {
                    machineId: MACHINE_ID,
                    materializationId: MATERIALIZATION_ID,
                },
            },
            data: { enabled: false },
        });

        await expect(listAutomationConversationTargetsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {},
        })).rejects.toBeInstanceOf(AutomationConversationTargetVerificationCallerError);
    });
});
