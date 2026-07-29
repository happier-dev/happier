import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const serverRoot = join(import.meta.dirname, '..', '..');
const migrationId = '20260727140000_add_session_metadata_privacy_envelope';
const prohibitedAccountFields = [
    'ownerMetadataKeyGeneration',
    'ownerMetadataKeyFingerprint',
    'ownerMetadataLastMigrationId',
    'ownerMetadataPreparingMigrationId',
    'ownerMetadataPreparingKeyGeneration',
    'ownerMetadataPreparingKeyFingerprint',
] as const;
const prohibitedSessionFields = [
    'ownerMetadataVersion',
    'ownerMetadataKeyGeneration',
    'ownerMetadataMigrationId',
    'ownerMetadataSourceVersion',
    'ownerMetadataSecondary',
    'ownerMetadataSecondaryKeyGeneration',
    'ownerMetadataSecondaryMigrationId',
    'ownerMetadataSecondarySourceVersion',
] as const;
const prohibitedIndexes = [
    'session_owner_slot_primary_completeness_idx',
    'session_owner_slot_secondary_completeness_idx',
] as const;

async function read(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), 'utf8');
}

describe('session metadata privacy envelope schema and migration contract', () => {
    it.each([
        'prisma/schema.prisma',
        'prisma/sqlite/schema.prisma',
        'prisma/mysql/schema.prisma',
    ])('keeps the owner ciphertext and server-readable layout on the canonical Session row: %s', async (schemaPath) => {
        const schema = await read(schemaPath);
        const sessionModel = schema.match(/model Session \{[\s\S]*?\n\}/)?.[0] ?? '';
        expect(sessionModel).toMatch(/\bownerMetadata\s+String\?/);
        expect(sessionModel).toMatch(/\bmetadataLayoutVersion\s+Int\s+@default\(0\)/);
        expect(schema).not.toContain('model SessionOwnerMetadata');
    });

    it.each([
        ['prisma/migrations', '"Session"', '"ownerMetadata"', '"metadataLayoutVersion"'],
        ['prisma/sqlite/migrations', '"Session"', '"ownerMetadata"', '"metadataLayoutVersion"'],
        ['prisma/mysql/migrations', '`Session`', '`ownerMetadata`', '`metadataLayoutVersion`'],
    ])('adds both fields without copying metadata or rewriting transcripts: %s', async (
        migrationRoot,
        table,
        ownerColumn,
        layoutColumn,
    ) => {
        const sql = await read(`${migrationRoot}/${migrationId}/migration.sql`);
        expect(sql).toContain(`ALTER TABLE ${table}`);
        expect(sql).toContain(ownerColumn);
        expect(sql).toContain(layoutColumn);
        expect(sql).toMatch(/metadataLayoutVersion[^;]*DEFAULT 0/i);
        expect(sql).not.toMatch(/UPDATE[\s\S]*SET[\s\S]*ownerMetadata\s*=/i);
        expect(sql).not.toMatch(/SessionMessage|SessionTranscript/i);
    });

    it('keeps the owner envelope unbounded enough for ciphertext on MySQL', async () => {
        const schema = await read('prisma/mysql/schema.prisma');
        expect(schema).toMatch(/ownerMetadata\s+String\?\s+@db\.LongText/);
        const sql = await read(`prisma/mysql/migrations/${migrationId}/migration.sql`);
        expect(sql).toMatch(/`ownerMetadata`\s+LONGTEXT\b/);
    });

    it('uses case-exact MySQL comparison semantics for canonical owner-ciphertext CAS values', async () => {
        const schema = await read('prisma/mysql/schema.prisma');
        expect(schema).toMatch(/ownerMetadata\s+String\?\s+@db\.LongText/);

        const canonicalKind10Ciphertext =
            'oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGDb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==';
        const caseOnlyDistinctKind10Ciphertext =
            'oQoBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQGdb9gtt8Xqs3gDuzJU/wWRuslcRY3OZA==';
        const canonicalBytes = Buffer.from(canonicalKind10Ciphertext, 'base64');
        const caseOnlyDistinctBytes = Buffer.from(caseOnlyDistinctKind10Ciphertext, 'base64');
        expect([...canonicalBytes.slice(0, 2)]).toEqual([0xa1, 10]);
        expect([...caseOnlyDistinctBytes.slice(0, 2)]).toEqual([0xa1, 10]);
        expect(
            [...canonicalKind10Ciphertext].filter(
                (character, index) =>
                    character !== caseOnlyDistinctKind10Ciphertext[index],
            ),
        ).toHaveLength(1);
        expect(canonicalKind10Ciphertext.toLowerCase())
            .toBe(caseOnlyDistinctKind10Ciphertext.toLowerCase());

        const sql = await read(`prisma/mysql/migrations/${migrationId}/migration.sql`);
        // MySQL 8.0's utf8mb4_bin is case-sensitive on the admitted ASCII Base64
        // alphabet and preserves the repository's documented 8.0.16 support floor:
        // https://dev.mysql.com/doc/refman/8.0/en/charset-binary-collations.html
        expect(sql).toMatch(
            /`ownerMetadata`\s+LONGTEXT\s+CHARACTER SET utf8mb4\s+COLLATE utf8mb4_bin\s+NULL/,
        );
        expect(sql).not.toContain('COLLATE utf8mb4_0900_bin');
    });

    it.each([
        'prisma/schema.prisma',
        'prisma/sqlite/schema.prisma',
        'prisma/mysql/schema.prisma',
    ])('adds no owner rotation, secondary slot, or migration-ledger state: %s', async (schemaPath) => {
        const schema = await read(schemaPath);
        const accountModel = schema.match(/model Account \{[\s\S]*?\n\}/)?.[0] ?? '';
        const sessionModel = schema.match(/model Session \{[\s\S]*?\n\}/)?.[0] ?? '';

        for (const field of prohibitedAccountFields) {
            expect(accountModel).not.toContain(field);
        }
        for (const field of prohibitedSessionFields) {
            expect(sessionModel).not.toContain(field);
        }
        for (const index of prohibitedIndexes) {
            expect(sessionModel).not.toContain(index);
        }
    });

    it.each([
        ['prisma/migrations', '"Account"'],
        ['prisma/sqlite/migrations', '"Account"'],
        ['prisma/mysql/migrations', '`Account`'],
    ])('does not mutate Account or add draft rotation/migration machinery: %s', async (
        migrationRoot,
        accountTable,
    ) => {
        const sql = await read(`${migrationRoot}/${migrationId}/migration.sql`);
        expect(sql).not.toContain(`ALTER TABLE ${accountTable}`);
        for (const field of [...prohibitedAccountFields, ...prohibitedSessionFields]) {
            expect(sql).not.toContain(field);
        }
        for (const index of prohibitedIndexes) {
            expect(sql).not.toContain(index);
        }
        expect(sql).not.toMatch(/\bUPDATE\b/i);
        expect(sql).not.toMatch(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i);
        expect(sql).not.toMatch(/SessionMessage|SessionTranscript/i);
    });
});
