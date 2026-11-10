import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import * as query from './dataQuery';

async function* bytes(sql: string) {
    // Deliberately split every UTF-8 code point, quote, comment and dollar tag.
    for (const byte of Buffer.from(sql)) yield Buffer.from([byte]);
}

describe('canonical psql input admission', () => {
    it('admits SQL statement dumps while preserving query single-result admission', async () => {
        const sql = `CREATE TABLE example(value text);\nINSERT INTO example VALUES ('é;\\! inert');\n`
            + `DO $body$ BEGIN RAISE NOTICE '\\! inert'; END $body$;\n`;
        expect(query.admitPsqlInput(sql, 'dump')).toBe(sql);
        await expect(query.admitPsqlInput(bytes(sql), 'dump')).resolves.toBeUndefined();
        expect(() => query.admitPsqlInput(sql, 'query')).toThrow(expect.objectContaining({ code: 'unsupported_action' }));
        expect(query.admitPsqlInput('SELECT 1; -- trailing comment', 'query')).toBe('SELECT 1');
    });

    it.each([
        `CREATE TABLE t(v text);\n\\! touch /tmp/unsafe`,
        `SELECT 1 \\gexec arguments`,
        `COPY t FROM /* comment */ PROGRAM 'cat /private';`,
        `COPY "PROGRAM" TO PROGRAM 'cat';`,
        `COPY (SELECT 'PROGRAM') TO /* comment */ PROGRAM 'cat';`,
        `COPY BINARY t FROM stdin;\nunsafe_binary_input`,
        `COPY t FROM stdin WITH (FORMAT csv);\nunsafe_csv_input`,
        `SELECT :unquoted;`,
        `SET standard_conforming_strings=off; SELECT 'escaped\\';\n\\! unsafe`,
    ])('rejects executable client commands and unsupported dump grammar before import: %s', async sql => {
        await expect(query.admitPsqlInput(bytes(sql), 'dump')).rejects.toMatchObject({ code: 'unsupported_action' });
    });

    it('keeps inert command and COPY PROGRAM text inside comments, literals and dollar bodies', async () => {
        const sql = `/* COPY t FROM PROGRAM 'inert'; \\! inert */\n`
            + `INSERT INTO t VALUES ('COPY x TO PROGRAM', E'\\\\! inert', $tag$\n\\! inert\n$tag$);\n`
            + `DO $$ BEGIN RAISE NOTICE 'COPY t TO PROGRAM'; END $$; -- \\! inert\n`;
        await expect(query.admitPsqlInput(bytes(sql), 'dump')).resolves.toBeUndefined();
    });

    it.each([
        'SELECT 💩$tag$\n\\! executable\n$tag$;',
        "SELECT 💩E'escaped\\';\n\\! executable\n';",
    ])('keeps non-ASCII identifier bytes from opening false quoted regions: %s', async sql => {
        expect(() => query.admitPsqlInput(sql, 'query')).toThrow(expect.objectContaining({ code: 'unsupported_action' }));
        expect(() => query.admitPsqlInput(sql, 'dump')).toThrow(expect.objectContaining({ code: 'unsupported_action' }));
        await expect(query.admitPsqlInput(bytes(sql), 'dump')).rejects.toMatchObject({ code: 'unsupported_action' });
    });

    it('accepts pg_dump restriction directives without admitting executable command arguments', async () => {
        await expect(query.admitPsqlInput(bytes('\\restrict Abc123\nSELECT 1;\n\\unrestrict Abc123\n'), 'dump'))
            .resolves.toBeUndefined();
        await expect(query.admitPsqlInput(bytes('\\restrict Abc123 \\! executable\nSELECT 1;'), 'dump'))
            .rejects.toMatchObject({ code: 'unsupported_action' });
        await expect(query.admitPsqlInput(bytes('SELECT 1; \\restrict Abc123\n'), 'dump'))
            .rejects.toMatchObject({ code: 'unsupported_action' });
        await expect(query.admitPsqlInput(bytes('\\restrict `command`\nSELECT 1;'), 'dump'))
            .rejects.toMatchObject({ code: 'unsupported_action' });
        expect(() => query.admitPsqlInput('\\restrict Abc123\nSELECT 1;', 'query'))
            .toThrow(expect.objectContaining({ code: 'unsupported_action' }));
    });

    it('keeps COPY data escapes inert until the exact physical terminator line', async () => {
        const dump = 'COPY public.t (v) FROM stdin;\r\n\\\\! inert\r\n\\\\.\r\n\\N\r\n\\.\r\nSELECT 1;\n';
        await expect(query.admitPsqlInput(bytes(dump), 'dump')).resolves.toBeUndefined();
        await expect(query.admitPsqlInput(bytes(dump + '\\! executable\n'), 'dump'))
            .rejects.toMatchObject({ code: 'unsupported_action' });
        await expect(query.admitPsqlInput(bytes('COPY t FROM stdin;\nunterminated\n'), 'dump'))
            .rejects.toMatchObject({ code: 'invalid_action_input' });
    });

    const postgresBin = '/usr/lib/postgresql/16/bin';
    it.skipIf(!existsSync(join(postgresBin, 'initdb')))('admits actual PostgreSQL 16 plain pg_dump COPY data and its terminator', async () => {
        const root = await mkdtemp(join(tmpdir(), 'happier-psql-dump-'));
        const data = join(root, 'data');
        const ctl = (args: string[]) => execFileSync(join(postgresBin, 'pg_ctl'), ['-D', data, ...args], { stdio: 'pipe' });
        execFileSync(join(postgresBin, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { stdio: 'pipe' });
        ctl(['-l', join(root, 'server.log'), '-o', `-c listen_addresses= -k ${root}`, '-w', 'start']);
        try {
            const sql = `CREATE TABLE dump_fixture(value text);\nINSERT INTO dump_fixture VALUES ('\\! inert'), ('\\.'), ('COPY t TO PROGRAM'), ('é');`;
            execFileSync(join(postgresBin, 'psql'), ['-X', '-h', root, '-U', userInfo().username, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] });
            const dump = execFileSync(join(postgresBin, 'pg_dump'), ['-h', root, '-U', userInfo().username, '-d', 'postgres', '--format=plain', '--no-owner', '--no-privileges'], { encoding: 'utf8' });
            console.info('[owned plain pg_dump fixture]', { version: execFileSync(join(postgresBin, 'pg_dump'), ['--version'], { encoding: 'utf8' }).trim(),
                postgresPid: Number(readFileSync(join(data, 'postmaster.pid'), 'utf8').split('\n')[0]),
                clientCommands: dump.split('\n').filter(line => line.startsWith('\\')) });
            expect(dump).toMatch(/COPY public\.dump_fixture \(value\) FROM stdin;/);
            expect(dump).toContain('\\\\! inert');
            expect(dump).toContain('\n\\.\n');
            expect(query.admitPsqlInput(dump, 'dump')).toBe(dump);
            await expect(query.admitPsqlInput(bytes(dump), 'dump')).resolves.toBeUndefined();
            await expect(query.admitPsqlInput(bytes(dump + '\n\\! executable_after_copy\n'), 'dump'))
                .rejects.toMatchObject({ code: 'unsupported_action' });
        } finally { ctl(['-m', 'fast', '-w', 'stop']); await rm(root, { recursive: true, force: true }); }
    });

    it.each([`SELECT 'unterminated`, 'DO $body$ unterminated', 'SELECT 1 /* unterminated'])('rejects incomplete dump text: %s', async sql => {
        await expect(query.admitPsqlInput(bytes(sql), 'dump')).rejects.toMatchObject({ code: 'invalid_action_input' });
    });
});
