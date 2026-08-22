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
                    id: "automation-manual-owned",
                    accountId: ACCOUNT_ID,
                    name: "Owned manual",
                    enabled: true,
                    targetType: "execution_run",
                    templateCiphertext: "manual-definition-content",
                    templateVersion: 3,
                    triggerKind: "manual",
                },
                {
                    id: "automation-schedule-deleted",
                    accountId: ACCOUNT_ID,
                    name: "Deleted schedule",
                    enabled: true,
                    deletedAt: new Date("2026-08-12T00:00:00.000Z"),
                    scheduleKind: "interval",
                    everyMs: 60_000,
                    targetType: "execution_run",
                    templateCiphertext: "deleted-definition-content",
                    templateVersion: 3,
                    triggerKind: "schedule",
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
                    id: "automation-schedule-foreign",
                    accountId: FOREIGN_ACCOUNT_ID,
                    name: "Foreign schedule",
                    enabled: true,
                    scheduleKind: "interval",
                    everyMs: 60_000,
                    targetType: "execution_run",
                    templateCiphertext: "foreign-definition-content",
                    templateVersion: 3,
                    triggerKind: "schedule",
                },
            ],
        });
    });

    it("verifies an existing schedule Automation so a conversation is an additional invocation source", async () => {
        // A conversation binding never replaces the Automation's primary
        // trigger, so a scheduled Automation is a first-class binding target
        // and its schedule stays exactly where it was.
        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                automationId: "automation-schedule-owned",
                expectedTemplateVersion: 3,
            },
        })).resolves.toEqual({ kind: "verified", templateVersion: 3 });

        await expect(db.automation.findUnique({
            where: { id: "automation-schedule-owned" },
            select: { triggerKind: true, scheduleKind: true, everyMs: true },
        })).resolves.toEqual({ triggerKind: "schedule", scheduleKind: "interval", everyMs: 60_000 });
    });

    it("verifies one Automation for every distinct conversation binding that names it", async () => {
        // Multiple bindings feed one Automation, so verification carries no
        // per-binding exclusivity: the same target answers each binding.
        for (const _binding of ["binding-discord-thread-a", "binding-telegram-chat-b"]) {
            await expect(verifyAutomationConversationTargetV1({
                accountId: ACCOUNT_ID,
                caller,
                input: {
                    automationId: "automation-schedule-owned",
                    expectedTemplateVersion: 3,
                },
            })).resolves.toEqual({ kind: "verified", templateVersion: 3 });
        }
    });

    it("verifies an Automation for a plugin that did not author it", async () => {
        // Automations belong to the Account, not to a plugin: any installed
        // plugin the user binds from reaches the same targets.
        await db.accountPluginRelease.create({
            data: {
                accountId: ACCOUNT_ID,
                pluginId: "acme.slack-bridge",
                version: PLUGIN_VERSION,
                archiveDigestSha256: releaseFacts.archiveDigestSha256,
                normalizedManifest: {
                    ...releaseFacts.normalizedManifest,
                    id: "acme.slack-bridge",
                },
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
                materializationId: "materialization-acme-slack-bridge",
                pluginId: "acme.slack-bridge",
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

        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller: {
                pluginId: "acme.slack-bridge",
                machineId: MACHINE_ID,
                machineInstallationId: MACHINE_INSTALLATION_ID,
                materializationId: "materialization-acme-slack-bridge",
            },
            input: {
                automationId: "automation-schedule-owned",
                expectedTemplateVersion: 3,
            },
        })).resolves.toEqual({ kind: "verified", templateVersion: 3 });
    });

    it.each([
        "automation-schedule-missing",
        "automation-schedule-deleted",
        "automation-schedule-foreign",
    ])("folds inaccessible target %s into the same notFound result", async (automationId) => {
        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { automationId, expectedTemplateVersion: 3 },
        })).resolves.toEqual({ kind: "notVerified", reason: "notFound" });
    });

    it("reports version mismatch without returning the current version or stored content", async () => {
        const result = await verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                automationId: "automation-schedule-owned",
                expectedTemplateVersion: 2,
            },
        });

        expect(result).toEqual({ kind: "notVerified", reason: "templateVersionMismatch" });
        expect(result).not.toHaveProperty("templateVersion");
        expect(result).not.toHaveProperty("templateCiphertext");
        expect(result).not.toHaveProperty("triggerDefinitionEnvelope");
    });

    it("refuses final-result delivery for a target that cannot carry a reply", async () => {
        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                automationId: "automation-schedule-owned",
                expectedTemplateVersion: 3,
                resultDelivery: "finalResult",
            },
        })).resolves.toEqual({ kind: "notVerified", reason: "resultDeliveryUnsupported" });
    });

    it("refuses a caller whose plugin materialization is not current", async () => {
        await db.pluginMachineMaterialization.deleteMany({});

        await expect(verifyAutomationConversationTargetV1({
            accountId: ACCOUNT_ID,
            caller,
            input: {
                automationId: "automation-schedule-owned",
                expectedTemplateVersion: 3,
            },
        })).rejects.toBeInstanceOf(AutomationConversationTargetVerificationCallerError);
    });

    it("projects every current Account Automation regardless of primary trigger, including disabled ones", async () => {
        await db.automation.create({
            data: {
                id: "automation-manual-disabled",
                accountId: ACCOUNT_ID,
                name: "Disabled manual",
                enabled: false,
                targetType: "execution_run",
                templateCiphertext: "disabled-definition-content",
                templateVersion: 4,
                triggerKind: "manual",
            },
        });

        await expect(listAutomationConversationTargetsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { limit: 100 },
        })).resolves.toEqual({
            items: [
                {
                    automationId: "automation-manual-disabled",
                    templateVersion: 4,
                    label: "Disabled manual",
                },
                {
                    automationId: "automation-manual-owned",
                    templateVersion: 3,
                    label: "Owned manual",
                },
                {
                    automationId: "automation-schedule-owned",
                    templateVersion: 3,
                    label: "Owned schedule",
                },
            ],
            nextCursor: null,
        });
    });

    it("offers no next page when the last page exactly fills the requested limit", async () => {
        await expect(listAutomationConversationTargetsV1({
            accountId: ACCOUNT_ID,
            caller,
            input: { limit: 2 },
        })).resolves.toEqual({
            items: [
                { automationId: "automation-manual-owned", templateVersion: 3, label: "Owned manual" },
                { automationId: "automation-schedule-owned", templateVersion: 3, label: "Owned schedule" },
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
                    triggerKind: "manual" as const,
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
            "automation-manual-owned",
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
                { automationId: "automation-schedule-owned", templateVersion: 3, label: "Owned schedule" },
            ],
            nextCursor: null,
        });
    });

    it("accepts a deleted cursor and returns a later insert without cursor state", async () => {
        await db.automation.deleteMany({ where: { accountId: ACCOUNT_ID } });
        await db.automation.createMany({
            data: ["a", "b"].map((suffix, index) => ({
                id: `automation-keyset-${suffix}`,
                accountId: ACCOUNT_ID,
                name: `Keyset ${suffix}`,
                enabled: true,
                targetType: "execution_run" as const,
                templateCiphertext: `keyset-definition-${suffix}`,
                templateVersion: index,
                triggerKind: "manual" as const,
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
                triggerKind: "manual",
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
});
