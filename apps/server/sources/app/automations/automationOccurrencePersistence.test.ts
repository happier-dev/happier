import { describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";

import { findAutomationTriggerOccurrencesTx } from "./automationOccurrencePersistence";

describe("findAutomationTriggerOccurrencesTx", () => {
    it("reads a bounded Event occurrence set in one query", async () => {
        const findMany = vi.fn().mockResolvedValue([
            { id: "run-1", triggerId: "trigger-1", occurrenceKey: "occurrence-1" },
        ]);

        await expect(findAutomationTriggerOccurrencesTx({
            tx: { automationRun: { findMany } } as unknown as Tx,
            accountId: "account-1",
            occurrences: [
                { triggerId: "trigger-1", occurrenceKey: "occurrence-1" },
                { triggerId: "trigger-2", occurrenceKey: "occurrence-2" },
            ],
            select: { id: true, triggerId: true, occurrenceKey: true },
        })).resolves.toEqual([
            { id: "run-1", triggerId: "trigger-1", occurrenceKey: "occurrence-1" },
        ]);

        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findMany).toHaveBeenCalledWith({
            where: {
                accountId: "account-1",
                OR: [
                    { triggerId: "trigger-1", occurrenceKey: "occurrence-1" },
                    { triggerId: "trigger-2", occurrenceKey: "occurrence-2" },
                ],
            },
            select: { id: true, triggerId: true, occurrenceKey: true },
        });
    });
});
