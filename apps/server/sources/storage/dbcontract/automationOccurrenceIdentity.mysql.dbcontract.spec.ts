import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    AutomationOccurrenceKeyV1Schema,
    PluginMachineMaterializationRefV1Schema,
    serializeAutomationRunExecutionRecipeV1,
} from "@happier-dev/protocol";

import { claimAutomationRun } from "@/app/automations/automationClaimService";
import { db, initDbMysql, isPrismaErrorCode } from "@/storage/db";

const provider = String(process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "")
    .trim()
    .toLowerCase();

function serializeClaimablePlainRecipe(params: Readonly<{
    machineId: string;
    occurrenceKey: string | null;
}>): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        template: {
            t: "plain",
            v: { v: 1, prompt: "Run the MySQL occurrence-identity contract" },
        },
        triggerEvidence: params.occurrenceKey === null
            ? null
            : {
                t: "plain",
                v: {
                    v: 1,
                    kind: "pluginEvent",
                    occurrenceKey: params.occurrenceKey,
                },
            },
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: {
                    serverId: "mysql-contract-server",
                    machineId: params.machineId,
                },
                directory: "/tmp/mysql-occurrence-identity-contract",
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
    });
    if (serialized.kind !== "available") {
        throw new Error("Failed to construct the strict MySQL occurrence-identity recipe");
    }
    return serialized.serialized;
}

describe.skipIf(provider !== "mysql")("MySQL AutomationRun occurrence identity contract", () => {
    let dbConnected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error("Missing DATABASE_URL (required for the MySQL AutomationRun occurrence identity contract).");
        }
        await initDbMysql();
        await db.$connect();
        dbConnected = true;
    });

    afterAll(async () => {
        if (!dbConnected) return;
        await db.$disconnect();
    });

    it("dedupes exact occurrence keys while retaining and claiming case variants", async () => {
        const occurrenceKey = AutomationOccurrenceKeyV1Schema.parse("A".repeat(43));
        const caseVariantOccurrenceKey = AutomationOccurrenceKeyV1Schema.parse(`a${"A".repeat(42)}`);
        expect(occurrenceKey).not.toBe(caseVariantOccurrenceKey);
        expect(occurrenceKey.toLowerCase()).toBe(caseVariantOccurrenceKey.toLowerCase());

        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = `mysql-automation-machine-${randomUUID()}`;
        await db.machine.create({
            data: {
                id: machineId,
                accountId: account.id,
                installationId: `mysql-automation-installation-${randomUUID()}`,
                metadata: "{}",
            },
            select: { id: true },
        });
        const sourceSelectorId = randomUUID();
        const definitionRecipe = serializeClaimablePlainRecipe({ machineId, occurrenceKey: null });
        const firstRunRecipe = serializeClaimablePlainRecipe({ machineId, occurrenceKey });
        const secondRunRecipe = serializeClaimablePlainRecipe({
            machineId,
            occurrenceKey: caseVariantOccurrenceKey,
        });
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "MySQL canonical occurrence identity contract",
                scheduleKind: null,
                targetType: "new_session",
                templateCiphertext: definitionRecipe,
                templateVersion: 1,
                triggerKind: "pluginEvent",
                triggerEventPluginId: "com.happier.mysql-contract",
                triggerEventLocalId: "occurrence-identity",
                triggerSourceSelectorId: sourceSelectorId,
                triggerSourceContractVersion: 1,
                triggerObservationTransport: "checkpointedPull",
                triggerDefinitionEnvelope: '{"t":"plain","v":{}}',
                assignments: {
                    create: [{ machineId, enabled: true, priority: 0 }],
                },
            },
            select: { id: true },
        });
        const now = Date.now();
        const firstDueAt = new Date(now - 20_000);
        const secondDueAt = new Date(now - 10_000);

        const firstRun = await db.automationRun.create({
            data: {
                accountId: account.id,
                automationId: automation.id,
                originKind: "pluginEvent",
                originOccurredAt: firstDueAt,
                occurrenceKey,
                originSourceSelectorId: sourceSelectorId,
                triggerEvidenceEnvelope: '{"t":"plain","v":{}}',
                executionInputEnvelope: firstRunRecipe,
                scheduledAt: firstDueAt,
                dueAt: firstDueAt,
            },
            select: { id: true },
        });
        const secondRun = await db.automationRun.create({
            data: {
                accountId: account.id,
                automationId: automation.id,
                originKind: "pluginEvent",
                originOccurredAt: secondDueAt,
                occurrenceKey: caseVariantOccurrenceKey,
                originSourceSelectorId: sourceSelectorId,
                triggerEvidenceEnvelope: '{"t":"plain","v":{}}',
                executionInputEnvelope: secondRunRecipe,
                scheduledAt: secondDueAt,
                dueAt: secondDueAt,
            },
            select: { id: true },
        });
        let duplicateError: unknown = null;
        try {
            await db.automationRun.create({
                data: {
                    accountId: account.id,
                    automationId: automation.id,
                    originKind: "pluginEvent",
                    originOccurredAt: firstDueAt,
                    occurrenceKey,
                    originSourceSelectorId: sourceSelectorId,
                    triggerEvidenceEnvelope: '{"t":"plain","v":{}}',
                    executionInputEnvelope: firstRunRecipe,
                    scheduledAt: firstDueAt,
                    dueAt: firstDueAt,
                },
                select: { id: true },
            });
        } catch (error) {
            duplicateError = error;
        }
        expect(isPrismaErrorCode(duplicateError, "P2002")).toBe(true);

        const retained = await db.automationRun.findMany({
            where: { automationId: automation.id },
            select: { occurrenceKey: true },
            orderBy: { occurrenceKey: "asc" },
        });
        expect(retained.map((run) => run.occurrenceKey)).toEqual([
            occurrenceKey,
            caseVariantOccurrenceKey,
        ]);

        const firstClaim = await claimAutomationRun({
            accountId: account.id,
            machineId,
            leaseDurationMs: 30_000,
        });
        expect(firstClaim.run).toEqual(expect.objectContaining({
            id: firstRun.id,
            occurrenceKey,
            attempt: 1,
        }));
        const secondClaim = await claimAutomationRun({
            accountId: account.id,
            machineId,
            leaseDurationMs: 30_000,
        });
        expect(secondClaim.run).toEqual(expect.objectContaining({
            id: secondRun.id,
            occurrenceKey: caseVariantOccurrenceKey,
            attempt: 1,
        }));

        await db.automationRun.update({
            where: { id: firstRun.id },
            data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
            select: { id: true },
        });
        const reclaimed = await claimAutomationRun({
            accountId: account.id,
            machineId,
            leaseDurationMs: 30_000,
        });
        expect(reclaimed.run).toEqual(expect.objectContaining({
            id: firstRun.id,
            occurrenceKey,
            attempt: 2,
        }));
    });

    it("retains case-variant reporter materialization identities for one catalog scope", async () => {
        const materializationRef = (materializationId: string) => (
            PluginMachineMaterializationRefV1Schema.parse({
                machineId: "mysql-contract-machine",
                materializationId,
                pluginId: "com.happier.mysql-contract",
            })
        );
        const reporterMaterializationId = materializationRef("Materialization-identity").materializationId;
        const caseVariantReporterMaterializationId = materializationRef(
            "materialization-identity",
        ).materializationId;
        expect(reporterMaterializationId).not.toBe(caseVariantReporterMaterializationId);
        expect(reporterMaterializationId.toLowerCase()).toBe(
            caseVariantReporterMaterializationId.toLowerCase(),
        );

        const account = await db.account.create({
            data: { publicKey: `mysql-automation-catalog-${randomUUID()}` },
            select: { id: true },
        });
        const at = new Date();
        const shared = {
            accountId: account.id,
            eventPluginId: "com.happier.mysql-contract",
            reporterMachineId: "mysql-contract-machine",
            reporterMachineInstallationId: "mysql-contract-installation",
            scopeKey: "checkpointedPull",
            observedRevision: 1n,
            adoptedRevision: 1n,
            state: "current" as const,
            reportedAt: at,
        };

        await db.automationEventSourceCatalogStatus.create({
            data: { ...shared, reporterMaterializationId },
            select: { reporterMaterializationId: true },
        });
        await db.automationEventSourceCatalogStatus.create({
            data: { ...shared, reporterMaterializationId: caseVariantReporterMaterializationId },
            select: { reporterMaterializationId: true },
        });

        const retained = await db.automationEventSourceCatalogStatus.findMany({
            where: {
                accountId: account.id,
                eventPluginId: shared.eventPluginId,
                scopeKey: shared.scopeKey,
            },
            select: { reporterMaterializationId: true },
            orderBy: { reporterMaterializationId: "asc" },
        });
        expect(retained.map((row) => row.reporterMaterializationId)).toEqual([
            reporterMaterializationId,
            caseVariantReporterMaterializationId,
        ]);
    });
});
