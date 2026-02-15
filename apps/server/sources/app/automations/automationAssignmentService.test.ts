import { describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";

import { replaceAutomationAssignmentsTx } from "./automationAssignmentService";

describe("replaceAutomationAssignmentsTx", () => {
    it("does not rely on createMany skipDuplicates for Prisma compatibility", async () => {
        const updatedAt = new Date("2026-02-12T10:00:00.000Z");
        const createMany = vi.fn(async (args: unknown) => {
            if (
                args &&
                typeof args === "object" &&
                Object.prototype.hasOwnProperty.call(args, "skipDuplicates")
            ) {
                throw new Error("Unknown argument `skipDuplicates`");
            }
        });

        // Test fixture only needs the Tx subset touched by the service under test.
        const tx = {
            machine: {
                findMany: vi.fn(async () => [{ id: "machine-1" }]),
            },
            automationAssignment: {
                deleteMany: vi.fn(async () => undefined),
                createMany,
                findMany: vi.fn(async () => [
                    {
                        machineId: "machine-1",
                        enabled: true,
                        priority: 100,
                        updatedAt,
                    },
                ]),
            },
        } as unknown as Tx;

        await expect(
            replaceAutomationAssignmentsTx({
                tx,
                accountId: "acct-1",
                automationId: "auto-1",
                assignments: [{ machineId: "machine-1", enabled: true, priority: 100 }],
            }),
        ).resolves.toEqual([
            {
                machineId: "machine-1",
                enabled: true,
                priority: 100,
                updatedAt,
            },
        ]);
    });
});
