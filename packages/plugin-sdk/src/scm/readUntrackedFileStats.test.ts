import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runWithBackendRuntimeServices, type BackendRuntimeServices } from './backend.js';
import { readUntrackedFileStats } from './readUntrackedFileStats.js';

describe('readUntrackedFileStats', () => {
    const roots: string[] = [];
    afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

    it.skipIf(process.platform === 'win32')('counts symlink content without following existing or dangling targets', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scm-untracked-links-'));
        roots.push(root);
        await writeFile(join(root, 'target'), 'line\n'.repeat(20));
        await symlink('target', join(root, 'link'));
        await symlink('absent', join(root, 'dangling'));
        expect(await readUntrackedFileStats(root, ['link', 'dangling'])).toEqual({
            link: { pendingAdded: 1, isBinary: false },
            dangling: { pendingAdded: 1, isBinary: false },
        });
    });

    it('measures complete text lines and NUL evidence, leaving oversized files unmeasured', async () => {
        const root = await mkdtemp(join(tmpdir(), 'scm-untracked-stats-'));
        roots.push(root);
        const files = { empty: '', terminated: 'hello\n', unterminated: 'hello', multiline: 'hello\nworld\n', binary: 'hello\0world', oversized: 'x'.repeat(5_000_001) };
        await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(root, name), content)));
        const result = await readUntrackedFileStats(root, Object.keys(files));
        expect(result).toEqual({
            empty: { pendingAdded: 0, isBinary: false },
            terminated: { pendingAdded: 1, isBinary: false },
            unterminated: { pendingAdded: 1, isBinary: false },
            multiline: { pendingAdded: 2, isBinary: false },
            binary: { pendingAdded: 0, isBinary: true },
        });
    });

    it('routes through BackendRuntimeServices.repositoryFileSystem without touching local disk and fails closed when omitted', async () => {
        const localRoot = await mkdtemp(join(tmpdir(), 'scm-untracked-remote-'));
        roots.push(localRoot);
        await writeFile(join(localRoot, 'note.txt'), 'local\n'.repeat(40), 'utf8');

        const lstat = vi.fn(async (targetPath: string) => {
            if (targetPath === join(localRoot, 'note.txt')) {
                return { dev: 1, ino: 1, size: 12, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
            }
            if (targetPath === join(localRoot, 'link')) {
                return { dev: 1, ino: 2, size: 6, isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
            }
            throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });
        const readFile = vi.fn(async () => Buffer.from('a\nb\nc\n', 'utf8'));
        const readlink = vi.fn(async () => 'dest');

        const repositoryFileSystem = {
            lstat,
            readFile,
            readlink,
        } as unknown as NonNullable<BackendRuntimeServices['repositoryFileSystem']>;

        const remoteResult = await runWithBackendRuntimeServices({
            runCommand: async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }),
            repositoryFileSystem,
        }, () => readUntrackedFileStats(localRoot, ['note.txt', 'link']));

        expect(remoteResult).toEqual({
            'note.txt': { pendingAdded: 3, isBinary: false },
            link: { pendingAdded: 1, isBinary: false },
        });
        expect(lstat).toHaveBeenCalledTimes(2);
        expect(readFile).toHaveBeenCalledTimes(1);
        expect(readlink).toHaveBeenCalledTimes(1);

        await expect(runWithBackendRuntimeServices({
            runCommand: async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }),
        }, () => readUntrackedFileStats(localRoot, ['note.txt']))).rejects.toMatchObject({
            code: 'BACKEND_UNAVAILABLE',
        });
    });
});
