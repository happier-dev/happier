import { describe, expect, it } from "vitest";

import { createSessionTransactionModel } from "./txHarness";

describe("createSessionTransactionModel", () => {
    it("models guarded Session write-boundary count and mutation semantics", async () => {
        const updatedAt = new Date("2026-07-01T00:00:00.000Z");
        const model = createSessionTransactionModel({
            id: "s1",
            accountId: "owner",
            metadataLayoutVersion: 1,
            seq: 4,
            updatedAt,
        });

        await expect(model.session.updateMany({
            where: { id: "s1", metadataLayoutVersion: 0 },
            data: { seq: { increment: 1 }, updatedAt },
        })).resolves.toEqual({ count: 0 });
        expect(model.readSession()).toMatchObject({ seq: 4, updatedAt });

        await expect(model.session.updateMany({
            where: {
                AND: [
                    { id: "s1" },
                    { accountId: "owner", metadataLayoutVersion: 1 },
                ],
            },
            data: { seq: { increment: 1 }, updatedAt },
        })).resolves.toEqual({ count: 1 });
        expect(model.readSession()).toMatchObject({ seq: 5, updatedAt });

        await expect(model.session.deleteMany({
            where: { id: "s1", accountId: "owner" },
        })).resolves.toEqual({ count: 1 });
        expect(model.readSession()).toBeNull();
    });
});
