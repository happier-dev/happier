import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const serverRoot = join(import.meta.dirname, '..', '..');
const migrationId = '20260713210000_add_session_subagent_custody';
const retirementMigrationId = '20260713233000_add_session_subagent_custody_retirement';

async function read(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), 'utf8');
}

describe('durable subagent custody schema and migration contract', () => {
    it.each([
        'prisma/schema.prisma',
        'prisma/sqlite/schema.prisma',
        'prisma/mysql/schema.prisma',
    ])('keeps the three Prisma schemas on the dedicated record-and-receipt owner: %s', async (schemaPath) => {
        const schema = await read(schemaPath);
        expect(schema).toContain('model SessionSubagentCustody {');
        expect(schema).toContain('model SessionSubagentCustodyReceipt {');
        expect(schema).toContain('@@unique([accountId, sessionId, custodyKey, subagentKey]');
        expect(schema).toContain('@@unique([accountId, sessionId, custodyKey, operationId]');
        expect(schema).toContain('@@index([accountId, sessionId, custodyKey, expiresAt]');
        expect(schema).not.toMatch(/resultContent|resultCiphertext/);
    });

    it.each([
        ['prisma/migrations', 'COLLATE "C"'],
        ['prisma/sqlite/migrations', null],
        ['prisma/mysql/migrations', 'COLLATE utf8mb4_0900_bin'],
    ])('uses ordinal opaque identity without trimming or case folding: %s', async (migrationRoot, expectedCollation) => {
        const sql = await read(`${migrationRoot}/${migrationId}/migration.sql`);
        if (expectedCollation) {
            expect(sql).toContain(expectedCollation);
            expect(sql).toMatch(/custodyKey[^\n]*COLLATE/);
            expect(sql).toMatch(/subagentKey[^\n]*COLLATE/);
            expect(sql).toMatch(/operationId[^\n]*COLLATE/);
        } else {
            // SQLite text comparisons use BINARY by default. Keep the already-applied
            // migration immutable instead of editing it to spell out the default.
            expect(sql).not.toMatch(/\bCOLLATE\s+(?:NOCASE|RTRIM)\b/i);
        }
    });

    it('uses MySQL NO PAD identity and keeps public identifiers out of indexes', async () => {
        const sql = await read(`prisma/mysql/migrations/${migrationId}/migration.sql`);
        expect(sql).not.toContain('COLLATE utf8mb4_bin');
        expect(sql.match(/COLLATE utf8mb4_0900_bin/g) ?? []).toHaveLength(4);
        expect(sql).toMatch(/`subagentId` LONGTEXT NOT NULL/);
        expect(sql).toMatch(/`groupId` LONGTEXT NULL/);
        expect(sql).not.toMatch(/(?:UNIQUE )?INDEX[^\n]*(?:subagentId|groupId)/);
    });

    it.each([
        'prisma/migrations',
        'prisma/sqlite/migrations',
        'prisma/mysql/migrations',
    ])('cascades both custody tables with the session and actor account: %s', async (migrationRoot) => {
        const sql = await read(`${migrationRoot}/${migrationId}/migration.sql`);
        expect(sql.match(/ON DELETE CASCADE/g) ?? []).toHaveLength(4);
    });

    it.each([
        ['prisma/migrations', '42bfd2860e118970f945b7448c77c67661aa8a064a044f3e2193f7bd768ff1d9'],
        ['prisma/sqlite/migrations', '6c5e1a9c57c4225663de7e7e30c18316b695549e497076eaaf3c901589b7f193'],
        ['prisma/mysql/migrations', '017bee5a57bbdc9663603df3ef2cb255c0e29ca1c519ef4adb7860a883891a83'],
    ])('pins the append-only migration bytes: %s', async (migrationRoot, expectedSha256) => {
        const sql = await read(`${migrationRoot}/${migrationId}/migration.sql`);
        expect(createHash('sha256').update(sql).digest('hex')).toBe(expectedSha256);
    });

    it.each([
        'prisma/migrations',
        'prisma/sqlite/migrations',
        'prisma/mysql/migrations',
    ])('adds generation ownership to the applied tables in the later migration: %s', async (migrationRoot) => {
        const sql = await read(`${migrationRoot}/${retirementMigrationId}/migration.sql`);
        for (const table of ['SessionSubagentCustody', 'SessionSubagentCustodyReceipt']) {
            for (const column of ['pluginId', 'contributionId', 'immutableGenerationId']) {
                expect(sql).toMatch(new RegExp(`ALTER TABLE ["\`]${table}["\`][^;]*ADD(?: COLUMN)? ["\`]${column}["\`]`));
            }
        }
        expect(sql).toContain('SubagentCustody_generation_retirement_idx');
        expect(sql).toContain('SubagentCustodyReceipt_generation_retirement_idx');
        expect(sql).toMatch(/SessionSubagentCustodyRetiredGeneration[\s\S]*capacitySlot/);
        expect(sql).toContain('SubagentCustodyRetiredGeneration_capacity_slot_key');
    });
});
