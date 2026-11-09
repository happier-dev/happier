import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const migration = '20261026150000_add_session_appearance';

describe('personal appearance provider storage', () => {
    it.each(['prisma', 'prisma/sqlite', 'prisma/mysql'])('keeps %s account/session ownership cascading', async provider => {
        const schema = await readFile(join(root, provider, 'schema.prisma'), 'utf8');
        const model = schema.match(/model SessionAppearance \{[\s\S]*?\n\}/)?.[0];
        expect(model).toContain('@@unique([accountId, sessionId])');
        expect(model).toContain('account Account @relation(fields: [accountId], references: [id], onDelete: Cascade)');
        expect(model).toContain('session Session @relation(fields: [sessionId], references: [id], onDelete: Cascade)');
        if (provider.endsWith('mysql')) expect(model).toMatch(/displayDbValue\s+String\s+@db.LongText/);
        const sql = (await readFile(join(root, provider, 'migrations', migration, 'migration.sql'), 'utf8')).replaceAll('`', '"').replaceAll('" ("', '"("');
        expect(sql).toContain('CREATE TABLE "SessionAppearance"');
        expect(sql).toContain('"SessionAppearance_accountId_sessionId_key"');
        expect(sql).toContain('"SessionAppearance_sessionId_idx"');
        expect(sql).toContain('FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE');
        expect(sql).toContain('FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE');
    });
});
