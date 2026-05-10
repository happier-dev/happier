import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { applyWorkspaceMetadata } from './applyWorkspaceMetadata';

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(directory);
    return directory;
}

describe('applyWorkspaceMetadata', () => {
    afterEach(async () => {
        await Promise.all(tempRoots.splice(0, tempRoots.length).map(async (directory) => await rm(directory, { recursive: true, force: true })));
    });

    it('applies mode and mtime metadata to regular files', async () => {
        const root = await makeTempDir('workspace-apply-metadata-file-');
        const filePath = join(root, 'README.md');
        const targetMtimeMs = Date.UTC(2024, 4, 1, 12, 30, 0, 0);
        await writeFile(filePath, '# staged metadata\n', { encoding: 'utf8', mode: 0o600 });

        const result = await applyWorkspaceMetadata({
            entryKind: 'file',
            entryPath: filePath,
            mode: 0o100755,
            mtimeMs: targetMtimeMs,
        });

        const stats = await lstat(filePath);
        expect(result).toEqual({ modeApplied: true, mtimeApplied: true });
        expect(stats.mode & 0o777).toBe(0o755);
        expect(Math.abs(stats.mtimeMs - targetMtimeMs)).toBeLessThan(5);
    });

    it('applies mode and mtime metadata to directories', async () => {
        const root = await makeTempDir('workspace-apply-metadata-directory-');
        const directoryPath = join(root, 'src');
        const targetMtimeMs = Date.UTC(2023, 10, 2, 6, 15, 0, 0);
        await mkdir(directoryPath);

        const result = await applyWorkspaceMetadata({
            entryKind: 'directory',
            entryPath: directoryPath,
            mode: 0o040755,
            mtimeMs: targetMtimeMs,
        });

        const stats = await lstat(directoryPath);
        expect(result).toEqual({ modeApplied: true, mtimeApplied: true });
        expect(stats.mode & 0o777).toBe(0o755);
        expect(Math.abs(stats.mtimeMs - targetMtimeMs)).toBeLessThan(5);
    });

    it('skips symlink metadata application on platforms where the helper stays fail-closed', async () => {
        const root = await makeTempDir('workspace-apply-metadata-symlink-');
        const targetPath = join(root, 'target.txt');
        const linkPath = join(root, 'target-link');
        await writeFile(targetPath, 'target\n', 'utf8');
        await symlink('./target.txt', linkPath);

        await expect(applyWorkspaceMetadata({
            entryKind: 'symlink',
            entryPath: linkPath,
            mode: 0o120777,
            mtimeMs: Date.UTC(2022, 1, 1, 0, 0, 0, 0),
        })).resolves.toEqual({ modeApplied: false, mtimeApplied: false });
    });
});
