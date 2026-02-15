import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { claimAutomationRun } from "./automationClaimService";

const TEST_TEMPLATE_ENVELOPE = JSON.stringify({
    kind: "happier_automation_template_encrypted_v1",
    payloadCiphertext: "ciphertext-base64",
});

async function createAccountWithMachine(machineId: string, publicKey: string): Promise<{ accountId: string }> {
    const account = await db.account.create({
        data: { publicKey },
        select: { id: true },
    });
    await db.machine.create({
        data: {
            id: machineId,
            accountId: account.id,
            metadata: "{}",
        },
    });
    return { accountId: account.id };
}

async function createAutomationWithAssignments(params: {
    accountId: string;
    machineIds: string[];
    name: string;
}) {
    const automation = await db.automation.create({
        data: {
            accountId: params.accountId,
            name: params.name,
            enabled: true,
            scheduleKind: "interval",
            everyMs: 60_000,
            targetType: "new_session",
            templateCiphertext: TEST_TEMPLATE_ENVELOPE,
            templateVersion: 1,
            assignments: {
                create: params.machineIds.map((machineId) => ({
                    machineId,
                    enabled: true,
                    priority: 0,
                })),
            },
        },
        select: { id: true },
    });
    return automation;
}

describe("automationClaimService (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-automation-claim-service-" });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.restoreEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("allows only one machine to claim a queued run", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-claim-race" },
            select: { id: true },
        });
        await db.machine.createMany({
            data: [
                { id: "machine-1", accountId: account.id, metadata: "{}" },
                { id: "machine-2", accountId: account.id, metadata: "{}" },
            ],
        });
        const automation = await createAutomationWithAssignments({
            accountId: account.id,
            machineIds: ["machine-1", "machine-2"],
            name: "Race automation",
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: account.id,
                state: "queued",
                scheduledAt: new Date(Date.now() - 30_000),
                dueAt: new Date(Date.now() - 20_000),
            },
            select: { id: true },
        });

        const [claimOne, claimTwo] = await Promise.all([
            claimAutomationRun({
                accountId: account.id,
                machineId: "machine-1",
                leaseDurationMs: 30_000,
            }),
            claimAutomationRun({
                accountId: account.id,
                machineId: "machine-2",
                leaseDurationMs: 30_000,
            }),
        ]);

        const nonNullClaims = [claimOne, claimTwo].filter((entry) => !!entry.run);
        expect(nonNullClaims).toHaveLength(1);

        const claimed = await db.automationRun.findUnique({
            where: { id: run.id },
            select: {
                state: true,
                claimedByMachineId: true,
                attempt: true,
            },
        });
        expect(claimed).toEqual(
            expect.objectContaining({
                state: "claimed",
                attempt: 1,
            }),
        );
        expect(["machine-1", "machine-2"]).toContain(claimed?.claimedByMachineId ?? "");
    });

    it("reclaims a run when the previous lease expired", async () => {
        const { accountId } = await createAccountWithMachine("machine-1", "pk-automation-claim-expired-1");
        await db.machine.create({
            data: {
                id: "machine-2",
                accountId,
                metadata: "{}",
            },
        });

        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: ["machine-1", "machine-2"],
            name: "Expired lease automation",
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId,
                state: "claimed",
                scheduledAt: new Date(Date.now() - 60_000),
                dueAt: new Date(Date.now() - 50_000),
                claimedAt: new Date(Date.now() - 40_000),
                claimedByMachineId: "machine-1",
                leaseExpiresAt: new Date(Date.now() - 1_000),
                attempt: 1,
            },
            select: { id: true },
        });

        const claim = await claimAutomationRun({
            accountId,
            machineId: "machine-2",
            leaseDurationMs: 30_000,
        });

        expect(claim.run?.id).toBe(run.id);
        expect(claim.run?.claimedByMachineId).toBe("machine-2");

        const updated = await db.automationRun.findUnique({
            where: { id: run.id },
            select: {
                claimedByMachineId: true,
                attempt: true,
                state: true,
            },
        });
        expect(updated).toEqual(
            expect.objectContaining({
                state: "claimed",
                claimedByMachineId: "machine-2",
                attempt: 2,
            }),
        );
    });

    it("reclaims a stale running run when lease expiration has passed", async () => {
        const { accountId } = await createAccountWithMachine("machine-1", "pk-automation-claim-running-expired-1");
        await db.machine.create({
            data: {
                id: "machine-2",
                accountId,
                metadata: "{}",
            },
        });

        const automation = await createAutomationWithAssignments({
            accountId,
            machineIds: ["machine-1", "machine-2"],
            name: "Expired running lease automation",
        });
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId,
                state: "running",
                scheduledAt: new Date(Date.now() - 120_000),
                dueAt: new Date(Date.now() - 110_000),
                claimedAt: new Date(Date.now() - 100_000),
                startedAt: new Date(Date.now() - 95_000),
                claimedByMachineId: "machine-1",
                leaseExpiresAt: new Date(Date.now() - 2_000),
                attempt: 1,
            },
            select: { id: true },
        });

        const claim = await claimAutomationRun({
            accountId,
            machineId: "machine-2",
            leaseDurationMs: 30_000,
        });

        expect(claim.run?.id).toBe(run.id);
        expect(claim.run?.claimedByMachineId).toBe("machine-2");
        expect(claim.run?.state).toBe("claimed");

        const updated = await db.automationRun.findUnique({
            where: { id: run.id },
            select: {
                state: true,
                claimedByMachineId: true,
                attempt: true,
            },
        });
        expect(updated).toEqual(
            expect.objectContaining({
                state: "claimed",
                claimedByMachineId: "machine-2",
                attempt: 2,
            }),
        );
    });
});
