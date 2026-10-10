import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as fs from './index.public.js';

describe('native SQLite filesystem seam', () => {
    it('opens existing state read-only without creating missing databases or allowing writes', () => {
        const directory = mkdtempSync(join(tmpdir(), 'happier-sqlite-read-only-'));
        const path = join(directory, 'state.sqlite');
        try {
            const writer = fs.openSqliteDatabaseSync(path);
            writer.exec('CREATE TABLE records (value TEXT NOT NULL)');
            writer.prepare('INSERT INTO records (value) VALUES (?)').run('existing');
            writer.close();
            const reader = fs.openSqliteDatabaseSync(path, { readOnly: true });
            try {
                expect(reader.prepare('SELECT value FROM records').get()).toEqual({ value: 'existing' });
                expect(() => reader.prepare('INSERT INTO records (value) VALUES (?)').run('new')).toThrow();
            } finally {
                reader.close();
            }
            expect(() => fs.openSqliteDatabaseSync(join(directory, 'missing.sqlite'), { readOnly: true })).toThrow();
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
    it('opens independent databases and preserves bound values through the runtime-selected provider', () => {
        expect(fs.openSqliteDatabaseSync).toBeTypeOf('function');
        const first = fs.openSqliteDatabaseSync(':memory:');
        const second = fs.openSqliteDatabaseSync(':memory:');
        try {
            for (const db of [first, second]) db.exec('CREATE TABLE records (value TEXT NOT NULL)');
            first.prepare('INSERT INTO records (value) VALUES (?)').run('a\0b');
            expect(first.prepare('SELECT value FROM records').get()).toEqual({ value: 'a\0b' });
            expect(second.prepare('SELECT value FROM records').all()).toEqual([]);
        } finally {
            first.close();
            second.close();
        }
    });
});
