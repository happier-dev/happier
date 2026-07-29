import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

const allowedProviderActions = ["send", "steer", "interrupt_and_send"] as const;

describe("SessionPendingMessage providerAction persistence", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-pending-provider-action-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    it("keeps fresh rows nullable and accepts only the three frozen provider actions", async () => {
        const account = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: {
                tag: `tag-${randomUUID()}`,
                accountId: account.id,
                metadata: "meta",
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
            },
            select: { id: true },
        });
        const pending = await db.sessionPendingMessage.create({
            data: {
                sessionId: session.id,
                authorAccountId: account.id,
                localId: `pending-${randomUUID()}`,
                content: { t: "encrypted", c: "ciphertext" },
                requestedAction: { v: 1, kind: "enqueue" },
                status: "queued",
                position: 1,
            },
            select: { id: true },
        });

        const columns = await db.$queryRawUnsafe<Array<{ name: string }>>(
            'PRAGMA table_info("SessionPendingMessage")',
        );
        expect(columns.map((column) => column.name)).toContain("providerAction");

        const initial = await db.$queryRawUnsafe<Array<{ providerAction: string | null }>>(
            'SELECT "providerAction" FROM "SessionPendingMessage" WHERE "id" = ?',
            pending.id,
        );
        expect(initial).toEqual([{ providerAction: null }]);

        for (const providerAction of allowedProviderActions) {
            await db.$executeRawUnsafe(
                'UPDATE "SessionPendingMessage" SET "providerAction" = ? WHERE "id" = ?',
                providerAction,
                pending.id,
            );
            const rows = await db.$queryRawUnsafe<Array<{ providerAction: string | null }>>(
                'SELECT "providerAction" FROM "SessionPendingMessage" WHERE "id" = ?',
                pending.id,
            );
            expect(rows).toEqual([{ providerAction }]);
        }

        await expect(db.$executeRawUnsafe(
            'UPDATE "SessionPendingMessage" SET "providerAction" = ? WHERE "id" = ?',
            "retry",
            pending.id,
        )).rejects.toThrow();
    });
});
