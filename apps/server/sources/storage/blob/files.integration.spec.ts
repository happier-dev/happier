import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deletePrivateFile, initFilesLocalFromEnv, loadFiles, readPrivateFile, readPublicFile, writePrivateFile } from './files';

describe('local private/public file root admission', () => {
    it.each([
        { publicRoot: 'public', privateRoot: 'public' },
        { publicRoot: 'public', privateRoot: 'public/nested' },
        { publicRoot: 'private/artifacts', privateRoot: 'private' },
    ])('refuses overlapping roots ($publicRoot / $privateRoot) while leaving public startup usable', async roots => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-files-isolation-'));
        try {
            initFilesLocalFromEnv({ HAPPIER_SERVER_LIGHT_DATA_DIR: dir,
                HAPPIER_SERVER_LIGHT_FILES_DIR: join(dir, roots.publicRoot),
                HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: join(dir, roots.privateRoot) });
            await loadFiles();
            await expect(writePrivateFile('artifacts/a/b', Uint8Array.of(1)))
                .rejects.toMatchObject({ code: 'private_storage_unavailable' });
            await expect(readPrivateFile('artifacts/a/b')).rejects.toMatchObject({ code: 'private_storage_unavailable' });
            await expect(deletePrivateFile('artifacts/a/b')).rejects.toMatchObject({ code: 'private_storage_unavailable' });
        } finally { await rm(dir, { recursive: true, force: true }); }
    });

    it('resolves ancestor symlink aliases before admitting private IO', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-files-isolation-'));
        try {
            await mkdir(join(dir, 'actual'));
            await symlink(join(dir, 'actual'), join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
            initFilesLocalFromEnv({ HAPPIER_SERVER_LIGHT_DATA_DIR: dir,
                HAPPIER_SERVER_LIGHT_FILES_DIR: join(dir, 'actual'),
                HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: join(dir, 'alias', 'private') });
            await loadFiles();
            await expect(writePrivateFile('artifacts/a/b', Uint8Array.of(1)))
                .rejects.toMatchObject({ code: 'private_storage_unavailable' });
        } finally { await rm(dir, { recursive: true, force: true }); }
    });

    it('admits disjoint sibling-prefix roots and never exposes private bytes through public reads', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'happier-files-isolation-'));
        try {
            initFilesLocalFromEnv({ HAPPIER_SERVER_LIGHT_DATA_DIR: dir,
                HAPPIER_SERVER_LIGHT_FILES_DIR: join(dir, 'public'),
                HAPPIER_SERVER_LIGHT_PRIVATE_FILES_DIR: join(dir, 'public-private') });
            await loadFiles();
            const bytes = Uint8Array.of(0, 255, 12);
            await writePrivateFile('artifacts/a/b', bytes);
            expect(await readPrivateFile('artifacts/a/b')).toEqual(bytes);
            await expect(readPublicFile('artifacts/a/b')).rejects.toThrow();
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
});
