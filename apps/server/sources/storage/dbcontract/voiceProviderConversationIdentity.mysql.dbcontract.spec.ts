import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveVoiceProviderConversationKey } from "@/app/api/routes/voice/voiceProviderConversationIdentity";
import { db, initDbMysql, isPrismaErrorCode } from "@/storage/db";

const provider = String(process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "")
    .trim()
    .toLowerCase();

describe.skipIf(provider !== "mysql")("MySQL voice provider conversation identity contract", () => {
    let dbConnected = false;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error("Missing DATABASE_URL (required for the MySQL voice identity contract).");
        }
        await initDbMysql();
        await db.$connect();
        dbConnected = true;
    });

    afterAll(async () => {
        if (!dbConnected) return;
        await db.$disconnect();
    });

    it("round-trips the rolling-window MySQL width and enforces digest uniqueness", async () => {
        const account = await db.account.create({
            data: { publicKey: `mysql-voice-identity-${randomUUID()}` },
            select: { id: true },
        });
        const providerId = "mysql-contract-é";
        const providerConversationId = ` ${"界".repeat(189)} `;
        const sessionId = "🙂".repeat(512);
        expect([...providerConversationId]).toHaveLength(191);
        expect([...sessionId]).toHaveLength(512);

        const providerConversationKey = deriveVoiceProviderConversationKey({
            providerId,
            providerConversationId,
        });
        const lease = await db.voiceSessionLease.create({
            data: {
                accountId: account.id,
                sessionId,
                periodKey: "2026-07",
                grantedBy: "contract",
                elevenLabsAgentId: "contract-agent",
                providerId,
                providerConversationId,
                providerConversationKey,
                expiresAt: new Date(Date.now() + 60_000),
            },
            select: { id: true },
        });
        const conversation = await db.voiceConversation.create({
            data: {
                accountId: account.id,
                leaseId: lease.id,
                providerId,
                providerConversationId,
                providerConversationKey,
                durationSeconds: 1,
            },
            select: { id: true },
        });

        await expect(db.voiceSessionLease.findUniqueOrThrow({
            where: { id: lease.id },
            select: { sessionId: true, providerConversationId: true, providerConversationKey: true },
        })).resolves.toEqual({ sessionId, providerConversationId, providerConversationKey });
        await expect(db.voiceConversation.findUniqueOrThrow({
            where: { id: conversation.id },
            select: { providerConversationId: true, providerConversationKey: true },
        })).resolves.toEqual({ providerConversationId, providerConversationKey });

        const computed = await db.$queryRawUnsafe<Array<{ computedKey: string }>>(
            `SELECT LOWER(SHA2(CONCAT(
                CONVERT('happier.voice.provider-conversation.v1' USING BINARY), CHAR(0),
                UNHEX(LPAD(HEX(OCTET_LENGTH(CONVERT(\`providerId\` USING BINARY))), 8, '0')),
                CONVERT(\`providerId\` USING BINARY),
                UNHEX(LPAD(HEX(OCTET_LENGTH(CONVERT(\`providerConversationId\` USING BINARY))), 8, '0')),
                CONVERT(\`providerConversationId\` USING BINARY)
            ), 256)) AS computedKey
            FROM \`VoiceConversation\`
            WHERE \`id\` = ?`,
            conversation.id,
        );
        expect(computed).toEqual([{ computedKey: providerConversationKey }]);

        let duplicateError: unknown;
        try {
            await db.voiceConversation.create({
                data: {
                    accountId: account.id,
                    providerId,
                    providerConversationId: "different-exact-raw-value",
                    providerConversationKey,
                    durationSeconds: 1,
                },
            });
        } catch (error) {
            duplicateError = error;
        }
        expect(isPrismaErrorCode(duplicateError, "P2002")).toBe(true);
    });

    it("retains legacy indexes and nullable digest columns until a later contract release", async () => {
        const indexes = await db.$queryRawUnsafe<Array<{
            TABLE_NAME: string;
            INDEX_NAME: string;
            NON_UNIQUE: bigint | number;
            SEQ_IN_INDEX: bigint | number;
            COLUMN_NAME: string;
        }>>(
            `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
             FROM INFORMATION_SCHEMA.STATISTICS
             WHERE TABLE_SCHEMA = DATABASE()
               AND TABLE_NAME IN ('VoiceConversation', 'VoiceSessionLease')
             ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
        );
        const byName = new Map<string, Array<{ column: string; nonUnique: number }>>();
        for (const row of indexes) {
            const name = `${row.TABLE_NAME}.${row.INDEX_NAME}`;
            const entries = byName.get(name) ?? [];
            entries.push({ column: row.COLUMN_NAME, nonUnique: Number(row.NON_UNIQUE) });
            byName.set(name, entries);
        }

        expect(byName.get("VoiceConversation.VoiceConversation_providerId_providerConversationKey_key")).toEqual([
            { column: "providerId", nonUnique: 0 },
            { column: "providerConversationKey", nonUnique: 0 },
        ]);
        expect(byName.get("VoiceSessionLease.VoiceSessionLease_provider_binding_key_lookup_idx")).toEqual([
            { column: "accountId", nonUnique: 1 },
            { column: "providerId", nonUnique: 1 },
            { column: "providerConversationKey", nonUnique: 1 },
        ]);
        expect(byName.get("VoiceConversation.VoiceConversation_providerId_providerConversationId_key")).toEqual([
            { column: "providerId", nonUnique: 0 },
            { column: "providerConversationId", nonUnique: 0 },
        ]);
        expect(byName.get("VoiceSessionLease.VoiceSessionLease_provider_binding_lookup_idx")).toEqual([
            { column: "accountId", nonUnique: 1 },
            { column: "providerId", nonUnique: 1 },
            { column: "providerConversationId", nonUnique: 1 },
        ]);

        const columns = await db.$queryRawUnsafe<Array<{
            TABLE_NAME: string;
            COLUMN_NAME: string;
            DATA_TYPE: string;
            CHARACTER_MAXIMUM_LENGTH: bigint | number;
            IS_NULLABLE: "YES" | "NO";
        }>>(
            `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE()
               AND (
                   (TABLE_NAME = 'VoiceConversation' AND COLUMN_NAME IN ('providerConversationId', 'providerConversationKey'))
                   OR
                   (TABLE_NAME = 'VoiceSessionLease' AND COLUMN_NAME IN ('sessionId', 'providerConversationId', 'providerConversationKey'))
               )`,
        );
        const shape = Object.fromEntries(columns.map((row) => [
            `${row.TABLE_NAME}.${row.COLUMN_NAME}`,
            {
                type: row.DATA_TYPE,
                maxLength: Number(row.CHARACTER_MAXIMUM_LENGTH),
                nullable: row.IS_NULLABLE === "YES",
            },
        ]));
        expect(shape).toEqual({
            "VoiceConversation.providerConversationId": { type: "varchar", maxLength: 191, nullable: false },
            "VoiceConversation.providerConversationKey": { type: "char", maxLength: 64, nullable: true },
            "VoiceSessionLease.sessionId": { type: "varchar", maxLength: 512, nullable: true },
            "VoiceSessionLease.providerConversationId": { type: "varchar", maxLength: 191, nullable: true },
            "VoiceSessionLease.providerConversationKey": { type: "char", maxLength: 64, nullable: true },
        });
    });
});
