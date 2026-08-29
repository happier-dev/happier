import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const serverRoot = join(import.meta.dirname, '..', '..');
const migrationId = '20260829120000_add_automation_definition_list_index';

async function read(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), 'utf8');
}

function automationModel(schema: string): string {
    const match = schema.match(/model Automation \{[\s\S]*?\n\}/)?.[0];
    if (!match) throw new Error('Automation model not found');
    return match;
}

describe('Automation definition list keyset index contract', () => {
    it('keeps the exact PostgreSQL ordering tuple in the canonical Prisma schema', async () => {
        const model = automationModel(await read('prisma/schema.prisma'));
        expect(model).toContain(
            '@@index([accountId, deletedAt, updatedAt(sort: Desc), id(sort: Asc)], map: "Automation_account_deleted_updated_id_idx")',
        );
    });

    it.each([
        'prisma/mysql/schema.prisma',
        'prisma/sqlite/schema.prisma',
    ])('keeps the generated provider index correspondence in %s', async (schemaPath) => {
        const model = automationModel(await read(schemaPath));
        expect(model).toContain(
            '@@index([accountId, deletedAt, updatedAt, id], map: "Automation_account_deleted_updated_id_idx")',
        );
    });

    it.each([
        {
            migration: `prisma/migrations/${migrationId}/migration.sql`,
            expected: 'ON "Automation"("accountId", "deletedAt", "updatedAt" DESC, "id" ASC)',
        },
        {
            migration: `prisma/sqlite/migrations/${migrationId}/migration.sql`,
            expected: 'ON "Automation"("accountId", "deletedAt", "updatedAt" DESC, "id" ASC)',
        },
        {
            migration: `prisma/mysql/migrations/${migrationId}/migration.sql`,
            expected: 'ON `Automation`(`accountId`, `deletedAt`, `updatedAt` DESC, `id` ASC)',
        },
    ])('creates the provider index with stable mixed ordering: $migration', async ({ migration, expected }) => {
        const sql = await read(migration);
        expect(sql).toContain('Automation_account_deleted_updated_id_idx');
        expect(sql).toContain(expected);
        expect(sql).not.toMatch(/\b(?:UPDATE|DELETE|DROP)\b/i);
    });
});
