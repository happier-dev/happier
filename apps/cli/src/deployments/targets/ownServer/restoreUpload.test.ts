import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
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
