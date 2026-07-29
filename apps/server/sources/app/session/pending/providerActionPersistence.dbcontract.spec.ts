import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, initDbMysql, initDbPostgres } from "@/storage/db";

const allowedProviderActions = ["send", "steer", "interrupt_and_send"] as const;

function resolveContractProvider(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported provider-action contract provider: ${raw}`);
}

describe("SessionPendingMessage providerAction DB contract", () => {
    const provider = resolveContractProvider();

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL for DB contract test");
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
    });

    afterAll(async () => {
        await db.$disconnect();
    });

    it("persists null and the strict frozen provider-action enum", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-provider-action-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag: `provider-action-${randomUUID()}`,
                metadata: "{}",
            },
            select: { id: true },
        });
        const pending = await db.sessionPendingMessage.create({
            data: {
                sessionId: session.id,
                localId: `provider-action-${randomUUID()}`,
                content: { t: "encrypted", c: "ciphertext" },
                requestedAction: { v: 1, kind: "enqueue" },
                status: "queued",
                position: 1,
            },
            select: { id: true, providerAction: true },
        });
        expect(pending.providerAction).toBeNull();

        for (const providerAction of allowedProviderActions) {
            const updated = await db.sessionPendingMessage.update({
                where: { id: pending.id },
                data: { providerAction },
                select: { providerAction: true },
            });
            expect(updated.providerAction).toBe(providerAction);
        }

        const table = provider === "mysql" ? "`SessionPendingMessage`" : '"SessionPendingMessage"';
        const column = provider === "mysql" ? "`providerAction`" : '"providerAction"';
        const idColumn = provider === "mysql" ? "`id`" : '"id"';
        await expect(db.$executeRawUnsafe(
            `UPDATE ${table} SET ${column} = 'retry' WHERE ${idColumn} = '${pending.id}'`,
        )).rejects.toThrow();
    });
});
