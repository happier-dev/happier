import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Header } from 'tar';
import { describe, expect, it } from 'vitest';
import { admitOwnServerRestoreUpload } from './restoreUpload';

it.each(['database', 'corrupt'] as const)('admits a SQLite upload only after native integrity succeeds: %s', async mode => {
    const root = await mkdtemp(join(tmpdir(), 'happier-upload-integrity-'));
    try {
        const filePath = join(root, 'upload.sqlite');
        if (mode === 'database') {
            const database = new DatabaseSync(filePath);
            try { database.exec("CREATE TABLE records(value TEXT); INSERT INTO records VALUES('uploaded');"); }
            finally { database.close(); }
        } else await writeFile(filePath, 'SQLite format 3\0corrupt database');
        const bytes = await readFile(filePath);
        const upload = { kind: 'upload' as const, transferId: 'admitted-sqlite-upload', filePath,
            sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
            readChunk: async ({ offset, length }: { offset: number; length: number }) => bytes.subarray(offset, offset + length) };
        const result = admitOwnServerRestoreUpload({ upload, operationId: 'sqlite-upload-prepare',
            destination: { adapter: 'sqlite-v1', environmentId: 'environment', revision: 1, service: 'app',
                path: '/data/database.sqlite', stagingVolume: 'upload-stage', hasMeaningfulData: false, writerServices: [] },
            signal: new AbortController().signal,
            async execute(request) {
                if (request.kind !== 'sqliteStage' || request.source.kind !== 'upload') throw new Error('Expected SQLite upload staging');
                // Substitute only Docker's filesystem/SQLite boundary, keeping
                // the real uploaded bytes and SQLite integrity implementation.
                const staged = join(root, request.destination.stagingVolume);
                await writeFile(staged, await upload.readChunk({ offset: 0, length: request.source.sizeBytes }));
                let database: DatabaseSync | undefined;
                try {
                    database = new DatabaseSync(staged, { readOnly: true });
                    const rows = database.prepare('PRAGMA integrity_check').all();
                    if (rows.length !== 1 || rows[0]?.integrity_check !== 'ok') throw new Error('Integrity failed');
                    return { kind: 'completed', exitCode: 0, stdout: 'ok\n', stdoutTruncated: false };
                } catch {
                    return { kind: 'completed', exitCode: 1, stdout: '', stdoutTruncated: false };
                } finally { database?.close(); }
            } });
        if (mode === 'database') await expect(result).resolves.toBe('sqlite');
        else await expect(result).rejects.toMatchObject({ code: 'backup_integrity_failed' });
    } finally { await rm(root, { recursive: true, force: true }); }
});

describe('volume archive member admission', () => {
    // Real TAR bytes with exact hostile headers; the native list substitutes
    // only the Docker boundary by running the host tar over the same upload.
    type Member = Readonly<{ path: string; type?: 'File' | 'Directory' | 'SymbolicLink' | 'Link'; linkpath?: string; body?: string }>;
    const archive = (members: readonly Member[]) => Buffer.concat([...members.flatMap(member => {
        const body = Buffer.from(member.body ?? '');
        const header = new Header({ path: member.path, type: member.type ?? 'File', mode: member.type === 'Directory' ? 0o755 : 0o644,
            size: body.length, mtime: new Date(0), ...(member.linkpath ? { linkpath: member.linkpath } : {}) });
        header.encode();
        return [header.block!, body, Buffer.alloc((512 - body.length % 512) % 512)];
    }), Buffer.alloc(1024)]);
    const legitimate: readonly Member[] = [
        { path: 'data/', type: 'Directory' }, { path: 'data/nested/', type: 'Directory' },
        { path: 'data/nested/fixture.db', body: 'fixture' },
        { path: 'data/nested/current', type: 'SymbolicLink', linkpath: 'fixture.db' },
        { path: 'data/nested/sibling', type: 'SymbolicLink', linkpath: '../nested/./fixture.db' },
        { path: 'data/hard.db', type: 'Link', linkpath: 'data/nested/fixture.db' },
    ];
    const admitArchive = async (members: readonly Member[]) => {
        const root = await mkdtemp(join(tmpdir(), 'happier-upload-archive-'));
        try {
            const filePath = join(root, 'upload.tar');
            await writeFile(filePath, archive(members));
            const bytes = await readFile(filePath);
            const requests: string[] = [];
            const result = await admitOwnServerRestoreUpload({ operationId: 'volume-upload-prepare',
                upload: { kind: 'upload', transferId: 'admitted-volume-upload', filePath,
                    sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
                    readChunk: async ({ offset, length }: { offset: number; length: number }) => bytes.subarray(offset, offset + Math.min(length, 700)) },
                destination: { adapter: 'volume-v1', environmentId: 'environment', revision: 1, service: 'app', volume: 'data',
                    currentVolume: 'current', stagingVolume: 'stage', hasMeaningfulData: true, writerServices: ['app'], runningServices: ['app'] },
                signal: new AbortController().signal,
                async execute(request) {
                    if (request.kind !== 'volumeArchive') throw new Error('Expected the native archive reader');
                    requests.push(request.mode);
                    const listed = spawnSync('tar', ['-tf', filePath]);
                    return { kind: 'completed', exitCode: listed.status ?? 1, stdout: listed.stdout.toString(), stdoutTruncated: false,
                        stderr: listed.stderr.toString(), stderrTruncated: false };
                } }).then(format => ({ format }), (error: unknown) => ({ error }));
            return { result, requests };
        } finally { await rm(root, { recursive: true, force: true }); }
    };

    it('admits a nested archive whose links stay inside the restore root', async () => {
        await expect(admitArchive(legitimate)).resolves.toEqual({ result: { format: 'volumeTar' }, requests: ['list'] });
    });

    it.each<[string, Member]>([
        ['dot-dot member', { path: '../w1-backup-164-escape', body: 'escape' }],
        ['nested dot-dot member', { path: 'data/../../escape', body: 'escape' }],
        ['absolute member', { path: '/tmp/escape', body: 'escape' }],
        ['escaping symlink', { path: 'data/nested/escape', type: 'SymbolicLink', linkpath: '../../../outside' }],
        ['absolute symlink', { path: 'data/escape', type: 'SymbolicLink', linkpath: '/etc/passwd' }],
        ['escaping hardlink', { path: 'data/escape', type: 'Link', linkpath: '../outside' }],
        ['absolute hardlink', { path: 'data/escape', type: 'Link', linkpath: '/etc/passwd' }],
    ])('refuses a %s before the native reader runs', async (_shape, member) => {
        const { result, requests } = await admitArchive([...legitimate, member]);
        expect(result).toMatchObject({ error: { code: 'backup_integrity_failed' } });
        expect(requests).toEqual([]);
    });
});
