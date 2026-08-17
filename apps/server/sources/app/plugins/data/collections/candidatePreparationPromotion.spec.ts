import { describe, expect, it, vi } from "vitest";

import type { Tx } from "@/storage/inTx";

import { applyCandidatePromotionRowUpdatesSetwiseInTx } from "./candidatePreparationPromotion";

describe("candidate preparation promotion row adapter", () => {
    it("applies one exact revision-fenced SQLite batch through one statement", async () => {
        const executeRawUnsafe = vi.fn(async () => 2);
        const tx = { $executeRawUnsafe: executeRawUnsafe } as unknown as Pick<Tx, "$executeRawUnsafe">;

        await expect(applyCandidatePromotionRowUpdatesSetwiseInTx({
            tx,
            provider: "sqlite",
            accountId: "account-1",
            source: {
                contractId: "source-contract",
                schemaVersion: 1,
                contractDigest: "source-digest",
            },
            target: {
                contractId: "target-contract",
                schemaVersion: 2,
                contractDigest: "target-digest",
            },
            rows: [
                {
                    id: "row-a",
                    expectedRevision: 3,
                    nextRevision: 4,
                    contentEnvelopeJson: JSON.stringify({ t: "plain", v: { note: "A" } }),
                },
                {
                    id: "row-b",
                    expectedRevision: 7,
                    nextRevision: 8,
                    contentEnvelopeJson: JSON.stringify({ t: "plain", v: { note: "B" } }),
                },
            ],
        })).resolves.toBe(true);

        expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
        expect(executeRawUnsafe).toHaveBeenCalledWith(
            expect.stringContaining('WITH "candidate"'),
            "row-a",
            3,
            2,
            4,
            "target-contract",
            "target-digest",
            JSON.stringify({ t: "plain", v: { note: "A" } }),
            "row-b",
            7,
            2,
            8,
            "target-contract",
            "target-digest",
            JSON.stringify({ t: "plain", v: { note: "B" } }),
            "account-1",
            "source-contract",
            1,
            "source-digest",
        );
    });

    it("reports a partial exact-CAS batch instead of accepting a subset promotion", async () => {
        const executeRawUnsafe = vi.fn(async () => 1);
        const tx = { $executeRawUnsafe: executeRawUnsafe } as unknown as Pick<Tx, "$executeRawUnsafe">;

        await expect(applyCandidatePromotionRowUpdatesSetwiseInTx({
            tx,
            provider: "sqlite",
            accountId: "account-1",
            source: {
                contractId: "source-contract",
                schemaVersion: 1,
                contractDigest: "source-digest",
            },
            target: {
                contractId: "target-contract",
                schemaVersion: 2,
                contractDigest: "target-digest",
            },
            rows: [
                {
                    id: "row-a",
                    expectedRevision: 3,
                    nextRevision: 4,
                    contentEnvelopeJson: JSON.stringify({ t: "plain", v: { note: "A" } }),
                },
                {
                    id: "row-b",
                    expectedRevision: 7,
                    nextRevision: 8,
                    contentEnvelopeJson: JSON.stringify({ t: "plain", v: { note: "B" } }),
                },
            ],
        })).resolves.toBe(false);
    });
});
